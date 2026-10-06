#!/usr/bin/env python3
"""Generate fake data in the store format, for working on the dashboard offline.

    python scripts/make_sample_data.py site/data
    python -m http.server -d site 8000      # then open http://localhost:8000

The numbers are invented; they only look roughly like a river.
"""

import json
import math
import random
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

STATIONS = [
    # id, river, place, lat, lon, dist from Zalog (km), tracked, level base, flow base, flow class
    ("3570", "Sava", "Šentjakob", 46.0789, 14.6131, 1.0, True, 95, 80, "srednji pretok"),
    ("5078", "Ljubljanica", "Moste I", 46.0569, 14.5583, 4.6, True, 150, 45, "srednji pretok"),
    ("4270", "Kamniška Bistrica", "Vir", 46.1530, 14.6010, 9.3, True, 60, 12, "mali pretok"),
    ("3530", "Sava", "Medno", 46.1230, 14.4400, 14.8, True, 110, 90, "velik pretok"),
    ("5040", "Ljubljanica", "Kamin", 45.9880, 14.4280, 17.0, True, 210, 40, "prvi visokovodni pretok"),
    ("4200", "Drava", "Maribor", 46.5598, 15.6358, 115, True, 130, 280, "srednji pretok"),
    ("1060", "Mura", "Gornja Radgona", 46.6800, 15.9900, 140, True, 180, 150, "mali pretok"),
    ("8060", "Soča", "Solkan", 45.9600, 13.6420, 80, True, 230, 110, "srednji pretok"),
    ("5640", "Savinja", "Celje", 46.2330, 15.2680, 60, True, 90, 40, "mali pretok"),
    ("9990", "Brez", "Brez podatkov", 46.3000, 14.2000, 40, False, 0, 0, ""),
]


def level_at(t: datetime, base: float, rng: random.Random, floods: list) -> float:
    doy = t.timetuple().tm_yday
    seasonal = 25 * math.cos((doy - 330) / 365 * 2 * math.pi) + 10 * math.cos((doy - 120) / 365 * 4 * math.pi)
    flood = sum(h * math.exp(-max(0.0, (t - s).total_seconds()) / 86400 / d) for s, h, d in floods if t >= s)
    return base + seasonal + flood + rng.gauss(0, 1.5)


def main(out: Path) -> None:
    rng = random.Random(4)
    now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    start = datetime(1991, 1, 1, tzinfo=timezone.utc)
    floods = []
    t = start
    while t < now:
        t += timedelta(days=rng.expovariate(1 / 25))
        floods.append((t, rng.expovariate(1 / 45), rng.uniform(1.5, 6)))

    catalogue = []
    for sid, river, place, lat, lon, dist, tracked, base, flow, cls in STATIONS:
        catalogue.append({"id": sid, "river": river, "place": place, "lat": lat, "lon": lon, "dist_km": dist,
                          "tracked": tracked, "time": now.strftime("%Y-%m-%dT%H:%MZ"),
                          "level": base if tracked else None, "flow": flow if tracked else None,
                          "temp": 12.4 if tracked else None, "flow_class": cls or None})
        if not tracked:
            continue
        d = out / sid
        (d / "live").mkdir(parents=True, exist_ok=True)
        live_start = now - timedelta(days=75)
        rows = ["date,level,flow,temp,src"]
        day = start
        while day < now:
            lvl = level_at(day + timedelta(hours=12), base, rng, floods)
            src = "a" if day < datetime(now.year - 1, 1, 1, tzinfo=timezone.utc) else "m"
            temp = 11 - 7 * math.cos((day.timetuple().tm_yday - 20) / 365 * 2 * math.pi)
            rows.append(f"{day:%Y-%m-%d},{lvl:.0f},{flow * (lvl / base) ** 2:.2f},{temp:.1f},{src}")
            day += timedelta(days=1)
        (d / "daily.csv").write_text("\n".join(rows) + "\n")

        months = {}
        t = live_start
        while t <= now:
            lvl = level_at(t, base, rng, floods)
            temp = 11 - 7 * math.cos((t.timetuple().tm_yday - 20) / 365 * 2 * math.pi) + 1.2 * math.sin(t.hour / 24 * 2 * math.pi)
            months.setdefault(f"{t:%Y-%m}", []).append(f"{t:%Y-%m-%dT%H:%MZ},{lvl:.0f},{flow * (lvl / base) ** 2:.2f},{temp:.1f}")
            t += timedelta(minutes=30)
        for m, lines in months.items():
            (d / "live" / f"{m}.csv").write_text("time,level,flow,temp\n" + "\n".join(lines) + "\n")
        catalogue[-1]["level"] = float(lines[-1].split(",")[1])
        (d / "meta.json").write_text(json.dumps({"id": sid, "river": river, "place": place,
                                                 "live_months": sorted(months), "daily_from": "1991-01-01"}))

    (out / "stations.json").write_text(json.dumps({
        "generated": now.strftime("%Y-%m-%dT%H:%MZ"), "home": {"name": "Zalog", "lat": 46.07, "lon": 14.615},
        "default": "5078", "radius_km": 10, "stations": catalogue}, ensure_ascii=False, indent=1))
    print(f"Sample data written to {out}")


if __name__ == "__main__":
    main(Path(sys.argv[1] if len(sys.argv) > 1 else "site/data"))
