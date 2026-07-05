// Assemble the final artifacts deck.gl will consume:
//
// data/out/buildings.json  — every geocoded building: position, floors,
//                            year completed, town, dwelling units
// data/out/transactions.bin — columnar little-endian binary, one struct-of-
//                            arrays block per column (layout in meta.json)
// data/out/meta.json       — column layout, enums, month range, stats
//
// Transactions reference buildings by index, so coordinates live once in
// buildings.json instead of on every one of ~1M rows.
import { RAW, INTERIM, OUT, csvToObjects, addressKey } from "./lib";

type Hit = { lat: number; lon: number; postal: string } | null;

const cache: Record<string, Hit> = await Bun.file(`${INTERIM}/geocode-cache.json`).json();
const enums = await Bun.file(`${INTERIM}/enums.json`).json();

// Building footprints from HDB Existing Building, keyed by postal code
// (unique per feature). Outer ring only, 5dp (~1m) precision.
const footprints = new Map<string, [number, number][]>();
{
  const geo = await Bun.file(`${RAW}/hdb-buildings.geojson`).json();
  for (const f of geo.features) {
    const ring: [number, number][] = f.geometry.type === "MultiPolygon"
      ? f.geometry.coordinates[0][0]
      : f.geometry.coordinates[0];
    footprints.set(
      String(f.properties.POSTAL_COD),
      ring.map(([x, y]) => [Number(x.toFixed(5)), Number(y.toFixed(5))]),
    );
  }
}

// MRT/LRT exits (LTA, d_b39d3a0871985372d7e1637193335da5): nearest-exit
// distance per building, plus a deduped station list for map display.
const exits: { name: string; lon: number; lat: number }[] = [];
{
  const g = await Bun.file(`${RAW}/mrt-exits.geojson`).json();
  for (const f of g.features) {
    const name = String(f.properties.STATION_NA)
      .replace(/\s+(MRT|LRT)\s+STATION$/i, "")
      .trim();
    const [lon, lat] = f.geometry.coordinates;
    exits.push({ name, lon, lat });
  }
}
const RAD = Math.PI / 180;
function distM(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const dLat = (bLat - aLat) * RAD;
  const dLon = (bLon - aLon) * RAD;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * RAD) * Math.cos(bLat * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(s));
}
function nearestExit(lat: number, lon: number) {
  let best = Infinity;
  let hit = exits[0];
  for (const e of exits) {
    const d = distM(lat, lon, e.lat, e.lon);
    if (d < best) {
      best = d;
      hit = e;
    }
  }
  return { name: hit.name, m: Math.round(best), lat: hit.lat, lon: hit.lon };
}

// Building heights and unit counts from HDB property information.
const propInfo = new Map<string, { floors: number; year: number; units: number }>();
for (const r of csvToObjects(await Bun.file(`${RAW}/hdb-property-info.csv`).text())) {
  propInfo.set(addressKey(r.blk_no, r.street), {
    floors: Number(r.max_floor_lvl) || 0,
    year: Number(r.year_completed) || 0,
    units: Number(r.total_dwelling_units) || 0,
  });
}

// Buildings: every address that geocoded successfully.
const buildingIdx = new Map<string, number>();
const buildings: any[] = [];
const lines = (await Bun.file(`${INTERIM}/transactions.ndjson`).text()).split("\n").filter(Boolean);
const rows = lines.map((l) => JSON.parse(l));

let noGeo = 0;
let noHeight = 0;
for (const r of rows) {
  if (buildingIdx.has(r.addr)) continue;
  const hit = cache[r.addr];
  if (!hit) {
    noGeo++;
    buildingIdx.set(r.addr, -1);
    continue;
  }
  const info = propInfo.get(r.addr);
  if (!info) noHeight++;
  const [block, street] = r.addr.split("|");
  buildingIdx.set(r.addr, buildings.length);
  const mrt = nearestExit(hit.lat, hit.lon);
  buildings.push({
    block,
    street,
    town: r.town,
    lat: hit.lat,
    lon: hit.lon,
    postal: hit.postal,
    floors: info?.floors ?? 0,
    year: info?.year ?? 0,
    units: info?.units ?? 0,
    mrt: mrt.name.toLowerCase().replace(/(^|\s|-)\S/g, (c) => c.toUpperCase()),
    mrtM: mrt.m,
    mrtLat: +mrt.lat.toFixed(6),
    mrtLon: +mrt.lon.toFixed(6),
    footprint: footprints.get(hit.postal) ?? null,
  });
}
// stations.json is emitted by 05-stations.ts (codes, colors, footprints).

const kept = rows.filter((r) => buildingIdx.get(r.addr)! >= 0);
const n = kept.length;

// Columnar binary, columns ordered by descending element size so every
// column's byte offset stays aligned for zero-copy typed-array views
// regardless of row count (u32 first, then u16, then u8).
if (buildings.length > 65535) throw new Error("buildingIdx overflows u16");
const cols = {
  price: new Uint32Array(n),
  building: new Uint16Array(n),
  month: new Uint16Array(n),
  sqmX10: new Uint16Array(n),
  leaseStart: new Uint16Array(n),
  flatType: new Uint8Array(n),
  flatModel: new Uint8Array(n),
  storey: new Uint8Array(n),
};
let minMonth = Infinity;
let maxMonth = -Infinity;
kept.forEach((r, i) => {
  cols.building[i] = buildingIdx.get(r.addr)!;
  cols.month[i] = r.m;
  cols.price[i] = r.price;
  cols.sqmX10[i] = r.sqm;
  cols.flatType[i] = r.ft;
  cols.flatModel[i] = r.fm;
  cols.storey[i] = r.storey;
  cols.leaseStart[i] = r.lease;
  if (r.m < minMonth) minMonth = r.m;
  if (r.m > maxMonth) maxMonth = r.m;
});

const layout: any[] = [];
let offset = 0;
const parts: ArrayBuffer[] = [];
for (const [name, arr] of Object.entries(cols)) {
  layout.push({ name, type: arr.constructor.name, offset, length: n });
  parts.push(arr.buffer as ArrayBuffer);
  offset += arr.byteLength;
}
await Bun.write(`${OUT}/transactions.bin`, new Blob(parts));
await Bun.write(`${OUT}/buildings.json`, JSON.stringify(buildings));
await Bun.write(
  `${OUT}/meta.json`,
  JSON.stringify(
    {
      count: n,
      monthZero: "1990-01",
      minMonth,
      maxMonth,
      layout,
      enums,
      stats: {
        totalRows: rows.length,
        droppedNoGeocode: rows.length - n,
        buildings: buildings.length,
        buildingsWithoutHeight: noHeight,
        addressesUnresolved: noGeo,
      },
    },
    null,
    1,
  ),
);

const mb = (x: number) => (x / 1e6).toFixed(1) + " MB";
const withFp = buildings.filter((b) => b.footprint).length;
console.log(`transactions: ${n}/${rows.length} kept (${rows.length - n} dropped, no geocode)`);
console.log(`buildings: ${buildings.length} (${noHeight} without height info, ${withFp} with footprints)`);
console.log(`transactions.bin: ${mb(offset)}  buildings.json: ${mb(Bun.file(`${OUT}/buildings.json`).size)}`);
