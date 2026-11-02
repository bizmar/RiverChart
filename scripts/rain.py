"""Rain over the Ljubljanica and Sava catchments, from Open-Meteo (https://open-meteo.com, CC BY 4.0).

High groundwater at Zalog follows the rivers within about a day, and the rivers follow heavy rain over their
catchments. A rain forecast therefore gives the earliest warning: in the 2015-2026 backtest, a forecast of
70 mm or more over three days came 2-10 days before each of the three high-groundwater events at Zalog.

Rain is the mean of the two catchments, each the mean of a few points (daily totals in mm):

    rain/daily.csv      date,mm   past days (history imported once, then the last week refreshed every run)
    rain/forecast.csv   date,mm   today and the next days
"""

from __future__ import annotations

import json
from datetime import date, timedelta
from pathlib import Path

import arso

ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"
FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
SOURCE = "Open-Meteo (open-meteo.com), CC BY 4.0"
HISTORY_FROM = "2014-06-01"
FORECAST_DAYS = 4  # today + 3
PAST_DAYS = 7  # the archive lags a few days; the forecast API's past days fill that in

# Points over each catchment: (name, lat, lon, catchment).
POINTS = [
    ("Vrhnika", 45.96, 14.29, "Ljubljanica"),
    ("Cerknica", 45.79, 14.36, "Ljubljanica"),
    ("Ljubljana", 46.06, 14.51, "Ljubljanica"),
    ("Bohinj", 46.28, 13.89, "Sava"),
    ("Kamnik", 46.23, 14.61, "Sava"),
]


def query(url: str, **params) -> list[dict[str, float | None]]:
    """Daily precipitation for every point, as [{date: mm}] in POINTS order."""
    raw = arso.fetch(url, {
        "latitude": ",".join(str(p[1]) for p in POINTS),
        "longitude": ",".join(str(p[2]) for p in POINTS),
        "daily": "precipitation_sum",
        "timezone": "Europe/Ljubljana",
        **params,
    }, timeout=90)
    data = json.loads(raw)
    if isinstance(data, dict):  # one point comes back as an object, several as a list
        data = [data]
    return [dict(zip(d["daily"]["time"], d["daily"]["precipitation_sum"])) for d in data]


def combine(per_point: list[dict[str, float | None]]) -> dict[str, float]:
    """Mean of the catchment means, for days where every point has a value."""
    days = set.intersection(*(set(k for k, v in p.items() if v is not None) for p in per_point))
    out = {}
    for d in sorted(days):
        means = []
        for basin in dict.fromkeys(p[3] for p in POINTS):
            vals = [per_point[i][d] for i, p in enumerate(POINTS) if p[3] == basin]
            means.append(sum(vals) / len(vals))
        out[d] = round(sum(means) / len(means), 1)
    return out


def read(path: Path) -> dict[str, float]:
    if not path.exists():
        return {}
    lines = path.read_text().splitlines()[1:]
    return {d: float(v) for d, v in (line.split(",") for line in lines if line)}


def write(path: Path, rows: dict[str, float]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("date,mm\n" + "".join(f"{d},{v:.1f}\n" for d, v in sorted(rows.items())))


def update(root: Path, log, today: date | None = None) -> dict | None:
    """Refresh rain/daily.csv and rain/forecast.csv; return the entry for stations.json. Never raises."""
    today = today or date.today()
    folder = root / "rain"
    daily = read(folder / "daily.csv")
    log("rain - Ljubljanica and Sava catchments (Open-Meteo)")
    try:
        if not daily:
            end = (today - timedelta(days=PAST_DAYS)).isoformat()
            daily = combine(query(ARCHIVE_URL, start_date=HISTORY_FROM, end_date=end))
            log(f"    history: {len(daily)} days, {min(daily)} .. {max(daily)}")
        recent = combine(query(FORECAST_URL, past_days=PAST_DAYS, forecast_days=FORECAST_DAYS))
    except Exception as e:  # noqa: BLE001 - rain is an extra; keep the run going
        log(f"    failed: {e}")
        return None
    t = today.isoformat()
    daily.update({d: v for d, v in recent.items() if d < t})
    forecast = {d: v for d, v in recent.items() if d >= t}
    write(folder / "daily.csv", daily)
    write(folder / "forecast.csv", forecast)
    next3 = [forecast[d] for d in sorted(forecast)[:3]]
    entry = {
        "source": SOURCE,
        "points": [{"name": n, "lat": la, "lon": lo, "catchment": c} for n, la, lo, c in POINTS],
        "updated": t,
        "next3_mm": round(sum(next3), 1) if len(next3) == 3 else None,
        "forecast": [{"date": d, "mm": forecast[d]} for d in sorted(forecast)],
    }
    log(f"    forecast: {entry['next3_mm']} mm over the next 3 days")
    return entry
