import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractCommercialClaims } from "./checker.js";
import { selectValue } from "./intelligence.js";
import { areaAliases, areaKey, matchAreaNames } from "../matching/area-names.js";
import { normalizeBuyerText } from "../conversation/text.js";

// Published area positioning (what each area is known for). It is stable
// lifestyle knowledge, not commercial terms: anything priced, dated or
// forecast is dropped at load and still needs a sourced project record.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_PATH = path.join(ROOT, "data", "area-guide.json");
const UNSAFE = /\b(?:guarantee[ds]?|will (?:appreciate|rise|grow|increase|outperform)|roi|yield|returns?|appreciation|forecast|ignore (?:previous|all)|instructions?\s*:|system prompt)\b/i;
const UNSAFE_AR = /مضمون|مضمونة|عائد|عوائد|توقعات|سيرتفع|سترتفع|تجاهل.*تعليمات|تعليمات النظام|متاح(?:ة)? الان|جاهز(?:ة)? للسكن|نفدت الوحدات/;
const KINDS = ["tagline", "character", "highlights", "bestFor", "considerations", "detail"];

let cached = null;
let cachedPath = null;

function safeLine(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim().replace(/[.]+$/, "");
  const normalized = normalizeBuyerText(text).replace(/٪/g, "%");
  if (!text || text.length > 280 || UNSAFE.test(text) || UNSAFE_AR.test(areaKey(text)) || extractCommercialClaims(normalized).length) return null;
  return text;
}

function lines(value) {
  const rows = Array.isArray(value) ? value : String(value ?? "").split(/\n+/);
  return rows.map(safeLine).filter(Boolean);
}

function safeParagraph(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text || text.length > 1400 || !text.split(/[.!؟]\s*/u).filter(Boolean).every(safeLine)) return null;
  return text;
}

function sourceUrls(value) {
  return (Array.isArray(value) ? value : String(value || "").split(/\s+/)).filter(value => {
    try { return new URL(value).protocol === "https:"; } catch { return false; }
  });
}

export function normalizeAreaGuideEntry(row = {}, defaults = {}) {
  const area = safeLine(row.area);
  if (!area || row.approved !== true) return null;
  const verifiedOn = row.lastVerified || defaults.lastVerified || null;
  return {
    id: row.id || `area-guide:${area.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    area,
    // "Yas Island" is also found as "yas"; "Al Reem Island" as "reem".
    aliases: areaAliases({ ...row, area }),
    tagline: safeLine(row.tagline),
    character: safeLine(row.character),
    highlights: lines(row.highlights),
    bestFor: lines(row.bestFor),
    considerations: lines(row.considerations),
    detail: safeParagraph(row.detail),
    ar: row.ar ? { area: safeLine(row.ar.area), tagline: safeLine(row.ar.tagline),
      detail: safeParagraph(row.ar.detail), character: safeLine(row.ar.character),
      highlights: lines(row.ar.highlights), bestFor: lines(row.ar.bestFor), considerations: lines(row.ar.considerations) } : null,
    sources: sourceUrls(row.sources || row.source || defaults.source),
    source: row.source || defaults.source || "Owner area brief",
    verifiedOn
  };
}

/** Airtable "Area Guide" rows use one item per line in the list fields. */
export function normalizeAreaGuideRecord(record = {}) {
  const f = record.fields || {};
  // Scoped orientation fields are independent of the still-pending research
  // row. They contain no commercial terms, forecasts or implied human review.
  if (Object.hasOwn(f, "Guide status")) {
    const area = f.Name || f.Area;
    const status = selectValue(f["Guide status"]);
    if (status !== "Published") return area ? { area, disabled: true } : null;
    const sources = sourceUrls(f["Guide sources"]);
    const checked = f["Guide checked on"];
    if (!sources.length || !Number.isFinite(Date.parse(checked)) || Date.parse(checked) > Date.now()) return { area, disabled: true };
    const fallback = loadAreaGuide().find(entry => areaKey(entry.area) === areaKey(area));
    const entry = normalizeAreaGuideEntry({ id: record.id, area, approved: true,
      aliases: fallback?.aliases, tagline: f["Guide tagline"], detail: f["Guide English"],
      ar: { area: fallback?.ar?.area || area, tagline: fallback?.ar?.tagline, detail: f["Guide Arabic"] },
      sources, source: sources[0], lastVerified: checked });
    return entry?.detail && entry.ar?.detail ? entry : { area, disabled: true };
  }
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
    if (entry.disabled) { byArea.delete(entry.area.toLowerCase()); continue; }
    const file = byArea.get(entry.area.toLowerCase());
    byArea.set(entry.area.toLowerCase(), file ? { ...entry, aliases: [...new Set([...file.aliases, ...entry.aliases])] } : entry);
  }
  return [...byArea.values()];
}

export function findAreaEntry(guide = [], name) {
  const key = areaKey(name);
  if (!key) return null;
  return guide.find(entry => entry.aliases.includes(key)) || null;
}

export function areasInText(guide = [], text = "") { return matchAreaNames(guide, text); }

/** Each approved line becomes a citable claim for composed replies. */
export function areaGuideClaims(entries = [], { now = Date.now() } = {}) {
  const claims = [];
  for (const entry of entries) {
    const checked = Date.parse(entry.verifiedOn || "");
    if (!Number.isFinite(checked) || checked > now) continue;
    for (const language of ["en", "ar"]) for (const kind of KINDS) {
      const local = language === "ar" ? entry.ar || {} : entry;
      const values = Array.isArray(local[kind]) ? local[kind] : local[kind] ? [local[kind]] : [];
      values.forEach((value, index) => claims.push({
        evidenceId: `${entry.id}:${language}:${kind}:${index}`,
        projectId: null, unitId: null, field: "areaHighlight", value,
        source: entry.source, recordId: entry.id, sourceRecordId: entry.id,
        scope: { area: entry.area, kind }, verifiedAt: entry.verifiedOn, verifiedOn: entry.verifiedOn,
        confidence: entry.sources?.length ? "Source checked" : "Owner approved", evidenceClass: "FACT", researchOnly: false, commercialQuote: null
      }));
    }
  }
  return claims;
}

/** Compact form for the model payload. */
export function areaGuideForModel(entries = []) {
  return entries.map(entry => ({ area: entry.area, tagline: entry.tagline, character: entry.character,
    highlights: entry.highlights, bestFor: entry.bestFor, considerations: entry.considerations,
    detail: entry.detail, ar: entry.ar, sources: entry.sources }));
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
export function areaPitchSentence(entry, { ar = false } = {}) {
  if (!entry?.tagline) return null;
  if (ar && entry.ar?.tagline) return `${entry.ar.area || entry.area}: ${entry.ar.tagline}.`;
  const highlights = entry.highlights.filter(item => !item.includes(",")).slice(0, 2);
  return `${entry.area} is ${entry.tagline}${highlights.length ? `, with ${highlights.join(" and ")}` : ""}.`;
}

/** "Areas" as a topic: one line per area, so the buyer can pick a lifestyle. */
export function areaOverviewText(guide = [], { limit = 12, ar = false } = {}) {
  const rows = guide.filter(entry => entry.tagline).slice(0, limit)
    .map(entry => ar ? `• ${entry.ar?.area || entry.area}: ${entry.ar?.tagline || entry.tagline}` : `• ${entry.area.replace(/ Island$/, "")}: ${entry.tagline}`);
  if (!rows.length) return null;
  return [ar ? "لكل منطقة في أبوظبي طابع مختلف:" : "Each area in Abu Dhabi has its own personality:", ...rows].join("\n");
}

/** One area in depth: what it is known for and who it suits. Considerations stay advisor guidance. */
export function areaDetailText(entry, { projectNames = [], ar = false } = {}) {
  if (!entry) return null;
  const detail = ar ? entry.ar?.detail : entry.detail;
  if (detail) return [detail, projectNames.length ? (ar ? `مشاريع أتابعها في المنطقة: ${projectNames.slice(0, 3).join("، ")}.` : `Projects I follow there: ${joinList(projectNames.slice(0, 3))}.`) : null].filter(Boolean).join(" ");
  const parts = [];
  parts.push(entry.character ? `${entry.character}.` : areaTaglineSentence(entry));
  if (entry.highlights.length) parts.push(`Highlights include ${joinList(entry.highlights.slice(0, 4))}.`);
  if (entry.bestFor.length) parts.push(`It suits ${joinList(entry.bestFor.slice(0, 3))}.`);
  if (projectNames.length) parts.push(`Projects I follow there: ${joinList(projectNames.slice(0, 3))}.`);
  return parts.filter(Boolean).join(" ");
}

export function resetAreaGuideCache() {
  cached = null;
  cachedPath = null;
}
