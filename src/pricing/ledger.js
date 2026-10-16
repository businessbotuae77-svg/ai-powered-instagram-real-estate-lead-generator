// Developer offers and resale asking prices, kept apart from recorded sales and
// from each other. Records are never deleted: a newer offer supersedes an
// older one by naming it, and the history stays readable. A missing value stays
// missing; nothing here infers a price, a payment plan or availability.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { areaKey } from "../matching/area-names.js";
import { districtKey, projectDistrict } from "../facts/project-geography.js";
import { EVIDENCE_TYPES, SOURCE_POLICY, currency, validDate } from "./policy.js";

export const OFFERS_PATH = fileURLToPath(new URL("../../data/pricing/developer-offers.json", import.meta.url));
export const ASKING_PATH = fileURLToPath(new URL("../../data/pricing/resale-asking.json", import.meta.url));

const STATUSES = new Set(["draft", "needs_clarification", "approved", "rejected", "withdrawn", "superseded"]);
const HOME_TYPES = new Set(["apartment", "penthouse", "villa", "townhouse", "duplex"]);
const HOME_SCOPES = new Set(["exact_unit", "home_type", "phase", "project"]);
const PRICE_KINDS = new Set(["exact_quote", "starting_price", "range", "published_average", "unspecified", "none"]);
const DISCOUNTS = new Set(["before_discount", "after_discount", "not_stated"]);
const PAYMENT_KINDS = new Set(["developer_plan", "full_payment", "unknown"]);
const AVAILABILITY = new Set(["unknown", "available", "not_available", "on_request"]);
const AVAILABILITY_SCOPES = new Set(["exact_unit", "home_type", "phase", "contact_inventory", "project"]);

const keyCache = new Map();
/** One identity for a project across the sales records, the catalogue and offers. */
export function pricingKey(name, district) {
  const cacheKey = `${name}\u0000${district}`;
  if (!keyCache.has(cacheKey)) keyCache.set(cacheKey, `${areaKey(name)}|${districtKey(projectDistrict(name, district))}`);
  return keyCache.get(cacheKey);
}

const positive = value => typeof value === "number" && Number.isFinite(value) && value > 0;
const count = value => Number.isInteger(value) && value >= 0;
const text = value => typeof value === "string" && value.trim().length > 0;

function problemsFor(record, evidenceType, ids) {
  const problems = [];
  const add = (code, field, blocking = true) => problems.push({ code, field, blocking });
  if (!text(record.id)) add("missing_id", "id");
  else if (ids.has(record.id)) add("duplicate_id", "id");
  if (record.evidenceType !== evidenceType) add("wrong_evidence_type", "evidenceType");
  if (!STATUSES.has(record.status)) add("invalid_status", "status");
  const project = record.project || {};
  if (!text(project.name)) add("missing_project", "project.name");
  if (!text(project.district)) add("missing_district", "project.district");
  const home = record.home || {};
  if (!HOME_SCOPES.has(home.scope)) add("invalid_home_scope", "home.scope");
  if (home.type != null && !HOME_TYPES.has(home.type)) add("invalid_home_type", "home.type");
  if (home.scope !== "project" && home.type == null) add("missing_home_type", "home.type");
  if (home.bedrooms != null && !count(home.bedrooms)) add("invalid_bedrooms", "home.bedrooms");
  if (["exact_unit", "home_type"].includes(home.scope) && home.bedrooms == null) add("missing_bedrooms", "home.bedrooms");
  if (home.scope === "exact_unit" && !text(home.unitId)) add("missing_unit_id", "home.unitId");
  for (const key of ["sizeSqftFrom", "sizeSqftTo"]) if (home[key] != null && !positive(home[key])) add("invalid_size", `home.${key}`);
  const price = record.price || {};
  if (!PRICE_KINDS.has(price.kind)) add("invalid_price_kind", "price.kind");
  if (price.kind !== "none") {
    if (price.currency !== "AED") add("currency_not_aed", "price.currency");
    if (price.amountAed == null) add(text(price.raw) ? "ambiguous_amount" : "missing_amount", "price.amountAed");
    else if (!positive(price.amountAed)) add("invalid_amount", "price.amountAed");
    if (price.kind === "range" && !positive(price.amountToAed)) add("missing_range_end", "price.amountToAed");
    if (price.kind === "unspecified") add("price_kind_unspecified", "price.kind");
    if (!DISCOUNTS.has(price.discount)) add("invalid_discount", "price.discount");
    if (price.discount === "after_discount" && !text(record.discountTerms?.eligibility)) add("discount_eligibility_unknown", "discountTerms.eligibility");
  }
  const payment = record.payment || {};
  if (!PAYMENT_KINDS.has(payment.kind)) add("invalid_payment_kind", "payment.kind");
  if (payment.stages != null) {
    // Stages are kept as written, and must add up: no stage is ever filled in.
    const parts = ["bookingPct", "constructionPct", "handoverPct", "postHandoverPct"].map(key => payment.stages[key]).filter(value => value != null);
    if (payment.kind !== "developer_plan") add("stages_without_plan", "payment.stages");
    if (!parts.length || parts.some(value => !(typeof value === "number" && value >= 0 && value <= 100))) add("invalid_stage", "payment.stages");
    else if (Math.abs(parts.reduce((sum, value) => sum + value, 0) - 100) > 0.01) add("payment_stages_do_not_sum", "payment.stages");
  }
  const availability = record.availability || {};
  if (!AVAILABILITY.has(availability.status)) add("invalid_availability", "availability.status");
  if (availability.status !== "unknown" && !AVAILABILITY_SCOPES.has(availability.scope)) add("availability_scope_missing", "availability.scope");
  const source = record.source || {};
  const policy = SOURCE_POLICY[source.kind];
  if (!policy) add("invalid_source_kind", "source.kind");
  else if (policy.evidence !== evidenceType) add("source_kind_wrong_evidence", "source.kind");
  if (!text(source.reference)) add("missing_source_reference", "source.reference");
  for (const field of ["issuedOn", "receivedOn", "verifiedOn", "firstSeenOn", "checkedOn", "validUntil", "listedOn"]) {
    if (record[field] != null && !validDate(record[field])) add("invalid_date", field);
  }
  if (!Array.isArray(record.supersedes)) add("invalid_supersedes", "supersedes");
  for (const item of Array.isArray(record.unresolved) ? record.unresolved : []) {
    if (item?.blocking !== false) problems.push({ code: "unresolved", field: item?.field || "unknown", blocking: true, question: item?.question || null });
  }
  return problems;
}

function scopeKey(record) {
  const { home = {}, price = {}, payment = {} } = record;
  return [record.projectKey, record.project?.phase || "", home.type || "", home.bedrooms ?? "", home.unitId || "",
    price.kind || "", payment.kind || "", price.discount || ""].join("|");
}

function normalize(records, evidenceType) {
  const ids = new Set();
  const rows = (Array.isArray(records) ? records : []).map(input => {
    const record = structuredClone(input || {});
    const problems = problemsFor(record, evidenceType, ids);
    if (text(record.id)) ids.add(record.id);
    record.supersedes = Array.isArray(record.supersedes) ? record.supersedes : [];
    record.unresolved = Array.isArray(record.unresolved) ? record.unresolved : [];
    record.projectKey = text(record.project?.name) && text(record.project?.district)
      ? pricingKey(record.project.registryName || record.project.name, record.project.district) : null;
    record.projectKeys = [...new Set([record.project?.name, record.project?.registryName].filter(text)
      .map(name => pricingKey(name, record.project.district)))];
    record.problems = problems;
    return record;
  });
  // A record is superseded only when an approved record names it.
  const replacedBy = new Map();
  for (const row of rows) if (row.status === "approved") for (const id of row.supersedes) replacedBy.set(id, row.id);
  for (const row of rows) {
    row.supersededBy = replacedBy.get(row.id) || row.supersededBy || null;
    row.scopeKey = scopeKey(row);
  }
  return Object.freeze(rows.map(row => Object.freeze(row)));
}

export function createPriceLedger({ offers = [], asking = [] } = {}, { loadedFrom = null } = {}) {
  return Object.freeze({ offers: normalize(offers, EVIDENCE_TYPES.OFFER), asking: normalize(asking, EVIDENCE_TYPES.ASKING), loadedFrom });
}

export function emptyPriceLedger() { return createPriceLedger(); }

const cache = new Map();
export function loadPriceLedger({ offersPath = OFFERS_PATH, askingPath = ASKING_PATH } = {}) {
  const key = `${offersPath}|${askingPath}`;
  if (cache.has(key)) return cache.get(key);
  const read = file => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return { records: [] }; } };
  const offers = read(offersPath), asking = read(askingPath);
  const ledger = createPriceLedger({ offers: offers.records, asking: asking.records }, { loadedFrom: { offersPath, askingPath } });
  cache.set(key, ledger);
  return ledger;
}

/** Review state, blockers and currency at a moment in time. */
export function recordState(record, { now = Date.now() } = {}) {
  const blocking = record.problems.filter(problem => problem.blocking);
  const age = currency(record, { now });
  const review = record.supersededBy ? "superseded" : record.status;
  const priced = record.price?.kind && record.price.kind !== "none" && positive(record.price.amountAed);
  return { review, blocking, currency: age, priced,
    usable: review === "approved" && !blocking.length && age.state === "current" };
}

export function recordsForProject(ledger, keys, kind = "offers") {
  const wanted = new Set(keys);
  return (ledger?.[kind] || []).filter(record => record.projectKeys.some(key => wanted.has(key)));
}
