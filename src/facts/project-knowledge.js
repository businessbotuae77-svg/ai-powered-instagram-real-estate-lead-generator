import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_PATH = fileURLToPath(new URL("../../data/market-prices/project_knowledge.json", import.meta.url));
const cache = new Map();
const internals = new WeakMap();
const PERIODS = ["Last 3 months", "This year", "Last 12 months"];
const BEDROOMS = ["Studio", "1 BR", "2 BR", "3 BR", "4 BR", "5+ BR", "Not stated", "All"];
const TYPES = ["Apartment", "Villa", "Townhouse", "Duplex", "Penthouse", "Villa plot", "Office", "Retail"];
const STAT_FILTERS = ["project", "area", "period", "saleSequence", "saleType", "type", "bedrooms"];
const STAT_NUMBERS = ["averageAedPerSqft", "medianAedPerSqft", "averagePriceAed", "medianPriceAed", "averageSizeSqft"];
const COUNTS = ["observedSales", "primaryOffPlanSales", "secondarySales", "primaryReadySales"];
const UNNAMED = new Set(["", "private", "no project name", "all projects", "unclassified", "unknown", "n/a", "na", "not specified"]);
const normalize = value => String(value ?? "").normalize("NFKC").toLowerCase().replace(/[’`]/g, "'").replace(/[\u064b-\u065f\u0670]/g, "").replace(/[أإآ]/g, "ا")
  .replace(/[٠-٩]/g, digit => String(digit.charCodeAt(0) - 1632)).replace(/\s+/g, " ").trim();
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const validDate = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const count = value => Number.isSafeInteger(value) && value >= 0;
const text = value => typeof value === "string" && value.trim().length > 0 && value.length <= 1000;

function coverageFor(projects) {
  const primary = new Set(projects.filter(project => project.primaryOffPlanSales > 0).map(project => project.name));
  const secondary = new Set(projects.filter(project => project.secondarySales > 0).map(project => project.name));
  const all = new Set(projects.map(project => project.name));
  return Object.freeze({ projectCount: all.size, identityCount: projects.length, primaryOffPlanProjectCount: primary.size,
    secondaryProjectCount: secondary.size, primaryOffPlanOrSecondaryProjectCount: new Set([...primary, ...secondary]).size,
    secondaryOnlyProjectCount: [...secondary].filter(name => !primary.has(name)).length,
    primaryReadyProjectCount: new Set(projects.filter(project => project.primaryReadySales > 0).map(project => project.name)).size,
    otherRecentProjectCount: [...all].filter(name => !primary.has(name) && !secondary.has(name)).length,
    observedSales: projects.reduce((total, project) => total + project.observedSales, 0),
    statsRowCount: projects.reduce((total, project) => total + project.stats.length, 0),
    projectsWithoutPriceStats: projects.filter(project => !project.stats.length).length });
}

function checkedSource(source) {
  if (!source || !/^[a-f0-9]{64}$/.test(source.sha256 || "") || source.commercialUse !== false ||
      source.url !== "https://adrec.gov.ae/en/market-data" || !validDate(source.dataUpTo) || !validDate(source.windowStart) ||
      source.windowEnd !== source.dataUpTo || source.windowStart > source.windowEnd || source.identitiesBeforeMetricFilters !== true ||
      source.countsAreRecordedRows !== true || source.duplicatesRetained !== true) throw new Error("Invalid project knowledge source");
  const periods = {};
  for (const period of PERIODS) {
    const dates = source.periods?.[period];
    if (!dates || !validDate(dates.start) || dates.end !== source.dataUpTo || dates.start < source.windowStart || dates.start > dates.end) throw new Error("Invalid project knowledge period");
    periods[period] = Object.freeze({ start: dates.start, end: dates.end });
  }
  if (periods["Last 12 months"].start !== source.windowStart || periods["This year"].start !== `${source.dataUpTo.slice(0, 4)}-01-01`) throw new Error("Invalid project knowledge calendar");
  return Object.freeze({ ...source, periods: Object.freeze(periods) });
}

function checkedCounts(row) {
  if (COUNTS.some(key => !count(row[key])) || row.observedSales < 1 || row.primaryOffPlanSales + row.secondarySales + row.primaryReadySales > row.observedSales) throw new Error("Invalid project knowledge counts");
}

function checkedProject(input, source, keys) {
  if (!input || !text(input.id) || !text(input.name) || input.sourceName !== input.name || UNNAMED.has(normalize(input.name)) || !text(input.area) || !Array.isArray(input.aliases) ||
      !Array.isArray(input.homeTypes) || !Array.isArray(input.stats) || input.aliases.some(alias => !text(alias)) ||
      !validDate(input.firstObservedSale) || !validDate(input.lastObservedSale) || input.firstObservedSale < source.windowStart ||
      input.lastObservedSale > source.windowEnd || input.firstObservedSale > input.lastObservedSale) throw new Error("Invalid project knowledge identity");
  checkedCounts(input);
  if (!count(input.otherSales) || input.otherSales + input.primaryOffPlanSales + input.secondarySales + input.primaryReadySales !== input.observedSales) throw new Error("Invalid project knowledge counts");
  const priority = input.primaryOffPlanSales ? "primary-off-plan" : input.secondarySales ? "secondary" : input.primaryReadySales ? "primary-ready" : "other-recorded";
  if (input.priority !== priority) throw new Error("Invalid project knowledge priority");
  const homeTypes = input.homeTypes.map(home => {
    checkedCounts(home);
    if (!["type", "propertyType", "assetClass"].every(key => text(home[key])) || !Array.isArray(home.layouts) || !Array.isArray(home.bedrooms) ||
        home.layouts.some(layout => !text(layout)) || home.bedrooms.some(bedrooms => !BEDROOMS.includes(bedrooms) || bedrooms === "All")) throw new Error("Invalid recorded home type");
    return Object.freeze({ ...home, layouts: Object.freeze([...home.layouts]), bedrooms: Object.freeze([...home.bedrooms]) });
  });
  if (homeTypes.reduce((total, home) => total + home.observedSales, 0) !== input.observedSales) throw new Error("Invalid recorded home counts");
  const stats = input.stats.map(row => {
    if (!text(row.key) || keys.has(row.key) || row.project !== input.name || row.area !== input.area || !PERIODS.includes(row.period) ||
        !["Primary", "Secondary", "All"].includes(row.saleSequence) || !["Off-plan", "Ready", "All"].includes(row.saleType) ||
        !TYPES.includes(row.type) || !BEDROOMS.includes(row.bedrooms) || !count(row.sales) || row.sales < 1 ||
        STAT_NUMBERS.some(key => typeof row[key] !== "number" || !Number.isFinite(row[key]) || row[key] < 0) ||
        !["OK", "Low sample"].includes(row.reliability) || (row.sales < 5) !== (row.reliability === "Low sample") ||
        row.periodStart !== source.periods[row.period].start || row.periodEnd !== source.periods[row.period].end ||
        !validDate(row.firstSale) || !validDate(row.lastSale) || row.firstSale < row.periodStart || row.lastSale > row.periodEnd || row.firstSale > row.lastSale) throw new Error("Invalid project price lookup");
    keys.add(row.key);
    return Object.freeze({ ...row });
  });
  return Object.freeze({ ...input, aliases: Object.freeze([...input.aliases]), homeTypes: Object.freeze(homeTypes), stats: Object.freeze(stats) });
}

/** Validate and index precomputed evidence without calculating price statistics. */
export function createProjectKnowledge(payload = {}) {
  if (!payload.source && !payload.projects?.length) {
    const data = Object.freeze({ version: 1, source: null, coverage: coverageFor([]), projects: Object.freeze([]) });
    internals.set(data, { aliases: [], names: Object.freeze([]), rows: [], indexes: new Map() });
    return data;
  }
  if (payload.version !== 1 || !Array.isArray(payload.projects)) throw new Error("Invalid project knowledge dataset");
  const source = checkedSource(payload.source), keys = new Set();
  const projects = payload.projects.map(project => checkedProject(project, source, keys));
  if (new Set(projects.map(project => project.id)).size !== projects.length || new Set(projects.map(project => JSON.stringify([project.area, project.name]))).size !== projects.length) throw new Error("Duplicate project knowledge identity");
  const coverage = coverageFor(projects);
  if (payload.coverage && Object.entries(coverage).some(([key, value]) => payload.coverage[key] !== value)) throw new Error("Invalid project knowledge coverage");
  const data = Object.freeze({ version: 1, source, coverage, projects: Object.freeze(projects) });
  const rows = projects.flatMap(project => project.stats);
  const indexes = new Map(STAT_FILTERS.map(key => [key, new Map()]));
  for (const row of rows) for (const [key, values] of indexes) {
    const normalized = normalize(row[key]);
    if (!values.has(normalized)) values.set(normalized, []);
    values.get(normalized).push(row);
  }
  internals.set(data, { rows, indexes, aliases: projects.map(project => ({ project, names: [...new Set([project.name, ...project.aliases].map(normalize))] })),
    names: Object.freeze([...new Set(projects.flatMap(project => [project.name, ...project.aliases]))]) });
  return data;
}

export function loadProjectKnowledge(filePath = DEFAULT_PATH) {
  const resolved = filePath instanceof URL ? fileURLToPath(filePath) : path.resolve(filePath);
  if (cache.has(resolved)) return cache.get(resolved);
  let data;
  try { data = createProjectKnowledge(JSON.parse(readFileSync(resolved, "utf8"))); }
  catch { data = createProjectKnowledge(); }
  cache.set(resolved, data);
  return data;
}

export function projectKnowledgeNames(data) { return internals.get(data)?.names || []; }
export function projectKnowledgeCoverage(data) { return data?.coverage || coverageFor([]); }
export function exactProjectKnowledge(query, data) {
  const name = normalize(query);
  return (internals.get(data)?.aliases || []).filter(entry => entry.names.includes(name)).map(entry => entry.project);
}

/** Exact names and explicit aliases only; a longer phase wins on the same mention. */
export function projectKnowledgeInMessage(message, data) {
  const normalized = normalize(message), hits = [];
  for (const { project, names } of internals.get(data)?.aliases || []) for (const name of names) {
    const conjunction = /^[\u0600-\u06ff]/.test(name) ? "(?:و)?" : "";
    const pattern = new RegExp(`(^|[^\\p{L}\\p{N}])${conjunction}(${escape(name)})(?=$|[^\\p{L}\\p{N}])`, "gu");
    for (const match of normalized.matchAll(pattern)) {
      const start = match.index + match[0].length - match[2].length;
      hits.push({ project, start, end: start + match[2].length });
    }
  }
  const seen = new Set();
  return hits.filter(hit => !hits.some(other => other.start <= hit.start && other.end >= hit.end && other.end - other.start > hit.end - hit.start))
    .sort((a, b) => a.start - b.start).filter(hit => {
      if (seen.has(hit.project.id)) return false;
      seen.add(hit.project.id); return true;
    }).map(hit => hit.project);
}

/** Filter existing rows exactly; missing segments never borrow another scope. */
export function lookupProjectSales(data, filters = {}) {
  const indexed = internals.get(data);
  if (!indexed) return [];
  const entries = [], ids = filters.id === undefined ? null : new Set(data.projects.filter(project => project.id === filters.id).map(project => JSON.stringify([project.name, project.area])));
  let candidates = indexed.rows, projectIdentities = null;
  for (const [key, value] of Object.entries(filters)) {
    if (key === "id") { if (!ids.size) return []; continue; }
    if (!STAT_FILTERS.includes(key) || value === undefined || value === null || value === "") return [];
    let names = [normalize(value)];
    if (key === "project") {
      const byId = data.projects.filter(project => project.id === value);
      const projects = [...exactProjectKnowledge(value, data), ...byId];
      if (!projects.length) return [];
      if (byId.length) projectIdentities = new Set(byId.map(project => JSON.stringify([project.name, project.area])));
      names = [...new Set(projects.map(project => normalize(project.name)))];
    }
    const rows = names.flatMap(name => indexed.indexes.get(key)?.get(name) || []);
    if (!rows.length) return [];
    if (rows.length < candidates.length) candidates = rows;
    entries.push([key, new Set(names)]);
  }
  return candidates.filter(row => (!ids || ids.has(JSON.stringify([row.project, row.area]))) &&
    (!projectIdentities || projectIdentities.has(JSON.stringify([row.project, row.area]))) && entries.every(([key, values]) => values.has(normalize(row[key]))));
}
