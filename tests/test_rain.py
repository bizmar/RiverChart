"""Tests for the rain forecast. Run: python -m unittest discover tests"""

import json
import sys
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path
from unittest import mock
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import rain  # noqa: E402

TODAY = date(2026, 11, 6)


def fake_fetch(calls):
    """Open-Meteo stand-in: point i gets i mm every day (so the catchment means are known)."""
    def fetch(url, params=None, **kw):
        calls.append((url, params))
        if "archive" in url:
            a, b = date.fromisoformat(params["start_date"]), date.fromisoformat(params["end_date"])
        else:
            a, b = TODAY - timedelta(days=params["past_days"]), TODAY + timedelta(days=params["forecast_days"] - 1)
        days = [(a + timedelta(days=i)).isoformat() for i in range((b - a).days + 1)]
        n = len(params["latitude"].split(","))
        return json.dumps([{"daily": {"time": days, "precipitation_sum": [float(i)] * len(days)}} for i in range(n)]).encode()
    return fetch


class RainTests(unittest.TestCase):
    def test_combine_averages_the_catchments(self):
        # Ljubljanica points 0,1,2 -> mean 1; Sava points 3,4 -> mean 3.5; overall 2.25
        per = [{"2026-11-06": float(i)} for i in range(5)]
        self.assertEqual(rain.combine(per), {"2026-11-06": 2.2})  # rounded to 0.1 (2.25 -> 2.2)

    def test_combine_skips_days_with_missing_points(self):
        per = [{"a": 1.0, "b": 1.0}] * 4 + [{"a": 1.0, "b": None}]
        self.assertEqual(rain.combine(per), {"a": 1.0})

    def test_update_imports_history_once_then_refreshes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root, calls = Path(tmp), []
            with mock.patch.object(rain.arso, "fetch", fake_fetch(calls)):
                entry = rain.update(root, lambda *a: None, TODAY)
                self.assertEqual([("archive" in u) for u, _ in calls], [True, False])
                daily = rain.read(root / "rain" / "daily.csv")
                self.assertEqual(min(daily), rain.HISTORY_FROM)
                self.assertEqual(max(daily), "2026-11-05")
                self.assertEqual(sorted(rain.read(root / "rain" / "forecast.csv")), ["2026-11-06", "2026-11-07", "2026-11-08", "2026-11-09"])
                self.assertEqual(entry["next3_mm"], 6.6)
                self.assertEqual(entry["updated"], "2026-11-06")
                calls.clear()
                rain.update(root, lambda *a: None, TODAY)
                self.assertEqual([("archive" in u) for u, _ in calls], [False])

    def test_failure_returns_none(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(rain.arso, "fetch", side_effect=RuntimeError("down")):
            self.assertIsNone(rain.update(Path(tmp), lambda *a: None, TODAY))


if __name__ == "__main__":
    unittest.main()
