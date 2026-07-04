// Deterministic question parser: extracts intent and constraints from
// natural-ish queries ("highest price in jurong in 2026", "4 room under
// 600k in punggol") without any LLM. The executor lives in main.ts.

export type Parsed = {
  superlative: "max" | "min" | null;
  flatType: number | null; // index into enums.flatTypes
  towns: number[]; // indices into enums.towns (may be several: "jurong")
  year: number | null;
  priceMax: number | null;
  priceMin: number | null;
};

const MAX_RE = /\b(HIGHEST|MOST EXPENSIVE|PRICIEST|RECORD|MAXIMUM|MAX|TOP) (PRICE|SALE|FLAT|PRICED?)?/;
const MIN_RE = /\b(CHEAPEST|LOWEST|LEAST EXPENSIVE|MINIMUM)\b/;

function parsePrice(num: string, suffix: string | undefined): number {
  const n = parseFloat(num.replace(/,/g, ""));
  if (!Number.isFinite(n)) return NaN;
  if (suffix === "K") return n * 1e3;
  if (suffix) return n * 1e6; // M / MIL / MILLION
  return n < 5000 ? n * 1e3 : n; // "under 600" almost always means S$600k
}

export function parseQuery(
  raw: string,
  towns: string[],
  flatTypes: string[],
  maxYear: number,
): Parsed {
  const q = " " + raw.trim().toUpperCase().replace(/[?.,!]/g, " ").replace(/\s+/g, " ") + " ";
  const p: Parsed = {
    superlative: MAX_RE.test(q) ? "max" : MIN_RE.test(q) ? "min" : null,
    flatType: null,
    towns: [],
    year: null,
    priceMax: null,
    priceMin: null,
  };

  const room = q.match(/\b([1-5])\s*[- ]?\s*(ROOM|RM|BR)S?\b/);
  if (room) p.flatType = flatTypes.indexOf(`${room[1]} ROOM`);
  else if (/\bEXEC/.test(q)) p.flatType = flatTypes.indexOf("EXECUTIVE");
  else if (/\bMULTI[- ]?GEN/.test(q)) p.flatType = flatTypes.indexOf("MULTI-GENERATION");
  if (p.flatType === -1) p.flatType = null;

  const under = q.match(/\b(?:UNDER|BELOW|LESS THAN|CHEAPER THAN|WITHIN|UP TO)\s*S?\$?\s*([\d.,]+)\s*(K|M|MIL|MILLION)?\b/);
  if (under) p.priceMax = parsePrice(under[1], under[2]);
  const over = q.match(/\b(?:OVER|ABOVE|MORE THAN|AT LEAST|FROM)\s*S?\$?\s*([\d.,]+)\s*(K|M|MIL|MILLION)\b/);
  if (over) p.priceMin = parsePrice(over[1], over[2]);

  const year = q.match(/\b((?:19|20)\d{2})\b/);
  if (year) {
    const y = Number(year[1]);
    if (y >= 1990 && y <= maxYear) p.year = y;
  }

  const tokens = new Set(q.trim().split(" "));
  for (let t = 0; t < towns.length; t++) {
    if (q.includes(` ${towns[t]} `)) {
      p.towns.push(t);
      continue;
    }
    // A distinctive single word matches all towns carrying it:
    // "JURONG" -> Jurong East + Jurong West. Short words (WEST, EAST)
    // are too ambiguous to match alone.
    for (const w of towns[t].split(" ")) {
      if (w.length >= 5 && tokens.has(w)) {
        p.towns.push(t);
        break;
      }
    }
  }
  return p;
}

export const hasConstraints = (p: Parsed) =>
  p.flatType !== null || p.priceMax !== null || p.priceMin !== null;
