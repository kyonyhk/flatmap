// Block story panel: a building's own 36-year price history — sparkline,
// lease position, floor-level breakdown, and its actual transactions.
// Pure DOM into #panel.
import { rampCss } from "./ramp";

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
    </div>
    ${sparkline(idx)}
    ${floorSection(idx)}
    <div class="panel-txhead muted" style="margin-top:10px">${txs.length.toLocaleString()} resales since 1990</div>
    <div class="txlist">${rows || `<div class="muted">no recorded resales</div>`}</div>
    <button id="panel-share">Share</button>`;

  el.classList.remove("hidden");
  document.getElementById("panel-close")!.addEventListener("click", ctx.onClose);
  document.getElementById("panel-share")!.addEventListener("click", async () => {
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
