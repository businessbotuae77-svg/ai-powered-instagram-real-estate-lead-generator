import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_DIRECTORY = fileURLToPath(new URL("../../data/market-prices/", import.meta.url));
const DIMENSIONS = ["Level", "Area", "Project", "Type", "Bedrooms", "Sale Type"];
const NUMBERS = ["Sales", "Avg AED per sqft", "Median AED per sqft", "Avg price AED", "Median price AED", "Avg size sqft", "Cheapest rank"];
const COMMON_COLUMNS = ["Key", ...DIMENSIONS, ...NUMBERS.filter(key => key !== "Cheapest rank"), "First sale", "Last sale", "Reliability"];
const FILTER_KEYS = { level: "Level", area: "Area", project: "Project", type: "Type", bedrooms: "Bedrooms", saleType: "Sale Type", period: "Period", quarter: "Quarter" };
const PLACEHOLDERS = new Set(["all projects", "no project name", "private"]);
const ALIASES = {
  "Abu Dhabi": ["Abu Dhabi emirate", "أبوظبي", "أبو ظبي"],
  "Al Reem Island": ["Reem", "Al Reem", "Reem Island", "الريم", "جزيرة الريم"],
  "Al Saadiyat Island": ["Saadiyat", "Saadiyat Island", "السعديات", "جزيرة السعديات"],
  "Yas Island": ["Yas", "ياس", "جزيرة ياس"],
  "Al Shamkhah": ["Shamkha", "Shamkhah", "Al Shamkha", "الشامخة", "شامخة"],
  "Khalifa City": ["مدينة خليفة", "خليفة"],
  "Al Hidayriyyat": ["Hudayriyat", "Hudayriyat Island", "الحديريات", "جزيرة الحديريات"],
  "Al Rahah": ["Al Raha", "Al Raha Beach", "Raha Beach", "الراحة", "شاطئ الراحة"],
  "The Gate, Masdar City": ["Masdar", "Masdar City", "مصدر", "مدينة مصدر"]
};
const cache = new Map();
const internals = new WeakMap();
const normalize = value => String(value ?? "").normalize("NFKC").toLowerCase().replace(/[’`]/g, "'").replace(/[\u064b-\u065f\u0670]/g, "").replace(/[أإآ]/g, "ا").replace(/\s+/g, " ").trim();
const escaped = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Strict RFC-style CSV reader; quoted commas, CRLF, BOM and newlines are data. */
export function parseMarketPriceCsv(input, requiredColumns = []) {
  const text = String(input).replace(/^\uFEFF/, "");
  const records = [];
  let row = [], field = "", quoted = false, closed = false, start = 0;
  const pushRow = () => {
    if (row.length !== 1 || row[0] !== "") records.push(row);
    row = []; field = ""; closed = false;
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char !== '"') continue;
      field += text.slice(start, i);
      if (text[i + 1] === '"') { field += '"'; i++; start = i + 1; }
      else { quoted = false; closed = true; }
    } else if (char === "," || char === "\r" || char === "\n") {
      row.push(closed ? field : text.slice(start, i));
      field = ""; closed = false;
      if (char !== ",") { pushRow(); if (char === "\r" && text[i + 1] === "\n") i++; }
      start = i + 1;
    }
    else if (char === '"' && i === start && !closed) { quoted = true; start = i + 1; }
    else {
      if (closed || char === '"') throw new Error("Malformed market CSV quote");
    }
  }
  if (quoted) throw new Error("Unclosed market CSV quote");
  if (start < text.length || row.length || closed) { row.push(closed ? field : text.slice(start)); pushRow(); }
  if (!records.length) throw new Error("Missing market CSV header");
  const headers = records.shift();
  if (new Set(headers).size !== headers.length || headers.some(header => !header)) throw new Error("Invalid market CSV header");
  for (const column of requiredColumns) if (!headers.includes(column)) throw new Error(`Missing market CSV column: ${column}`);
  return records.map(values => {
    if (values.length !== headers.length) throw new Error("Invalid market CSV column count");
    return Object.fromEntries(headers.map((header, index) => [header, values[index]]));
  });
}

function checkedRows(rows, quarterly) {
  const columns = [...COMMON_COLUMNS, ...(quarterly ? ["Quarter", "Quarter status"] : ["Period", "Cheapest rank", "Data up to"])];
  const keys = new Set();
  return Object.freeze(rows.map(input => {
    if (columns.some(column => !Object.hasOwn(input, column))) throw new Error("Missing market row field");
    const row = { ...input };
    if (keys.has(row.Key)) throw new Error("Duplicate market row key");
    keys.add(row.Key);
    if (!["Abu Dhabi", "District", "Project"].includes(row.Level) || !row.Area || !row.Project ||
        !["All", "Off-plan", "Ready"].includes(row["Sale Type"]) || !["OK", "Low sample"].includes(row.Reliability)) throw new Error("Invalid market row scope");
    for (const field of NUMBERS) {
      if (!Object.hasOwn(row, field)) continue;
      const value = row[field];
      if (field === "Cheapest rank" && (value === "" || value === null)) { row[field] = null; continue; }
      if (typeof value !== "number" && !/^\d+(?:\.\d+)?$/.test(String(value))) throw new Error("Invalid market row number");
      row[field] = Number(value);
      if (!Number.isFinite(row[field]) || row[field] < 0 || (["Sales", "Cheapest rank"].includes(field) && (!Number.isSafeInteger(row[field]) || row[field] < 1))) throw new Error("Invalid market row number");
    }
    if (quarterly && !/^\d{4}-Q[1-4]$/.test(row.Quarter)) throw new Error("Invalid market quarter");
    if (!quarterly && !["Last 3 months", "Last 12 months", "Last 2 years", "Last 3 years", "All data"].includes(row.Period)) throw new Error("Invalid market period");
    for (const field of ["First sale", "Last sale", ...(!quarterly ? ["Data up to"] : [])]) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(row[field]) || !Number.isFinite(Date.parse(row[field])) || new Date(row[field]).toISOString().slice(0, 10) !== row[field]) throw new Error("Invalid market row date");
    }
    if (row["First sale"] > row["Last sale"] || (!quarterly && row["Last sale"] > row["Data up to"])) throw new Error("Invalid market row dates");
    return Object.freeze(row);
  }));
}

function makeIndex(rows, timeColumn) {
  const indexes = new Map([...DIMENSIONS, timeColumn].map(column => [column, new Map()]));
  for (const row of rows) for (const [column, values] of indexes) {
    const key = normalize(row[column]);
    if (!values.has(key)) values.set(key, []);
    values.get(key).push(row);
  }
  return indexes;
}

function placeId(place) { return JSON.stringify([place.level, place.area, place.project]); }
function placeAliases(place) {
  // Masdar is deliberately a single project, never the whole Khalifa district.
  return [...new Set([place.name, ...(ALIASES[place.name] || [])].map(normalize))];
}

/** Index the supplied precomputed figures. No prices, averages or ranks are calculated. */
export function createMarketPrices({ periodRows = [], quarterRows = [], report = {} } = {}) {
  const periods = checkedRows(periodRows, false), quarters = checkedRows(quarterRows, true);
  const dates = [...new Set(periods.map(row => row["Data up to"]))];
  if (dates.length > 1) throw new Error("Mixed market table versions");
  const placeMap = new Map();
  let firstSale = null, lastSale = null;
  for (const row of [...periods, ...quarters]) {
    if (!firstSale || row["First sale"] < firstSale) firstSale = row["First sale"];
    if (!lastSale || row["Last sale"] > lastSale) lastSale = row["Last sale"];
    if (row.Level === "Project" && PLACEHOLDERS.has(normalize(row.Project))) continue;
    const place = { level: row.Level, area: row.Area, project: row.Project, name: row.Level === "Project" ? row.Project : row.Area };
    placeMap.set(placeId(place), place);
  }
  if (dates[0] && lastSale > dates[0]) throw new Error("Mixed market table versions");
  const places = Object.freeze([...placeMap.values()].map(Object.freeze));
  const coverage = Object.freeze({ available: Boolean(periods.length || quarters.length), projectCount: new Set(places.filter(place => place.level === "Project").map(place => place.project)).size,
    districtCount: new Set(places.filter(place => place.level === "District").map(place => place.area)).size,
    periodRows: periods.length, quarterRows: quarters.length, dataUpTo: dates[0] || lastSale, firstSale,
    sourceSales: report.sourceSales ?? null, salesUsed: report.salesUsed ?? null });
  const data = Object.freeze({ periods, quarters, periodRows: periods, quarterRows: quarters, places, coverage,
    source: Object.freeze({ origin: "Bundled precomputed market tables", dataUpTo: coverage.dataUpTo, commercialUse: false }) });
  internals.set(data, { periods: makeIndex(periods, "Period"), quarters: makeIndex(quarters, "Quarter"),
    aliases: places.map(place => ({ place, names: placeAliases(place) })) });
  return data;
}

/** Read the bundled tables once per directory, including a fail-closed missing dataset. */
export function loadMarketPrices(directory = DEFAULT_DIRECTORY) {
  directory = directory?.directory || directory;
  const resolved = directory instanceof URL ? fileURLToPath(directory) : path.resolve(directory);
  if (cache.has(resolved)) return cache.get(resolved);
  let data;
  try {
    const periodRows = parseMarketPriceCsv(readFileSync(path.join(resolved, "period_prices.csv"), "utf8"), [...COMMON_COLUMNS, "Period", "Cheapest rank", "Data up to"]);
    const quarterRows = parseMarketPriceCsv(readFileSync(path.join(resolved, "quarterly_prices.csv"), "utf8"), [...COMMON_COLUMNS, "Quarter", "Quarter status"]);
    let report = "";
    try { report = readFileSync(path.join(resolved, "build_report.txt"), "utf8"); } catch { /* Optional provenance counts. */ }
    data = createMarketPrices({ periodRows, quarterRows, report: {
      sourceSales: Number(report.match(/^Source rows: (\d+)$/m)?.[1]) || null,
      salesUsed: Number(report.match(/^Sales used in the tables: (\d+)$/m)?.[1]) || null
    } });
  } catch {
    data = createMarketPrices();
  }
  cache.set(resolved, data);
  return data;
}

function lookup(data, filters, table, timeColumn) {
  if (!data || !internals.has(data)) return [];
  const entries = [];
  for (const [key, value] of Object.entries(filters)) {
    const column = FILTER_KEYS[key] || key;
    // Unknown and empty filters must never silently widen a requested scope.
    if (![...DIMENSIONS, timeColumn].includes(column) || value === null || value === undefined || value === "") return [];
    const normalized = normalize(value);
    if (entries.some(([field, existing]) => field === column && existing !== normalized)) return [];
    entries.push([column, normalized]);
  }
  const indexes = internals.get(data)[table];
  let candidates = data[table];
  for (const [column, value] of entries) {
    const rows = indexes.get(column).get(value);
    if (!rows) return [];
    if (rows.length < candidates.length) candidates = rows;
  }
  return candidates.filter(row => entries.every(([column, value]) => normalize(row[column]) === value));
}

export function marketPriceRows(data, filters = {}) { return lookup(data, filters, "periods", "Period"); }
export function marketQuarterRows(data, filters = {}) { return lookup(data, filters, "quarters", "Quarter"); }
export function marketPriceCoverage(data) { return data?.coverage || createMarketPrices().coverage; }

/** Resolve the whole supplied name, including explicit aliases, without substring guesses. */
export function exactMarketPlaces(query, data) {
  if (!internals.has(data)) return [];
  const text = normalize(query);
  if (!text) return [];
  return internals.get(data).aliases.filter(({ names }) => names.includes(text)).map(({ place }) => place);
}

/** Cheapest means the supplied rank, with low-sample/unranked rows excluded. */
export function cheapestMarketAreas(data, filters = {}, { limit = 5 } = {}) {
  const level = filters.level ?? filters.Level ?? "District";
  const rows = marketPriceRows(data, { ...filters, level });
  // An incomplete segment would mix ranks that were calculated in different groups.
  if (["Period", "Type", "Bedrooms", "Sale Type"].some(key => new Set(rows.map(row => row[key])).size > 1)) return [];
  return rows.filter(row => row.Reliability === "OK" && Number.isFinite(row["Cheapest rank"]))
    .sort((a, b) => a["Cheapest rank"] - b["Cheapest rank"] || a.Area.localeCompare(b.Area) || a.Project.localeCompare(b.Project))
    .slice(0, Math.max(0, Math.min(100, Math.floor(Number(limit) || 0))));
}

/** Exact names and declared aliases only; preserve ambiguous names for clarification. */
export function marketPlacesInMessage(message, data) {
  if (!internals.has(data)) return [];
  const text = normalize(message), hits = [];
  for (const { place, names } of internals.get(data).aliases) for (const name of names) {
    const conjunction = /^[\u0600-\u06ff]/.test(name) ? "(?:و)?" : "";
    const pattern = new RegExp(`(^|[^\\p{L}\\p{N}])${conjunction}(${escaped(name)})(?=$|[^\\p{L}\\p{N}])`, "gu");
    for (const match of text.matchAll(pattern)) {
      const start = match.index + match[0].length - match[2].length;
      hits.push({ place, start, end: start + match[2].length });
    }
  }
  const specific = hits.filter(hit => !hits.some(other => other.start <= hit.start && other.end >= hit.end && other.end - other.start > hit.end - hit.start));
  const seen = new Set();
  return specific.sort((a, b) => a.start - b.start).filter(hit => {
    const id = placeId(hit.place);
    if (seen.has(id)) return false;
    seen.add(id); return true;
  }).map(hit => hit.place);
}

function distance(a, b) {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 0; i < a.length; i++) {
    const next = [i + 1];
    for (let j = 0; j < b.length; j++) next.push(Math.min(next[j] + 1, previous[j + 1] + 1, previous[j] + Number(a[i] !== b[j])));
    previous = next;
  }
  return previous[b.length];
}

/** Suggestions are identities to ask about, never an automatic fuzzy selection. */
export function findMarketPlaces(query, data, { limit = 5 } = {}) {
  if (!internals.has(data)) return [];
  const text = normalize(query);
  if (text.length < 2 || text.length > 200) return [];
  const scored = internals.get(data).aliases.map(({ place, names }) => {
    let score = Infinity;
    for (const name of names) {
      if (name === text) score = 0;
      else if (name.includes(text) && text.length >= 3) score = Math.min(score, 1 + (name.length - text.length) / name.length);
      else {
        const difference = distance(text, name);
        if (difference <= Math.max(1, Math.floor(Math.max(text.length, name.length) * 0.25))) score = Math.min(score, 2 + difference / Math.max(text.length, name.length));
      }
    }
    return { place, score };
  });
  return scored.filter(item => Number.isFinite(item.score)).sort((a, b) => a.score - b.score || a.place.name.localeCompare(b.place.name))
    .slice(0, Math.max(0, Math.min(20, Math.floor(Number(limit) || 0)))).map(item => item.place);
}

export const marketPlaceMatches = findMarketPlaces;
export function marketCheapestAreas(data, filters = {}, limit = 5) { return cheapestMarketAreas(data, filters, typeof limit === "object" ? limit : { limit }); }
