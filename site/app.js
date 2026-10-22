"use strict";

const DATA = "data/";
const DAY = 86400000;
const TZ = "Europe/Ljubljana";

const METRICS = {
  level: { label: "Water level", short: "Level", unit: "cm", digits: 0, color: "--c-level" },
  flow: { label: "Flow", short: "Flow", unit: "m³/s", digits: 1, color: "--c-flow" },
  temp: { label: "Water temperature", short: "Temperature", unit: "°C", digits: 1, color: "--c-temp" },
  // Groundwater, whichever river station is picked: VOKA SNAGA's well at Zalog (daily, a fixed release up to mid-2026)
  // and ARSO's well at Hrastje (hourly, live).
  zalog: { label: "Groundwater at Zalog", short: "Zalog", unit: "m a.s.l.", digits: 2, color: "--c-zalog" },
  hrastje: { label: "Groundwater at Hrastje", short: "Hrastje", unit: "m a.s.l.", digits: 2, color: "--c-ground" },
};
const RIVER = ["level", "flow", "temp"];
const WELLS = ["zalog", "hrastje"];
const GROUND = "ground"; // the "Ground" choice: both groundwater panels
const RANGES = [
  { id: "2d", label: "2 d", title: "Last 2 days", days: 2 },
  { id: "7d", label: "7 d", title: "Last week", days: 7 },
  { id: "30d", label: "30 d", title: "Last month", days: 30 },
  { id: "1y", label: "1 y", title: "Last year", days: 365 },
  { id: "10y", label: "10 y", title: "Last 10 years", days: 3652 },
  { id: "all", label: "All", title: "Whole record", days: Infinity },
];

const state = {
  stations: [],
  byId: {},
  station: null,
  metric: "level",
  range: "7d",
  cache: {},
  series: {},
  window: [0, 0],
  picked: null, // a day chosen with the date picker, "YYYY-MM-DD"
  above: {}, // "times above" values per measurement, e.g. { level: 150 }
  gw: null, // ARSO's Hrastje well from stations.json
  zalog: null, // VOKA SNAGA's Zalog well from stations.json
};

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

// ---------------------------------------------------------------- formatting

const nf = (digits) => new Intl.NumberFormat("en-GB", { maximumFractionDigits: digits, minimumFractionDigits: 0 });
const fmtVal = (v, metric) => (v == null ? "–" : nf(metric === "flow" && Math.abs(v) < 10 ? 2 : METRICS[metric].digits).format(v));
const dateFmt = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "short", day: "numeric", month: "short", year: "numeric" });
const timeFmt = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
const shortDateFmt = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, day: "numeric", month: "short", year: "numeric" });
const isoLocal = (t) => {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(t).map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
};

function ago(t) {
  const min = Math.round((Date.now() - t) / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

// ARSO describes the current state in Slovene ("srednji pretok", "prvi visokovodni pretok", ...).
function classify(text) {
  if (!text) return null;
  const s = text.toLowerCase();
  const rules = [
    [/tretj/, "critical", "Flood stage 3"],
    [/drug/, "critical", "Flood stage 2"],
    [/prvi|visokovod|poplav/, "serious", "Flood stage 1"],
    [/velik|visok/, "warning", "High"],
    [/mal|nizek|nizk/, "info", "Low"],
    [/srednj|normal|povpre|obi.ajn/, "good", "Normal"], // "običajni pretok" since autumn 2026
  ];
  for (const [re, level, label] of rules) if (re.test(s)) return { level, label, raw: text };
  return { level: "info", label: text, raw: text };
}

const ICONS = {
  good: '<circle cx="8" cy="8" r="7" fill="var(--good)"/><path d="M4.8 8.2l2.1 2.1 4.3-4.6" stroke="#fff" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  info: '<circle cx="8" cy="8" r="7" fill="var(--muted)"/><path d="M8 7.2v4.3M8 4.6v.2" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/>',
  warning: '<path d="M8 1.5l7 12.5H1z" fill="var(--warning)"/><path d="M8 6v3.6M8 11.7v.2" stroke="#0b0b0b" stroke-width="1.6" stroke-linecap="round"/>',
  serious: '<path d="M8 1.5l7 12.5H1z" fill="var(--serious)"/><path d="M8 6v3.6M8 11.7v.2" stroke="#0b0b0b" stroke-width="1.6" stroke-linecap="round"/>',
  critical: '<path d="M5 1h6l4 4v6l-4 4H5l-4-4V5z" fill="var(--critical)"/><path d="M8 4.5v4.3M8 11.2v.2" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/>',
};
function statusNode(cls, prefix) {
  const wrap = document.createDocumentFragment();
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = ICONS[cls.level];
  wrap.append(svg);
  const label = el("span");
  label.append(el("b", null, (prefix ? prefix + ": " : "") + cls.label));
  if (cls.raw !== cls.label) label.append(document.createTextNode(` · ${cls.raw}`));
  wrap.append(label);
  return wrap;
}

// ---------------------------------------------------------------- data

async function getText(path) {
  const r = await fetch(DATA + path, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.text();
}

function parseCsv(text) {
  const lines = text.trim().split("\n");
  const head = lines.shift().split(",");
  return lines.map((line) => {
    const cells = line.split(",");
    const row = {};
    head.forEach((h, i) => (row[h] = cells[i] ?? ""));
    return row;
  });
}
const num = (s) => (s === "" || s == null ? null : Number(s));

function parseLive(text) {
  return parseCsv(text).map((r) => ({ t: Date.parse(r.time), level: num(r.level), flow: num(r.flow), temp: num(r.temp) }));
}
function parseDaily(text) {
  return parseCsv(text).map((r) => {
    const [y, m, d] = r.date.split("-").map(Number);
    return { date: r.date, t: Date.UTC(y, m - 1, d, 11), level: num(r.level), flow: num(r.flow), temp: num(r.temp), daily: true, src: r.src };
  });
}

async function stationData(id) {
  const c = (state.cache[id] ??= { live: new Map() });
  if (!c.meta) {
    const [meta, daily] = await Promise.all([getText(`${id}/meta.json`).then(JSON.parse), getText(`${id}/daily.csv`).catch(() => "date\n")]);
    c.meta = meta;
    c.daily = parseDaily(daily);
    await loadMonths(id, meta.live_months.slice(-2));
  }
  return c;
}

async function loadMonths(id, months) {
  const c = state.cache[id];
  const todo = months.filter((m) => !c.live.has(m));
  const texts = await Promise.all(todo.map((m) => getText(`${id}/live/${m}.csv`).catch(() => "time\n")));
  todo.forEach((m, i) => c.live.set(m, parseLive(texts[i])));
  return todo.length > 0;
}

// Where a measurement's data lives: one of the groundwater wells, or the picked river station.
const sourceId = (metric) => ({ hrastje: state.gw?.id, zalog: state.zalog?.id })[metric] ?? state.station;
// ARSO's well readings are cm relative to the well top; shown as metres above sea level.
const gwMetres = (cm) => Math.round((state.gw.datum + cm / 100) * 100) / 100;

function seriesFor(id) {
  if (!WELLS.includes(id)) return buildPoints(state.cache[state.station], id);
  const c = state.cache[sourceId(id)];
  if (!c?.meta) return [];
  const pts = buildPoints(c, "level");
  // Zalog is stored in metres already; Hrastje as ARSO publishes it.
  return id === "zalog" ? pts : pts.map((p) => (p[1] == null ? p : [p[0], gwMetres(p[1]), ...p.slice(2)]));
}

// One line: measured readings where they are loaded, daily means (ARSO's archive or our own) for every other day.
function buildPoints(c, metric) {
  const live = [...c.live.keys()].sort().flatMap((m) => c.live.get(m)).filter((r) => r[metric] != null);
  const liveDays = new Set(live.map((r) => isoDay(r.t)));
  const merged = [
    ...c.daily.filter((d) => d[metric] != null && !liveDays.has(d.date)).map((d) => [d.t, d[metric], 1]),
    ...live.map((r) => [r.t, r[metric]]),
  ].sort((x, y) => x[0] - y[0]);
  const pts = [];
  let prev = null;
  for (const p of merged) {
    // Break the line across gaps: more than 4 days around daily values, or 6 hours between readings.
    const maxGap = prev && (prev[2] || p[2]) ? 4 * DAY : 6 * 3600000;
    if (prev && p[0] - prev[0] > maxGap) pts.push([prev[0] + 1, null]);
    pts.push(p);
    prev = p;
  }
  return pts;
}

// ---------------------------------------------------------------- chart

// state.metric is one of METRICS, or ALL for the three measurements stacked on one time axis.
const ALL = "all";
let chart;
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// Measurements this station has any data for, plus the groundwater wells that have data.
function available() {
  const st = state.byId[state.station];
  const c = state.cache[state.station];
  const live = c ? [...c.live.values()].flat() : [];
  const has = RIVER.filter((k) => st?.[k] != null || c?.daily?.some((d) => d[k] != null) || live.some((r) => r[k] != null));
  for (const w of WELLS) {
    const g = state.cache[sourceId(w)];
    if (g?.meta && (g.daily.some((d) => d.level != null) || [...g.live.values()].flat().some((r) => r.level != null))) has.push(w);
  }
  return has;
}
function panels() {
  if (state.metric === ALL) return available();
  if (state.metric === GROUND) return available().filter((id) => WELLS.includes(id));
  return [state.metric];
}
// Phone layout: TradingView-style dense chart with the value scale on the right.
const isCompact = () => matchMedia("(max-width: 640px)").matches;

// Black or white text, whichever reads better on a filled badge of this colour.
function inkOn(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lin = (c) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const L = 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return L > 0.18 ? "#0b0b0b" : "#ffffff";
}

function buildAllSeries() {
  state.series = Object.fromEntries(panels().map((id) => [id, seriesFor(id)]));
}

const panelTitle = (id) => METRICS[id].label;

function chartOption() {
  const ids = panels();
  const n = ids.length;
  const ink2 = css("--ink-2"), muted = css("--muted"), grid = css("--grid"), axis = css("--axis"), surface = css("--surface");
  const color = (id) => css(METRICS[id].color);
  // Panel layout in pixels; renderChart re-runs this when the chart's size or layout mode changes.
  const compact = isCompact();
  const L = compact
    ? { left: 6, right: 46, top: 22, gap: 26, bottom: 50, slider: 20, font: 10 }
    : { left: 56, right: 16, top: n > 1 ? 34 : 28, gap: 46, bottom: 78, slider: 34, font: 12 };
  const H = $("chart").clientHeight || 480;
  // Stacked view on phones: water temperature gets a slim panel, the others share the rest equally.
  const slim = (id) => compact && n > 1 && id === "temp";
  const weight = ids.map((id) => (slim(id) ? 0.4 : 1));
  const unit = (H - L.top - L.bottom - L.gap * (n - 1)) / weight.reduce((a, b) => a + b, 0);
  const heights = weight.map((w) => w * unit);
  const panelTop = (i) => L.top + heights.slice(0, i).reduce((a, b) => a + b, 0) + i * L.gap;
  // Every panel spans the same time range, so they zoom and pan in step
  // (the groundwater well's record is shorter and its newest readings arrive later than the river's).
  const span = dataBounds();
  const panelIdx = ids.map((_, i) => i);
  // Panel titles: always in the stacked view, and on phones (where the unit has no room on the axis).
  const titled = compact || n > 1;
  // "Times above": the line turns red wherever it is above the chosen value.
  const aboveId = aboveMetric();
  const above = state.above[aboveId];
  const alert = css("--critical");
  // Values a panel's scale must include: the "times above" value, and the reference line on the Zalog panel.
  const mark = state.zalog?.reference?.value;
  const mustShow = (id) => [id === aboveId ? above : null, id === "zalog" ? mark : null].filter((v) => v != null);
  const lastPoint = (id) => { const p = state.series[id]; for (let i = p.length - 1; i >= 0; i--) if (p[i][1] != null) return p[i]; return null; };
  return {
    animation: false,
    textStyle: { fontFamily: css("--font") },
    axisPointer: { link: [{ xAxisIndex: "all" }], lineStyle: { color: muted, width: 1 }, label: { show: false } },
    title: titled ? ids.map((id, i) => ({
      text: `{k|━━} ${panelTitle(id)} (${METRICS[id].unit})`,
      left: compact ? 4 : 8,
      top: panelTop(i) - (compact ? 19 : 26),
      textStyle: { fontSize: compact ? 11 : 13, fontWeight: 600, color: ink2, rich: { k: { color: color(id), fontSize: compact ? 9 : 10 } } },
    })) : [],
    grid: (panelBoxes = ids.map((_, i) => ({ left: L.left, right: L.right, top: panelTop(i), height: heights[i] }))),
    visualMap: above != null && ids.includes(aboveId) ? [{
      type: "piecewise",
      show: false,
      seriesIndex: ids.indexOf(aboveId),
      dimension: 1,
      // ECharts 5.6 needs one closed range to build its colour stops, so "above" gets a far-away ceiling.
      pieces: [{ gt: above, lte: Math.abs(above) * 10 + 1e6, color: alert }, { lte: above, color: color(aboveId) }],
    }] : [],
    xAxis: ids.map((_, i) => ({
      type: "time",
      gridIndex: i,
      min: span?.[0],
      max: span?.[1],
      axisLine: { lineStyle: { color: axis } },
      axisTick: { show: false },
      splitNumber: compact ? 4 : undefined,
      axisLabel: { show: i === n - 1, color: muted, hideOverlap: true, fontSize: L.font },
      splitLine: { show: false },
    })),
    yAxis: ids.map((id, i) => ({
      type: "value",
      gridIndex: i,
      scale: id !== "flow",
      min: id === "flow" ? 0 : mustShow(id).length ? (v) => Math.min(v.min, ...mustShow(id)) : undefined,
      // A little headroom over the reference line, so its label stays inside the panel.
      max: mustShow(id).length ? (v) => Math.max(v.max, ...mustShow(id).map((x) => (x === mark ? x + 0.3 : x))) : undefined,
      position: compact ? "right" : "left",
      name: titled ? "" : METRICS[id].unit,
      nameTextStyle: { color: muted, align: "right", padding: [0, 6, 0, 0] },
      splitNumber: slim(id) ? 2 : compact || n > 1 ? 3 : 5,
      axisLabel: { color: muted, fontSize: L.font, margin: compact ? 6 : 8 },
      splitLine: { lineStyle: { color: grid } },
    })),
    tooltip: {
      trigger: "axis",
      confine: true,
      backgroundColor: surface,
      borderColor: css("--border"),
      textStyle: { color: css("--ink") },
      formatter: (params) => {
        const shown = params.filter((x) => x.value[1] != null).sort((a, b) => a.seriesIndex - b.seriesIndex);
        if (!shown.length) return "";
        const [t, , daily] = shown[0].value;
        const when = daily ? `${dateFmt.format(t)} · daily mean` : `${dateFmt.format(t)}, ${timeFmt.format(t)}`;
        return `<div style="font-size:13px;color:${ink2}">${when}</div>` + shown.map((p) => {
          const id = ids[p.seriesIndex];
          return `<div style="display:flex;align-items:center;gap:8px;margin-top:4px">` +
            `<span style="display:inline-block;width:14px;height:2px;background:${color(id)};border-radius:1px"></span>` +
            `<b style="font-size:16px">${fmtVal(p.value[1], id)} ${METRICS[id].unit}</b>` +
            `<span style="color:${ink2}">${METRICS[id].short}</span></div>`;
        }).join("");
      },
    },
    dataZoom: [
      { type: "inside", xAxisIndex: panelIdx, throttle: 50 },
      {
        type: "slider",
        xAxisIndex: panelIdx,
        height: L.slider,
        bottom: compact ? 4 : 12,
        showDetail: !compact,
        borderColor: grid,
        backgroundColor: "transparent",
        fillerColor: css("--wash"),
        dataBackground: { lineStyle: { color: muted, width: 1 }, areaStyle: { color: muted, opacity: 0.12 } },
        selectedDataBackground: { lineStyle: { color: color(ids[0]), width: 1 }, areaStyle: { color: color(ids[0]), opacity: 0.18 } },
        handleStyle: { color: surface, borderColor: muted },
        moveHandleStyle: { color: muted, opacity: 0.4 },
        textStyle: { color: muted },
        labelFormatter: (v) => shortDateFmt.format(v),
        brushSelect: false,
      },
    ],
    series: ids.map((id, i) => ({
      type: "line",
      name: METRICS[id].label,
      xAxisIndex: i,
      yAxisIndex: i,
      data: state.series[id],
      showSymbol: false,
      symbolSize: 8,
      connectNulls: false,
      // On the "times above" panel the visualMap colours the line, so it must not be fixed here.
      lineStyle: { width: 2, color: id === aboveId && above != null ? undefined : color(id) },
      itemStyle: { color: id === aboveId && above != null ? undefined : color(id), borderColor: surface, borderWidth: 2 },
      emphasis: { disabled: true },
      markLine: panelLines(id, compact, lastPoint(id)),
      markArea: pickedArea(),
      areaStyle: {
        color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
          { offset: 0, color: hexAlpha(color(id), 0.2) },
          { offset: 1, color: hexAlpha(color(id), 0) },
        ]),
      },
    })),
  };
}

function hexAlpha(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}

// Horizontal lines on a panel: the latest-value badge (phones) and the "times above" value.
function panelLines(id, compact, last) {
  const color = css(METRICS[id].color), alert = css("--critical");
  const data = [];
  if (compact && last) {
    data.push({
      yAxis: last[1],
      lineStyle: { color, type: "dashed", width: 1, opacity: 0.7 },
      label: { position: "end", formatter: fmtVal(last[1], id), backgroundColor: color, color: inkOn(color), padding: [2, 4], borderRadius: 2, fontSize: 10, fontWeight: 600 },
    });
  }
  // The Zalog level on a chosen reference day.
  const mark = state.zalog?.reference;
  if (id === "zalog" && mark) {
    data.push({
      yAxis: mark.value,
      lineStyle: { color: css("--ink"), type: "solid", width: 1.5, opacity: 0.75 },
      label: { position: "insideEndTop", formatter: `reference ${fmtVal(mark.value, id)} m (${shortDayFmt.format(dayBounds(mark.date)[0])})`, color: css("--ink"), fontSize: compact ? 10 : 11, fontWeight: 600 },
    });
  }
  // The Hrastje well's record high and low (shown when the view reaches them, e.g. with a "times above" value).
  if (id === "hrastje" && state.gw) {
    for (const [rec, word] of [[state.gw.record_high, "record high"], [state.gw.record_low, "record low"]]) {
      data.push({
        yAxis: rec.value,
        lineStyle: { color: css("--muted"), type: "dotted", width: 1.5 },
        label: { position: "insideEndTop", formatter: `${word} ${fmtVal(rec.value, id)} (${rec.date.slice(0, 4)})`, color: css("--ink-2"), fontSize: compact ? 10 : 11 },
      });
    }
  }
  const above = state.above[id];
  if (id === aboveMetric() && above != null) {
    data.push({
      yAxis: above,
      lineStyle: { color: alert, type: "dashed", width: 1.5, opacity: 0.9 },
      label: { position: "insideStartTop", formatter: `above ${fmtVal(above, id)} ${METRICS[id].unit}`, color: alert, fontSize: compact ? 10 : 11, fontWeight: 600 },
    });
  }
  return data.length ? { silent: true, symbol: "none", animation: false, data } : undefined;
}

// First and last time with data across the shown panels.
function dataBounds() {
  const all = panels().map((id) => state.series[id]).filter((p) => p?.length);
  if (!all.length) return null;
  return [Math.min(...all.map((p) => p[0][0])), Math.max(...all.map((p) => p[p.length - 1][0]))];
}

function rangeWindow(rangeId) {
  const b = dataBounds();
  if (!b) return [0, 0];
  const [first, last] = b;
  const r = RANGES.find((x) => x.id === rangeId);
  return [r.days === Infinity ? first : Math.max(first, last - r.days * DAY), last];
}

function setWindow([s, e]) {
  chart.setOption({ dataZoom: [{ startValue: s, endValue: e }, { startValue: s, endValue: e }] });
  onWindow(s, e);
}

function currentWindow() {
  const dz = chart.getOption().dataZoom[0];
  return [dz.startValue, dz.endValue];
}

let chartHeight = 0, chartCompact = null;
function renderChart(keepWindow) {
  chartCompact = isCompact();
  const win = keepWindow ? currentWindow() : rangeWindow(state.range);
  $("chart").classList.toggle("multi", panels().length > 1);
  $("chart").classList.toggle("multi-4", panels().length > 3);
  chart.resize();
  chartHeight = $("chart").clientHeight;
  chart.setOption(chartOption(), { notMerge: true });
  const b = dataBounds();
  if (b) {
    $("date").min = isoDay(b[0]);
    $("date").max = isoDay(Date.now());
  }
  setWindow(win);
}

// Called whenever the visible time window changes.
let lazyBusy = false;
async function onWindow(s, e) {
  state.window = [s, e];
  renderWindowStats();
  renderEmptyNotes();
  if ($("table").closest("details").open) renderTable();
  // Zoomed into an older stretch: fetch the measured months it covers (river station and groundwater well).
  if (lazyBusy || e - s > 120 * DAY) return;
  const todo = [...new Set(panels().map(sourceId))].map((id) => [id, missingMonths(id, s, e)]).filter(([, m]) => m.length);
  if (!todo.length) return;
  lazyBusy = true;
  try {
    if ((await Promise.all(todo.map(([id, m]) => loadMonths(id, m)))).some(Boolean)) {
      buildAllSeries();
      const span = dataBounds();
      chart.setOption({
        xAxis: panels().map(() => ({ min: span?.[0], max: span?.[1] })),
        series: panels().map((id) => ({ data: state.series[id] })),
      });
      renderAbove();
      setWindow([s, e]);
    }
  } finally {
    lazyBusy = false;
  }
}

// Measured months of a station that the window needs, contiguous back to what is loaded so the line has no holes.
function missingMonths(id, s, e) {
  const c = state.cache[id];
  if (!c?.meta) return [];
  const months = c.meta.live_months;
  const want = months.filter((m) => {
    const [y, mo] = m.split("-").map(Number);
    return Date.UTC(y, mo, 1) > s - DAY && Date.UTC(y, mo - 1, 1) < e + DAY;
  });
  if (!want.some((m) => !c.live.has(m))) return [];
  const first = months.indexOf(want[0]);
  const loadedFirst = Math.min(...[...c.live.keys()].map((m) => months.indexOf(m)));
  return months.slice(first, Math.max(loadedFirst, first + 1));
}

// A note inside any panel with nothing to show in the visible window (e.g. after VOKA's Zalog release ends).
let panelBoxes = [];
function renderEmptyNotes() {
  const ids = panels();
  const graphic = ids.map((id, i) => {
    const box = panelBoxes[i];
    if (!box || ids.length < 2 || visiblePoints(id).length) return { id: `empty-${i}`, type: "text", invisible: true, style: { text: "" } };
    const pts = (state.series[id] ?? []).filter((p) => p[1] != null);
    const until = pts.length && pts[pts.length - 1][0] < state.window[0] ? ` · data ends ${shortDayFmt.format(pts[pts.length - 1][0])}` : "";
    return {
      id: `empty-${i}`,
      type: "text",
      invisible: false,
      left: "center",
      top: box.top + box.height / 2 - 8,
      silent: true,
      style: { text: `No ${METRICS[id].short} data in this period${until}`, fill: css("--muted"), font: `13px ${css("--font")}` },
    };
  });
  chart.setOption({ graphic });
}

function visiblePoints(id) {
  const [s, e] = state.window;
  return (state.series[id] ?? []).filter((p) => p[1] != null && p[0] >= s && p[0] <= e);
}

// Rows of the visible window, one per timestamp, with a value per shown measurement.
function visibleRows() {
  const ids = panels();
  const byTime = new Map();
  for (const id of ids) {
    for (const [t, v, daily] of visiblePoints(id)) {
      const row = byTime.get(t) ?? { t, daily: !!daily, vals: {} };
      row.vals[id] = v;
      byTime.set(t, row);
    }
  }
  return { ids, rows: [...byTime.values()].sort((a, b) => a.t - b.t) };
}

function renderWindowStats() {
  renderDayReadout();
  const box = $("window-stats");
  box.replaceChildren();
  const ids = panels();
  const multi = ids.length > 1;
  box.classList.toggle("multi", multi);
  let anyDaily = false, anyLive = false;
  for (const id of ids) {
    const pts = visiblePoints(id);
    if (!pts.length) continue;
    let lo = pts[0], hi = pts[0], sum = 0;
    for (const p of pts) {
      if (p[1] < lo[1]) lo = p;
      if (p[1] > hi[1]) hi = p;
      sum += p[1];
      if (p[2]) anyDaily = true;
      else anyLive = true;
    }
    const unit = METRICS[id].unit;
    const dd = (v, t) => {
      const d = el("dd", null, `${fmtVal(v, id)} ${unit}`);
      if (t != null) d.append(el("span", null, shortDateFmt.format(t)));
      return d;
    };
    const items = [["Lowest", dd(lo[1], lo[0])], ["Highest", dd(hi[1], hi[0])], ["Average", dd(sum / pts.length)]];
    if (multi) {
      const row = el("div", "ws-row");
      const name = el("p", "ws-name");
      const key = el("span", "key");
      key.style.background = css(METRICS[id].color);
      name.append(key, METRICS[id].short);
      row.append(name);
      for (const [label, d] of items) row.append(wrapStat(label, d));
      box.append(row);
    } else {
      for (const [label, d] of items) box.append(wrapStat(`${label} in view`, d));
    }
  }
  if (anyDaily || anyLive) {
    const res = anyDaily ? "Daily means" + (anyLive ? " + measured" : "") : "Measured (10–60 min)";
    box.append(wrapStat("Resolution", el("dd", null, res)));
  }
}

const rowTime = (r) => (r.daily ? isoLocal(r.t).slice(0, 10) : isoLocal(r.t));

function renderTable() {
  const { ids, rows } = visibleRows();
  const MAX = 1000;
  $("table-note").textContent = rows.length > MAX
    ? `Showing the latest ${MAX} of ${rows.length} rows in view. Download for all of them.`
    : `${rows.length} rows in view.`;
  const thead = $("table").tHead, tbody = $("table").tBodies[0];
  thead.replaceChildren();
  const hr = thead.insertRow();
  for (const h of ["Time (Ljubljana)", ...ids.map((id) => `${METRICS[id].label} (${METRICS[id].unit})`), "Type"]) hr.append(el("th", null, h));
  const frag = document.createDocumentFragment();
  for (const r of rows.slice(-MAX).reverse()) {
    const tr = el("tr");
    tr.append(el("td", null, rowTime(r)));
    for (const id of ids) tr.append(el("td", null, r.vals[id] == null ? "" : fmtVal(r.vals[id], id)));
    tr.append(el("td", null, r.daily ? "daily mean" : "measured"));
    frag.append(tr);
  }
  tbody.replaceChildren(frag);
}

function downloadCsv() {
  const { ids, rows } = visibleRows();
  const st = state.byId[state.station];
  const lines = [["time_ljubljana", ...ids.map((id) => `${id}_${METRICS[id].unit.replace(/[^a-z0-9]/gi, "")}`), "type"].join(",")];
  for (const r of rows) lines.push([rowTime(r), ...ids.map((id) => r.vals[id] ?? ""), r.daily ? "daily_mean" : "measured"].join(","));
  const a = el("a");
  a.href = URL.createObjectURL(new Blob([lines.join("\n") + "\n"], { type: "text/csv" }));
  a.download = `${st.river}-${st.place}-${state.metric}.csv`.replace(/\s+/g, "_");
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------------------------------------------------------------- date picker

const pad2 = (n) => String(n).padStart(2, "0");
const isoDay = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
// Start and end of a calendar day in the viewer's time zone.
function dayBounds(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return [new Date(y, m - 1, d).getTime(), new Date(y, m - 1, d + 1).getTime()];
}
const dayFmt = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
const shortDayFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });

// The chosen day, shaded on every panel.
function pickedArea() {
  const ink = css("--ink");
  return {
    silent: true,
    itemStyle: { color: hexAlpha(ink, 0.07), borderColor: hexAlpha(ink, 0.35), borderWidth: 1, borderType: "dashed" },
    data: state.picked ? [[{ xAxis: dayBounds(state.picked)[0] }, { xAxis: dayBounds(state.picked)[1] }]] : [],
  };
}

// Centre the chart on a day, keeping the current zoom (or a month, when zoomed out further than a year).
function jumpToDate(iso) {
  state.picked = iso || null;
  renderDatePick();
  writeHash();
  if (!chart.getOption()?.series?.length) return;
  chart.setOption({ series: panels().map(() => ({ markArea: pickedArea() })) });
  const b = dataBounds();
  if (!state.picked || !b) {
    renderDayReadout();
    return;
  }
  const [a, z] = dayBounds(state.picked);
  const [s, e] = currentWindow();
  let span = e - s;
  if (!(span > 0) || span > 366 * DAY) span = 30 * DAY;
  span = Math.max(span, 2 * DAY);
  let start = (a + z) / 2 - span / 2, end = start + span;
  if (end > b[1]) { start -= end - b[1]; end = b[1]; }
  if (start < b[0]) { end = Math.min(b[1], end + (b[0] - start)); start = b[0]; }
  for (const btn of $("ranges").children) btn.setAttribute("aria-checked", "false");
  setWindow([start, end]);
}

function renderDatePick() {
  const set = !!state.picked;
  $("date-text").textContent = set ? shortDayFmt.format(dayBounds(state.picked)[0]) : "Date";
  $("date-text").closest(".date-button").classList.toggle("set", set);
  $("date").value = state.picked ?? "";
  $("date-clear").hidden = !set;
}

// One line with the chosen day's values, from the daily record (ARSO's archive, or the mean of our readings).
function renderDayReadout() {
  const box = $("day-readout");
  box.replaceChildren();
  box.hidden = !state.picked;
  if (!state.picked) return;
  // One river measurement: all three of the station's values. Stacked or groundwater view: what is shown.
  const ids = state.metric === ALL || state.metric === GROUND ? panels() : RIVER;
  const dayRow = (id) => state.cache[sourceId(id)]?.daily?.find((d) => d.date === state.picked);
  const value = (id, row) => (id === "hrastje" ? (row.level == null ? null : gwMetres(row.level)) : id === "zalog" ? row.level : row[id]);
  const vals = ids.map((id) => [id, dayRow(id)]).filter(([id, row]) => row && value(id, row) != null);
  box.append(el("b", null, dayFmt.format(dayBounds(state.picked)[0])), ": ");
  if (!vals.length) {
    const c = state.cache[sourceId(ids[0])];
    box.append(c?.meta ? noDataReason(c, state.picked) : "no data.");
    return;
  }
  vals.forEach(([id, row], i) => {
    if (i) box.append(" · ");
    box.append(`${METRICS[id].short} `, el("b", null, `${fmtVal(value(id, row), id)} ${METRICS[id].unit}`));
  });
  const src = vals[0][1].src;
  box.append(el("span", "note", { a: " · daily mean, validated by ARSO", v: " · daily value from VOKA SNAGA" }[src] ?? " · daily mean of the measured readings"));
}

function noDataReason(c, iso) {
  const archiveTo = c.meta.archive_to;
  if (c.meta.daily_from && iso < c.meta.daily_from) return `no data. This station's record starts on ${shortDayFmt.format(dayBounds(c.meta.daily_from)[0])}.`;
  if (archiveTo && iso > archiveTo) {
    // After ARSO's checked archive there are only our own readings and copies recovered from the Internet Archive.
    return `no data yet. ARSO's checked archive currently ends on ${shortDayFmt.format(dayBounds(archiveTo)[0])}, and no readings from this day were saved.`;
  }
  return "no reading for this day.";
}

// ---------------------------------------------------------------- times above a value

// The measurement "times above" works on: the one shown, or the water level in the stacked view.
function aboveMetric() {
  if (state.metric === GROUND) return panels().includes("zalog") ? "zalog" : panels()[0] ?? "hrastje";
  if (state.metric !== ALL) return state.metric;
  const has = panels();
  return has.includes("level") ? "level" : has[0];
}

// Every stretch where the line is above x, over the whole record.
function episodesAbove(id, x) {
  const out = [];
  let cur = null;
  for (const [t, v, daily] of state.series[id] ?? []) {
    if (v != null && v > x) {
      if (!cur) cur = { start: t, end: t, peak: v, peakT: t, daily: false };
      cur.end = t;
      if (v > cur.peak) { cur.peak = v; cur.peakT = t; }
      if (daily) cur.daily = true;
    } else if (cur) {
      out.push(cur);
      cur = null;
    }
  }
  if (cur) out.push({ ...cur, ongoing: true });
  return out;
}

function lasted(ep) {
  if (ep.daily) {
    const days = Math.round((ep.end - ep.start) / DAY) + 1;
    return days === 1 ? "1 day" : `${days} days`;
  }
  const h = (ep.end - ep.start) / 3600000;
  if (h < 1) return "under 1 h";
  return h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} days`;
}

let aboveShowAll = false;
function renderAbove() {
  const id = aboveMetric();
  const m = METRICS[id];
  const x = state.above[id];
  $("above-what").textContent = m.label[0].toLowerCase() + m.label.slice(1);
  $("above-unit").textContent = m.unit;
  if (document.activeElement !== $("above")) $("above").value = x ?? "";
  $("above-clear").hidden = x == null;

  // Suggestions: ARSO's flood-stage flows for this station.
  const dl = $("above-suggest");
  dl.replaceChildren();
  const stages = id === "flow" ? state.byId[state.station]?.thresholds?.flow : null;
  const suggest = Object.entries(stages ?? {}).map(([stage, v]) => [v, `Flood stage ${stage}`]);
  if (id === "zalog" && state.zalog) {
    if (state.zalog.reference) suggest.push([state.zalog.reference.value, `Reference (${state.zalog.reference.date})`]);
    suggest.push([state.zalog.highest.value, `Highest since ${state.zalog.first.slice(0, 4)} (${state.zalog.highest.date.slice(0, 4)})`]);
  }
  if (id === "hrastje" && state.gw) {
    suggest.push([state.gw.record_high.value, `Record high (${state.gw.record_high.date.slice(0, 4)})`]);
  }
  for (const [v, label] of suggest) {
    const o = el("option");
    o.value = v;
    o.label = label;
    dl.append(o);
  }

  const sum = $("above-summary"), list = $("above-list"), more = $("above-more");
  list.replaceChildren();
  sum.replaceChildren();
  sum.hidden = x == null;
  more.hidden = true;
  if (x == null) return;

  const eps = episodesAbove(id, x);
  const first = state.series[id]?.find((p) => p[1] != null);
  const since = first ? shortDayFmt.format(first[0]) : "";
  if (!eps.length) {
    sum.append(`Not above ${fmtVal(x, id)} ${m.unit} since ${since}.`);
  } else {
    const top = eps.reduce((a, b) => (b.peak > a.peak ? b : a));
    sum.append(el("b", null, eps.length === 1 ? "Once" : `${eps.length} times`), ` since ${since}. Highest: `,
      el("b", null, `${fmtVal(top.peak, id)} ${m.unit}`), ` on ${dayFmt.format(top.peakT)}.`);
  }
  if (eps.some((e) => e.daily) || !eps.length) {
    sum.append(el("span", "note", "Before live recording began, this uses ARSO's daily averages, so short peaks within a day may not show."));
  }

  const shown = aboveShowAll ? eps.slice().reverse() : eps.slice(-8).reverse(); // newest first
  for (const ep of shown) {
    const b = el("button");
    b.type = "button";
    const when = ep.daily || ep.end - ep.start >= DAY
      ? (isoDay(ep.start) === isoDay(ep.end) ? shortDayFmt.format(ep.start) : `${shortDayFmt.format(ep.start)} – ${shortDayFmt.format(ep.end)}`)
      : `${shortDayFmt.format(ep.start)}, ${timeFmt.format(ep.start)}–${timeFmt.format(ep.end)}`;
    const peak = el("span", "peak", "peak ");
    peak.append(el("b", null, `${fmtVal(ep.peak, id)} ${m.unit}`));
    b.append(el("span", "when", when), el("span", null, ep.ongoing ? "still above" : lasted(ep)), peak);
    b.title = "Show this on the chart";
    b.onclick = () => {
      jumpToDate(isoDay(ep.peakT));
      $("chart").scrollIntoView({ behavior: "smooth", block: "center" });
    };
    const li = el("li");
    li.append(b);
    list.append(li);
  }
  if (eps.length > 8) {
    more.hidden = false;
    more.textContent = aboveShowAll ? "Show only the latest 8" : `Show all ${eps.length}`;
  }
}

let aboveTimer = null;
function setAbove(raw) {
  const id = aboveMetric();
  const v = raw === "" || raw == null ? null : Number(raw);
  if (v != null && !Number.isFinite(v)) return;
  if (v == null) delete state.above[id];
  else state.above[id] = v;
  aboveShowAll = false;
  writeHash();
  renderChart(true);
  renderAbove();
}

// ---------------------------------------------------------------- page

function renderControls() {
  const metrics = $("metrics");
  metrics.replaceChildren();
  const has = available();
  const options = [...RIVER.map((id) => [id, METRICS[id].short, METRICS[id].label]), [GROUND, "Ground", "Groundwater at Zalog and Hrastje"], [ALL, "All", "Everything, stacked"]];
  for (const [id, label, title] of options) {
    const b = el("button", null, label);
    b.type = "button";
    b.title = title;
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(id === state.metric));
    b.disabled = id === ALL ? has.length < 2 : id === GROUND ? !has.some((x) => WELLS.includes(x)) : !has.includes(id);
    b.onclick = () => { state.metric = id; update(true); };
    metrics.append(b);
  }
  const ranges = $("ranges");
  ranges.replaceChildren();
  for (const r of RANGES) {
    const b = el("button", null, r.label);
    b.type = "button";
    b.title = r.title;
    b.setAttribute("aria-label", r.title);
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(r.id === state.range));
    b.onclick = () => {
      state.range = r.id;
      writeHash();
      for (const x of ranges.children) x.setAttribute("aria-checked", String(x === b));
      setWindow(rangeWindow(r.id));
    };
    ranges.append(b);
  }
}

function renderStationChips() {
  const nav = $("stations");
  nav.replaceChildren();
  for (const st of state.stations.filter((s) => s.tracked)) {
    const b = el("button", "chip");
    b.type = "button";
    b.setAttribute("aria-pressed", String(st.id === state.station));
    const meta = el("span", "meta", st.place);
    meta.append(el("span", "dist", ` · ${distLabel(st)}`));
    b.append(el("span", "river", st.river), meta);
    b.onclick = () => selectStation(st.id);
    nav.append(b);
  }
}

const distLabel = (st) => (st.dist_km == null ? "" : st.dist_km < 1 ? `${Math.round(st.dist_km * 1000)} m away` : `${st.dist_km.toFixed(1)} km away`);

function renderHero() {
  const st = state.byId[state.station];
  // In the stacked view the headline number is the first shown measurement (normally the level).
  const hm = state.metric === ALL ? panels()[0] ?? "level" : state.metric;
  if (hm === GROUND) return renderGroundHero();
  const m = METRICS[hm];
  $("hero-label").textContent = `${m.label} · ${st.river}, ${st.place}`;
  $("hero-value").textContent = fmtVal(st[hm], hm);
  $("hero-unit").textContent = st[hm] == null ? "" : m.unit;

  const trend = $("hero-trend");
  const c = state.cache[state.station];
  renderTrend(trend, liveRows(c).filter((r) => r[hm] != null).map((r) => [r.t, r[hm]]), hm);

  const stats = $("hero-stats");
  stats.replaceChildren();
  for (const id of RIVER) {
    const mm = METRICS[id];
    if (id === hm || st[id] == null) continue;
    const dd = el("dd", null, fmtVal(st[id], id));
    dd.append(el("small", null, mm.unit));
    stats.append(wrapStat(mm.label, dd));
  }
  if (st.time) {
    const t = Date.parse(st.time);
    const dd = el("dd", null, timeFmt.format(t));
    dd.append(el("small", "ago", ago(t)));
    stats.append(wrapStat("Measured", dd));
  }

  if (st[hm] == null) trend.textContent = "No live reading from ARSO right now. The chart shows the recorded history.";

  const status = $("status");
  status.replaceChildren();
  const cls = classify(st.flow_class) || classify(st.level_class);
  const flood = st.thresholds?.flow;
  status.hidden = !cls && !flood;
  if (cls) status.append(statusNode(cls, st.flow_class ? "Flow" : "Level"));
  if (flood) {
    const stages = Object.entries(flood).sort().map(([k, v]) => `${k}: ${fmtVal(v, "flow")}`).join(" · ");
    status.append(el("span", "thresholds", `Flood stages at ${stages} m³/s`));
  }
}

const liveRows = (c) => (c ? [...c.live.keys()].sort().flatMap((k) => c.live.get(k)) : []);

// Change over the last 24 hours, from measured [time, value] pairs (oldest first).
function renderTrend(box, live, metric) {
  box.replaceChildren();
  if (live.length < 2) return;
  const [lastT, lastV] = live[live.length - 1];
  const target = lastT - DAY;
  const before = live.reduce((best, r) => (Math.abs(r[0] - target) < Math.abs(best[0] - target) ? r : best), live[0]);
  if (Math.abs(before[0] - target) >= 2 * 3600000) return;
  const d = Math.round((lastV - before[1]) * 100) / 100;
  // A change in groundwater is plain metres, not metres above sea level.
  const unit = WELLS.includes(metric) ? "m" : METRICS[metric].unit;
  if (d === 0) box.textContent = "No change in the last 24 h";
  else box.append(el("span", d > 0 ? "up" : "down", `${d > 0 ? "▲ +" : "▼ −"}${fmtVal(Math.abs(d), metric)} ${unit}`), " in the last 24 h");
}

// Headline for groundwater: the live Hrastje well, and the Zalog well's reference and record.
function renderGroundHero() {
  const gw = state.gw;
  if (!gw) return;
  const m = METRICS.hrastje;
  $("hero-label").textContent = `Groundwater · ${gw.name}, ${distLabel(gw)} · live`;
  $("hero-value").textContent = fmtVal(gw.level, "hrastje");
  $("hero-unit").textContent = gw.level == null ? "" : m.unit;
  const trend = $("hero-trend");
  const live = liveRows(state.cache[gw.id]).filter((r) => r.level != null).map((r) => [r.t, gwMetres(r.level)]);
  renderTrend(trend, live, "hrastje");
  if (gw.level == null) trend.textContent = "No recent reading from ARSO. The chart shows the recorded history.";

  const stats = $("hero-stats");
  stats.replaceChildren();
  const metres = (v) => { const dd = el("dd", null, fmtVal(v, "hrastje")); dd.append(el("small", null, "m")); return dd; };
  if (gw.level != null) stats.append(wrapStat("Below ground at the well", metres(gw.surface - gw.level)));
  for (const [label, rec] of [["Record high", gw.record_high], ["Record low", gw.record_low]]) {
    const dd = metres(rec.value);
    dd.append(el("small", "ago", shortDayFmt.format(dayBounds(rec.date)[0])));
    stats.append(wrapStat(label, dd));
  }
  if (gw.time) {
    const t = Date.parse(gw.time);
    const dd = el("dd", null, timeFmt.format(t));
    dd.append(el("small", "ago", ago(t)));
    stats.append(wrapStat("Measured", dd));
  }

  const status = $("status");
  status.replaceChildren();
  if (gw.level != null) {
    const below = gw.record_high.value - gw.level;
    status.append(el("span", null, below > 0
      ? `Hrastje: ${fmtVal(below, "hrastje")} m below its record high (${gw.record_high.date.slice(0, 4)}).`
      : `Hrastje: at or above its record high (${gw.record_high.date.slice(0, 4)}).`));
  }
  // Zalog: its level on the reference day, and its highest.
  const z = state.zalog, mark = z?.reference;
  if (mark) {
    const over = z.highest.value - mark.value;
    status.append(el("span", "thresholds", `Zalog: reference ${fmtVal(mark.value, "zalog")} m (${shortDayFmt.format(dayBounds(mark.date)[0])}). ` +
      `Highest since ${z.first.slice(0, 4)}: ${fmtVal(z.highest.value, "zalog")} m on ${shortDayFmt.format(dayBounds(z.highest.date)[0])}` +
      (over > 0 ? `, ${fmtVal(over, "zalog")} m above that.` : ".")));
  }
  status.hidden = !status.childNodes.length;
}

function wrapStat(label, dd) {
  const d = el("div");
  d.append(el("dt", null, label), dd);
  return d;
}

function renderNearby() {
  const grid = $("nearby");
  grid.replaceChildren();
  const wells = [
    state.zalog && [state.zalog, `VOKA SNAGA well · daily, to ${shortDayFmt.format(dayBounds(state.zalog.last.date)[0])}`, state.zalog.last.value],
    state.gw && [state.gw, `ARSO groundwater well · ${state.gw.aquifer}`, state.gw.level],
  ].filter(Boolean);
  for (const [w, about, value] of wells) {
    const card = el("button", "station-card tracked");
    card.type = "button";
    card.onclick = () => { state.metric = GROUND; update(true); window.scrollTo({ top: 0, behavior: "smooth" }); };
    const meta = el("div", "meta", distLabel(w));
    meta.append(el("span", "extra", ` · ${about}`));
    card.append(el("div", "name", `Groundwater · ${w.name}`), meta);
    const vals = el("div", "vals");
    if (value != null) {
      const v = el("span");
      v.append(el("b", null, fmtVal(value, "zalog")), document.createTextNode(" m a.s.l."));
      vals.append(v);
    }
    card.append(vals);
    grid.append(card);
  }
  const near = state.stations.filter((s) => s.dist_km != null && s.dist_km <= 30).slice(0, 12);
  for (const st of near) {
    const card = el(st.tracked ? "button" : "div", "station-card" + (st.tracked ? " tracked" : ""));
    if (st.tracked) {
      card.type = "button";
      card.onclick = () => { selectStation(st.id); window.scrollTo({ top: 0, behavior: "smooth" }); };
    }
    const meta = el("div", "meta", distLabel(st));
    meta.append(el("span", "extra", ` · station ${st.id}${st.tracked ? " · history recorded" : ""}`));
    card.append(el("div", "name", `${st.river} · ${st.place}`), meta);
    const vals = el("div", "vals");
    for (const id of RIVER) {
      const m = METRICS[id];
      if (st[id] == null) continue;
      const v = el("span");
      v.append(el("b", null, fmtVal(st[id], id)), document.createTextNode(` ${m.unit}`));
      vals.append(v);
    }
    card.append(vals);
    const cls = classify(st.flow_class) || classify(st.level_class);
    if (cls) {
      const c = el("div", "cls");
      c.append(statusNode(cls));
      card.append(c);
    }
    grid.append(card);
  }
}

// ---------------------------------------------------------------- state & routing

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  if (p.get("s") && state.byId[p.get("s")]?.tracked) state.station = p.get("s");
  if (METRICS[p.get("m")] || p.get("m") === ALL || p.get("m") === GROUND) state.metric = p.get("m");
  if (RANGES.some((r) => r.id === p.get("r"))) state.range = p.get("r");
  if (/^\d{4}-\d{2}-\d{2}$/.test(p.get("d") ?? "")) state.picked = p.get("d");
  for (const id of Object.keys(METRICS)) {
    const v = Number(p.get(`a${id[0]}`));
    if (p.get(`a${id[0]}`) && Number.isFinite(v)) state.above[id] = v;
  }
}
function writeHash() {
  const above = Object.entries(state.above).map(([id, v]) => `&a${id[0]}=${v}`).join("");
  history.replaceState(null, "", `#s=${state.station}&m=${state.metric}&r=${state.range}${state.picked ? `&d=${state.picked}` : ""}${above}`);
}

async function selectStation(id) {
  state.station = id;
  await update();
}

// keepWindow: stay on the same time range (switching measurement), instead of the range preset.
async function update(keepWindow = false) {
  writeHash();
  renderStationChips();
  $("chart").classList.add("loading");
  try {
    // The groundwater wells are a bonus: the river station must load, a well may fail.
    const well = (w) => w && stationData(w.id).catch(() => delete state.cache[w.id]);
    await Promise.all([stationData(state.station), well(state.gw), well(state.zalog)]);
    const has = available();
    const ok = state.metric === ALL ? has.length >= 2 : state.metric === GROUND ? has.some((x) => WELLS.includes(x)) : has.includes(state.metric);
    if (!ok) state.metric = has[0] ?? "level";
    buildAllSeries();
    renderHero();
    renderControls();
    renderChart(keepWindow && chart.getOption()?.series?.length > 0);
    renderAbove();
    if (state.picked && !keepWindow) jumpToDate(state.picked);
  } catch (err) {
    showError(`Could not load data for this station (${err.message}).`);
  } finally {
    $("chart").classList.remove("loading");
  }
}

function showError(msg) {
  const box = el("p", "error", msg);
  document.querySelector("main").prepend(box);
}

async function init() {
  chart = echarts.init($("chart"), null, { renderer: "canvas" });
  chart.on("datazoom", () => {
    const [s, e] = currentWindow();
    // A manual zoom no longer matches a preset.
    for (const b of $("ranges").children) b.setAttribute("aria-checked", "false");
    onWindow(s, e);
  });
  new ResizeObserver(() => {
    chart.resize();
    const changed = $("chart").clientHeight !== chartHeight || isCompact() !== chartCompact;
    if (changed && Object.keys(state.series).length) renderChart(true);
  }).observe($("chart"));
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => renderChart(true));
  $("download").onclick = downloadCsv;
  $("date").addEventListener("change", (e) => jumpToDate(e.target.value));
  // Open the calendar wherever the button is clicked (desktop browsers otherwise only open it from a tiny icon).
  $("date").addEventListener("click", () => { try { $("date").showPicker(); } catch { /* older browsers: typing still works */ } });
  $("date-clear").onclick = () => jumpToDate(null);
  // A different RiverChart link pasted into an open tab (our own updates use replaceState, which doesn't fire this).
  window.addEventListener("hashchange", () => {
    state.picked = null;
    state.above = {};
    readHash();
    renderDatePick();
    update();
  });
  $("above").addEventListener("input", (e) => {
    clearTimeout(aboveTimer);
    aboveTimer = setTimeout(() => setAbove(e.target.value.trim()), 400);
  });
  $("above-clear").onclick = () => { $("above").value = ""; setAbove(null); };
  $("above-more").onclick = () => { aboveShowAll = !aboveShowAll; renderAbove(); };
  $("table").closest("details").addEventListener("toggle", (e) => e.target.open && renderTable());

  let catalogue;
  try {
    catalogue = JSON.parse(await getText("stations.json"));
  } catch (err) {
    showError("No data yet. The first data update has probably not run. Check back in a few minutes.");
    return;
  }
  state.stations = catalogue.stations;
  state.byId = Object.fromEntries(catalogue.stations.map((s) => [s.id, s]));
  state.gw = catalogue.groundwater ?? null;
  state.zalog = catalogue.groundwater_zalog ?? null;
  state.station = state.byId[catalogue.default]?.tracked ? catalogue.default : catalogue.stations.find((s) => s.tracked)?.id;
  readHash();
  const gen = Date.parse(catalogue.generated);
  $("updated").textContent = `Data refreshed ${ago(gen)}`;
  $("updated").append(el("span", "extra", " · every 30 min"));
  $("updated").title = dateFmt.format(gen) + " " + timeFmt.format(gen);
  renderNearby();
  if (state.station) await update();
}

// ---------------------------------------------------------------- theme preference

// Kept in localStorage on this device only; nothing is sent anywhere. No cookies.
const prefs = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode: choice lasts this visit */ } },
};

const THEMES = {
  auto: { label: "Auto", next: "light", icon: '<circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 2a6 6 0 0 1 0 12z" fill="currentColor"/>' },
  light: { label: "Light", next: "dark", icon: '<circle cx="8" cy="8" r="3" fill="currentColor"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6L13 13M3 13l1.4-1.4M11.6 4.4L13 3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>' },
  dark: { label: "Dark", next: "auto", icon: '<path d="M13.5 9.5A6 6 0 0 1 6.5 2.5a6 6 0 1 0 7 7z" fill="currentColor"/>' },
};

function applyTheme(name) {
  if (name === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = name;
  const t = THEMES[name], b = $("theme");
  b.innerHTML = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">${t.icon}</svg><span class="label"></span>`;
  b.querySelector(".label").textContent = t.label;
  b.setAttribute("aria-label", `Colour theme: ${t.label}. Switch to ${THEMES[t.next].label}.`);
  b.title = `Theme: ${t.label} (click for ${THEMES[t.next].label})`;
  b.onclick = () => { prefs.set("rc-theme", t.next); applyTheme(t.next); };
  if (chart && Object.keys(state.series).length) renderChart(true);
}

function setupPrefs() {
  const saved = prefs.get("rc-theme");
  applyTheme(THEMES[saved] ? saved : "auto");
}

setupPrefs();
if (window.echarts) init();
else window.addEventListener("load", () => (window.echarts ? init() : showError("The chart library failed to load.")));
