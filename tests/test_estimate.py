"""Tests for the Zalog groundwater estimate. Run: python -m unittest discover tests"""

import math
import sys
import unittest
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import estimate  # noqa: E402


def days(n, start="2015-01-01"):
    a = date.fromisoformat(start)
    return [(a + timedelta(days=i)).isoformat() for i in range(n)]


class EstimateTests(unittest.TestCase):
    def test_solve(self):
        self.assertEqual([round(v, 9) for v in estimate.solve([[0, 2], [3, 1]], [4, 5])], [1, 2])

    def test_fit_recovers_known_coefficients(self):
        xs = [[1.0, i, (i * 7) % 11] for i in range(50)]
        ys = [3 + 0.5 * a - 2 * b for _, a, b in xs]
        self.assertEqual([round(c, 6) for c in estimate.fit(xs, ys)], [3, 0.5, -2])

    def test_smoothed_carries_over_gaps(self):
        d = days(4)
        out = estimate.smoothed({d[0]: 0.0, d[1]: 10.0}, d, 2)
        self.assertEqual(out, {d[0]: 0.0, d[1]: 5.0, d[2]: 5.0, d[3]: 5.0})  # a gap holds the average

    def test_estimate_follows_the_rivers_after_the_well_ends(self):
        # Synthetic rivers with a yearly cycle and floods; the well is a known mix of them.
        span = days(8 * 365)
        lj = {d: 50 + 40 * math.sin(i / 58) + (200 if i % 97 < 3 else 0) for i, d in enumerate(span)}
        sava = {d: 200 + 150 * math.cos(i / 41) for i, d in enumerate(span)}
        rows = estimate.feature_rows({"L": lj, "S": sava}, span)
        truth = {d: 263 + 0.004 * x[2] + 0.003 * x[4] + 0.002 * x[7] for d, x in rows.items()}
        well_end = span[-60]
        well = {d: v for d, v in truth.items() if d <= well_end and d >= span[estimate.WARMUP_DAYS]}

        r = estimate.estimate(well, lj, sava, today=span[-1])
        self.assertEqual(r["days"][0][0], span[-59])
        self.assertEqual(r["days"][-1][0], span[-1])
        self.assertEqual(len(r["days"]), 59)
        self.assertLess(r["rmse"], 0.02)
        for d, v in r["days"]:
            self.assertAlmostEqual(v, truth[d], delta=0.02)

    def test_too_little_well_data(self):
        span = days(400)
        lj = {d: 50.0 + i % 9 for i, d in enumerate(span)}
        self.assertIsNone(estimate.estimate({span[-1]: 263.0}, lj, lj, span[-1]))
        self.assertIsNone(estimate.estimate({}, lj, lj, span[-1]))


if __name__ == "__main__":
    unittest.main()
