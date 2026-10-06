"use strict";

const DATA = "data/";
const DAY = 86400000;
const TZ = "Europe/Ljubljana";

const METRICS = {
  level: { label: "Water level", short: "Level", unit: "cm", digits: 0 },
  flow: { label: "Flow", short: "Flow", unit: "m³/s", digits: 1 },
  temp: { label: "Water temperature", short: "Temperature", unit: "°C", digits: 1 },
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
  points: [],
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

let chart;
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function chartOption() {
  const m = METRICS[state.metric];
  const ink2 = css("--ink-2"), muted = css("--muted"), grid = css("--grid"), axis = css("--axis");
  const series = css("--series"), surface = css("--surface");
  return {
    animation: false,
    textStyle: { fontFamily: css("--font") },
    grid: { left: 8, right: 16, top: 28, bottom: 78, containLabel: true },
    xAxis: {
      type: "time",
      axisLine: { lineStyle: { color: axis } },
      axisTick: { show: false },
      axisLabel: { color: muted, hideOverlap: true },
      splitLine: { show: false },
    },
    yAxis: {
      type: "value",
      scale: state.metric !== "flow",
      min: state.metric === "flow" ? 0 : undefined,
      name: m.unit,
      nameTextStyle: { color: muted, align: "right", padding: [0, 6, 0, 0] },
      axisLabel: { color: muted },
      splitLine: { lineStyle: { color: grid } },
    },
    tooltip: {
      trigger: "axis",
      backgroundColor: surface,
      borderColor: css("--border"),
      textStyle: { color: css("--ink") },
      axisPointer: { type: "line", lineStyle: { color: muted, width: 1 }, label: { show: false } },
      formatter: (params) => {
        const p = params.find((x) => x.value[1] != null);
        if (!p) return "";
        const [t, v, daily] = p.value;
        const when = daily ? `${dateFmt.format(t)} · daily mean` : `${dateFmt.format(t)}, ${timeFmt.format(t)}`;
        return `<div style="font-size:13px;color:${ink2}">${when}</div>` +
          `<div style="display:flex;align-items:center;gap:8px;margin-top:4px">` +
          `<span style="display:inline-block;width:14px;height:2px;background:${series};border-radius:1px"></span>` +
          `<b style="font-size:16px">${fmtVal(v, state.metric)} ${m.unit}</b>` +
          `<span style="color:${ink2}">${m.short}</span></div>`;
      },
    },
    dataZoom: [
      { type: "inside", throttle: 50 },
      {
        type: "slider",
        height: 34,
        bottom: 12,
        borderColor: grid,
        backgroundColor: "transparent",
        fillerColor: css("--wash"),
        dataBackground: { lineStyle: { color: muted, width: 1 }, areaStyle: { color: muted, opacity: 0.12 } },
        selectedDataBackground: { lineStyle: { color: series, width: 1 }, areaStyle: { color: series, opacity: 0.18 } },
        handleStyle: { color: surface, borderColor: muted },
        moveHandleStyle: { color: muted, opacity: 0.4 },
        textStyle: { color: muted },
        labelFormatter: (v) => shortDateFmt.format(v),
        brushSelect: false,
      },
    ],
    series: [{
      type: "line",
      name: m.label,
      data: state.points,
      showSymbol: false,
      symbolSize: 8,
      connectNulls: false,
      lineStyle: { width: 2, color: series },
      itemStyle: { color: series, borderColor: surface, borderWidth: 2 },
      emphasis: { disabled: true },
      areaStyle: {
        color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
          { offset: 0, color: hexAlpha(series, 0.22) },
          { offset: 1, color: hexAlpha(series, 0) },
        ]),
      },
    }],
  };
}

function hexAlpha(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}

function rangeWindow(rangeId) {
  const pts = state.points;
  if (!pts.length) return [0, 0];
  const first = pts[0][0], last = pts[pts.length - 1][0];
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

function renderChart(keepWindow) {
  const win = keepWindow ? currentWindow() : rangeWindow(state.range);
  chart.setOption(chartOption(), { replaceMerge: ["series"] });
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
      state.points = buildPoints(c, state.metric);
      chart.setOption({ series: [{ data: state.points }] });
      setWindow([s, e]);
    }
  } finally {
    lazyBusy = false;
  }
}

function visiblePoints() {
  const [s, e] = state.window;
  return state.points.filter((p) => p[1] != null && p[0] >= s && p[0] <= e);
}

function renderWindowStats() {
  const pts = visiblePoints();
  const box = $("window-stats");
  box.replaceChildren();
  if (!pts.length) return;
  let lo = pts[0], hi = pts[0], sum = 0;
  for (const p of pts) {
    if (p[1] < lo[1]) lo = p;
    if (p[1] > hi[1]) hi = p;
    sum += p[1];
  }
  const unit = METRICS[state.metric].unit;
  const item = (label, v, t) => {
    const dd = el("dd", null, `${fmtVal(v, state.metric)} ${unit}`);
    if (t != null) dd.append(el("span", null, shortDateFmt.format(t)));
    box.append(wrapStat(label, dd));
  };
  item("Lowest in view", lo[1], lo[0]);
  item("Highest in view", hi[1], hi[0]);
  item("Average in view", sum / pts.length);
  const daily = pts.some((p) => p[2]);
  box.append(wrapStat("Resolution", el("dd", null, daily ? "Daily means" + (pts.some((p) => !p[2]) ? " + measured" : "") : "Measured (10–60 min)")));
}

function renderTable() {
  const pts = visiblePoints();
  const m = METRICS[state.metric];
  const MAX = 1000;
  const rows = pts.slice(-MAX).reverse();
  $("table-note").textContent = pts.length > MAX
    ? `Showing the latest ${MAX} of ${pts.length} values in view. Download for all of them.`
    : `${pts.length} values in view.`;
  const thead = $("table").tHead, tbody = $("table").tBodies[0];
  thead.replaceChildren();
  const hr = thead.insertRow();
  for (const h of ["Time (Ljubljana)", `${m.label} (${m.unit})`, "Type"]) hr.append(el("th", null, h));
  const frag = document.createDocumentFragment();
  for (const [t, v, daily] of rows) {
    const tr = el("tr");
    tr.append(el("td", null, daily ? isoLocal(t).slice(0, 10) : isoLocal(t)), el("td", null, fmtVal(v, state.metric)), el("td", null, daily ? "daily mean" : "measured"));
    frag.append(tr);
  }
  tbody.replaceChildren(frag);
}

function downloadCsv() {
  const m = METRICS[state.metric];
  const st = state.byId[state.station];
  const lines = [`time_ljubljana,${state.metric}_${m.unit.replace(/[^a-z0-9]/gi, "")},type`];
  for (const [t, v, daily] of visiblePoints()) lines.push(`${daily ? isoLocal(t).slice(0, 10) : isoLocal(t)},${v},${daily ? "daily_mean" : "measured"}`);
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
  const st = state.byId[state.station];
  for (const [id, m] of Object.entries(METRICS)) {
    const b = el("button", null, m.short);
    b.type = "button";
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(id === state.metric));
    const c = state.cache[state.station];
    const has = st?.[id] != null || c?.daily?.some((d) => d[id] != null);
    b.disabled = !has;
    b.onclick = () => { state.metric = id; update(); };
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
    b.append(el("span", "river", st.river), el("span", "meta", `${st.place} · ${distLabel(st)}`));
    b.onclick = () => selectStation(st.id);
    nav.append(b);
  }
}

const distLabel = (st) => (st.dist_km == null ? "" : st.dist_km < 1 ? `${Math.round(st.dist_km * 1000)} m away` : `${st.dist_km.toFixed(1)} km away`);

function renderHero() {
  const st = state.byId[state.station];
  const m = METRICS[state.metric];
  $("hero-label").textContent = `${m.label} · ${st.river}, ${st.place}`;
  $("hero-value").textContent = fmtVal(st[state.metric], state.metric);
  $("hero-unit").textContent = st[state.metric] == null ? "" : m.unit;

  // Change over the last 24 hours, from the measured readings.
  const trend = $("hero-trend");
  trend.replaceChildren();
  const c = state.cache[state.station];
  const live = c ? [...c.live.keys()].sort().flatMap((k) => c.live.get(k)).filter((r) => r[state.metric] != null) : [];
  if (live.length > 1) {
    const last = live[live.length - 1];
    const target = last.t - DAY;
    const before = live.reduce((best, r) => (Math.abs(r.t - target) < Math.abs(best.t - target) ? r : best), live[0]);
    if (Math.abs(before.t - target) < 2 * 3600000) {
      const d = last[state.metric] - before[state.metric];
      if (d === 0) trend.textContent = "No change in the last 24 h";
      else trend.append(el("span", d > 0 ? "up" : "down", `${d > 0 ? "▲ +" : "▼ −"}${fmtVal(Math.abs(d), state.metric)} ${m.unit}`), " in the last 24 h");
    }
  }

  const stats = $("hero-stats");
  stats.replaceChildren();
  for (const [id, mm] of Object.entries(METRICS)) {
    if (id === state.metric || st[id] == null) continue;
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

  if (st[state.metric] == null) trend.textContent = "No live reading from ARSO right now. The chart shows the recorded history.";

  const status = $("status");
  status.replaceChildren();
  const cls = classify(st.flow_class) || classify(st.level_class);
  const flood = st.thresholds?.flow;
  status.hidden = !cls && !flood;
  if (cls) status.append(statusNode(cls, st.flow_class ? "Flow" : "Level"));
  if (flood) {
    const stages = Object.entries(flood).sort().map(([k, v]) => `${k}: ${fmtVal(v, "flow")}`).join(" · ");
    status.append(el("span", "thresholds", `${cls ? "· " : ""}Flood stages at ${stages} m³/s`));
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
    card.append(el("div", "name", `${st.river} · ${st.place}`), el("div", "meta", `${distLabel(st)} · station ${st.id}${st.tracked ? " · history recorded" : ""}`));
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
  if (METRICS[p.get("m")]) state.metric = p.get("m");
  if (RANGES.some((r) => r.id === p.get("r"))) state.range = p.get("r");
}
function writeHash() {
  history.replaceState(null, "", `#s=${state.station}&m=${state.metric}&r=${state.range}`);
}

async function selectStation(id) {
  state.station = id;
  await update();
}

async function update() {
  writeHash();
  renderStationChips();
  $("chart").classList.add("loading");
  try {
    const c = await stationData(state.station);
    const st = state.byId[state.station];
    if (st[state.metric] == null && !c.daily.some((d) => d[state.metric] != null)) {
      state.metric = Object.keys(METRICS).find((k) => st[k] != null) ?? "level";
    }
    state.points = buildPoints(c, state.metric);
    renderHero();
    renderControls();
    renderChart(false);
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
  new ResizeObserver(() => chart.resize()).observe($("chart"));
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
  $("updated").textContent = `Data refreshed ${ago(gen)} · every 30 min`;
  $("updated").title = dateFmt.format(gen) + " " + timeFmt.format(gen);
  renderNearby();
  if (state.station) await update();
}

if (window.echarts) init();
else window.addEventListener("load", () => (window.echarts ? init() : showError("The chart library failed to load.")));
