#!/usr/bin/env python3
"""Backtest the alert rules on the daily record: would they have warned before Zalog's high groundwater?

    python scripts/backtest.py --store store > docs/backtest.md

An *event* is a run of days when the Zalog well (VOKA SNAGA P-1gl, 2015-2026) was within EVENT_BELOW_M of
the reference level. Each rule is replayed day by day on daily means, with the same on/clear hysteresis
as scripts/alerts.py, and scored on:

    alerts       how many times it turned on
    caught       events with the rule on between LEAD_WINDOW days before the event and its last day
    lead         days from the rule turning on to the event's first day (0 = same day)
    false        alerts with no event within LEAD_WINDOW days after them

The Zalog estimate is scored honestly: each year is estimated by a fit that never saw that year.
Daily means are smoother than the live readings alerts.py sees, so live alerts fire a little more often.
"""

from __future__ import annotations

import argparse
import csv
import sys
from datetime import date, timedelta
from pathlib import Path

import estimate
from alerts import RIVER, SAVA, WARN_CLEAR_CM, WARN_CM, ZALOG_NEAR_CLEAR_M, ZALOG_NEAR_M

ZALOG = "VOKA-P-1gl"
REFERENCE_DATE = "2023-11-06"
EVENT_BELOW_M = 0.40
LEAD_WINDOW = 10


def load(path: Path, field: str) -> dict[str, float]:
    with path.open(newline="") as f:
        return {r["date"]: float(r[field]) for r in csv.DictReader(f) if r.get(field)}


def gap(a: str, b: str) -> int:
    return (date.fromisoformat(b) - date.fromisoformat(a)).days


def runs(days: list[str], max_gap: int = 3) -> list[tuple[str, str]]:
    """Consecutive runs of sorted days (gaps up to max_gap days join a run)."""
    out: list[list[str]] = []
    for d in days:
        if out and gap(out[-1][1], d) <= max_gap:
            out[-1][1] = d
        else:
            out.append([d, d])
    return [tuple(r) for r in out]


def replay(series: dict[str, float], on_at: float, clear_at: float) -> list[str]:
    """Days the rule turns on, with hysteresis: on at >= on_at, stays on while >= clear_at."""
    starts, on = [], False
    for d in sorted(series):
        v = series[d]
        now = v >= on_at or (on and v >= clear_at)
        if now and not on:
            starts.append(d)
        on = now
    return starts


def active_days(series: dict[str, float], on_at: float, clear_at: float) -> set[str]:
    out, on = set(), False
    for d in sorted(series):
        v = series[d]
        on = v >= on_at or (on and v >= clear_at)
        if on:
            out.add(d)
    return out


def score(series, on_at, clear_at, events, period):
    lo, hi = period
    series = {d: v for d, v in series.items() if lo <= d <= hi}
    starts = replay(series, on_at, clear_at)
    act = active_days(series, on_at, clear_at)
    caught, leads = 0, []
    for first, last in events:
        window = [d for d in act if gap(d, first) <= LEAD_WINDOW and d <= last]
        if window:
            caught += 1
            leads.append(max(0, gap(min(window), first)))
    false = sum(1 for s in starts if not any(-LEAD_WINDOW <= gap(first, s) <= 0 or first <= s <= last
                                              for first, last in events))
    return {"alerts": len(starts), "caught": caught, "leads": leads, "false": false}


def honest_estimate(well, lj, sava) -> dict[str, float]:
    """Each year's estimate from a fit on every other year (leave one year out)."""
    first = min(well)
    start = (date.fromisoformat(first) - timedelta(days=estimate.WARMUP_DAYS)).isoformat()
    rows = estimate.feature_rows({"L": lj, "S": sava}, estimate.day_range(start, max(well)))
    measured = [d for d in sorted(well) if d in rows and d in lj and d in sava]
    out = {}
    for year in sorted({d[:4] for d in measured}):
        train = [d for d in measured if d[:4] != year]
        coef = estimate.fit([rows[d] for d in train], [well[d] for d in train])
        out.update({d: estimate.predict(coef, rows[d]) for d in measured if d[:4] == year})
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--store", type=Path, default=Path("store"))
    args = ap.parse_args()
    s = args.store
    lj_cm = load(s / RIVER / "daily.csv", "level")
    lj_q, sava_q = load(s / RIVER / "daily.csv", "flow"), load(s / SAVA / "daily.csv", "flow")
    well = load(s / ZALOG / "daily.csv", "level")
    ref = well[REFERENCE_DATE]
    est = honest_estimate(well, lj_q, sava_q)
    covered = sorted(d for d in est)
    period = (covered[0], covered[-1])
    years = gap(*period) / 365.25
    events = runs(sorted(d for d in well if period[0] <= d <= period[1] and well[d] >= ref - EVENT_BELOW_M))

    p = print
    p("# Alert backtest\n")
    p(f"Made by `scripts/backtest.py` from the daily record, {period[0]} to {period[1]} "
      f"({years:.1f} years with Zalog well data and both rivers).\n")
    p(f"**Events**: Zalog groundwater within {EVENT_BELOW_M:.2f} m of the reference level ({ref:.2f} m, {REFERENCE_DATE}), "
      f"i.e. at or above {ref - EVENT_BELOW_M:.2f} m:\n")
    for first, last in events:
        peak = max((v, d) for d, v in well.items() if first <= d <= last)
        p(f"- {first} to {last}: peak {peak[0]:.2f} m on {peak[1]}")
    p(f"\nA rule *catches* an event when it is on at some point from {LEAD_WINDOW} days before the event to its "
      f"last day. *Lead* is how many days before the event it turned on. A *false* alert has no event in the "
      f"{LEAD_WINDOW} days after it.\n")

    def table(title, series, rows, unit, current):
        p(f"## {title}\n")
        p(f"| On at | Clears at | Alerts | Per year | Caught | Lead (days) | False |")
        p(f"|---|---|---|---|---|---|---|")
        for on_at, clear_at, label in rows:
            r = score(series, on_at, clear_at, events, period)
            mark = " **(now)**" if current == (on_at, clear_at) else ""
            p(f"| {label[0]}{mark} | {label[1]} | {r['alerts']} | {r['alerts'] / years:.1f} | "
              f"{r['caught']} of {len(events)} | {', '.join(map(str, r['leads'])) or '–'} | {r['false']} |")
        p("")

    table("Ljubljanica high (Moste I, daily mean level)", lj_cm,
          [(v, v - 20, (f"{v} cm", f"{v - 20} cm")) for v in (180, 200, 220, 240, 260)], "cm",
          (WARN_CM, WARN_CLEAR_CM))
    rows = []
    for m in (0.3, 0.5, 0.7, 0.9, 1.1):
        c = m + (ZALOG_NEAR_CLEAR_M - ZALOG_NEAR_M)
        rows.append((ref - m, ref - c, (f"{m:.1f} m below", f"{c:.1f} m below")))
    table("Zalog estimate near the reference (estimated from the rivers, each year unseen by its fit)", est, rows, "m",
          (ref - ZALOG_NEAR_M, ref - ZALOG_NEAR_CLEAR_M))
    return 0


if __name__ == "__main__":
    sys.exit(main())
