#!/usr/bin/env python3
"""Phone alerts, a Live Activity and widgets through the Notify! app (https://getnotifyapp.com).

Runs after every data update:

    python scripts/alerts.py --store store

Each rule is a state with hysteresis: it alerts once when it turns on, re-arms only once the value has
dropped back well below, and the warning rules send an all-clear when they turn off. What was sent is
kept in <store>/alerts.json, so a run that changes nothing sends nothing.

While a warning is on, a Live Activity on the Lock Screen follows the Ljubljanica and groundwater.
A Lock Screen widget and a Home Screen widget show the latest values all the time.

Credentials come from the environment and are never written anywhere:

    NOTIFY_URL         the device's webhook address from the Notify! app, ...?token=...
    NOTIFY_BEACON_URL  optional: a Notify! beacon ping address. Pinged on every run, so the app
                       alerts by itself if these updates stop arriving.

Without NOTIFY_URL the script does nothing. It never fails the data update.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlencode, urlparse
from urllib.request import Request, urlopen

SITE = "https://bizmar.github.io/RiverChart/"
GATEWAY = "https://push.getnotifyapp.com"
RIVER, SAVA = "5078", "3570"  # Ljubljanica at Moste I, Sava at Sentjakob

# Ljubljanica at Moste I. It was about 200-255 cm on both 2023 days with groundwater at the reference level at
# Zalog, and of all live gauges it follows the Zalog groundwater best (correlation 0.90, 2015-2026).
WARN_CM, WARN_CLEAR_CM = 200, 180
RISE_CM, RISE_CLEAR_CM, RISE_HOURS = 40, 15, 6
# Groundwater at Hrastje, metres over three days.
GW_RISE_M, GW_RISE_CLEAR_M, GW_RISE_DAYS = 0.30, 0.10, 3
# ARSO's readings older than this: the dashboard can no longer see the river.
STALE_HOURS = 6

FLOOD_WORDS = re.compile(r"prvi|drug|tretj|visokovod|poplav", re.I)
COLOURS = {"normal": "#2A78D6", "heads-up": "#FAB219", "warning": "#EC835A", "urgent": "#D03B3B"}
# River-wave notification icons in the same colours, published with the site (site/icons).
icon = lambda lvl: f"{SITE}icons/alert-{lvl}.png"  # noqa: E731


# --------------------------------------------------------------------------- data

def parse_time(s: str) -> datetime:
    return datetime.strptime(s, "%Y-%m-%dT%H:%MZ").replace(tzinfo=timezone.utc)


def live_series(store: Path, station_id: str, field: str = "level") -> list[tuple[datetime, float]]:
    """The last two months of measured readings, oldest first."""
    months = sorted((store / station_id / "live").glob("*.csv"))[-2:]
    out = []
    for path in months:
        with path.open(newline="") as f:
            out += [(parse_time(r["time"]), float(r[field])) for r in csv.DictReader(f) if r.get(field)]
    return sorted(out)


def change_over(series: list[tuple[datetime, float]], hours: float) -> float | None:
    """Latest value minus the value about `hours` earlier (None without a reading near that time)."""
    if not series:
        return None
    t, v = series[-1]
    target = t - timedelta(hours=hours)
    before = min(series, key=lambda p: abs(p[0] - target))
    if abs(before[0] - target) > timedelta(hours=max(1.5, hours / 4)):
        return None
    return v - before[1]


def snapshot(store: Path, now: datetime) -> dict:
    """Everything the rules and the phone surfaces need, from the data the update just wrote."""
    cat = json.loads((store / "stations.json").read_text())
    by_id = {s["id"]: s for s in cat["stations"]}
    lj, sv, gw = by_id.get(RIVER, {}), by_id.get(SAVA, {}), cat.get("groundwater") or {}
    river = live_series(store, RIVER)
    gw_m = [(t, gw["datum"] + v / 100) for t, v in live_series(store, gw["id"])] if gw.get("id") else []

    floods = []
    for st in (lj, sv):
        stage1 = (st.get("thresholds") or {}).get("flow", {}).get("1")
        if FLOOD_WORDS.search(st.get("flow_class") or "") or (stage1 and st.get("flow") and st["flow"] >= stage1):
            floods.append(f"{st['river']} at {st['place']}: {st.get('flow_class') or 'flood stage'}"
                          + (f" ({st['flow']:.0f} m³/s)" if st.get("flow") else ""))
    stage1 = (lj.get("thresholds") or {}).get("flow", {}).get("1")
    return {
        "lj_cm": lj.get("level"),
        "lj_flow": lj.get("flow"),
        "lj_stage1": stage1,
        "lj_time": parse_time(lj["time"]) if lj.get("time") else None,
        "lj_change": change_over(river, RISE_HOURS),
        "sava_cm": sv.get("level"),
        "gw_m": gw.get("level"),
        "gw_change": change_over(gw_m, GW_RISE_DAYS * 24),
        "floods": floods,
        "now": now,
    }


# --------------------------------------------------------------------------- rules

def fmt(v: float | None, digits: int = 0, signed: bool = False) -> str:
    if v is None:
        return "–"
    s = f"{v:+.{digits}f}" if signed else f"{v:.{digits}f}"
    return s.replace("-", "−")


def evaluate(snap: dict, active: dict) -> dict:
    """Which rules are on now, given which were on before (hysteresis)."""
    on = dict(active)
    cm, rise, gw_rise = snap["lj_cm"], snap["lj_change"], snap["gw_change"]
    if cm is not None:
        on["high"] = cm >= WARN_CM or (active.get("high", False) and cm >= WARN_CLEAR_CM)
    if rise is not None:
        on["rise"] = rise >= RISE_CM or (active.get("rise", False) and rise >= RISE_CLEAR_CM)
    if gw_rise is not None:
        on["gw_rise"] = gw_rise >= GW_RISE_M or (active.get("gw_rise", False) and gw_rise >= GW_RISE_CLEAR_M)
    on["flood"] = bool(snap["floods"])
    on["stale"] = snap["lj_time"] is None or snap["now"] - snap["lj_time"] > timedelta(hours=STALE_HOURS)
    return on


def level(on: dict) -> str:
    if on.get("flood"):
        return "urgent"
    if on.get("high"):
        return "warning"
    if on.get("rise") or on.get("gw_rise"):
        return "heads-up"
    return "normal"


def messages(snap: dict, before: dict, on: dict) -> list[dict]:
    """Notifications for rules that just changed. Warnings break through Focus; heads-ups do not."""
    out = []
    add = lambda rule, title, text, lvl="normal", urgent=False: out.append(  # noqa: E731
        {"rule": rule, "title": title, "text": f"{text}\n{SITE}", "groupType": "riverchart", "timeSensitive": urgent,
         "iconUrl": icon(lvl)})
    turned_on = lambda k: on.get(k) and not before.get(k)  # noqa: E731
    turned_off = lambda k: before.get(k) and not on.get(k)  # noqa: E731
    cm, rise = fmt(snap["lj_cm"]), fmt(snap["lj_change"], signed=True)
    if turned_on("flood"):
        add("flood", "Flood stage", "ARSO reports a flood stage. " + "; ".join(snap["floods"]) + ".", "urgent", urgent=True)
    if turned_off("flood"):
        add("flood", "Flood stage over", "ARSO no longer reports a flood stage on the Ljubljanica or the Sava.")
    if turned_on("high") and not turned_on("flood"):  # a flood stage already says it
        add("high", "Ljubljanica high", f"Moste I: {cm} cm ({rise} cm in {RISE_HOURS} h), above {WARN_CM} cm. "
            "Groundwater at Zalog was at the reference level when the river was this high.", "warning", urgent=True)
    if turned_off("high"):
        add("high", "All clear", f"Ljubljanica back to {cm} cm at Moste I.")
    if turned_on("rise") and not on.get("high"):
        add("rise", "Ljubljanica rising fast", f"Moste I: {rise} cm in {RISE_HOURS} h, now {cm} cm.", "heads-up")
    if turned_on("gw_rise"):
        add("gw_rise", "Groundwater rising",
            f"Hrastje: {fmt(snap['gw_change'], 2, True)} m in {GW_RISE_DAYS} days, now {fmt(snap['gw_m'], 2)} m.", "heads-up")
    if turned_on("stale"):
        add("stale", "No new river data",
            f"ARSO has sent no Ljubljanica readings for over {STALE_HOURS} h, so RiverChart cannot see the river.")
    if turned_off("stale"):
        add("stale", "River data is back", f"ARSO readings are arriving again. Ljubljanica at Moste I: {cm} cm.")
    return out


def tile(snap: dict, lvl: str) -> dict:
    """Shared content for the Live Activity and the Home Screen widget."""
    rise = snap["lj_change"]
    trend = "steady" if rise is None or abs(rise) < 3 else ("rising" if rise > 0 else "falling")
    content = {
        "title": f"Ljubljanica {fmt(snap['lj_cm'])} cm",
        "body": {"urgent": "Flood stage", "warning": "High", "heads-up": "Rising", "normal": "Normal"}[lvl]
                + f" · {fmt(rise, signed=True)} cm in {RISE_HOURS} h",
        "symbol": "water.waves",
        "tint": COLOURS[lvl],
        "status": trend,
        "metrics": [
            {"label": "Ljubljanica", "value": fmt(snap["lj_cm"]), "unit": "cm"},
            {"label": "Sava", "value": fmt(snap["sava_cm"]), "unit": "cm"},
            {"label": "Groundwater", "value": fmt(snap["gw_m"], 2), "unit": "m"},
        ],
        "button": {"title": "Open RiverChart", "url": SITE, "open": True},
    }
    if snap["lj_flow"] and snap["lj_stage1"]:
        content["progress"] = round(min(100, 100 * snap["lj_flow"] / snap["lj_stage1"]), 1)  # of flood stage 1
    return content


# --------------------------------------------------------------------------- Notify!

class Notify:
    def __init__(self, webhook_url: str, log, timeout: int = 30):
        u = urlparse(webhook_url)
        token = parse_qs(u.query).get("token", [""])[0]
        device = u.path.rstrip("/").rsplit("/", 1)[-1]
        if u.scheme != "https" or not token or not re.fullmatch(r"[A-Za-z0-9]{4,32}", device):
            raise ValueError("NOTIFY_URL should be the device's webhook address from the Notify! app, ending in ?token=...")
        self.device, self.token, self.log, self.timeout = device, token, log, timeout

    def call(self, path: str, body: dict | None = None, **query) -> tuple[int, dict]:
        url = f"{GATEWAY}{path}?{urlencode({'token': self.token, **query})}"
        data = json.dumps(body).encode() if body is not None else None
        req = Request(url, data=data, method="POST" if data is not None else "GET",
                      headers={"Content-Type": "application/json", "User-Agent": "RiverChart/1.0"})
        try:
            with urlopen(req, timeout=self.timeout) as r:
                return r.status, json.loads(r.read() or b"{}")
        except HTTPError as e:
            try:
                detail = json.loads(e.read() or b"{}")
            except ValueError:
                detail = {}
            return e.code, detail

    def send(self, msg: dict) -> bool:
        status, resp = self.call(f"/notify-json/{self.device}", msg)
        self.log(f"  notification '{msg['title']}': HTTP {status}" + ("" if status < 300 else f" {resp}"))
        return status < 300

    def upsert(self, kind: str, key: str, state: dict, content: dict, **create_query) -> None:
        """Update a widget or tile by its stored id; create it (again) when there is none or it is gone."""
        path = {"widget": "/widgets", "screen": "/screenwidgets", "activity": "/live-activity"}[kind]
        wid = state.get(key)
        if wid:
            status, resp = self.call(f"{path}/{wid}", content)
            if status < 300:
                return
            self.log(f"  {kind} {wid}: HTTP {status}, creating a new one")
        status, resp = self.call(f"{path}/{self.device}", content, new="1", **create_query)
        new_id = resp.get("widgetId") or resp.get("screenWidgetId") or resp.get("activityId")
        self.log(f"  {kind} created: HTTP {status} {new_id or resp}")
        if status < 300 and new_id:
            state[key] = new_id
            if resp.get("expiresAt"):
                state[key + "_expires"] = resp["expiresAt"]

    def end_activity(self, state: dict, content: dict) -> None:
        wid = state.pop("activity", None)
        state.pop("activity_expires", None)
        if wid:
            status, _ = self.call(f"/live-activity/{wid}", {**content, "end": True, "keepFor": 3600})
            self.log(f"  live activity {wid} ended: HTTP {status}")


def run(store: Path, notify: Notify | None, beacon_url: str | None, log, now: datetime | None = None) -> dict:
    now = now or datetime.now(timezone.utc)
    state_path = store / "alerts.json"
    state = json.loads(state_path.read_text()) if state_path.exists() else {}
    snap = snapshot(store, now)
    before = state.get("active", {})
    on = evaluate(snap, before)
    lvl = level(on)
    msgs = messages(snap, before, on)
    log(f"alerts: level {lvl}; on: {sorted(k for k, v in on.items() if v) or 'none'}; {len(msgs)} to send")

    if notify:
        ids = state.setdefault("ids", {})
        for m in msgs:
            rule = m.pop("rule")
            if not notify.send(m):
                on[rule] = before.get(rule, False)  # not delivered: the next run tries again
        content = tile(snap, lvl)
        widget = {"title": "Ljubljanica", "value": fmt(snap["lj_cm"]), "unit": "cm", "symbol": "water.waves",
                  "tint": COLOURS[lvl], "detail": f"{content['body']} · groundwater {fmt(snap['gw_m'], 2)} m",
                  "progress": content.get("progress")}
        # Written on every run: the Home Screen widget dims itself two hours after its last write.
        notify.upsert("widget", "widget", ids, widget)
        notify.upsert("screen", "screen", ids, {**content, "title": "RiverChart"})
        if lvl in ("warning", "urgent"):
            expires = ids.get("activity_expires")
            if expires and expires < now.strftime("%Y-%m-%dT%H:%M"):  # Apple's 8 h ceiling: start a fresh tile
                ids.pop("activity", None)
            notify.upsert("activity", "activity", ids, content)
        else:
            notify.end_activity(ids, content)
        state["active"] = on
    else:
        log("alerts: NOTIFY_URL is not set, nothing sent")
        state["active"] = on
    state["level"], state["checked"] = lvl, now.strftime("%Y-%m-%dT%H:%MZ")
    state_path.write_text(json.dumps(state, indent=1) + "\n")

    if beacon_url:
        try:
            with urlopen(Request(beacon_url, headers={"User-Agent": "RiverChart/1.0"}), timeout=30) as r:
                log(f"  beacon ping: HTTP {r.status}")
        except Exception as e:  # noqa: BLE001
            log(f"  beacon ping failed: {e}")
    return state


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--store", type=Path, default=Path("store"))
    ap.add_argument("--test", action="store_true", help="also send a test notification")
    args = ap.parse_args()
    log = lambda *a: print(*a, flush=True)  # noqa: E731
    try:
        url = os.environ.get("NOTIFY_URL", "").strip()
        notify = Notify(url, log) if url else None
        if notify and args.test:
            notify.send({"title": "RiverChart test", "iconUrl": icon("normal"), "text": f"Alerts are set up. You will hear from RiverChart when the river or groundwater needs attention.\n{SITE}"})
        run(args.store, notify, os.environ.get("NOTIFY_BEACON_URL", "").strip() or None, log)
    except Exception as e:  # noqa: BLE001 - alerts must never break the data update
        log(f"alerts failed: {type(e).__name__}: {e}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
