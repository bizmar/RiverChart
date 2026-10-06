#!/usr/bin/env python3
"""Fetch the latest ARSO river data for stations around Zalog and add it to the data store.

The store is a plain folder of CSV/JSON files that the dashboard reads directly:

    stations.json              every ARSO station with its latest reading, sorted by distance
    <id>/meta.json             what is stored for a tracked station
    <id>/daily.csv             one row per day (validated archive + daily means of live data)
    <id>/live/<YYYY-MM>.csv    half-hourly readings, times in UTC

Run regularly (GitHub Actions does it every 30 minutes):

    python scripts/update.py --store store

New stations are back-filled automatically (30-day table + full daily archive).
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import sys
import time
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import arso

# Zalog, Ljubljana - where the Ljubljanica flows into the Sava.
HOME = {"name": "Zalog", "lat": 46.0700, "lon": 14.6150}
# Stations within this distance get their full history stored.
RADIUS_KM = 10
# Always tracked, whatever the radius: Ljubljanica at Moste I, the last gauge before Zalog.
ALWAYS_TRACK = {"5078"}
DEFAULT_STATION = "5078"

DIGITS = {"level": 1, "flow": 3, "temp": 1}


# --------------------------------------------------------------------------- helpers

def distance_km(lat1, lon1, lat2, lon2) -> float:
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def fmt(value: float | None, field: str) -> str:
    if value is None:
        return ""
    s = f"{value:.{DIGITS[field]}f}"
    return s.rstrip("0").rstrip(".") if "." in s else s


def iso(t: datetime) -> str:
    return t.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%MZ")


def parse_iso(s: str) -> datetime:
    return datetime.strptime(s, "%Y-%m-%dT%H:%MZ").replace(tzinfo=timezone.utc)


def read_table(path: Path) -> dict[str, dict[str, str]]:
    """Read a CSV keyed by its first column."""
    if not path.exists():
        return {}
    with path.open(newline="") as f:
        reader = csv.DictReader(f)
        key = reader.fieldnames[0]
        return {row[key]: row for row in reader}


def write_table(path: Path, columns: list[str], rows: dict[str, dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    with tmp.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=columns, extrasaction="ignore", lineterminator="\n")
        w.writeheader()
        for k in sorted(rows):
            w.writerow(rows[k])
    tmp.replace(path)


def write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n")


# --------------------------------------------------------------------------- store

LIVE_COLUMNS = ["time", "level", "flow", "temp"]
DAILY_COLUMNS = ["date", "level", "flow", "temp", "src"]  # src: a = ARSO archive, m = mean of live data


class StationStore:
    def __init__(self, root: Path, station_id: str):
        self.id = station_id
        self.dir = root / station_id
        self._months: dict[str, dict] = {}
        self.touched_months: set[str] = set()
        self.touched_days: set[date] = set()

    # live -----------------------------------------------------------------
    def month(self, key: str) -> dict[str, dict[str, str]]:
        if key not in self._months:
            self._months[key] = read_table(self.dir / "live" / f"{key}.csv")
        return self._months[key]

    def add_live(self, readings: list[tuple[datetime, dict]]) -> int:
        added = 0
        for t, values in readings:
            key = iso(t)
            month = self.month(key[:7])
            is_new = key not in month
            row = month.setdefault(key, {"time": key})
            changed = is_new or any(row.get(f) != fmt(v, f) for f, v in values.items())
            for f, v in values.items():
                row[f] = fmt(v, f)
            if changed:
                added += 1
                self.touched_months.add(key[:7])
                self.touched_days.add(t.astimezone(arso.LOCAL_TZ).date())
        return added

    def live_months(self) -> list[str]:
        d = self.dir / "live"
        return sorted(p.stem for p in d.glob("*.csv")) if d.exists() else []

    # daily ----------------------------------------------------------------
    def daily(self) -> dict[str, dict[str, str]]:
        if not hasattr(self, "_daily"):
            self._daily = read_table(self.dir / "daily.csv")
        return self._daily

    def add_archive(self, rows: list[tuple[date, dict]]) -> None:
        daily = self.daily()
        for d, values in rows:
            daily[d.isoformat()] = {"date": d.isoformat(), "src": "a", **{f: fmt(v, f) for f, v in values.items()}}

    def recompute_daily_means(self) -> None:
        """Turn live readings into daily means for days the archive does not cover yet."""
        daily = self.daily()
        for day in sorted(self.touched_days):
            key = day.isoformat()
            if daily.get(key, {}).get("src") == "a":
                continue
            start = datetime(day.year, day.month, day.day, tzinfo=arso.LOCAL_TZ).astimezone(timezone.utc)
            end = (datetime(day.year, day.month, day.day, tzinfo=arso.LOCAL_TZ) + timedelta(days=1)).astimezone(timezone.utc)
            sums, counts = defaultdict(float), defaultdict(int)
            for month_key in {iso(start)[:7], iso(end)[:7]}:
                for k, row in self.month(month_key).items():
                    if iso(start) <= k < iso(end):
                        for f in arso.FIELDS:
                            if row.get(f):
                                sums[f] += float(row[f])
                                counts[f] += 1
            if counts:
                daily[key] = {"date": key, "src": "m", **{f: fmt(sums[f] / counts[f], f) for f in counts}}

    # save -----------------------------------------------------------------
    def save(self, station: dict) -> None:
        for key in self.touched_months:
            write_table(self.dir / "live" / f"{key}.csv", LIVE_COLUMNS, self._months[key])
        if hasattr(self, "_daily"):
            write_table(self.dir / "daily.csv", DAILY_COLUMNS, self._daily)
        daily = sorted(self.daily())
        archive_days = [k for k, r in self.daily().items() if r.get("src") == "a"]
        write_json(self.dir / "meta.json", {
            "id": self.id,
            "river": station["river"],
            "place": station["place"],
            "live_months": self.live_months(),
            "daily_from": daily[0] if daily else None,
            "daily_to": daily[-1] if daily else None,
            "archive_to": max(archive_days) if archive_days else None,
            "updated": iso(datetime.now(timezone.utc)),
        })


# --------------------------------------------------------------------------- jobs

def backfill_archive(store: StationStore, station: dict, years: int | None, log) -> None:
    """Pull the validated daily archive, newest year first.

    years=None walks back until the record runs out; otherwise only the last N years.
    """
    this_year = datetime.now().year
    found, empty_streak, year = False, 0, this_year
    while year >= 1900:
        try:
            rows = arso.fetch_archive_year(station["river"], station["id"], year)
        except Exception as e:  # noqa: BLE001 - keep going, the archive is a bonus
            log(f"    archive {year}: {e}")
            rows = []
        if rows:
            store.add_archive(rows)
            found, empty_streak = True, 0
            log(f"    archive {year}: {len(rows)} days")
        else:
            empty_streak += 1
        year -= 1
        if years is not None and year <= this_year - years:
            break
        if (found and empty_streak >= 3) or (not found and empty_streak >= 8):
            break
        time.sleep(0.5)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--store", type=Path, default=Path("store"), help="data folder (default: ./store)")
    ap.add_argument("--archive", choices=["missing", "recent", "full"], default="missing",
                    help="daily archive: only for new stations (default), re-check last 3 years, or everything")
    ap.add_argument("--debug", action="store_true", help="print samples of the raw ARSO responses")
    args = ap.parse_args()
    log = lambda *a: print(*a, flush=True)  # noqa: E731

    raw = arso.fetch(arso.XML_URL)
    if args.debug:
        log("--- XML sample ---\n" + arso.decode(raw)[:1500] + "\n---")
    stations = arso.parse_latest_xml(raw)
    if not stations:
        log("No stations in the ARSO XML - format change?")
        return 1
    log(f"{len(stations)} stations in the latest ARSO data")

    for st in stations:
        st["dist_km"] = (
            round(distance_km(HOME["lat"], HOME["lon"], st["lat"], st["lon"]), 2)
            if st["lat"] is not None and st["lon"] is not None else None
        )
        st["tracked"] = st["id"] in ALWAYS_TRACK or (st["dist_km"] is not None and st["dist_km"] <= RADIUS_KM)
    stations.sort(key=lambda s: (s["dist_km"] is None, s["dist_km"] or 0))

    failures = 0
    for st in (s for s in stations if s["tracked"]):
        log(f"{st['id']} {st['river']} - {st['place']} ({st['dist_km']} km)")
        store = StationStore(args.store, st["id"])
        needs_archive = not (store.dir / "daily.csv").exists()

        readings = []
        if st["time"] and st["values"]:
            readings.append((st["time"], st["values"]))
        days = 1 if store.live_months() else 30
        try:
            table = arso.fetch_station_table(st["id"], days)
            if args.debug and table:
                log(f"    table sample: {table[0]} ... {table[-1]}")
            readings += table
            log(f"    {days}-day table: {len(table)} readings")
        except Exception as e:  # noqa: BLE001
            failures += 1
            log(f"    {days}-day table failed: {e}")
        log(f"    {store.add_live(readings)} new/changed readings")

        if needs_archive or args.archive != "missing":
            backfill_archive(store, st, {"missing": None, "full": None, "recent": 3}[args.archive], log)
        store.recompute_daily_means()
        store.save(st)

    write_json(args.store / "stations.json", {
        "generated": iso(datetime.now(timezone.utc)),
        "home": HOME,
        "default": DEFAULT_STATION,
        "radius_km": RADIUS_KM,
        "stations": [
            {
                "id": s["id"],
                "river": s["river"],
                "place": s["place"],
                "lat": s["lat"],
                "lon": s["lon"],
                "dist_km": s["dist_km"],
                "tracked": s["tracked"],
                "time": iso(s["time"]) if s["time"] else None,
                **{f: s["values"].get(f) for f in arso.FIELDS},
                **s["classes"],
                **({"thresholds": s["thresholds"]} if s["thresholds"] else {}),
            }
            for s in stations
        ],
    })
    tracked = sum(s["tracked"] for s in stations)
    log(f"Done: {tracked} tracked stations, {failures} table failures")
    # Fail only if every station table failed (ARSO down or format changed).
    return 1 if tracked and failures == tracked else 0


if __name__ == "__main__":
    sys.exit(main())
