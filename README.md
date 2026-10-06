# RiverChart

**Live and historic river levels for every automatic ARSO gauge in Slovenia. It opens on the Ljubljanica and Sava at Zalog (Ljubljana), and finds the nearest gauge to wherever you are.**

ARSO's station pages only show a static 30-day picture. This dashboard has:

- a **search at the top**: type a place or river name, or press "Near me" to use your location, and it shows the closest gauge. On a phone the search folds away once a place is set

- the current water level, flow and water temperature, with the change over the last 24 hours and ARSO's own status (normal / high / flood stage)
- an **interactive chart**: zoom with the scroll wheel or a pinch, drag to pan, or jump to 2 days … 10 years … the whole record
- **All** view: water level, flow and temperature stacked on one shared time axis, so zooming, panning and the hover readout move together
- **decades of history** from ARSO's validated daily archive, which flows straight on into measured readings (every 10 minutes for the last day, hourly before that) recorded since this project started
- a data table and a CSV download for whatever range you are looking at
- the nearest gauges to your place, with their current readings
- light and dark mode that follows your device, with a manual override, and a dense chart-first layout on phones

## Which gauge is closest to Zalog?

ARSO has no gauge on the Ljubljanica at Zalog itself. The useful ones are:

| Station | River | Distance from Zalog | Notes |
|---|---|---|---|
| **Šentjakob** (3570) | Sava | ~3 km | Just upstream of the confluence. A high Sava backs water up into the lower Ljubljanica, so it matters for Zalog too. |
| **Moste I** (5078) | Ljubljanica | ~5.7 km | The last Ljubljanica gauge before Zalog. This is the station behind ARSO's `H5078` page. |

Zalog is only the starting point. Every automatic ARSO station is recorded, and the site finds the nearest one to whatever place you search for.

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
- `scripts/update.py` merges new readings into plain CSV files. They are kept on the `data` branch, which is rewritten as a single commit each time so the repository stays small. Live readings older than a week are thinned to one per hour.
- `site/` is a static page (HTML + JavaScript + [Apache ECharts](https://echarts.apache.org/)) that reads those CSV files directly.

A new station gets its last 30 days of readings straight away. Its complete daily archive follows year by year, nearest to Zalog first, within a time budget per run (`--budget`, 50 minutes by default). With ~190 stations the first full history takes a few runs, and the next run picks up where the last one stopped. Every Monday the last 3 archive years are re-checked, because ARSO validates and publishes them with a delay.

### Data layout

```
stations.json               all ARSO stations + latest reading, nearest first
<id>/meta.json              what is stored for a station (archive_done = full daily history fetched)
<id>/daily.csv              date,level,flow,temp,src  (src a = ARSO archive, m = mean of live data)
<id>/live/YYYY-MM.csv       time (UTC),level,flow,temp  - measured readings, 10-60 min apart
```

Units: level in cm (on the gauge's own scale, not above sea level), flow in m³/s, temperature in °C.

## Setup (one-time)

1. **Settings → Pages → Build and deployment → Source: GitHub Actions**
2. **Actions → "Update data and publish" → Run workflow.** The first runs download every station's archive; run it a few times until the log no longer says "time budget used up".
3. Open `https://bizmar.github.io/RiverChart/`.

After that it updates itself every 30 minutes. GitHub may delay scheduled runs a little at busy times. The 1-day table fills in anything a late run missed.

To change the default place or station, edit the top of `scripts/update.py`.

## Working on it locally

```sh
python3 scripts/make_sample_data.py site/data     # fake data for offline work
python3 -m http.server -d site 8000               # open http://localhost:8000
python3 -m unittest discover tests                # parser and store tests
python3 scripts/update.py --store site/data       # real data from ARSO
```

## Privacy

No cookies, no ads, no tracking. The page loads only from its own site: the chart library ([Apache ECharts](https://echarts.apache.org/), Apache-2.0) is served from `site/vendor/` rather than a CDN.

Stored in the browser's `localStorage`, on the visitor's device only: the colour theme (`rc-theme`) and, once a place is chosen, that place (`rc-place`). A location from "Near me" is rounded to about 1 km before it is saved, and it is never sent anywhere. "Reset" in the search menu forgets it.

The one outside request: when a visitor searches for a *place name* (not a river or station), the text typed is sent to [OpenStreetMap Nominatim](https://nominatim.org/) to look up its coordinates, which also shows Nominatim the visitor's IP address. Matching rivers and stations, and "Near me", involve no outside request. GitHub Pages, as the host, sees visitors' IP addresses like any web server does.

## Data and licence

River data comes from the **Slovenian Environment Agency, [ARSO](https://www.arso.gov.si/vode/podatki/)**. Credit ARSO as the source when you reuse it. Recent values are automatic measurements that ARSO has not validated yet.

Code: MIT licence.
