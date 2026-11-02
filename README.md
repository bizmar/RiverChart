# RiverChart

**Live and historic river levels where the Ljubljanica meets the Sava, at Zalog (Ljubljana).**

ARSO's station pages only show a static 30-day picture. This dashboard has:

- the current water level, flow and water temperature, with the change over the last 24 hours and ARSO's own status (normal / high / flood stage)
- an **interactive chart**: zoom with the scroll wheel or a pinch, drag to pan, or jump to 2 days … 10 years … the whole record
- **groundwater** (the **Ground** button): around Zalog, cellars flood from rising groundwater rather than from the river itself. Two charts:
  - **Zalog**: VOKA SNAGA's well P-1gl in Zalog, daily from 2015 to June 2026, with a reference line at its level on 6 November 2023. After that, a dashed **estimate** from the rivers
  - **Hrastje**: ARSO's nearest automatic well (~4 km west), live, with its record high and low
- **All** view: water level, flow, temperature and groundwater stacked on one shared time axis, so zooming, panning and the hover readout move together
- **decades of history** from ARSO's validated daily archive, which flows straight on into measured readings (every 10 minutes for the last day, hourly before that) recorded since this project started
- a **"normal for this time of year" band** behind each chart: the range of daily means that 80 % of past years had on that date (the 10th to 90th percentile, within a week either side). The hover readout gives the same range. It is shown on views of 45 days or more, so it does not flatten short views, and only for series with 5 or more years of history
- a **date picker**: jump to any day and see its level, flow and temperature in one line
- **times above a value**: type e.g. 250 cm and the chart marks every stretch above it in red, with a list of each time (dates, how long, peak). Tap one to jump there. For flow, ARSO's flood-stage values are offered as suggestions
- **past high water**: every event since 2006 with the Ljubljanica averaging 240 cm or more at Moste I, or Zalog groundwater within 0.4 m of the reference level, with each event's peaks. Tap one to open that month in the **All** view
- a data table and a CSV download for whatever range you are looking at
- **share as an image**: the share button next to the date puts the chart as shown, with a title and the time span, on a PNG. Phones open the share sheet; computers download it
- every nearby ARSO gauge, sorted by distance from Zalog
- **data status**: when each source last delivered (site update, the river station, Hrastje, the Zalog estimate, the rain forecast), with a ⚠ when one is later than usual, and the gaps of more than a week in the shown station's record since 2015
- **installable app**: on iPhone, Safari → Share → **Add to Home Screen**; on Android or desktop Chrome, **Install app**. It opens full screen, and without a network it shows the last data it saw (`site/sw.js`, `site/manifest.webmanifest`)
- light and dark mode that follows your device, with a manual override, and a dense chart-first layout on phones

## Phone alerts

Alerts, a Live Activity and widgets on an iPhone, through the free [Notify!](https://getnotifyapp.com) app. `scripts/alerts.py` runs after every data update:

| Level | When | How |
|---|---|---|
| Heads-up | Heavy rain forecast: 70 mm or more over 3 days on the Ljubljanica and Sava catchments; Ljubljanica at Moste I at 200 cm or more, or rising 40 cm or more in 6 h; groundwater at Hrastje rising 0.30 m or more in 3 days | notification |
| Warning | The Zalog groundwater estimate comes within 0.70 m of the reference level | Time Sensitive notification, and a Live Activity until it is over |
| Urgent | ARSO reports a flood stage on the Ljubljanica (Moste I) or the Sava (Šentjakob) | Time Sensitive notification and Live Activity |

Each alert is sent once. A rule clears only once the value is well back down (the river under 180 cm, the Zalog estimate more than 0.90 m below the reference), so a level hovering at the threshold does not keep pinging. The warning then sends an "All clear".

**Why these levels.** `scripts/backtest.py` replays the rules on the daily record for 2015–2026 ([report](docs/backtest.md)). In that time Zalog groundwater came near the reference level three times: December 2017, August 2023 and November 2023.
- **The Zalog estimate rule** would have warned for all three: 1 day, the same day and 7 days ahead. It had 2 false alarms in 11 years.
- **The Ljubljanica above 200 cm** was also true every time, but it happens about 4 times a year, mostly with no high groundwater. So it is a heads-up, not a warning.
- **Warning time:** neither river rule gives much. High groundwater at Zalog follows the rivers within about a day.
- **A heavy rain forecast** (70 mm or more over 3 days) came 2–10 days before all three events. It also happens about twice a year with nothing after it, so it is a heads-up.

Re-run the backtest after changing a threshold: `cd scripts && python backtest.py --store ../store > ../docs/backtest.md`. A notice also comes when ARSO sends no readings for 6 hours, and again when they are back. A Lock Screen widget and a Home Screen widget show the latest values all the time. The thresholds are at the top of `scripts/alerts.py`.

Setup: in Notify!, copy the device's webhook address (it ends in `?token=...`) and add it under **Settings → Secrets and variables → Actions → New repository secret** as `NOTIFY_URL`. Optionally create a beacon in Notify! (expected every 60 minutes, grace 180) and add its ping address as `NOTIFY_BEACON_URL`. The app then alerts by itself if these updates stop. Check it with **Actions → Update data and publish → Run workflow → Send a test notification**.

## Which gauge is closest to Zalog?

ARSO has no gauge on the Ljubljanica at Zalog itself. The useful ones are:

| Station | River | Distance from Zalog | Notes |
|---|---|---|---|
| **Šentjakob** (3570) | Sava | ~3 km | Just upstream of the confluence. A high Sava backs water up into the lower Ljubljanica, so it matters for Zalog too. |
| **Moste I** (5078) | Ljubljanica | ~5.7 km | The last Ljubljanica gauge before Zalog. This is the station behind ARSO's `H5078` page. |

Every station within 10 km of Zalog (plus Moste I) is recorded automatically.

### Groundwater

ARSO also runs about 140 automatic groundwater wells ([map and tables](https://www.arso.gov.si/vode/podatki/podzem_amp/)). The nearest to Zalog is **Hrastje (0341)** (`G85040`), about 4 km west on the same aquifer (Ljubljansko polje). It reports hourly, but ARSO usually sends the readings about once a day.

**Zalog (P-1gl)** is a piezometer of JP VOKA SNAGA, the Ljubljana water company, in Zalog. Its daily levels for 2015 to June 2026 come from the open dataset [Groundwater-Level Monitoring Data from the Ljubljansko Barje and Ljubljansko Polje Piezometer Networks](https://zenodo.org/records/21789430) (Bračič Železnik, Čenčur Curk, Torkar; CC BY 4.0), imported once by `scripts/voka.py`. It is not updated live. The reference line is this well's own level on a chosen day, 6 November 2023 (266.38 m; `REFERENCE_DATE` in `scripts/update.py`). The highest level since 2015 was 266.96 m on 6 August 2023.

**The Zalog estimate.** Since the well's data ends in June 2026, `scripts/estimate.py` estimates it from the rivers. The Zalog well follows a weighted mix of the Ljubljanica's flow at Moste I and the Sava's flow at Šentjakob, each averaged over a few days to a few months. That mix is fitted to the well's 2015–2026 record (least squares) on every run. On three years held back from the fit, the estimate is typically within about ±0.2 m. It tends to run low at the sharpest peaks (about 0.5 m low on 6 August 2023). It is shown only on days with real readings of both rivers. The chart draws it dashed, with a band of its typical error. If newer well data is ever imported, the fit uses it automatically.

**Rain.** `scripts/rain.py` gets daily rain from [Open-Meteo](https://open-meteo.com/) (CC BY 4.0) at five points: Vrhnika, Cerknica and Ljubljana for the Ljubljanica, and Bohinj and Kamnik for the Sava. It averages each catchment, then the two catchments together. The history since 2014 is imported once. After that, every run refreshes the last week and the forecast for the next 3 days. The **Ground** view shows the forecast in its status lines.

Hrastje's water table is about 10 m higher than Zalog's, because the ground rises towards the city, so its levels cannot be compared with Zalog's. It is shown for its live trend: when it rises, Zalog rises too.

ARSO gives the level ("Nivo") in cm relative to the top of the well. The dashboard turns it into metres above sea level with the well's height from ARSO's [station sheet](https://meteo.arso.gov.si/uploads/probase/www/hidro/watercycle/text/sl/observation_sites/piezometers_wells/85040.pdf) (287.40 m), so it can be compared with any other height, for example a cellar floor. The record high (276.63 m, October 1973) and low (271.61 m, February 1989) come from the same sheet. History starts when this project began recording the well. ARSO's groundwater archive (`hidarhiv/pod_arhiv_tab.php`) could add older years once its archive site is back up. The "Stations nearby" section on the dashboard lists everything else ARSO publishes, with distances worked out from ARSO's coordinates.

## How it works

Everything runs for free on GitHub:

```
GitHub Actions (every 30 min)            GitHub Pages
  scripts/update.py                        site/ + data/
    ├─ ARSO latest-readings XML   ──►  data branch  ──►  https://bizmar.github.io/RiverChart/
    ├─ ARSO 1-day / 30-day tables
    ├─ ARSO groundwater well table (Hrastje)
    └─ ARSO daily archive (hidarhiv)
```

- `scripts/arso.py` downloads and parses the ARSO sources. It uses only the Python standard library.
- `scripts/alerts.py` sends the phone alerts (see above).
- `scripts/update.py` merges new readings into plain CSV files. They are kept on the `data` branch, which is rewritten as a single commit each time so the repository stays small.
- `site/` is a static page (HTML + JavaScript + [Apache ECharts](https://echarts.apache.org/)) that reads those CSV files directly.

The first run back-fills each station: the last 30 days at 30-minute resolution, and the complete daily archive, year by year. Every day the last 3 archive years are re-checked, because ARSO validates and publishes them with a delay. When ARSO's archive site is down for maintenance, the check says so in the log and simply tries again the next day.

### Filling the 2025 gap from the Internet Archive

ARSO has not published its checked (validated) data for 2025 yet: its archive and its statistics files both end in December 2024. Until it does, some of that time can be recovered from the [Internet Archive](https://web.archive.org/), which saved copies of ARSO's 30-day and 1-day station tables now and then. Each copy holds that period's automatic readings.

To import them, run **Actions → Update data and publish → Run workflow** with *wayback* set to a start date (e.g. `2025`). The imported readings are ARSO's own measurements, like the live data, and are shown the same way. When ARSO publishes the checked year, its daily values take over automatically.

### Data layout

```
stations.json               all ARSO stations + latest reading, nearest first
<id>/meta.json              what is stored for a tracked station
<id>/daily.csv              date,level,flow,temp,src  (src a = ARSO archive, m = mean of live data)
<id>/live/YYYY-MM.csv       time (UTC),level,flow,temp  - measured readings, 10-60 min apart
G85040/...                  the groundwater well, same layout (level = ARSO's "Nivo", hourly)
VOKA-P-1gl/daily.csv        the Zalog well, daily, level in m above sea level (src v = VOKA SNAGA)
VOKA-P-1gl/estimate.csv     the Zalog well estimated from the rivers, for days after its data ends
rain/daily.csv              daily rain (mm), mean of the Ljubljanica and Sava catchments, since mid-2014
rain/forecast.csv           the same for today and the next 3 days
```

Units: level in cm (on the gauge's own scale, not above sea level), flow in m³/s, temperature in °C. Groundwater level in cm relative to the well top, as ARSO publishes it; `stations.json` also gives the latest value in metres above sea level.

## Data backups

The `data` branch only keeps its latest state. Every Monday the workflow saves a copy of it as an asset of the [data-backups](https://github.com/bizmar/RiverChart/releases/tag/data-backups) release, and keeps the newest 8. To make one now: **Actions → Update data and publish → Run workflow → Make a backup copy of the data now**.

To restore one: download the `.tar.gz`, unpack it into an empty folder, and push that folder as the `data` branch:

```
mkdir restore && tar -xzf riverchart-data-YYYY-MM-DD.tar.gz -C restore && cd restore
git init -b data && git add -A && git commit -m "Restore data" && git push --force https://github.com/bizmar/RiverChart.git data
```

The next run carries on from there.

## Setup (one-time)

1. **Settings → Pages → Build and deployment → Source: GitHub Actions**
2. **Actions → "Update data and publish" → Run workflow.** The first run downloads the archives and takes several minutes.
3. Open `https://bizmar.github.io/RiverChart/`.

After that it updates itself every 30 minutes. GitHub may delay scheduled runs a little at busy times. The 1-day table fills in anything a late run missed.

To change the home location, radius or tracked stations, edit the top of `scripts/update.py`.

## Working on it locally

```sh
python3 scripts/make_sample_data.py site/data     # fake data for offline work
python3 -m http.server -d site 8000               # open http://localhost:8000
python3 -m unittest discover tests                # parser and store tests
python3 scripts/update.py --store site/data       # real data from ARSO
```

### Checks on pull requests

Every pull request runs two free checks:
- **Checks** (`.github/workflows/checks.yml`): ruff lint (settings in `ruff.toml`) and the unit tests for the Python scripts, plus a syntax check of the site's JavaScript. To lint locally: `pip install ruff && ruff check scripts tests`.
- **CodeQL** (`.github/workflows/codeql.yml`): GitHub's code scanning for security bugs in Python and JavaScript. It also runs weekly. Findings show on the pull request and under **Security → Code scanning**.

To block merging until they pass, go to **Settings → Branches → Add branch ruleset** (target `main`). Turn on **Require status checks to pass**, and add `python`, `site`, `analyze (python)` and `analyze (javascript-typescript)`.

## Privacy

No cookies, no ads, no tracking. The page loads only from its own site: the chart library ([Apache ECharts](https://echarts.apache.org/), Apache-2.0) is served from `site/vendor/` rather than a CDN. The only thing stored is the colour theme choice (`rc-theme` in the browser's `localStorage`), which stays on the visitor's device. GitHub Pages, as the host, sees visitors' IP addresses like any web server does.

## Data and licence

River data comes from the **Slovenian Environment Agency, [ARSO](https://www.arso.gov.si/vode/podatki/)**. Credit ARSO as the source when you reuse it. Recent values are automatic measurements that ARSO has not validated yet.

Code: MIT licence.
