// Merge the five resale CSVs into one normalized NDJSON file and extract
// the unique block+street addresses that need geocoding.
//
// Normalizations:
// - flat_type: "MULTI GENERATION" and "MULTI-GENERATION" unified
// - flat_model: uppercased (1990s files use IMPROVED, later files Improved)
// - month "YYYY-MM" -> monthIdx (months since 1990-01)
// - storey_range "10 TO 12" -> storeyMid 11
// - remaining lease derived uniformly as leaseCommence + 99 - saleYear
//   (the remaining_lease column only exists from 2015, so derive everywhere)
import { RAW, INTERIM, csvToObjects, addressKey } from "./lib";

const FILES = [
  "resale-1990-1999",
  "resale-2000-2012",
  "resale-2012-2014",
  "resale-2015-2016",
  "resale-2017-present",
];

const FLAT_TYPES = [
  "1 ROOM", "2 ROOM", "3 ROOM", "4 ROOM", "5 ROOM", "EXECUTIVE", "MULTI-GENERATION",
];

const normFlatType = (s: string) => {
  const t = s.trim().toUpperCase().replace("MULTI GENERATION", "MULTI-GENERATION");
  const idx = FLAT_TYPES.indexOf(t);
  if (idx === -1) throw new Error(`Unknown flat_type: ${s}`);
  return idx;
};

const flatModels = new Map<string, number>();
const normFlatModel = (s: string) => {
  const t = s.trim().toUpperCase();
  if (!flatModels.has(t)) flatModels.set(t, flatModels.size);
  return flatModels.get(t)!;
};

const monthIdx = (month: string) => {
  const [y, m] = month.split("-").map(Number);
  return (y - 1990) * 12 + (m - 1);
};

const storeyMid = (range: string) => {
  const m = range.match(/(\d+)\s+TO\s+(\d+)/);
  if (!m) throw new Error(`Bad storey_range: ${range}`);
  return Math.round((Number(m[1]) + Number(m[2])) / 2);
};

const towns = new Map<string, number>();
const addresses = new Map<string, { block: string; street: string; town: string }>();

const out: string[] = [];
let total = 0;
for (const name of FILES) {
  const rows = csvToObjects(await Bun.file(`${RAW}/${name}.csv`).text());
  for (const r of rows) {
    const town = r.town.trim().toUpperCase();
    if (!towns.has(town)) towns.set(town, towns.size);
    const key = addressKey(r.block, r.street_name);
    if (!addresses.has(key)) {
      addresses.set(key, { block: r.block.trim().toUpperCase(), street: r.street_name.trim().toUpperCase(), town });
    }
    const saleMonth = monthIdx(r.month);
    out.push(
      JSON.stringify({
        addr: key,
        m: saleMonth,
        town: towns.get(town),
        ft: normFlatType(r.flat_type),
        fm: normFlatModel(r.flat_model),
        storey: storeyMid(r.storey_range),
        sqm: Math.round(parseFloat(r.floor_area_sqm) * 10),
        lease: Number(r.lease_commence_date),
        price: Math.round(Number(r.resale_price)),
      }),
    );
    total++;
  }
  console.log(`${name}: ${rows.length} rows`);
}

await Bun.write(`${INTERIM}/transactions.ndjson`, out.join("\n") + "\n");
await Bun.write(
  `${INTERIM}/addresses.json`,
  JSON.stringify([...addresses.values()], null, 1),
);
await Bun.write(
  `${INTERIM}/enums.json`,
  JSON.stringify(
    {
      flatTypes: FLAT_TYPES,
      flatModels: [...flatModels.keys()],
      towns: [...towns.keys()],
    },
    null,
    1,
  ),
);
console.log(`total: ${total} transactions, ${addresses.size} unique addresses, ${flatModels.size} flat models, ${towns.size} towns`);
