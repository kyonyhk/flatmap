// Expand the address universe beyond blocks that have traded: every
// residential block in HDB property information joins addresses.json, so
// never-resold blocks (Tengah, young BTOs still inside their MOP) exist on
// the map as "not yet traded" rather than being invisible.
//
// Town names for new blocks come from property-info's bldg_contract_town
// code, learned by majority vote from blocks we already know (the resale
// data has the town name, property info has the code). Codes with no
// overlap (new towns) are supplied manually.
import { RAW, INTERIM, csvToObjects, addressKey } from "./lib";

const NEW_TOWN_CODES: Record<string, string> = { TG: "TENGAH" };

const rows = csvToObjects(await Bun.file(`${RAW}/hdb-property-info.csv`).text());
type Addr = { block: string; street: string; town: string };
const addresses: Addr[] = await Bun.file(`${INTERIM}/addresses.json`).json();
const known = new Map(addresses.map((a) => [addressKey(a.block, a.street), a.town]));

// Learn code -> town name from the overlap.
const votes = new Map<string, Map<string, number>>();
for (const r of rows) {
  const town = known.get(addressKey(r.blk_no, r.street));
  if (!town || !r.bldg_contract_town) continue;
  let v = votes.get(r.bldg_contract_town);
  if (!v) votes.set(r.bldg_contract_town, (v = new Map()));
  v.set(town, (v.get(town) ?? 0) + 1);
}
const codeToTown = new Map<string, string>();
for (const [code, v] of votes) {
  codeToTown.set(code, [...v.entries()].sort((a, z) => z[1] - a[1])[0][0]);
}
for (const [code, town] of Object.entries(NEW_TOWN_CODES)) {
  if (!codeToTown.has(code)) codeToTown.set(code, town);
}

const enums = await Bun.file(`${INTERIM}/enums.json`).json();
const townSet = new Set<string>(enums.towns);

let added = 0;
const skipped = new Map<string, number>();
for (const r of rows) {
  if (r.residential !== "Y" || !(+r.total_dwelling_units > 0)) continue;
  const key = addressKey(r.blk_no, r.street);
  if (known.has(key)) continue;
  const town = codeToTown.get(r.bldg_contract_town);
  if (!town) {
    skipped.set(r.bldg_contract_town, (skipped.get(r.bldg_contract_town) ?? 0) + 1);
    continue;
  }
  if (!townSet.has(town)) {
    townSet.add(town);
    enums.towns.push(town);
  }
  addresses.push({
    block: r.blk_no.trim().toUpperCase(),
    street: r.street.trim().toUpperCase().replace(/\s+/g, " "),
    town,
  });
  known.set(key, town);
  added++;
}

await Bun.write(`${INTERIM}/addresses.json`, JSON.stringify(addresses, null, 1));
await Bun.write(`${INTERIM}/enums.json`, JSON.stringify(enums, null, 1));
console.log(
  `universe: +${added} never-traded blocks -> ${addresses.length} addresses · towns: ${enums.towns.length}`,
);
if (skipped.size) console.log("skipped codes:", [...skipped.entries()].map(([c, n]) => `${c}×${n}`).join(" "));