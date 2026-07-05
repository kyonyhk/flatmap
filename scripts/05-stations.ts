// Station display data: joins LTA exits (which stations exist), rail line
// codes/colors (public LTA facts, cross-referenced from cheeaun/sgraildata),
// and URA Master Plan 2019 rail-station polygons (structure footprints,
// with above/underground flag). Emits data/out/stations.json.
import { RAW, OUT } from "./lib";

const norm = (s: string) =>
  s.toUpperCase().replace(/\s+(MRT|LRT)\s+STATION$/i, "").replace(/[^A-Z0-9]/g, "");

// LTA line colors by sgraildata's color vocabulary.
const LINE_HEX: Record<string, string> = {
  red: "#d42e12",
  green: "#009645",
  purple: "#9900aa",
  yellow: "#fa9e0d",
  blue: "#005ec4",
  brown: "#9d5b25",
  grey: "#748477",
  gray: "#748477",
};

// Stations that exist today, from the exits dataset.
const exitsGeo = await Bun.file(`${RAW}/mrt-exits.geojson`).json();
const byStation = new Map<string, { name: string; lat: number; lon: number; n: number }>();
for (const f of exitsGeo.features) {
  const raw = String(f.properties.STATION_NA).replace(/\s+(MRT|LRT)\s+STATION$/i, "").trim();
  const key = norm(raw);
  let s = byStation.get(key);
  if (!s) byStation.set(key, (s = { name: raw, lat: 0, lon: 0, n: 0 }));
  const [lon, lat] = f.geometry.coordinates;
  s.lat += lat;
  s.lon += lon;
  s.n++;
}

// Line codes + colors by station name, plus a code->station reverse map
// (a few exits rows name the station by its code, e.g. "CC9").
type Codes = { name: string; codes: string[]; colors: string[] };
const codesByName = new Map<string, Codes>();
const byCode = new Map<string, Codes>();
{
  const g = await Bun.file(`${RAW}/sgrail-stations.geojson`).json();
  for (const f of g.features) {
    if (f.geometry.type !== "Point" || !f.properties.station_codes || !f.properties.name) continue;
    const codes = String(f.properties.station_codes).split("-");
    const colors = String(f.properties.station_colors ?? "")
      .split("-")
      .map((c) => LINE_HEX[c] ?? "#52514e");
    const entry: Codes = { name: f.properties.name, codes, colors };
    codesByName.set(norm(f.properties.name), entry);
    for (const c of codes) byCode.set(c, entry);
  }
}
// Newer than the reference data.
codesByName.set("MARINASOUTH", { name: "Marina South", codes: ["TE22"], colors: [LINE_HEX.brown] });

// Structure footprints from Master Plan 2019.
const ringsByName = new Map<string, { grnd: string; ring: [number, number][] }>();
{
  const g = await Bun.file(`${RAW}/mp19-rail.geojson`).json();
  for (const f of g.features) {
    if (!f.properties?.NAME) continue;
    const ring = (f.geometry.type === "MultiPolygon"
      ? f.geometry.coordinates[0][0]
      : f.geometry.coordinates[0]
    ).map(([x, y]: number[]) => [+x.toFixed(5), +y.toFixed(5)]);
    ringsByName.set(norm(f.properties.NAME), {
      grnd: f.properties.GRND_LEVEL,
      ring,
    });
  }
}

const title = (s: string) =>
  s.toLowerCase().replace(/(^|\s|-)\S/g, (c) => c.toUpperCase());

let noCodes = 0;
let noRing = 0;
const stations = [...byStation.entries()].map(([key, s]) => {
  const cc = codesByName.get(key) ?? byCode.get(key);
  const rr = ringsByName.get(cc ? norm(cc.name) : key) ?? ringsByName.get(key);
  if (!cc) noCodes++;
  if (!rr) noRing++;
  return {
    name: title(cc?.name ?? s.name),
    lat: +(s.lat / s.n).toFixed(6),
    lon: +(s.lon / s.n).toFixed(6),
    codes: cc?.codes ?? [],
    colors: cc?.colors ?? [],
    grnd: rr?.grnd ?? null,
    ring: rr?.ring ?? null,
  };
});

await Bun.write(`${OUT}/stations.json`, JSON.stringify(stations));
console.log(
  `stations: ${stations.length} · without codes: ${noCodes} · without footprint: ${noRing}`,
);
if (noCodes) {
  for (const [key, s] of byStation) if (!codesByName.get(key)) console.log("  no codes:", s.name);
}
