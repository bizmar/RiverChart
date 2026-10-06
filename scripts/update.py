#!/usr/bin/env python3
"""Fetch the latest ARSO river data for every automatic station and add it to the data store.

The store is a plain folder of CSV/JSON files that the dashboard reads directly:

    stations.json              every ARSO station with its latest reading, nearest to home first
    <id>/meta.json             what is stored for a station
    <id>/daily.csv             one row per day (validated archive + daily means of live data)
    <id>/live/<YYYY-MM>.csv    measured readings, times in UTC (10 min apart for the last
                               week, one per hour before that)

Run regularly (GitHub Actions does it every 30 minutes):

    python scripts/update.py --store store

New stations get their live data straight away. The long daily archive is fetched station by
station, nearest to home first, until --budget minutes are used up; the next run carries on.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import sys
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import arso

# Zalog, Ljubljana - where the Ljubljanica flows into the Sava.
HOME = {"name": "Zalog", "lat": 46.0700, "lon": 14.6150}
# Shown when a visitor has not chosen a place: Ljubljanica at Moste I, the last gauge before Zalog.
DEFAULT_STATION = "5078"
# Stations are processed this many at a time (ARSO is a public server, so keep it small).
WORKERS = 3
# Live readings older than this keep one reading per hour; the newest week stays at full resolution.
THIN_AFTER_DAYS = 7

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

    def last_reading(self) -> datetime | None:
        months = self.live_months()
        if not months:
            return None
        times = list(self.month(months[-1]))
        return parse_iso(max(times)) if times else None

    def live_months(self) -> list[str]:
        d = self.dir / "live"
        on_disk = {p.stem for p in d.glob("*.csv")} if d.exists() else set()
        return sorted(on_disk | {m for m, rows in self._months.items() if rows})

    def thin(self, now: datetime, keep_days: int = THIN_AFTER_DAYS) -> None:
        """Keep one reading per hour for live data older than keep_days, so the store stays small."""
        cutoff = iso(now - timedelta(days=keep_days))
        # Anything older than two months was thinned by an earlier run.
        first_month = iso(now - timedelta(days=60))[:7]
        for month_key in self.live_months():
            if month_key < first_month:
                continue
            rows = self.month(month_key)
            by_hour: dict[str, list[str]] = defaultdict(list)
            for key in rows:
                if key < cutoff:
                    by_hour[key[:13]].append(key)
            for keys in by_hour.values():
                if len(keys) > 1:
                    keep = min(keys, key=lambda k: k[14:16])  # the reading nearest the full hour
                    for k in keys:
                        if k != keep:
                            del rows[k]
                            self.touched_months.add(month_key)

    def has_data(self) -> bool:
        return bool(self.daily()) or bool(self.live_months())

    def meta(self) -> dict:
        path = self.dir / "meta.json"
        return json.loads(path.read_text()) if path.exists() else {}

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
    def save(self, station: dict, archive_done: bool) -> None:
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
            "archive_done": archive_done,
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


def process_station(st: dict, args, deadline: float) -> tuple[bool, int, list[str]]:
    """Update one station. Returns (has_data, table_failures, log_lines)."""
    lines: list[str] = []
    out = lines.append
    out(f"{st['id']} {st['river']} - {st['place']} ({st['dist_km']} km)")
    store = StationStore(args.store, st["id"])
    meta = store.meta()
    archive_done = bool(meta.get("archive_done") or meta.get("archive_to"))
    failures = 0
    try:
        readings = []
        if st["time"] and st["values"]:
            readings.append((st["time"], st["values"]))
        # The 1-day table covers a normal run; after a gap (or for a new station) take 30 days.
        last = store.last_reading()
        days = 1 if last and datetime.now(timezone.utc) - last < timedelta(hours=20) else 30
        try:
            table = arso.fetch_station_table(st["id"], days)
            if args.debug and table:
                out(f"    table sample: {table[0]} ... {table[-1]}")
            readings += table
            out(f"    {days}-day table: {len(table)} readings")
        except Exception as e:  # noqa: BLE001
            failures += 1
            out(f"    {days}-day table failed: {e}")
        out(f"    {store.add_live(readings)} new/changed readings")

        if not archive_done or args.archive != "missing":
            if time.monotonic() < deadline:
                backfill_archive(store, st, {"missing": None, "full": None, "recent": 3}[args.archive], out)
                archive_done = True
            else:
                out("    daily archive: time budget used up, continues next run")
        store.recompute_daily_means()
        store.thin(datetime.now(timezone.utc))
        store.save(st, archive_done)
    except Exception as e:  # noqa: BLE001 - one broken station must not stop the rest
        failures += 1
        out(f"    FAILED: {type(e).__name__}: {e}")
    return store.has_data(), failures, lines


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--store", type=Path, default=Path("store"), help="data folder (default: ./store)")
    ap.add_argument("--archive", choices=["missing", "recent", "full"], default="missing",
                    help="daily archive: only where missing (default), re-check last 3 years, or everything")
    ap.add_argument("--budget", type=float, default=50, metavar="MIN",
                    help="stop starting new daily-archive downloads after this many minutes (default 50)")
    ap.add_argument("--debug", action="store_true", help="print samples of the raw ARSO responses")
    args = ap.parse_args()
    log = lambda *a: print(*a, flush=True)  # noqa: E731
    deadline = time.monotonic() + args.budget * 60

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
    # Nearest to home first, so the stations people look at most get their history first.
    stations.sort(key=lambda s: (s["dist_km"] is None, s["dist_km"] or 0))

    failures = 0
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        for st, (has_data, failed, lines) in zip(stations, pool.map(lambda s: process_station(s, args, deadline), stations)):
            st["tracked"] = has_data
            failures += failed
            for line in lines:
                log(line)

    write_json(args.store / "stations.json", {
        "generated": iso(datetime.now(timezone.utc)),
        "home": HOME,
        "default": DEFAULT_STATION,
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
    log(f"Done: {tracked} of {len(stations)} stations have data, {failures} failures")
    # Fail only if every station failed (ARSO down or format changed); the site keeps the previous data.
    return 1 if failures >= len(stations) else 0


if __name__ == "__main__":
    sys.exit(main())
