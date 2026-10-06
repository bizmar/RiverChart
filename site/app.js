"use strict";

const DATA = "data/";
const DAY = 86400000;
const TZ = "Europe/Ljubljana";

const METRICS = {
  level: { label: "Water level", short: "Level", unit: "cm", digits: 0, color: "--c-level" },
  flow: { label: "Flow", short: "Flow", unit: "m³/s", digits: 1, color: "--c-flow" },
  temp: { label: "Water temperature", short: "Temperature", unit: "°C", digits: 1, color: "--c-temp" },
};
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
    [/srednj|normal|povpre/, "good", "Normal"],
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
    return { t: Date.UTC(y, m - 1, d, 11), level: num(r.level), flow: num(r.flow), temp: num(r.temp), daily: true, src: r.src };
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

// One continuous line: validated daily means first, then measured live readings.
function buildPoints(c, metric) {
  const live = [...c.live.keys()].sort().flatMap((m) => c.live.get(m)).filter((r) => r[metric] != null);
  const liveStart = live.length ? live[0].t : Infinity;
  const pts = [];
  let prev = null;
  const push = (t, v, daily, maxGap) => {
    if (prev != null && t - prev > maxGap) pts.push([prev + 1, null]); // break the line across gaps
    pts.push(daily ? [t, v, 1] : [t, v]);
    prev = t;
  };
  for (const d of c.daily) if (d.t < liveStart - DAY / 2 && d[metric] != null) push(d.t, d[metric], true, 4 * DAY);
  for (const [i, r] of live.entries()) push(r.t, r[metric], false, i === 0 ? 4 * DAY : 6 * 3600000);
  return pts;
}

// ---------------------------------------------------------------- chart

// state.metric is one of METRICS, or ALL for the three measurements stacked on one time axis.
const ALL = "all";
let chart;
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// Measurements this station has any data for.
function available() {
  const st = state.byId[state.station];
  const c = state.cache[state.station];
  const live = c ? [...c.live.values()].flat() : [];
  return Object.keys(METRICS).filter((k) => st?.[k] != null || c?.daily?.some((d) => d[k] != null) || live.some((r) => r[k] != null));
}
const panels = () => (state.metric === ALL ? available() : [state.metric]);
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
  const c = state.cache[state.station];
  state.series = Object.fromEntries(panels().map((id) => [id, buildPoints(c, id)]));
}

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
  const h = (H - L.top - L.bottom - L.gap * (n - 1)) / n;
  const panelTop = (i) => L.top + i * (h + L.gap);
  const panelIdx = ids.map((_, i) => i);
  // Panel titles: always in the stacked view, and on phones (where the unit has no room on the axis).
  const titled = compact || n > 1;
  const lastPoint = (id) => { const p = state.series[id]; for (let i = p.length - 1; i >= 0; i--) if (p[i][1] != null) return p[i]; return null; };
  return {
    animation: false,
    textStyle: { fontFamily: css("--font") },
    axisPointer: { link: [{ xAxisIndex: "all" }], lineStyle: { color: muted, width: 1 }, label: { show: false } },
    title: titled ? ids.map((id, i) => ({
      text: `{k|━━} ${METRICS[id].label} (${METRICS[id].unit})`,
      left: compact ? 4 : 8,
      top: panelTop(i) - (compact ? 19 : 26),
      textStyle: { fontSize: compact ? 11 : 13, fontWeight: 600, color: ink2, rich: { k: { color: color(id), fontSize: compact ? 9 : 10 } } },
    })) : [],
    grid: ids.map((_, i) => ({ left: L.left, right: L.right, top: panelTop(i), height: h })),
    xAxis: ids.map((_, i) => ({
      type: "time",
      gridIndex: i,
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
      min: id === "flow" ? 0 : undefined,
      position: compact ? "right" : "left",
      name: titled ? "" : METRICS[id].unit,
      nameTextStyle: { color: muted, align: "right", padding: [0, 6, 0, 0] },
      splitNumber: compact || n > 1 ? 3 : 5,
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
      lineStyle: { width: 2, color: color(id) },
      itemStyle: { color: color(id), borderColor: surface, borderWidth: 2 },
      emphasis: { disabled: true },
      // Phones: TradingView-style badge with the latest value on the value scale.
      markLine: compact && lastPoint(id) ? {
        silent: true,
        symbol: "none",
        animation: false,
        lineStyle: { color: color(id), type: "dashed", width: 1, opacity: 0.7 },
        label: {
          position: "end",
          formatter: fmtVal(lastPoint(id)[1], id),
          backgroundColor: color(id),
          color: inkOn(color(id)),
          padding: [2, 4],
          borderRadius: 2,
          fontSize: 10,
          fontWeight: 600,
        },
        data: [{ yAxis: lastPoint(id)[1] }],
      } : undefined,
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

function rangeWindow(rangeId) {
  const all = panels().map((id) => state.series[id]).filter((p) => p?.length);
  if (!all.length) return [0, 0];
  const first = Math.min(...all.map((p) => p[0][0]));
  const last = Math.max(...all.map((p) => p[p.length - 1][0]));
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
  chart.resize();
  chartHeight = $("chart").clientHeight;
  chart.setOption(chartOption(), { notMerge: true });
  setWindow(win);
}

// Called whenever the visible time window changes.
let lazyBusy = false;
async function onWindow(s, e) {
  state.window = [s, e];
  renderWindowStats();
  if ($("table").closest("details").open) renderTable();
  // Zoomed into an older stretch: fetch the measured months it covers.
  const c = state.cache[state.station];
  if (lazyBusy || !c || e - s > 120 * DAY) return;
  const want = c.meta.live_months.filter((m) => {
    const [y, mo] = m.split("-").map(Number);
    return Date.UTC(y, mo, 1) > s - DAY && Date.UTC(y, mo - 1, 1) < e + DAY;
  });
  if (!want.some((m) => !c.live.has(m))) return;
  lazyBusy = true;
  try {
    // Load contiguous months back to what we have, so the live line has no holes.
    const first = c.meta.live_months.indexOf(want[0]);
    const loadedFirst = Math.min(...[...c.live.keys()].map((m) => c.meta.live_months.indexOf(m)));
    if (await loadMonths(state.station, c.meta.live_months.slice(first, Math.max(loadedFirst, first + 1)))) {
      buildAllSeries();
      chart.setOption({ series: panels().map((id) => ({ data: state.series[id] })) });
      setWindow([s, e]);
    }
  } finally {
    lazyBusy = false;
  }
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

// ---------------------------------------------------------------- page

function renderControls() {
  const metrics = $("metrics");
  metrics.replaceChildren();
  const has = available();
  const options = [...Object.entries(METRICS).map(([id, m]) => [id, m.short, m.label]), [ALL, "All", "All three, stacked"]];
  for (const [id, label, title] of options) {
    const b = el("button", null, label);
    b.type = "button";
    b.title = title;
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(id === state.metric));
    b.disabled = id === ALL ? has.length < 2 : !has.includes(id);
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
  const m = METRICS[hm];
  $("hero-label").textContent = `${m.label} · ${st.river}, ${st.place}`;
  $("hero-value").textContent = fmtVal(st[hm], hm);
  $("hero-unit").textContent = st[hm] == null ? "" : m.unit;

  // Change over the last 24 hours, from the measured readings.
  const trend = $("hero-trend");
  trend.replaceChildren();
  const c = state.cache[state.station];
  const live = c ? [...c.live.keys()].sort().flatMap((k) => c.live.get(k)).filter((r) => r[hm] != null) : [];
  if (live.length > 1) {
    const last = live[live.length - 1];
    const target = last.t - DAY;
    const before = live.reduce((best, r) => (Math.abs(r.t - target) < Math.abs(best.t - target) ? r : best), live[0]);
    if (Math.abs(before.t - target) < 2 * 3600000) {
      const d = last[hm] - before[hm];
      if (d === 0) trend.textContent = "No change in the last 24 h";
      else trend.append(el("span", d > 0 ? "up" : "down", `${d > 0 ? "▲ +" : "▼ −"}${fmtVal(Math.abs(d), hm)} ${m.unit}`), " in the last 24 h");
    }
  }

  const stats = $("hero-stats");
  stats.replaceChildren();
  for (const [id, mm] of Object.entries(METRICS)) {
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

function wrapStat(label, dd) {
  const d = el("div");
  d.append(el("dt", null, label), dd);
  return d;
}

function renderNearby() {
  const grid = $("nearby");
  grid.replaceChildren();
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
    for (const [id, m] of Object.entries(METRICS)) {
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
  if (METRICS[p.get("m")] || p.get("m") === ALL) state.metric = p.get("m");
  if (RANGES.some((r) => r.id === p.get("r"))) state.range = p.get("r");
}
function writeHash() {
  history.replaceState(null, "", `#s=${state.station}&m=${state.metric}&r=${state.range}`);
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
    const c = await stationData(state.station);
    const has = available();
    if (state.metric === ALL ? has.length < 2 : !has.includes(state.metric)) state.metric = has[0] ?? "level";
    buildAllSeries();
    renderHero();
    renderControls();
    renderChart(keepWindow && chart.getOption()?.series?.length > 0);
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
