import { readFileSync } from "node:fs";

// Geography identity is shared by matching and area guidance. Publishing an
// area description never changes the commercial catalogue or its quote gates.
export function areaKey(value) {
  return String(value || "").toLowerCase().replace(/[أإآ]/g, "ا").replace(/ى/g, "ي")
    .replace(/[\u064b-\u065f\u0670\u0640]/g, "").replace(/\s+/g, " ").trim();
}

export function areaAliases(entry) {
  return [...new Set([entry.area, entry.area?.replace(/\s+island$/i, ""),
    entry.area?.replace(/^al\s+/i, "").replace(/\s+island$/i, ""), entry.ar?.area,
    ...(entry.aliases || [])].map(areaKey).filter(alias => alias.length > 1))];
}

const data = JSON.parse(readFileSync(new URL("../../data/area-guide.json", import.meta.url), "utf8"));
export const AREA_IDENTITIES = data.areas.map(entry => ({ area: entry.area, aliases: areaAliases(entry) }));
export const CATALOG_AREA_ALIASES = Object.fromEntries(AREA_IDENTITIES.flatMap(entry => entry.aliases.map(alias => [alias, entry.area])));

function escapeRegex(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/** Prefer the longest name at a location: Yas Bay cannot become Yas Island.
 * Unicode boundaries also recognise Arabic and its attached conjunction و.
 */
export function matchAreaNames(entries, text) {
  const input = areaKey(text);
  const matches = [];
  for (const entry of entries) {
    for (const alias of entry.aliases || areaAliases(entry)) {
      const re = new RegExp(`(^|[^\\p{L}\\p{N}])(?:و)?(${escapeRegex(areaKey(alias))})(?=$|[^\\p{L}\\p{N}])`, "gu");
      for (const m of input.matchAll(re)) {
        const start = m.index + m[0].length - m[2].length;
        matches.push({ entry, start, end: start + m[2].length });
      }
    }
  }
  const picked = [];
  for (const match of matches.sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start)) {
    if (!picked.some(other => match.start < other.end && other.start < match.end)) picked.push(match);
  }
  const seen = new Set();
  return picked.sort((a, b) => a.start - b.start).map(m => m.entry).filter(entry => {
    if (seen.has(entry.area)) return false;
    seen.add(entry.area); return true;
  });
}
