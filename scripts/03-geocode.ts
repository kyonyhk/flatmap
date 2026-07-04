// Geocode unique block+street addresses via the OneMap search API.
// Resumable: results checkpoint to geocode-cache.json every 200 lookups,
// so re-running skips everything already resolved.
//
// OneMap's documented limit is ~250 calls/min; this paces to ~180/min.
// A token is not currently required for /common/elastic/search (responses
// carry a warning but include results). If OneMap starts hard-enforcing,
// set ONEMAP_TOKEN in the environment and it will be sent.
import { INTERIM, sleep } from "./lib";

type Addr = { block: string; street: string; town: string };
type Hit = { lat: number; lon: number; postal: string };

const addresses: Addr[] = await Bun.file(`${INTERIM}/addresses.json`).json();
const cachePath = `${INTERIM}/geocode-cache.json`;
const cache: Record<string, Hit | null> = (await Bun.file(cachePath).exists())
  ? await Bun.file(cachePath).json()
  : {};

// HDB street abbreviations, used as a fallback query when the raw string misses.
const EXPANSIONS: [RegExp, string][] = [
  [/\bAVE\b/g, "AVENUE"], [/\bST\b/g, "STREET"], [/\bRD\b/g, "ROAD"],
  [/\bDR\b/g, "DRIVE"], [/\bCRES\b/g, "CRESCENT"], [/\bCTRL\b/g, "CENTRAL"],
  [/\bNTH\b/g, "NORTH"], [/\bSTH\b/g, "SOUTH"], [/\bBT\b/g, "BUKIT"],
  [/\bPL\b/g, "PLACE"], [/\bTER\b/g, "TERRACE"], [/\bCL\b/g, "CLOSE"],
  [/\bGDNS\b/g, "GARDENS"], [/\bHTS\b/g, "HEIGHTS"], [/\bUPP\b/g, "UPPER"],
  [/\bKG\b/g, "KAMPONG"], [/\bC'WEALTH\b/g, "COMMONWEALTH"], [/\bPK\b/g, "PARK"],
  [/\bMKT\b/g, "MARKET"], [/\bLOR\b/g, "LORONG"], [/\bJLN\b/g, "JALAN"],
];

const expand = (street: string) => {
  let s = street;
  for (const [re, full] of EXPANSIONS) s = s.replace(re, full);
  return s;
};

const TOKEN = process.env.ONEMAP_TOKEN;

async function search(query: string): Promise<any[]> {
  const url =
    "https://www.onemap.gov.sg/api/common/elastic/search?returnGeom=Y&getAddrDetails=Y&pageNum=1&searchVal=" +
    encodeURIComponent(query);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      // Timeout is load-bearing: OneMap tarpits (holds the connection open,
      // never responds) instead of returning 429 when it throttles, so an
      // un-timed fetch wedges forever. Connection: close avoids reusing a
      // tarpitted keep-alive socket.
      const res = await fetch(url, {
        headers: {
          Connection: "close",
          ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
        },
        signal: AbortSignal.timeout(10000),
      });
      if (res.status === 429) {
        await sleep(15000 * (attempt + 1));
        continue;
      }
      const json = await res.json();
      return json.results ?? [];
    } catch {
      await sleep(5000 * (attempt + 1));
    }
  }
  throw new Error(`OneMap unreachable for: ${query}`);
}

// A result counts as a match when its BLK_NO equals the HDB block number.
function pick(results: any[], block: string): Hit | null {
  for (const r of results) {
    if ((r.BLK_NO ?? "").toUpperCase() === block && r.LATITUDE && r.LONGITUDE) {
      return { lat: Number(r.LATITUDE), lon: Number(r.LONGITUDE), postal: r.POSTAL ?? "" };
    }
  }
  return null;
}

// One block per street goes first: each resolved block teaches
// 03b-propagate that street's ST_COD in the footprint GeoJSON, which then
// resolves every other block on the street without touching OneMap.
const unresolved = addresses.filter((a) => !(`${a.block}|${a.street}` in cache));
const seenStreet = new Set<string>();
const firstPerStreet: Addr[] = [];
const rest: Addr[] = [];
for (const a of unresolved) {
  if (seenStreet.has(a.street)) rest.push(a);
  else {
    seenStreet.add(a.street);
    firstPerStreet.push(a);
  }
}
// STREETS_ONLY=1 restricts a run to one lookup per street, for alternating
// with 03b-propagate: teach a street, propagate its blocks, repeat.
const pending = process.env.STREETS_ONLY ? firstPerStreet : [...firstPerStreet, ...rest];
console.log(`${addresses.length} addresses, ${pending.length} to geocode (${firstPerStreet.length} street-first)`);

// 3 workers, each pacing >=800ms per address (1-2 requests) keeps the
// combined rate around 180-220 calls/min, under OneMap's ~250/min.
let done = 0;
let misses = 0;
let next = 0;
async function worker() {
  while (next < pending.length) {
    const a = pending[next++];
    const key = `${a.block}|${a.street}`;
    const started = Date.now();
    let hit = pick(await search(`${a.block} ${a.street}`), a.block);
    if (!hit) {
      const expanded = expand(a.street);
      if (expanded !== a.street) hit = pick(await search(`${a.block} ${expanded}`), a.block);
    }
    cache[key] = hit;
    if (!hit) misses++;
    done++;
    if (done % 200 === 0 || done === pending.length) {
      await Bun.write(cachePath, JSON.stringify(cache));
      console.log(`${done}/${pending.length} geocoded, ${misses} misses`);
    }
    const elapsed = Date.now() - started;
    if (elapsed < 1000) await sleep(1000 - elapsed);
  }
}
await Promise.all([worker(), worker(), worker()]);

await Bun.write(cachePath, JSON.stringify(cache));
const resolved = Object.values(cache).filter(Boolean).length;
console.log(`done: ${resolved}/${Object.keys(cache).length} resolved (${misses} new misses)`);
