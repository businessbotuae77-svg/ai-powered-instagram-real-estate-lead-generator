import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractCommercialClaims } from "./checker.js";
import { selectValue } from "./intelligence.js";

// Owner-approved area positioning (what each area is known for). It is stable
// lifestyle knowledge, not commercial terms: anything priced, dated or
// forecast is dropped at load and still needs a sourced project record.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_PATH = path.join(ROOT, "data", "area-guide.json");
const UNSAFE = /\b(?:guarantee[ds]?|will (?:appreciate|rise|grow|increase|outperform)|roi|yield|returns?|appreciation|forecast|ignore (?:previous|all)|instructions?\s*:|system prompt)\b/i;
const KINDS = ["tagline", "character", "highlights", "bestFor", "considerations"];

let cached = null;
let cachedPath = null;

function safeLine(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim().replace(/[.]+$/, "");
  if (!text || text.length > 280 || UNSAFE.test(text) || extractCommercialClaims(text).length) return null;
  return text;
}

function lines(value) {
  const rows = Array.isArray(value) ? value : String(value ?? "").split(/\n+/);
  return rows.map(safeLine).filter(Boolean);
}

export function normalizeAreaGuideEntry(row = {}, defaults = {}) {
  const area = safeLine(row.area);
  if (!area || row.approved !== true) return null;
  const verifiedOn = row.lastVerified || defaults.lastVerified || null;
  return {
    id: row.id || `area-guide:${area.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    area,
    // "Yas Island" is also found as "yas"; "Al Reem Island" as "reem".
    aliases: [...new Set([area, area.replace(/\s+island$/i, ""), area.replace(/^al\s+/i, "").replace(/\s+island$/i, ""), ...(row.aliases || [])]
      .map(alias => String(alias).toLowerCase().trim()).filter(alias => alias.length > 2))],
    tagline: safeLine(row.tagline),
    character: safeLine(row.character),
    highlights: lines(row.highlights),
    bestFor: lines(row.bestFor),
    considerations: lines(row.considerations),
    source: row.source || defaults.source || "Owner area brief",
    verifiedOn
  };
}

/** Airtable "Area Guide" rows use one item per line in the list fields. */
export function normalizeAreaGuideRecord(record = {}) {
  const f = record.fields || {};
  return normalizeAreaGuideEntry({
    id: record.id,
    area: f.Area || f.Name,
    aliases: String(f.Aliases || "").split(/[,\n]+/),
    approved: f.Approved === true || /^approved$/i.test(selectValue(f.Approval) || ""),
    tagline: f.Tagline,
    character: f.Character || f.Summary,
    highlights: f.Highlights,
    bestFor: f["Best for"],
    considerations: f.Considerations,
    source: f.Source || "Airtable Area Guide",
    lastVerified: f["Last verified"] || null
  });
}

export function loadAreaGuide(filePath = process.env.AREA_GUIDE_PATH || DEFAULT_PATH) {
  if (cached && cachedPath === filePath) return cached;
  let rows = [];
  let defaults = {};
  try {
    const data = JSON.parse(readFileSync(filePath, "utf8"));
    rows = data.areas || [];
    defaults = { source: data.source, lastVerified: data.lastVerified };
  } catch {
    rows = [];
  }
  cached = rows.map(row => normalizeAreaGuideEntry(row, defaults)).filter(Boolean);
  cachedPath = filePath;
  return cached;
}

/** File entries are the default; an Airtable row for the same area wins. */
export function areaGuideFromCatalog(catalog = {}, fileEntries = loadAreaGuide()) {
  const byArea = new Map(fileEntries.map(entry => [entry.area.toLowerCase(), entry]));
  for (const entry of catalog.intelligence?.areaGuide || []) {
    if (!entry) continue;
    const file = byArea.get(entry.area.toLowerCase());
    byArea.set(entry.area.toLowerCase(), file ? { ...entry, aliases: [...new Set([...file.aliases, ...entry.aliases])] } : entry);
  }
  return [...byArea.values()];
}

export function findAreaEntry(guide = [], name) {
  const key = String(name || "").toLowerCase().trim();
  if (!key) return null;
  return guide.find(entry => entry.aliases.includes(key)) || null;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function areasInText(guide = [], text = "") {
  const lower = String(text).toLowerCase();
  return guide.filter(entry => entry.aliases.some(alias => new RegExp(`\\b${escapeRegExp(alias)}\\b`).test(lower)));
}

/** Each approved line becomes a citable claim for composed replies. */
export function areaGuideClaims(entries = [], { now = Date.now() } = {}) {
  const claims = [];
  for (const entry of entries) {
    const checked = Date.parse(entry.verifiedOn || "");
    if (!Number.isFinite(checked) || checked > now) continue;
    for (const kind of KINDS) {
      const values = Array.isArray(entry[kind]) ? entry[kind] : entry[kind] ? [entry[kind]] : [];
      values.forEach((value, index) => claims.push({
        evidenceId: `${entry.id}:${kind}:${index}`,
        projectId: null, unitId: null, field: "areaHighlight", value,
        source: entry.source, recordId: entry.id, sourceRecordId: entry.id,
        scope: { area: entry.area, kind }, verifiedAt: entry.verifiedOn, verifiedOn: entry.verifiedOn,
        confidence: "Owner approved", evidenceClass: "FACT", researchOnly: false, commercialQuote: null
      }));
    }
  }
  return claims;
}

/** Compact form for the model payload. */
export function areaGuideForModel(entries = []) {
  return entries.map(entry => ({ area: entry.area, tagline: entry.tagline, character: entry.character,
    highlights: entry.highlights, bestFor: entry.bestFor, considerations: entry.considerations }));
}

function joinList(items) {
  if (items.length <= 1) return items.join("");
  // Items that contain their own commas read better separated by semicolons.
  const separator = items.some(item => item.includes(",")) ? "; " : ", ";
  return `${items.slice(0, -1).join(separator)}${separator === "; " ? "; and " : " and "}${items.at(-1)}`;
}

export function areaTaglineSentence(entry) {
  if (!entry?.tagline) return null;
  return `${entry.area} is ${entry.tagline}.`;
}

/** One line that sells a location: what it is known for plus two highlights. */
export function areaPitchSentence(entry) {
  if (!entry?.tagline) return null;
  const highlights = entry.highlights.filter(item => !item.includes(",")).slice(0, 2);
  return `${entry.area} is ${entry.tagline}${highlights.length ? `, with ${highlights.join(" and ")}` : ""}.`;
}

/** "Areas" as a topic: one line per area, so the buyer can pick a lifestyle. */
export function areaOverviewText(guide = [], { limit = 6 } = {}) {
  const rows = guide.filter(entry => entry.tagline).slice(0, limit)
    .map(entry => `• ${entry.area.replace(/ Island$/, "")}: ${entry.tagline}`);
  if (!rows.length) return null;
  return ["Each area in Abu Dhabi has its own personality:", ...rows].join("\n");
}

/** One area in depth: what it is known for, who it suits, and one honest caveat. */
export function areaDetailText(entry, { projectNames = [] } = {}) {
  if (!entry) return null;
  const parts = [];
  parts.push(entry.character ? `${entry.character}.` : areaTaglineSentence(entry));
  if (entry.highlights.length) parts.push(`Highlights include ${joinList(entry.highlights.slice(0, 4))}.`);
  if (entry.bestFor.length) parts.push(`It suits ${joinList(entry.bestFor.slice(0, 3))}.`);
  if (entry.considerations.length) parts.push(`Worth knowing: ${entry.considerations[0]}.`);
  if (projectNames.length) parts.push(`Projects I follow there: ${joinList(projectNames.slice(0, 3))}.`);
  return parts.filter(Boolean).join(" ");
}

export function resetAreaGuideCache() {
  cached = null;
  cachedPath = null;
}
