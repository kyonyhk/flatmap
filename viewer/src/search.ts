// Omnibox: one search surface for everything askable — blocks (postal code
// or free text), towns, eras/stories, and years. Entirely client-side.
import type { Era } from "./events";

type Building = { block: string; street: string; town: number; postal: string };

export type SearchPick =
  | { kind: "block"; idx: number }
  | { kind: "town"; town: number }
  | { kind: "era"; era: number }
  | { kind: "year"; year: number }
  | { kind: "run"; run: () => void }
  | { kind: "query"; q: string }; // fills the box and searches — teaches the grammar

type Item = { pick: SearchPick; label: string; sub: string; badge: string };

// Computed answers (superlatives, filters) supplied by the host app.
export type AnswerItem = { label: string; sub: string; badge: string; run: () => void };

// Curated examples shown on focus and as the zero-results fallback.
export type Suggestion = Item;

// Users type full words; the data uses HDB abbreviations.
const CONTRACTIONS: [RegExp, string][] = [
  [/\bAVENUE\b/g, "AVE"], [/\bSTREET\b/g, "ST"], [/\bROAD\b/g, "RD"],
  [/\bDRIVE\b/g, "DR"], [/\bCRESCENT\b/g, "CRES"], [/\bCENTRAL\b/g, "CTRL"],
  [/\bNORTH\b/g, "NTH"], [/\bSOUTH\b/g, "STH"], [/\bBUKIT\b/g, "BT"],
  [/\bPLACE\b/g, "PL"], [/\bTERRACE\b/g, "TER"], [/\bCLOSE\b/g, "CL"],
  [/\bGARDENS\b/g, "GDNS"], [/\bHEIGHTS\b/g, "HTS"], [/\bUPPER\b/g, "UPP"],
  [/\bKAMPONG\b/g, "KG"], [/\bCOMMONWEALTH\b/g, "C'WEALTH"], [/\bPARK\b/g, "PK"],
  [/\bMARKET\b/g, "MKT"], [/\bLORONG\b/g, "LOR"], [/\bJALAN\b/g, "JLN"],
];

const title = (s: string) =>
  s.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());

export function initSearch(opts: {
  buildings: Building[];
  towns: string[];
  eras: Era[];
  maxYear: number;
  onPick: (p: SearchPick) => void;
  answers?: (q: string) => AnswerItem[];
  suggestions?: () => Suggestion[];
}) {
  const { buildings, towns, eras, maxYear, onPick } = opts;
  const input = document.getElementById("search-input") as HTMLInputElement;
  const list = document.getElementById("search-results")!;
  const byPostal = new Map(buildings.map((b, i) => [b.postal, i]));
  let items: Item[] = [];
  let cursor = -1;
  let fallback = false; // showing suggestions because the query had no match

  const blockItem = (idx: number): Item => {
    const b = buildings[idx];
    return {
      pick: { kind: "block", idx },
      label: `Blk ${b.block} ${title(b.street)}`,
      sub: `${title(towns[b.town])} · ${b.postal}`,
      badge: "block",
    };
  };

  function find(raw: string): Item[] {
    const q = raw.trim().toUpperCase();
    if (!q) return [];
    if (/^\d{6}$/.test(q)) {
      const hit = byPostal.get(q);
      return hit === undefined ? [] : [blockItem(hit)];
    }
    const out: Item[] = [];
    // Question-shaped queries get computed answers, ranked first.
    if (opts.answers && raw.trim().length >= 8) {
      for (const a of opts.answers(raw).slice(0, 2)) {
        out.push({ pick: { kind: "run", run: a.run }, label: a.label, sub: a.sub, badge: a.badge });
      }
    }
    if (/^(19|20)\d\d$/.test(q)) {
      const y = Number(q);
      if (y >= 1990 && y <= maxYear) {
        out.push({
          pick: { kind: "year", year: y },
          label: `Go to ${y}`,
          sub: "scrub the timeline",
          badge: "year",
        });
      }
    }
    if (q.length >= 3) {
      for (let i = 0; i < eras.length && out.length < 4; i++) {
        if (`${eras[i].title} ${eras[i].sub}`.toUpperCase().includes(q)) {
          out.push({
            pick: { kind: "era", era: i },
            label: eras[i].title,
            sub: eras[i].sub,
            badge: "story",
          });
        }
      }
      for (let t = 0; t < towns.length && out.length < 6; t++) {
        if (towns[t].includes(q)) {
          out.push({
            pick: { kind: "town", town: t },
            label: title(towns[t]),
            sub: "fly to town",
            badge: "town",
          });
        }
      }
    }
    // Blocks fill the remaining slots.
    let qq = q;
    for (const [re, abbr] of CONTRACTIONS) qq = qq.replace(re, abbr);
    const tokens = qq.split(/\s+/);
    let blk: string | null = null;
    let rest = tokens;
    if (/^\d+[A-Z]?$/.test(tokens[0]) && tokens.length > 1) {
      blk = tokens[0];
      rest = tokens.slice(1);
    }
    if (blk || rest.some((t) => t.length >= 3)) {
      // "520" should also find 520A/520B/520C; exact block matches rank first.
      const exact: Item[] = [];
      const prefix: Item[] = [];
      for (let i = 0; i < buildings.length && exact.length + prefix.length < 12; i++) {
        const b = buildings[i];
        if (blk && !b.block.startsWith(blk)) continue;
        const hay = `${b.street} ${towns[b.town]}`;
        if (!rest.every((t) => hay.includes(t))) continue;
        (blk && b.block === blk ? exact : prefix).push(blockItem(i));
      }
      out.push(...exact, ...prefix);
    }
    return out.slice(0, 8);
  }

  function render() {
    const head = fallback
      ? `<div class="nores">no match — try one of these</div>`
      : "";
    list.innerHTML = head + items.map((it, i) => `
      <div class="hit${i === cursor ? " cur" : ""}" data-i="${i}">
        <div class="hit-main"><strong>${it.label}</strong><span>${it.sub}</span></div>
        <span class="hit-badge">${it.badge}</span>
      </div>`).join("");
    list.classList.toggle("open", items.length > 0);
  }

  function computeItems(raw: string): Item[] {
    const t = raw.trim();
    if (!t) {
      fallback = false;
      return opts.suggestions?.() ?? [];
    }
    const found = find(raw);
    if (found.length) {
      fallback = false;
      return found;
    }
    fallback = t.length >= 3 && !!opts.suggestions;
    return fallback ? opts.suggestions!() : [];
  }

  function pick(it: Item) {
    if (it.pick.kind === "query") {
      // Teach by demonstration: fill the box and search it.
      input.value = it.pick.q;
      items = computeItems(it.pick.q);
      cursor = items.length && !fallback ? 0 : -1;
      render();
      input.focus();
      return;
    }
    items = [];
    cursor = -1;
    render();
    input.value = "";
    input.blur();
    onPick(it.pick);
  }

  input.addEventListener("input", () => {
    items = computeItems(input.value);
    cursor = items.length && !fallback && input.value.trim() ? 0 : -1;
    render();
  });
  input.addEventListener("focus", () => {
    if (!input.value.trim()) {
      items = computeItems("");
      cursor = -1;
      render();
    }
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!items.length) return;
      cursor = (cursor + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
      render();
    } else if (e.key === "Enter" && cursor >= 0) {
      pick(items[cursor]);
    } else if (e.key === "Escape") {
      items = [];
      render();
      input.value = "";
      input.blur();
    }
    e.stopPropagation();
  });
  input.addEventListener("keyup", (e) => e.stopPropagation());
  list.addEventListener("pointerdown", (e) => {
    const hit = (e.target as HTMLElement).closest(".hit") as HTMLElement | null;
    if (hit) {
      e.preventDefault();
      pick(items[Number(hit.dataset.i)]);
    }
  });
  input.addEventListener("blur", () => setTimeout(() => {
    items = [];
    render();
  }, 150));
}
