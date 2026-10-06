# RiverChart

**Live and historic river levels where the Ljubljanica meets the Sava, at Zalog (Ljubljana).**

ARSO's station pages only show a static 30-day picture. This dashboard has:

- the current water level, flow and water temperature, with the change over the last 24 hours and ARSO's own status (normal / high / flood stage)
- an **interactive chart**: zoom with the scroll wheel or a pinch, drag to pan, or jump to 2 days … 10 years … the whole record
- **All** view: water level, flow and temperature stacked on one shared time axis, so zooming, panning and the hover readout move together
- **decades of history** from ARSO's validated daily archive, which flows straight on into measured readings (every 10 minutes for the last day, hourly before that) recorded since this project started
- a data table and a CSV download for whatever range you are looking at
- every nearby ARSO gauge, sorted by distance from Zalog
- light and dark mode that follows your device, with a manual override, and a dense chart-first layout on phones

## Which gauge is closest to Zalog?

ARSO has no gauge on the Ljubljanica at Zalog itself. The useful ones are:

| Station | River | Distance from Zalog | Notes |
|---|---|---|---|
| **Šentjakob** (3570) | Sava | ~3 km | Just upstream of the confluence. A high Sava backs water up into the lower Ljubljanica, so it matters for Zalog too. |
| **Moste I** (5078) | Ljubljanica | ~5.7 km | The last Ljubljanica gauge before Zalog. This is the station behind ARSO's `H5078` page. |

Every station within 10 km of Zalog (plus Moste I) is recorded automatically. The "Stations nearby" section on the dashboard lists everything else ARSO publishes, with distances worked out from ARSO's coordinates.

## How it works

Everything runs for free on GitHub:

```
GitHub Actions (every 30 min)            GitHub Pages
  scripts/update.py                        site/ + data/
    ├─ ARSO latest-readings XML   ──►  data branch  ──►  https://bizmar.github.io/RiverChart/
    ├─ ARSO 1-day / 30-day tables
    └─ ARSO daily archive (hidarhiv)
```

- `scripts/arso.py` downloads and parses the three ARSO sources. It uses only the Python standard library.
- `scripts/update.py` merges new readings into plain CSV files. They are kept on the `data` branch, which is rewritten as a single commit each time so the repository stays small.
- `site/` is a static page (HTML + JavaScript + [Apache ECharts](https://echarts.apache.org/)) that reads those CSV files directly.

The first run back-fills each station: the last 30 days at 30-minute resolution, and the complete daily archive, year by year. Every Monday the last 3 archive years are re-checked, because ARSO validates and publishes them with a delay.

### Data layout

```
stations.json               all ARSO stations + latest reading, nearest first
<id>/meta.json              what is stored for a tracked station
<id>/daily.csv              date,level,flow,temp,src  (src a = ARSO archive, m = mean of live data)
<id>/live/YYYY-MM.csv       time (UTC),level,flow,temp  - measured readings, 10-60 min apart
```

Units: level in cm (on the gauge's own scale, not above sea level), flow in m³/s, temperature in °C.

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

- **No cookies, no ads, no tracking.** The page loads only from its own site; the chart library ([Apache ECharts](https://echarts.apache.org/), Apache-2.0) is served from `site/vendor/` rather than a CDN.
- Two choices are kept in the browser's `localStorage`, on the visitor's device only: the colour theme (`rc-theme`) and the privacy notice answer (`rc-consent`).
- The first visit shows a short notice with a switch for anonymous statistics. **No statistics are collected today.** If analytics are ever added, the code must call `RiverChart.analyticsAllowed()` first and load nothing when it returns `false`. Without a saved answer, a browser's Global Privacy Control or Do Not Track signal counts as "no".
- GitHub Pages, as the host, sees visitors' IP addresses like any web server does.

## Data and licence

River data comes from the **Slovenian Environment Agency, [ARSO](https://www.arso.gov.si/vode/podatki/)**. Credit ARSO as the source when you reuse it. Recent values are automatic measurements that ARSO has not validated yet.

Code: MIT licence.
