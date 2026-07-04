// Singapore HDB resale prices — 3D time-scrubbable map.
//
// Rendering: MapLibre dark basemap + deck.gl SolidPolygonLayer extruding real
// building footprints at real heights. Color encodes trailing-12-month average
// price per m² per building (sequential blue ramp, light = expensive, anchored
// for the dark surface). Buildings not yet completed at the scrubbed date are
// hidden — estates rise out of the ground as time plays.
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { SolidPolygonLayer, PathLayer, TextLayer } from "@deck.gl/layers";
import { EVENTS, type Era } from "./events";
import { initPanel, showPanel, hidePanel } from "./panel";
import { initSearch, type SearchPick, type AnswerItem, type Suggestion } from "./search";
import { parseQuery, hasConstraints, type Parsed } from "./query";
import { RAMP, LUT } from "./ramp";
import { DataFilterExtension } from "@deck.gl/extensions";

type Building = {
  block: string;
  street: string;
  town: number;
  lat: number;
  lon: number;
  postal: string;
  floors: number;
  year: number;
  units: number;
  footprint: [number, number][] | null;
};

// ------------------------------------------------------------ url state ----
// Shareable moments: #m=<monthIdx>&c=<now|all>&cam=<lon,lat,zoom,pitch,bearing>

const hashState = (() => {
  const p = new URLSearchParams(location.hash.slice(1));
  const cam = p.get("cam")?.split(",").map(Number);
  return {
    m: p.has("m") ? Number(p.get("m")) : null,
    mode: p.get("c") === "all" ? ("history" as const) : p.get("c") === "now" ? ("now" as const) : null,
    cam: cam && cam.length === 5 && cam.every((x) => Number.isFinite(x)) ? cam : null,
    b: p.get("b"),
  };
})();

// ---------------------------------------------------------------- map ----
// Created before the data fetch so basemap tiles stream while the ~30MB of
// transaction data downloads.

const map = new maplibregl.Map({
  container: "map",
  style: "https://basemaps.cartocdn.com/gl/dark-matter-nolabels-gl-style/style.json",
  center: hashState.cam ? [hashState.cam[0], hashState.cam[1]] : [103.82, 1.352],
  zoom: hashState.cam?.[2] ?? 11.2,
  pitch: hashState.cam?.[3] ?? 55,
  bearing: hashState.cam?.[4] ?? -12,
  maxPitch: 70,
  antialias: true,
});
const mapLoaded = new Promise<void>((res) => map.on("load", () => res()));

// ---------------------------------------------------------------- data ----

const [meta, buildings, bin] = await Promise.all([
  fetch("/data/meta.json").then((r) => r.json()),
  fetch("/data/buildings.json").then((r) => r.json()) as Promise<Building[]>,
  fetch("/data/transactions.bin").then((r) => r.arrayBuffer()),
]);

const TYPES: Record<string, any> = { Uint8Array, Uint16Array, Uint32Array };
const col: Record<string, Uint8Array | Uint16Array | Uint32Array> = {};
for (const c of meta.layout) col[c.name] = new TYPES[c.type](bin, c.offset, c.length);

const N = meta.count as number;
const B = buildings.length;
const M = (meta.maxMonth as number) + 1;

// Per-building per-month aggregates, then a trailing-window pass per tick.
const psmSum = new Float32Array(B * M);
const priceSum = new Float32Array(B * M);
const cnt = new Uint16Array(B * M);
for (let i = 0; i < N; i++) {
  const idx = col.building[i] * M + col.month[i];
  const sqm = col.sqmX10[i] / 10;
  psmSum[idx] += col.price[i] / sqm;
  priceSum[idx] += col.price[i];
  cnt[idx]++;
}

// Prices bucketed by month (for the ticker's trailing-window median) and
// per-month totals. Built once; the window pass copies month slices into a
// scratch buffer and sorts.
const monthTotals = new Uint32Array(M);
for (let i = 0; i < N; i++) monthTotals[col.month[i]]++;
const monthOffsets = new Uint32Array(M + 1);
for (let m = 0; m < M; m++) monthOffsets[m + 1] = monthOffsets[m] + monthTotals[m];
const monthPrices = new Uint32Array(N);
{
  const cursor = monthOffsets.slice(0, M);
  for (let i = 0; i < N; i++) monthPrices[cursor[col.month[i]]++] = col.price[i];
}
const medianScratch = new Uint32Array(N);

// Sorted completion years for the "blocks built" counter (0 = unknown,
// counted as always present).
const knownYears = buildings.map((b) => b.year).filter(Boolean).sort((a, b) => a - b);
const unknownYears = B - knownYears.length;

// Per-building transaction index (for the block panel).
const txCounts = new Uint32Array(B);
for (let i = 0; i < N; i++) txCounts[col.building[i]]++;
const txOffsets = new Uint32Array(B + 1);
for (let b = 0; b < B; b++) txOffsets[b + 1] = txOffsets[b] + txCounts[b];
const txIndex = new Uint32Array(N);
{
  const cursor = txOffsets.slice(0, B);
  for (let i = 0; i < N; i++) txIndex[cursor[col.building[i]]++] = i;
}
const byPostal = new Map<string, number>(buildings.map((b, i) => [b.postal, i]));

// Town centroids for omnibox "fly to town".
const townCenters: { lat: number; lon: number; n: number }[] =
  meta.enums.towns.map(() => ({ lat: 0, lon: 0, n: 0 }));
for (const b of buildings) {
  const t = townCenters[b.town];
  t.lat += b.lat;
  t.lon += b.lon;
  t.n++;
}
for (const t of townCenters) {
  if (t.n) {
    t.lat /= t.n;
    t.lon /= t.n;
  }
}

// Fixed color domain across the full history (log scale), so playing time
// shows appreciation as a global drift toward the light end. p2/p98 of the
// per-transaction S$/m² distribution.
const domain = (() => {
  const sample = new Float32Array(N);
  for (let i = 0; i < N; i++) sample[i] = col.price[i] / (col.sqmX10[i] / 10);
  sample.sort();
  return [sample[Math.floor(N * 0.02)], sample[Math.floor(N * 0.98)]];
})();
const logMin = Math.log(domain[0]);
const logSpan = Math.log(domain[1]) - logMin;

// ------------------------------------------------------------- palette ----
const NO_SALES: [number, number, number] = [56, 56, 53]; // recessive #383835

document.getElementById("legend-bar")!.style.background =
  `linear-gradient(90deg, ${RAMP.join(",")})`;

function updateLegend() {
  const caption = document.getElementById("legend-caption")!;
  const min = document.getElementById("legend-min")!;
  const max = document.getElementById("legend-max")!;
  if (colorMode === "now") {
    caption.textContent = "S$ / m² rank · trailing 12 mo";
    min.textContent = "cheapest";
    max.textContent = "priciest";
  } else {
    caption.textContent = "S$ / m² · trailing 12 mo";
    min.textContent = `≤ ${Math.round(domain[0]).toLocaleString()}`;
    max.textContent = `≥ ${Math.round(domain[1]).toLocaleString()}`;
  }
}

// ------------------------------------------------------- per-tick state ----

const WINDOW = 12;
const psmNow = new Float32Array(B);
const cntNow = new Uint32Array(B);
const priceNow = new Float32Array(B);
const pctNow = new Float32Array(B);

// "now" colors each building by its percentile among buildings trading in
// the current window (differentiates any single month); "history" uses the
// fixed 1990–2026 log domain (playing time shows absolute appreciation).
let colorMode: "now" | "history" = hashState.mode ?? "now";

function computeWindow(month: number) {
  const from = Math.max(0, month - WINDOW + 1);
  for (let b = 0; b < B; b++) {
    let ps = 0, pr = 0, c = 0;
    const base = b * M;
    for (let m = from; m <= month; m++) {
      ps += psmSum[base + m];
      pr += priceSum[base + m];
      c += cnt[base + m];
    }
    psmNow[b] = c ? ps / c : 0;
    priceNow[b] = c ? pr / c : 0;
    cntNow[b] = c;
  }
  const active: number[] = [];
  for (let b = 0; b < B; b++) if (cntNow[b]) active.push(psmNow[b]);
  active.sort((x, y) => x - y);
  const last = Math.max(1, active.length - 1);
  for (let b = 0; b < B; b++) {
    if (!cntNow[b]) continue;
    let lo = 0, hi = active.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (active[mid] < psmNow[b]) lo = mid + 1;
      else hi = mid;
    }
    pctNow[b] = lo / last;
  }
}

// Fallback ~28m square for the few buildings without a footprint polygon.
const D = 0.000125;
const polygonOf = (b: Building): [number, number][] =>
  b.footprint ?? [
    [b.lon - D, b.lat - D], [b.lon + D, b.lat - D],
    [b.lon + D, b.lat + D], [b.lon - D, b.lat + D], [b.lon - D, b.lat - D],
  ];

const yearOf = (month: number) => 1990 + Math.floor(month / 12);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthName = (m: number) => `${MONTHS[m % 12]} ${yearOf(m)}`;
const sgd = (x: number) => "S$" + Math.round(x).toLocaleString();

// -------------------------------------------------------------- layers ----

let curMonth = hashState.m !== null
  ? Math.max(0, Math.min(meta.maxMonth, hashState.m))
  : (meta.maxMonth as number);

let selectedIdx: number | null = null;

// Active constraint filter ("4-room under S$600k in Punggol"): buildings
// with no matching sale in the trailing window dim out. Recomputed on each
// month change while active.
let activeFilter: Parsed | null = null;
let filterRev = 0;
const filterMatch = new Uint8Array(B);

function txMatches(i: number, f: Parsed, mLo: number, mHi: number): boolean {
  const m = col.month[i];
  if (m < mLo || m > mHi) return false;
  if (f.flatType !== null && col.flatType[i] !== f.flatType) return false;
  if (f.priceMax !== null && col.price[i] > f.priceMax) return false;
  if (f.priceMin !== null && col.price[i] < f.priceMin) return false;
  if (f.towns.length && !f.towns.includes(buildings[col.building[i]].town)) return false;
  return true;
}

function computeFilterMatch(f: Parsed, month: number, out: Uint8Array): number {
  out.fill(0);
  const mLo = Math.max(0, month - WINDOW + 1);
  let count = 0;
  for (let i = 0; i < N; i++) {
    if (!txMatches(i, f, mLo, month)) continue;
    if (!out[col.building[i]]) {
      out[col.building[i]] = 1;
      count++;
    }
  }
  return count;
}

let hashTimer: ReturnType<typeof setTimeout> | null = null;
function writeHash() {
  if (hashTimer) clearTimeout(hashTimer);
  hashTimer = setTimeout(() => {
    const c = map.getCenter();
    history.replaceState(
      null,
      "",
      `#m=${curMonth}&c=${colorMode === "now" ? "now" : "all"}` +
        `&cam=${c.lng.toFixed(4)},${c.lat.toFixed(4)},${map.getZoom().toFixed(2)},` +
        `${map.getPitch().toFixed(0)},${map.getBearing().toFixed(0)}` +
        (selectedIdx !== null ? `&b=${buildings[selectedIdx].postal}` : ""),
    );
  }, 250);
}
map.on("moveend", writeHash);

function makeLayer(month: number) {
  const year = yearOf(month);
  return new SolidPolygonLayer<Building>({
    id: "blocks",
    data: buildings,
    extruded: true,
    getPolygon: polygonOf,
    getElevation: (b) => (b.year > year ? 0 : Math.max(b.floors, 3) * 2.8),
    getFillColor: (b, { index }) => {
      if (b.year > year) return [0, 0, 0, 0];
      if (activeFilter && !filterMatch[index]) return [26, 26, 25, 150];
      if (!cntNow[index]) return [...NO_SALES, 200];
      const t = colorMode === "now"
        ? pctNow[index]
        : (Math.log(psmNow[index]) - logMin) / logSpan;
      const c = LUT[Math.max(0, Math.min(255, Math.round(t * 255)))];
      return [c[0], c[1], c[2], 255];
    },
    // The selected building is GPU-filtered out (a transparent fill would
    // still write depth and occlude the floor plates); the wireframe shell
    // layer draws it instead.
    extensions: [new DataFilterExtension({ filterSize: 1 })],
    getFilterValue: (_, { index }) => (index === selectedIdx ? 0 : 1),
    filterRange: [0.5, 1.5],
    elevationScale: 3,
    pickable: true,
    onClick: ({ index }) => select(index),
    material: { ambient: 0.5, diffuse: 0.55, shininess: 40, specularColor: [60, 70, 90] },
    updateTriggers: {
      getFillColor: [month, colorMode, filterRev],
      getElevation: year,
      getFilterValue: selectedIdx,
    },
    transitions: { getElevation: 220 },
  });
}

// Wireframe cage standing in for the selected building: keeps its shape
// legible while leaving the interior floor plates fully visible.
function makeShellLayer() {
  if (selectedIdx === null) return null;
  const b = buildings[selectedIdx];
  return new SolidPolygonLayer<Building>({
    id: "shell",
    data: [b],
    extruded: true,
    filled: false,
    wireframe: true,
    getPolygon: polygonOf,
    getElevation: Math.max(b.floors, 3) * 2.8,
    elevationScale: 3,
    getLineColor: [255, 255, 255, 110],
  });
}

// Floor cutaway for the selected building: one translucent plate per storey
// band that has recorded sales, at true height, colored by that band's
// all-time average S$/m² (normalized within the building). Storey values are
// band midpoints from the resale data (e.g. "10 TO 12" -> 11), so plates sit
// where the data actually is; floors that never traded stay empty.
type Plate = { s: number; z: number; t: number; psm: number; n: number; rel: number };

function makeCutawayLayer() {
  if (selectedIdx === null) return null;
  const b = buildings[selectedIdx];
  const bands = new Map<number, { ps: number; c: number }>();
  let totalPs = 0, totalC = 0;
  for (let k = txOffsets[selectedIdx]; k < txOffsets[selectedIdx + 1]; k++) {
    const i = txIndex[k];
    const psm = col.price[i] / (col.sqmX10[i] / 10);
    const s = col.storey[i];
    let e = bands.get(s);
    if (!e) bands.set(s, (e = { ps: 0, c: 0 }));
    e.ps += psm;
    e.c++;
    totalPs += psm;
    totalC++;
  }
  if (!bands.size) return null;
  const blockAvg = totalPs / totalC;
  const entries = [...bands.entries()].map(([s, e]) => ({ s, psm: e.ps / e.c, n: e.c }));
  const min = Math.min(...entries.map((e) => e.psm));
  const max = Math.max(...entries.map((e) => e.psm));
  // Storey bands are midpoints ("16 TO 18" -> 17) and can exceed the block's
  // max floor level; clamp so plates stay inside the shell.
  const shellFloors = Math.max(b.floors, 3);
  const ring = polygonOf(b);
  const plates: Plate[] = entries.map((e) => ({
    ...e,
    z: Math.min(e.s, shellFloors) * 2.8 * 3, // matches extrusion (elevationScale 3)
    t: max > min ? (e.psm - min) / (max - min) : 0.5,
    rel: e.psm / blockAvg - 1,
  }));
  return [
    new SolidPolygonLayer<Plate>({
      id: "cutaway",
      data: plates,
      extruded: false,
      getPolygon: (p) => ring.map(([x, y]) => [x, y, p.z]) as any,
      getFillColor: (p) => {
        const c = LUT[Math.round(p.t * 255)];
        return [c[0], c[1], c[2], 220];
      },
      pickable: true,
    }),
    new TextLayer<Plate>({
      id: "cutaway-labels",
      data: plates,
      // Floated above the plate so the billboarded glyphs don't z-fight
      // with the plate polygon or the wireframe shell.
      getPosition: (p) => [ring[0][0], ring[0][1], p.z + 3] as any,
      getText: (p) => `F${p.s}`,
      getSize: 12,
      getColor: [255, 255, 255, 235],
      getTextAnchor: "start",
      getAlignmentBaseline: "bottom",
      getPixelOffset: [4, 0],
      fontFamily: "'Helvetica Neue', Arial, sans-serif",
      fontSettings: { sdf: true },
      outlineWidth: 3,
      outlineColor: [13, 13, 13, 220],
    }),
  ];
}

// White crown outline around the selected building, drawn at roof height.
function makeSelectionLayer() {
  if (selectedIdx === null) return null;
  const b = buildings[selectedIdx];
  const h = Math.max(b.floors, 3) * 2.8 * 3 + 2;
  return new PathLayer<Building>({
    id: "selection",
    data: [b],
    getPath: (bb) => polygonOf(bb).map(([x, y]) => [x, y, h]) as any,
    getColor: [255, 255, 255, 235],
    getWidth: 2.5,
    widthUnits: "pixels",
  });
}

const overlay = new MapboxOverlay({
  layers: [],
  getTooltip: ({ object, index }) => {
    if (!object) return null;
    if ("psm" in object && "rel" in object) {
      const p = object as Plate;
      const rel = Math.abs(p.rel) < 0.005 ? "at block average" :
        `${p.rel > 0 ? "+" : "−"}${Math.abs(p.rel * 100).toFixed(0)}% vs block average`;
      return {
        html:
          `<div><strong>≈ F${p.s}</strong></div>` +
          `<div style="margin-top:2px"><span class="val">${sgd(p.psm)}</span>/m² all-time · ${p.n} sale${p.n > 1 ? "s" : ""}</div>` +
          `<div class="sub">${rel}</div>`,
      };
    }
    const b = object as Building;
    const stats = cntNow[index]
      ? `<span class="val">${sgd(priceNow[index])}</span> avg · <span class="val">${sgd(psmNow[index])}</span>/m² · ${cntNow[index]} sale${cntNow[index] > 1 ? "s" : ""}`
      : `<span class="muted">no sales in window</span>`;
    return {
      html:
        `<div><strong>Blk ${b.block}</strong> ${b.street}</div>` +
        `<div class="sub">${meta.enums.towns[b.town]} · ${b.floors || "?"} floors · built ${b.year || "?"}</div>` +
        `<div style="margin-top:4px">${stats}</div>`,
    };
  },
});
map.addControl(overlay as any);

// Ticker: trailing-window median price, sales pace, blocks standing.
const evTitle = document.getElementById("event-title")!;
const evSub = document.getElementById("event-sub")!;
const evBox = document.getElementById("event")!;
const statMedian = document.getElementById("stat-median")!;
const statSales = document.getElementById("stat-sales")!;
const statBlocks = document.getElementById("stat-blocks")!;

function updateTicker(month: number) {
  const from = Math.max(0, month - WINDOW + 1);
  const lo = monthOffsets[from];
  const hi = monthOffsets[month + 1];
  const n = hi - lo;
  let median = 0;
  if (n) {
    medianScratch.set(monthPrices.subarray(lo, hi));
    medianScratch.subarray(0, n).sort();
    median = medianScratch[n >> 1];
  }
  const year = yearOf(month);
  let built = knownYears.length;
  {
    let l = 0, h = knownYears.length;
    while (l < h) {
      const mid = (l + h) >> 1;
      if (knownYears[mid] <= year) l = mid + 1;
      else h = mid;
    }
    built = l + unknownYears;
  }
  statMedian.textContent = `S$${median.toLocaleString()} median`;
  statSales.textContent = `${n.toLocaleString()} sales past yr`;
  statBlocks.textContent = `${built.toLocaleString()} of ${B.toLocaleString()} blocks`;

  const era = EVENTS.find((e) => month >= e.from && month <= e.to);
  evBox.classList.toggle("on", !!era);
  if (era) {
    evTitle.textContent = era.title;
    evSub.textContent = era.sub;
  }
}

function update() {
  computeWindow(curMonth);
  if (activeFilter) {
    const n = computeFilterMatch(activeFilter, curMonth, filterMatch);
    filterRev++;
    updateFilterChip(n);
  }
  overlay.setProps({
    layers: [
      makeLayer(curMonth),
      makeShellLayer(),
      ...(makeCutawayLayer() ?? []),
      makeSelectionLayer(),
    ].filter(Boolean),
  });
  dateEl.textContent = monthName(curMonth);
  slider.value = String(curMonth);
  updateLegend();
  updateTicker(curMonth);
  writeHash();
}

function select(idx: number | null, fly = false) {
  selectedIdx = idx;
  if (idx === null) hidePanel();
  else {
    showPanel(idx);
    if (fly) {
      const b = buildings[idx];
      map.flyTo({
        center: [b.lon, b.lat],
        zoom: Math.max(map.getZoom(), 15.5),
        pitch: 60,
        duration: 2200,
      });
    }
  }
  update();
}

function eraJump(e: Era) {
  stop();
  curMonth = e.at;
  const sel = e.select !== undefined ? byPostal.get(e.select) ?? null : null;
  select(sel); // also runs update()
  map.flyTo({
    center: [e.cam[0], e.cam[1]],
    zoom: e.cam[2],
    pitch: e.cam[3],
    bearing: e.cam[4],
    duration: 2400,
  });
}

const segNow = document.getElementById("seg-now")!;
const segAll = document.getElementById("seg-all")!;
function setMode(mode: "now" | "history") {
  colorMode = mode;
  segNow.classList.toggle("on", mode === "now");
  segAll.classList.toggle("on", mode === "history");
  update();
}
segNow.addEventListener("click", () => setMode("now"));
segAll.addEventListener("click", () => setMode("history"));

// ------------------------------------------------------------------ ui ----

const slider = document.getElementById("month") as HTMLInputElement;
const dateEl = document.getElementById("date")!;
const playBtn = document.getElementById("play")! as HTMLButtonElement;
slider.max = String(meta.maxMonth);
slider.value = String(curMonth);

// One dot per era at its starting month — click to jump there, camera and all.
const dots = document.getElementById("era-dots")!;
for (const e of EVENTS) {
  const dot = document.createElement("i");
  dot.style.left = `${(e.from / meta.maxMonth) * 100}%`;
  dot.title = e.title;
  dot.addEventListener("click", () => eraJump(e));
  dots.appendChild(dot);
}

const toastEl = document.getElementById("toast")!;
let toastTimer: ReturnType<typeof setTimeout> | null = null;
function showToast(msg: string) {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2200);
}

initPanel({
  buildings,
  enums: meta.enums,
  col,
  M,
  maxMonth: meta.maxMonth,
  psmSum,
  cnt,
  txOffsets,
  txIndex,
  monthName,
  onClose: () => select(null),
  toast: showToast,
});

const ISLAND = { center: [103.82, 1.352] as [number, number], zoom: 11.2, pitch: 55, bearing: -12 };

// ------------------------------------------------- computed answers ----

const FLAT_SHORT = ["1-rm", "2-rm", "3-rm", "4-rm", "5-rm", "Exec", "MG"];
const titleCase = (s: string) => s.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());
const filterChip = document.getElementById("filter-chip")!;
const filterLabel = document.getElementById("filter-label")!;

function describe(p: Parsed): string {
  const bits: string[] = [];
  if (p.flatType !== null) bits.push(FLAT_SHORT[p.flatType]);
  if (p.priceMax !== null) bits.push(`under S$${(p.priceMax / 1000).toFixed(0)}k`);
  if (p.priceMin !== null) bits.push(`over S$${(p.priceMin / 1000).toFixed(0)}k`);
  if (p.towns.length) bits.push(p.towns.map((t) => titleCase(meta.enums.towns[t])).join(" / "));
  return bits.join(" · ");
}

function updateFilterChip(count: number) {
  filterLabel.textContent = `${describe(activeFilter!)} · ${count.toLocaleString()} blocks`;
}

function clearFilter() {
  activeFilter = null;
  filterChip.classList.add("hidden");
  filterRev++; // update() only bumps this while a filter is active
  update();
}
document.getElementById("filter-clear")!.addEventListener("click", clearFilter);

function answers(q: string): AnswerItem[] {
  const p = parseQuery(q, meta.enums.towns, meta.enums.flatTypes, yearOf(meta.maxMonth));
  const out: AnswerItem[] = [];

  if (p.superlative) {
    const mLo = p.year ? Math.max(0, (p.year - 1990) * 12) : 0;
    const mHi = p.year ? Math.min(meta.maxMonth, (p.year - 1990) * 12 + 11) : meta.maxMonth;
    let bestI = -1;
    for (let i = 0; i < N; i++) {
      if (!txMatches(i, p, mLo, mHi)) continue;
      if (
        bestI === -1 ||
        (p.superlative === "max" ? col.price[i] > col.price[bestI] : col.price[i] < col.price[bestI])
      ) {
        bestI = i;
      }
    }
    if (bestI >= 0) {
      const i = bestI;
      const bIdx = col.building[i];
      const b = buildings[bIdx];
      // The month and flat type of the sale itself follow in the sub line,
      // so the scope only names what the sale doesn't already show.
      const scope = [
        p.superlative === "max" ? "highest price" : "lowest price",
        p.towns.length ? p.towns.map((t) => titleCase(meta.enums.towns[t])).join("/") : null,
        p.year ? null : "all time",
      ].filter(Boolean).join(" · ");
      out.push({
        label: `S$${col.price[i].toLocaleString()} — Blk ${b.block} ${titleCase(b.street)}`,
        sub: `${scope} · ${monthName(col.month[i])} · ${FLAT_SHORT[col.flatType[i]]} · ${Math.round(col.sqmX10[i] / 10)} m² · ~F${col.storey[i]}`,
        badge: "answer",
        run: () => {
          stop();
          curMonth = col.month[i];
          select(bIdx, true);
        },
      });
    }
  }

  if (hasConstraints(p) && !p.superlative) {
    const scratch = new Uint8Array(B);
    const n = computeFilterMatch(p, curMonth, scratch);
    out.push({
      label: `Show ${describe(p)}`,
      sub: `${n.toLocaleString()} blocks with a matching sale in the past year — others dim`,
      badge: "filter",
      run: () => {
        activeFilter = p;
        filterChip.classList.remove("hidden");
        update();
      },
    });
  }
  return out;
}

function onSearchPick(p: SearchPick) {
  if (p.kind === "run") {
    p.run();
  } else if (p.kind === "block") {
    select(p.idx, true);
  } else if (p.kind === "town") {
    const c = townCenters[p.town];
    select(null);
    map.flyTo({ center: [c.lon, c.lat], zoom: 13.4, pitch: 55, duration: 2200 });
  } else if (p.kind === "era") {
    eraJump(EVENTS[p.era]);
  } else {
    stop();
    curMonth = Math.min(meta.maxMonth, (p.year - 1990) * 12 + 6);
    update();
  }
}
// Focus/zero-result suggestions: one example of everything the box can do,
// shuffled per focus so the breadth shows over repeat visits.
const SUGGESTION_POOL: Suggestion[] = [];
{
  const amk = byPostal.get("560121");
  if (amk !== undefined) {
    SUGGESTION_POOL.push({
      label: "Blk 121 Ang Mo Kio Ave 3",
      sub: "any block, by address or postal code",
      badge: "block",
      pick: { kind: "block", idx: amk },
    });
  }
  const pg = meta.enums.towns.indexOf("PUNGGOL");
  if (pg >= 0) {
    SUGGESTION_POOL.push({
      label: "Punggol",
      sub: "fly to a town",
      badge: "town",
      pick: { kind: "town", town: pg },
    });
  }
  SUGGESTION_POOL.push(
    {
      label: "1997",
      sub: "jump the timeline to any year",
      badge: "year",
      pick: { kind: "year", year: 1997 },
    },
    {
      label: "The first million-dollar flat",
      sub: EVENTS[5].sub,
      badge: "story",
      pick: { kind: "era", era: 5 },
    },
    {
      label: "highest price in Jurong in 2026",
      sub: "ask about prices in plain words",
      badge: "ask",
      pick: { kind: "query", q: "highest price in jurong in 2026" },
    },
    {
      label: "4-room under 600k in Punggol",
      sub: "filter the island by budget",
      badge: "ask",
      pick: { kind: "query", q: "4 room under 600k in punggol" },
    },
    {
      label: "Watch 36 years of Singapore",
      sub: "play the timeline from 1990",
      badge: "play",
      pick: {
        kind: "run",
        run: () => {
          select(null);
          stop();
          curMonth = 0;
          map.flyTo({ ...ISLAND, duration: 2000 });
          play();
        },
      },
    },
  );
}
const shuffledSuggestions = () => {
  const a = [...SUGGESTION_POOL];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

initSearch({
  buildings,
  towns: meta.enums.towns,
  eras: EVENTS,
  maxYear: yearOf(meta.maxMonth),
  onPick: onSearchPick,
  answers,
  suggestions: shuffledSuggestions,
});

// Era captions are jump targets, same as the slider dots.
document.getElementById("event")!.addEventListener("click", () => {
  const era = EVENTS.find((e) => curMonth >= e.from && curMonth <= e.to);
  if (era) eraJump(era);
});

// Compass: needle tracks bearing; click faces north. Rotation itself is
// right-drag / Ctrl+drag (MapLibre default) — the tooltip teaches it.
const compass = document.getElementById("compass")!;
const needle = compass.querySelector("svg")!;
map.on("rotate", () => {
  needle.style.transform = `rotate(${-map.getBearing()}deg)`;
});
compass.addEventListener("click", () => map.easeTo({ bearing: 0, duration: 600 }));

// Basemap toggle: CARTO dark (default) or dimmed Esri satellite. The deck
// overlay is a map control, so it survives setStyle.
const SAT_STYLE: any = {
  version: 8,
  sources: {
    sat: {
      type: "raster",
      tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
      tileSize: 256,
      maxzoom: 19,
      attribution: "Esri, Maxar, Earthstar Geographics, and the GIS User Community",
    },
  },
  layers: [
    { id: "bg", type: "background", paint: { "background-color": "#0d0d0d" } },
    {
      id: "sat",
      type: "raster",
      source: "sat",
      // Dimmed + desaturated so the data reads on top of the imagery.
      paint: { "raster-brightness-max": 0.72, "raster-saturation": -0.25 },
    },
  ],
};
const DARK_STYLE = "https://basemaps.cartocdn.com/gl/dark-matter-nolabels-gl-style/style.json";
const baseDark = document.getElementById("base-dark")!;
const baseSat = document.getElementById("base-sat")!;
function setBasemap(sat: boolean) {
  baseDark.classList.toggle("on", !sat);
  baseSat.classList.toggle("on", sat);
  map.setStyle(sat ? SAT_STYLE : DARK_STYLE);
}
baseDark.addEventListener("click", () => setBasemap(false));
baseSat.addEventListener("click", () => setBasemap(true));

slider.addEventListener("input", () => {
  curMonth = Number(slider.value);
  stop();
  update();
});

let playing = false;
let timer: ReturnType<typeof setInterval> | null = null;
function stop() {
  playing = false;
  playBtn.innerHTML = "&#9654;";
  if (timer) clearInterval(timer);
  timer = null;
}
function play() {
  if (curMonth >= meta.maxMonth) curMonth = 0;
  playing = true;
  playBtn.innerHTML = "&#10073;&#10073;";
  timer = setInterval(() => {
    curMonth++;
    if (curMonth >= meta.maxMonth) {
      curMonth = meta.maxMonth;
      stop();
    }
    update();
  }, 150);
}
playBtn.addEventListener("click", () => (playing ? stop() : play()));
window.addEventListener("keydown", (e) => {
  if (e.code === "ArrowRight" || e.code === "ArrowLeft") {
    stop();
    curMonth = Math.max(0, Math.min(meta.maxMonth, curMonth + (e.code === "ArrowRight" ? 1 : -1)));
    update();
  } else if (e.code === "Escape" && selectedIdx !== null) {
    select(null);
  }
});

segNow.classList.toggle("on", colorMode === "now");
segAll.classList.toggle("on", colorMode === "history");
await mapLoaded;
// Restore a shared block selection; fly only when the link has no camera.
if (hashState.b && byPostal.has(hashState.b)) {
  select(byPostal.get(hashState.b)!, !hashState.cam);
} else {
  update();
}
document.getElementById("loading")!.classList.add("done");
