// Shared helpers for the data pipeline.

export const ROOT = new URL("..", import.meta.url).pathname;
export const RAW = `${ROOT}data/raw`;
export const INTERIM = `${ROOT}data/interim`;
export const OUT = `${ROOT}data/out`;

// Minimal RFC-4180 CSV parser. The government CSVs are simple but some
// fields are quoted, so handle quotes properly rather than splitting on commas.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field.endsWith("\r") ? field.slice(0, -1) : field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field.endsWith("\r") ? field.slice(0, -1) : field);
    if (row.length > 1 || row[0] !== "") rows.push(row);
  }
  return rows;
}

export function csvToObjects(text: string): Record<string, string>[] {
  const rows = parseCsv(text);
  const header = rows[0];
  return rows.slice(1).map((r) => {
    const o: Record<string, string> = {};
    for (let i = 0; i < header.length; i++) o[header[i]] = r[i] ?? "";
    return o;
  });
}

export const addressKey = (block: string, street: string) =>
  `${block.trim().toUpperCase()}|${street.trim().toUpperCase().replace(/\s+/g, " ")}`;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
