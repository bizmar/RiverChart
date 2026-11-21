"""Estimate groundwater at Zalog after VOKA SNAGA's well data ends.

The Zalog well (P-1gl) follows the rivers: its daily level is close to a weighted mix of the
Ljubljanica's flow at Moste I and the Sava's flow at Šentjakob, smoothed over a few days to a
few months. This module fits that mix on the years where all three exist (plain least squares,
standard library only) and uses it to estimate the well's level for the days since its data ends.

On days with a reading from ARSO's Hrastje well (same aquifer, 4 km west), a second fit adds that
well's level: a measured groundwater level, so the estimate is closer, above all at the peaks
(leave-one-year-out 2015-2025: 0.11 m typical error instead of 0.15 m; the three high-water peaks
within 0.2 m instead of up to 0.5 m; docs/estimate-experiments.md). After Hrastje's last reading
(it often arrives a day late), the river fit carries on with the last difference, fading out.

The model is refitted on every run, so it improves on its own if newer well data is imported.
"""

from __future__ import annotations

import math
from datetime import date, timedelta

# (series, smoothing in days) for each input. "L" = Ljubljanica flow, "S" = Sava flow.
# Several time scales let the fit learn both the fast response to a flood and the slow seasonal level.
FEATURES = [("L", 1), ("L", 3), ("L", 10), ("L", 30), ("L", 90), ("S", 3), ("S", 30)]
# With the Hrastje well ("H", m a.s.l.) as well.
WELL_FEATURES = [("H", 1), ("H", 3), ("H", 10), ("H", 30)] + FEATURES
# After Hrastje's last reading, its correction to the river fit fades with this time constant (days).
FADE_DAYS = 7
# Days of river data before the first well day, so the slowest average has settled.
WARMUP_DAYS = 180
# The last this-many days of well data are held back once to measure the error on unseen days.
TEST_DAYS = 3 * 365


def day_range(first: str, last: str) -> list[str]:
    a, b = date.fromisoformat(first), date.fromisoformat(last)
    return [(a + timedelta(days=i)).isoformat() for i in range((b - a).days + 1)]


def interpolated(series: dict[str, float], days: list[str]) -> dict[str, float]:
    """`series` with gaps between known days filled by a straight line (nothing before the first or after the last)."""
    known = [d for d in days if d in series]
    out = dict((d, series[d]) for d in known)
    index = {d: i for i, d in enumerate(days)}
    for a, b in zip(known, known[1:]):
        ia, ib = index[a], index[b]
        for i in range(ia + 1, ib):
            out[days[i]] = series[a] + (series[b] - series[a]) * (i - ia) / (ib - ia)
    return out


def smoothed(series: dict[str, float], days: list[str], tau: float) -> dict[str, float]:
    """Exponential moving average over `days`. Missing days keep the previous value."""
    out, v = {}, None
    for d in days:
        x = series.get(d, v)
        if x is None:
            continue
        v = x if v is None else v + (x - v) / tau
        out[d] = v
    return out


def feature_rows(inputs: dict[str, dict[str, float]], days: list[str], features=FEATURES) -> dict[str, list[float]]:
    """{day: [1, f1, f2, ...]} for every day where all inputs are known.

    Gaps in an input are bridged by a straight line first, so the slow averages keep moving through them.
    """
    filled = {name: interpolated(inputs[name], days) for name in {n for n, _ in features}}
    cols = [smoothed(filled[name], days, tau) for name, tau in features]
    return {d: [1.0] + [c[d] for c in cols] for d in days if all(d in c for c in cols)}


def solve(a: list[list[float]], b: list[float]) -> list[float]:
    """Solve a·x = b by Gaussian elimination with partial pivoting."""
    n = len(b)
    m = [row[:] + [b[i]] for i, row in enumerate(a)]
    for c in range(n):
        p = max(range(c, n), key=lambda r: abs(m[r][c]))
        if abs(m[p][c]) < 1e-12:
            raise ValueError("singular system")
        m[c], m[p] = m[p], m[c]
        for r in range(c + 1, n):
            f = m[r][c] / m[c][c]
            for k in range(c, n + 1):
                m[r][k] -= f * m[c][k]
    x = [0.0] * n
    for r in range(n - 1, -1, -1):
        x[r] = (m[r][n] - sum(m[r][k] * x[k] for k in range(r + 1, n))) / m[r][r]
    return x


def fit(xs: list[list[float]], ys: list[float]) -> list[float]:
    """Least-squares coefficients, via the normal equations on standardised columns."""
    n, k = len(xs), len(xs[0])
    mean = [sum(x[j] for x in xs) / n for j in range(k)]
    sd = [math.sqrt(sum((x[j] - mean[j]) ** 2 for x in xs) / n) or 1.0 for j in range(k)]
    z = [[1.0] + [(x[j] - mean[j]) / sd[j] for j in range(1, k)] for x in xs]
    ata = [[sum(r[i] * r[j] for r in z) for j in range(k)] for i in range(k)]
    aty = [sum(r[i] * y for r, y in zip(z, ys)) for i in range(k)]
    w = solve(ata, aty)
    # Back to coefficients on the raw columns.
    coef = [w[0] - sum(w[j] * mean[j] / sd[j] for j in range(1, k))] + [w[j] / sd[j] for j in range(1, k)]
    return coef


def predict(coef: list[float], x: list[float]) -> float:
    return sum(c * v for c, v in zip(coef, x))


def rmse(coef: list[float], xs: list[list[float]], ys: list[float]) -> float:
    return math.sqrt(sum((predict(coef, x) - y) ** 2 for x, y in zip(xs, ys)) / len(ys))


def held_out_fit(rows: dict[str, list[float]], well: dict[str, float], train: list[str]) -> tuple[list[float], float]:
    """Coefficients fitted on all of `train`, and the error on the last TEST_DAYS of a fit that did not see them."""
    cut = train[-TEST_DAYS]
    early, late = [d for d in train if d < cut], [d for d in train if d >= cut]
    trial = fit([rows[d] for d in early], [well[d] for d in early])
    test_rmse = rmse(trial, [rows[d] for d in late], [well[d] for d in late])
    return fit([rows[d] for d in train], [well[d] for d in train]), test_rmse


def estimate(well: dict[str, float], ljubljanica: dict[str, float], sava: dict[str, float], today: str,
             hrastje: dict[str, float] | None = None) -> dict | None:
    """Fit the model and estimate the well from the day after its last reading up to `today`.

    Each argument is {YYYY-MM-DD: value}: well levels in m a.s.l., river flows in m³/s.
    Returns {"days": [(day, value)], "rmse": m, "fit_rmse": m, "fit": [first, last], "hrastje": {...} or None}.
    "rmse" is the typical error of the newest day: the Hrastje fit's while its correction still counts.
    """
    if not well or not ljubljanica or not sava:
        return None
    first_well, last_well = min(well), max(well)
    start = (date.fromisoformat(first_well) - timedelta(days=WARMUP_DAYS)).isoformat()
    span = day_range(start, today)
    rows = feature_rows({"L": ljubljanica, "S": sava}, span)
    # Fit and estimate only on days with real readings of both rivers, never on bridged gaps.
    measured = {d for d in rows if d in ljubljanica and d in sava}
    train = sorted(d for d in well if d in measured)
    if len(train) < 2 * TEST_DAYS:
        return None
    coef, test_rmse = held_out_fit(rows, well, train)
    river = {d: predict(coef, rows[d]) for d in measured if d > last_well}

    # The Hrastje fit, on days with a real Hrastje reading.
    with_h, h_info = {}, None
    if hrastje:
        rows_h = feature_rows({"L": ljubljanica, "S": sava, "H": hrastje}, span, WELL_FEATURES)
        train_h = [d for d in train if d in rows_h and d in hrastje]
        if len(train_h) >= 2 * TEST_DAYS:
            coef_h, test_rmse_h = held_out_fit(rows_h, well, train_h)
            with_h = {d: predict(coef_h, rows_h[d]) for d in river if d in rows_h and d in hrastje}
            h_info = {"rmse": round(test_rmse_h, 2), "fit": [train_h[0], train_h[-1]]}

    out, offset, since = [], 0.0, None
    for d in sorted(river):
        if d in with_h:
            offset, since = with_h[d] - river[d], d
            v = with_h[d]
        else:
            fade = math.exp(-(date.fromisoformat(d) - date.fromisoformat(since)).days / FADE_DAYS) if since else 0.0
            v = river[d] + offset * fade
        out.append((d, round(v, 2)))
    newest_uses_h = bool(out and since and (date.fromisoformat(out[-1][0]) - date.fromisoformat(since)).days <= FADE_DAYS)
    if h_info:
        h_info.update({"days": len(with_h), "last": since})
    return {
        "days": out,
        "rmse": h_info["rmse"] if newest_uses_h else round(test_rmse, 2),
        "rmse_rivers": round(test_rmse, 2),
        "fit_rmse": round(rmse(coef, [rows[d] for d in train], [well[d] for d in train]), 2),
        "fit": [train[0], train[-1]],
        "hrastje": h_info,
    }
