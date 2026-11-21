# Zalog estimate: what else was tried (Nov 2026)

The estimate (`scripts/estimate.py`) is a least-squares mix of smoothed Ljubljanica and Sava flows. Each variant
below was scored leave-one-year-out on the VOKA SNAGA well (2015–2026): every year estimated by a fit that
never saw it. "High" is the days within 1 m of the reference level (46 days); the three peaks are
2017, August 2023 and November 2023.

| Inputs added to the current model | Error, all days | Error, high days | Peak errors (m) |
|---|---|---|---|
| none (current) | 0.154 m | 0.324 m | −0.30, −0.47, +0.30 |
| rain over the catchments, 7/30/90-day | 0.154 m | 0.300 m | |
| deep soil moisture (100–255 cm, ERA5) | 0.152 m | 0.302 m | |
| rain + soil moisture + ET0, everything | 0.153 m | 0.291 m | |
| log of the flows | 0.146 m | 0.289 m | −0.34, −0.64, −0.08 |
| flow above a high-water level | 0.152 m | 0.293 m | −0.29, −0.74, −0.12 |
| log + flow above high water | 0.140 m | 0.300 m | −0.27, −0.69, +0.02 |

None changes the picture: about 0.15 m on ordinary days, and still 0.3–0.7 m low at the sharpest peaks.
The river flows have given what they can. The warning margin (0.70 m below the reference) already allows for this.

## Update, 21 Nov 2026: the Hrastje well

ARSO's groundwater archive came back, with Hrastje (G85040) daily from 1973 to 2025. Same scoring:

| Inputs | Error, all days | Error, high days | Peak errors (m) |
|---|---|---|---|
| rivers (before) | 0.154 m | 0.323 m | −0.18, −0.47, +0.30 |
| Hrastje alone (1, 3, 10-day) | 0.128 m | 0.414 m | +0.03, +0.74, +0.23 |
| Hrastje 1 + rivers | 0.115 m | 0.359 m | −0.05, −0.20, +0.36 |
| **Hrastje 1, 3, 10, 30-day + rivers (now)** | **0.107 m** | **0.302 m** | **+0.14, +0.16, +0.17** |
| Hrastje 1, 3, 10, 30, 90-day + rivers | 0.105 m | 0.294 m | +0.12, +0.09, +0.16 |

The estimate now uses the bold row on days with a Hrastje reading. The peaks are no longer missed by up to
0.5 m: all three come out within 0.2 m, slightly high. The 90-day term adds little for one more input.

Still open: **newer P-1gl data from VOKA SNAGA** (the email to them) would extend the fit past June 2026.
