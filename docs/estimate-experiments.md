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

What would help is a second groundwater record with history on the same aquifer:

- **ARSO's Hrastje well (G85040)** history from ARSO's groundwater archive (`hidarhiv/pod_arhiv_tab.php`). Still
  "temporarily unavailable" on 8 Nov 2026. The Internet Archive has no copies of its tables (only 4 chart images).
  Once the archive is back, Hrastje's daily levels 2015–2026 could be fitted against Zalog, and the live Hrastje
  readings would then give a measured, not estimated, Zalog value.
- **Newer P-1gl data from VOKA SNAGA** (the email to them).
