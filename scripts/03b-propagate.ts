// Propagate geocodes through the HDB Existing Building footprint GeoJSON.
//
// The GeoJSON keys blocks by (BLK_NO, ST_COD) where ST_COD is an SLA street
// code, not a street name — so it can't join to resale addresses directly.
// But OneMap results carry postal codes, and postal codes are unique per
// footprint. So every OneMap-resolved address teaches us its street's
// ST_COD, and then any unresolved block whose (street's codes, BLK_NO)
// matches exactly one footprint resolves without a OneMap call.
//
// Runs before/after 03-geocode; both read and write the same cache.
// Propagated entries get fp: postal so 04-build can attach footprints.
import { RAW, INTERIM } from "./lib";

type Addr = { block: string; street: string; town: string };
type Hit = { lat: number; lon: number; postal: string } | null;

const addresses: Addr[] = await Bun.file(`${INTERIM}/addresses.json`).json();
const cachePath = `${INTERIM}/geocode-cache.json`;
const cache: Record<string, Hit> = (await Bun.file(cachePath).exists())
  ? await Bun.file(cachePath).json()
  : {};

const geo = await Bun.file(`${RAW}/hdb-buildings.geojson`).json();

function centroid(feature: any): [number, number] {
  const ring: [number, number][] = feature.geometry.type === "MultiPolygon"
    ? feature.geometry.coordinates[0][0]
    : feature.geometry.coordinates[0];
  let lon = 0;
  let lat = 0;
  for (const [x, y] of ring) {
    lon += x;
    lat += y;
  }
  return [lon / ring.length, lat / ring.length];
}

const byPostal = new Map<string, any>();
const byBlkCode = new Map<string, any[]>();
for (const f of geo.features) {
  const p = f.properties;
  byPostal.set(String(p.POSTAL_COD), f);
  const k = `${String(p.BLK_NO).toUpperCase()}|${p.ST_COD}`;
  if (!byBlkCode.has(k)) byBlkCode.set(k, []);
  byBlkCode.get(k)!.push(f);
}

// Learn street name -> street code(s) from already-resolved addresses.
const streetCodes = new Map<string, Set<string>>();
let teachers = 0;
for (const a of addresses) {
  const hit = cache[`${a.block}|${a.street}`];
  if (!hit?.postal) continue;
  const f = byPostal.get(hit.postal);
  if (!f) continue;
  if (!streetCodes.has(a.street)) streetCodes.set(a.street, new Set());
  streetCodes.get(a.street)!.add(f.properties.ST_COD);
  teachers++;
}

// Resolve unresolved addresses via (BLK_NO, learned ST_COD).
let propagated = 0;
let ambiguous = 0;
for (const a of addresses) {
  const key = `${a.block}|${a.street}`;
  if (cache[key]) continue;
  const codes = streetCodes.get(a.street);
  if (!codes) continue;
  const candidates: any[] = [];
  for (const code of codes) {
    for (const f of byBlkCode.get(`${a.block}|${code}`) ?? []) candidates.push(f);
  }
  if (candidates.length === 1) {
    const f = candidates[0];
    const [lon, lat] = centroid(f);
    cache[key] = { lat, lon, postal: String(f.properties.POSTAL_COD) };
    propagated++;
  } else if (candidates.length > 1) {
    ambiguous++;
  }
}

await Bun.write(cachePath, JSON.stringify(cache));
const resolved = Object.values(cache).filter(Boolean).length;
const streets = new Set(addresses.map((a) => a.street));
console.log(
  `learned codes for ${streetCodes.size}/${streets.size} streets (from ${teachers} resolved addresses)`,
);
console.log(
  `propagated ${propagated} (${ambiguous} ambiguous) -> ${resolved}/${addresses.length} resolved`,
);
