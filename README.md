# RiverChart

**Live and historic river levels where the Ljubljanica meets the Sava, at Zalog (Ljubljana).**

ARSO's station pages only show a static 30-day picture. This dashboard has:

- the current water level, flow and water temperature, with the change over the last 24 hours and ARSO's own status (normal / high / flood stage)
- an **interactive chart**: zoom with the scroll wheel or a pinch, drag to pan, or jump to 2 days … 10 years … the whole record
- **groundwater** (the **Ground** button): around Zalog, cellars flood from rising groundwater rather than from the river itself. Two charts:
  - **Zalog**: VOKA SNAGA's well P-1gl in Zalog, daily from 2015 to June 2026, with a reference line at its level on 6 November 2023
  - **Hrastje**: ARSO's nearest automatic well (~4 km west), live, with its record high and low
- **All** view: water level, flow, temperature and groundwater stacked on one shared time axis, so zooming, panning and the hover readout move together
- **decades of history** from ARSO's validated daily archive, which flows straight on into measured readings (every 10 minutes for the last day, hourly before that) recorded since this project started
- a **date picker**: jump to any day and see its level, flow and temperature in one line
- **times above a value**: type e.g. 250 cm and the chart marks every stretch above it in red, with a list of each time (dates, how long, peak). Tap one to jump there. For flow, ARSO's flood-stage values are offered as suggestions
- a data table and a CSV download for whatever range you are looking at
- every nearby ARSO gauge, sorted by distance from Zalog
- light and dark mode that follows your device, with a manual override, and a dense chart-first layout on phones

## Phone alerts

Alerts, a Live Activity and widgets on an iPhone, through the free [Notify!](https://getnotifyapp.com) app. `scripts/alerts.py` runs after every data update:

| Level | When | How |
|---|---|---|
| Heads-up | Ljubljanica at Moste I rises 40 cm or more in 6 h, or groundwater at Hrastje rises 0.30 m or more in 3 days | notification |
| Warning | Ljubljanica at Moste I at 200 cm or more (both 2023 reference days were above it) | Time Sensitive notification, and a Live Activity until it is over |
| Urgent | ARSO reports a flood stage on the Ljubljanica (Moste I) or the Sava (Šentjakob) | Time Sensitive notification and Live Activity |

Each alert is sent once. A warning clears only when the river is back under 180 cm, so a level hovering around 200 cm does not keep pinging, and then an "All clear" follows. A notice also comes when ARSO sends no readings for 6 hours, and again when they are back. A Lock Screen widget and a Home Screen widget show the latest values all the time. The thresholds are at the top of `scripts/alerts.py`.

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
```

Units: level in cm (on the gauge's own scale, not above sea level), flow in m³/s, temperature in °C. Groundwater level in cm relative to the well top, as ARSO publishes it; `stations.json` also gives the latest value in metres above sea level.

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

## Privacy

No cookies, no ads, no tracking. The page loads only from its own site: the chart library ([Apache ECharts](https://echarts.apache.org/), Apache-2.0) is served from `site/vendor/` rather than a CDN. The only thing stored is the colour theme choice (`rc-theme` in the browser's `localStorage`), which stays on the visitor's device. GitHub Pages, as the host, sees visitors' IP addresses like any web server does.

## Data and licence

River data comes from the **Slovenian Environment Agency, [ARSO](https://www.arso.gov.si/vode/podatki/)**. Credit ARSO as the source when you reuse it. Recent values are automatic measurements that ARSO has not validated yet.

Code: MIT licence.
