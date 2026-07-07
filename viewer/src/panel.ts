// Block story panel: a building's own 36-year price history — sparkline,
// lease position, floor-level breakdown, and its actual transactions.
// Pure DOM into #panel.
import { rampCss } from "./ramp";
import { track } from "./analytics";

type Ctx = {
  buildings: any[];
  enums: { flatTypes: string[]; towns: string[] };
  col: Record<string, Uint8Array | Uint16Array | Uint32Array>;
  M: number;
  maxMonth: number;
  psmSum: Float32Array;
  cnt: Uint16Array;
  txOffsets: Uint32Array;
  txIndex: Uint32Array;
  monthName: (m: number) => string;
  onClose: () => void;
  toast: (msg: string) => void;
};

let ctx: Ctx;
let el: HTMLElement;

export function initPanel(c: Ctx) {
  ctx = c;
  el = document.getElementById("panel")!;
}

const FLAT_SHORT = ["1-rm", "2-rm", "3-rm", "4-rm", "5-rm", "Exec", "MG"];
const title = (s: string) =>
  s.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());
const sgd = (x: number) => "S$" + Math.round(x).toLocaleString();

function sparkline(idx: number): string {
  const { psmSum, cnt, M } = ctx;
  const pts: { y: number; v: number }[] = [];
  const lastYear = 1990 + Math.floor((M - 1) / 12);
  for (let y = 0; y * 12 < M; y++) {
    let s = 0, c = 0;
    for (let m = y * 12; m < Math.min(M, y * 12 + 12); m++) {
      s += psmSum[idx * M + m];
      c += cnt[idx * M + m];
    }
    if (c) pts.push({ y: 1990 + y, v: s / c });
  }
  if (pts.length < 2) return `<div class="muted spark-empty">not enough sales for a trend</div>`;
  const w = 256, h = 56, pad = 3;
  const vmin = Math.min(...pts.map((p) => p.v));
  const vmax = Math.max(...pts.map((p) => p.v));
  const X = (y: number) => pad + ((y - 1990) / (lastYear - 1990)) * (w - 2 * pad);
  const Y = (v: number) => h - pad - ((v - vmin) / (vmax - vmin || 1)) * (h - 2 * pad);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${X(p.y).toFixed(1)},${Y(p.v).toFixed(1)}`).join("");
  const last = pts[pts.length - 1];
  const first = pts[0];
  const mult = last.v / first.v;
  return `
    <svg viewBox="0 0 ${w} ${h}" class="spark">
      <path d="${d}" fill="none" stroke="#86b6ef" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="${X(last.y).toFixed(1)}" cy="${Y(last.v).toFixed(1)}" r="2.5" fill="#cde2fb"/>
    </svg>
    <div class="spark-ends">
      <span>${sgd(first.v)}/m² · ${first.y}</span>
      <span>${sgd(last.v)}/m² · ${last.y}</span>
    </div>
    <div class="spark-mult">×${mult >= 10 ? mult.toFixed(0) : mult.toFixed(1)} since ${first.y}</div>`;
}

// Fair range: for each flat type this block contains, the 25th-75th
// percentile of the past year's estate sales of that type (S$/m²),
// adjusted by the block's own all-time premium vs its town (clamped, and
// only applied when both sides have enough data), sized by the block's
// typical unit. Receipts stated inline; explicitly an estimate.
function fairSection(idx: number): string {
  const { col, buildings, maxMonth, enums } = ctx;
  const b = buildings[idx];
  const N = col.price.length;
  const T = FLAT_SHORT.length;
  const { txOffsets, txIndex } = ctx;
  if (txOffsets[idx] === txOffsets[idx + 1]) return "";
  const blkLease = col.leaseStart[txIndex[txOffsets[idx]]];
  const est12: number[][] = Array.from({ length: T }, () => []); // similar lease vintage
  const est12All: number[][] = Array.from({ length: T }, () => []); // any vintage (fallback)
  const townAll = Array.from({ length: T }, () => ({ s: 0, c: 0 }));
  const blkAll = Array.from({ length: T }, () => ({ s: 0, c: 0 }));
  const blkSizes: number[][] = Array.from({ length: T }, () => []);
  const from = maxMonth - 11;
  for (let i = 0; i < N; i++) {
    const t = col.flatType[i];
    const psm = col.price[i] / (col.sqmX10[i] / 10);
    if (buildings[col.building[i]].town === b.town) {
      townAll[t].s += psm;
      townAll[t].c++;
      if (col.month[i] >= from) {
        est12All[t].push(psm);
        // Comps should be blocks of a similar age: a 1978 flat's fair range
        // shouldn't be stretched by 2015-lease premium blocks across town.
        if (Math.abs(col.leaseStart[i] - blkLease) <= 12) est12[t].push(psm);
      }
    }
    if (col.building[i] === idx) {
      blkAll[t].s += psm;
      blkAll[t].c++;
      blkSizes[t].push(col.sqmX10[i] / 10);
    }
  }
  const rows: string[] = [];
  for (let t = 0; t < T; t++) {
    const similar = est12[t].length >= 15;
    const pool = similar ? est12[t] : est12All[t];
    if (blkAll[t].c < 3 || pool.length < 15) continue;
    const arr = pool.sort((a, z) => a - z);
    const q = (p: number) => arr[Math.floor(p * (arr.length - 1))];
    let factor = 1;
    if (blkAll[t].c >= 5 && townAll[t].c >= 50) {
      factor = blkAll[t].s / blkAll[t].c / (townAll[t].s / townAll[t].c);
      factor = Math.max(0.8, Math.min(1.2, factor));
    }
    const sizes = blkSizes[t].sort((a, z) => a - z);
    const sqm = sizes[sizes.length >> 1];
    const lo = q(0.25) * factor * sqm;
    const hi = q(0.75) * factor * sqm;
    const fp = Math.round((factor - 1) * 100);
    rows.push(`
      <div class="fair-row">
        <strong>${FLAT_SHORT[t]}</strong>
        <span class="fair-range">${sgd(lo)} – ${sgd(hi)}</span>
        <span class="muted">~${Math.round(sqm)} m²</span>
      </div>
      <div class="fair-note muted">${arr.length} ${similar ? "similar-age " : ""}${title(enums.towns[b.town])} ${FLAT_SHORT[t]} sales, past 12 mo${fp ? ` · this block ${fp > 0 ? "+" : ""}${fp}% historically` : ""}</div>`);
  }
  if (!rows.length) return "";
  return `
    <div class="panel-txhead muted">fair range today</div>
    ${rows.join("")}
    <div class="fair-disc muted">an estimate from registered sales, not a valuation</div>`;
}

// Per-storey-band S$/m² bars — mirrors the 3D floor plates so the floor
// story is readable without hunting for them on the map.
function floorSection(idx: number): string {
  const { col, txOffsets, txIndex } = ctx;
  const bands = new Map<number, { ps: number; c: number }>();
  for (let k = txOffsets[idx]; k < txOffsets[idx + 1]; k++) {
    const i = txIndex[k];
    const s = col.storey[i];
    let e = bands.get(s);
    if (!e) bands.set(s, (e = { ps: 0, c: 0 }));
    e.ps += col.price[i] / (col.sqmX10[i] / 10);
    e.c++;
  }
  if (bands.size < 2) return "";
  const rows = [...bands.entries()]
    .map(([s, e]) => ({ s, psm: e.ps / e.c, n: e.c }))
    .sort((a, b) => b.s - a.s);
  const min = Math.min(...rows.map((r) => r.psm));
  const max = Math.max(...rows.map((r) => r.psm));
  const html = rows.map((r) => {
    const t = max > min ? (r.psm - min) / (max - min) : 0.5;
    return `<div class="floor-row">
      <span class="muted">F${r.s}</span>
      <div class="floor-bar"><i style="width:${Math.round(30 + t * 70)}%;background:${rampCss(t)}"></i></div>
      <span class="floor-val">${sgd(r.psm)}/m²</span>
      <span class="muted floor-n">${r.n}</span>
    </div>`;
  }).join("");
  return `<div class="panel-txhead muted" style="margin-top:2px">by floor · all-time S$/m² · sales</div>${html}`;
}

export function showPanel(idx: number) {
  const { buildings, enums, col, txOffsets, txIndex, monthName, maxMonth } = ctx;
  const b = buildings[idx];
  const txs = Array.from(txIndex.subarray(txOffsets[idx], txOffsets[idx + 1]))
    .sort((a, z) => col.month[z] - col.month[a]);

  const leaseStart = txs.length ? col.leaseStart[txs[0]] : b.year;
  const nowYear = 1990 + Math.floor(maxMonth / 12);
  const leaseLeft = leaseStart ? Math.max(0, leaseStart + 99 - nowYear) : null;

  const rows = txs.map((i) => `
    <div class="tx">
      <span class="muted">${monthName(col.month[i])}</span>
      <span>~F${col.storey[i]}</span>
      <span>${Math.round(col.sqmX10[i] / 10)} m²</span>
      <span>${FLAT_SHORT[col.flatType[i]]}</span>
      <strong>${sgd(col.price[i])}</strong>
    </div>`).join("");

  el.innerHTML = `
    <button id="panel-close" aria-label="Close">×</button>
    <div class="panel-head">
      <strong>Blk ${b.block}</strong> ${title(b.street)}
    </div>
    <div class="panel-sub muted">
      ${title(enums.towns[b.town])} · ${b.floors || "?"} floors · ${b.units || "?"} flats
      ${leaseLeft !== null ? `<br>99-yr lease from ${leaseStart} · <strong class="ink">${leaseLeft} yrs left</strong>` : ""}
      ${b.mrt ? `<br>${b.mrtM >= 1000 ? (b.mrtM / 1000).toFixed(1) + " km" : b.mrtM + " m"} straight-line to ${b.mrt} MRT` : ""}
    </div>
    ${fairSection(idx)}
    ${sparkline(idx)}
    ${floorSection(idx)}
    <div class="panel-txhead muted" style="margin-top:10px">${txs.length.toLocaleString()} resales since 1990</div>
    <div class="txlist">${rows || `<div class="muted">no recorded resales</div>`}</div>
    <button id="panel-share">Share</button>`;

  el.classList.remove("hidden");
  document.getElementById("panel-close")!.addEventListener("click", ctx.onClose);
  document.getElementById("panel-share")!.addEventListener("click", async () => {
    track("share");
    const shareTitle = `Blk ${b.block} ${title(b.street)} — every resale since 1990`;
    // Native share sheet on touch devices only; desktop Chrome/Safari also
    // expose navigator.share but their sheets are worse than copy + toast.
    if (navigator.share && matchMedia("(pointer: coarse)").matches) {
      try {
        await navigator.share({ title: shareTitle, url: location.href });
        return;
      } catch (err: any) {
        if (err?.name === "AbortError") return; // user closed the sheet
        // otherwise fall through to clipboard
      }
    }
    await navigator.clipboard.writeText(location.href);
    ctx.toast(`Link to Blk ${b.block} copied`);
  });
}

export function hidePanel() {
  el.classList.add("hidden");
  el.innerHTML = "";
}
