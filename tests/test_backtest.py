"""Tests for the alert backtest. Run: python -m unittest discover tests"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import backtest  # noqa: E402


def day(n):
    return f"2020-01-{n:02d}"


class BacktestTests(unittest.TestCase):
    def test_runs_join_short_gaps(self):
        self.assertEqual(backtest.runs([day(1), day(2), day(5), day(10)]), [(day(1), day(5)), (day(10), day(10))])

    def test_replay_has_hysteresis(self):
        series = {day(i + 1): v for i, v in enumerate([1, 5, 3, 5, 1, 5])}
        self.assertEqual(backtest.replay(series, 5, 3), [day(2), day(6)])

    def test_score_counts_caught_lead_and_false(self):
        series = {day(i + 1): v for i, v in enumerate([0, 9, 9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 9, 0, 0])}
        events = [(day(4), day(5))]
        r = backtest.score(series, 9, 5, events, (day(1), day(23)))
        self.assertEqual(r, {"alerts": 2, "caught": 1, "leads": [2], "false": 1})


if __name__ == "__main__":
    unittest.main()
