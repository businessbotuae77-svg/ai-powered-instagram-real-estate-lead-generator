// Airtable listing prices as offer evidence, without changing how listings are
// stored or shown. A project-level starting price covers the whole project: it
// can rule a budget out, but it cannot price one particular home type.
import { normalizePropertyType } from "../matching/normalize.js";
import { factPolicy } from "../facts/freshness.js";
import { EVIDENCE_TYPES } from "./policy.js";
import { pricingKey } from "./ledger.js";

const keysCache = new WeakMap();
/** Every name the sales records may use for a catalogue project. */
export function catalogueKeys(project) {
  if (keysCache.has(project)) return keysCache.get(project);
  const district = project.officialDistrict || project.area;
  const names = [project.name, ...(project.registryLabels || [])].filter(Boolean);
  const keys = [...new Set(names.flatMap(name => [pricingKey(name, district), pricingKey(name, project.area)]))];
  keysCache.set(project, keys);
  return keys;
}

/** The catalogue project, if any, that a recorded project name belongs to. */
export function catalogueProjectFor(catalog = {}, key) {
  return catalogueIndex(catalog).get(key) || null;
}

const indexCache = new WeakMap();
function catalogueIndex(catalog) {
  const projects = catalog.projects || [];
  if (indexCache.has(projects)) return indexCache.get(projects);
  const index = new Map();
  for (const project of projects) for (const key of catalogueKeys(project)) if (!index.has(key)) index.set(key, project);
  indexCache.set(projects, index);
  return index;
}

const homeType = type => {
  const value = normalizePropertyType(type);
  return value === "studio" ? "apartment" : value;
};

const offersCache = new WeakMap();
export function catalogueOffers(catalog = {}, { policy = factPolicy() } = {}) {
  // safeCatalog builds a new units list on each refresh, so one result per list is safe to reuse.
  const cacheable = Array.isArray(catalog.units);
  if (cacheable && offersCache.has(catalog.units)) return offersCache.get(catalog.units);
  const offers = buildCatalogueOffers(catalog, policy);
  if (cacheable) offersCache.set(catalog.units, offers);
  return offers;
}

function buildCatalogueOffers(catalog, policy) {
  const projects = new Map((catalog.projects || []).map(project => [project.id, project]));
  const offers = [];
  for (const unit of catalog.units || []) {
    const project = projects.get(unit.projectId);
    // safeCatalog has already removed stale prices; an unpriced row is not an offer.
    if (!project || unit.active === false || !(unit.startingPriceAed > 0) || unit.commercialOffer) continue;
    const level = unit.projectLevel === true;
    const types = level ? (unit.propertyTypes || []).map(homeType) : [homeType(unit.propertyType || (unit.bedrooms === 0 ? "studio" : null))];
    const single = level && unit.bedroomsMax != null && unit.bedrooms === unit.bedroomsMax && types.length === 1;
    offers.push({
      id: `catalogue:${unit.id}`, origin: "catalogue", evidenceType: EVIDENCE_TYPES.OFFER, status: "approved",
      project: { name: project.name, district: project.officialDistrict || project.area, area: project.area, developer: project.developerName || null,
        catalogueProjectId: project.id },
      projectKeys: catalogueKeys(project),
      home: level && !single
        ? { scope: "project", type: types.length === 1 ? types[0] : null, types, bedrooms: null, bedroomsFrom: unit.bedrooms ?? null, bedroomsTo: unit.bedroomsMax ?? null, label: unit.bedroomRange || null }
        : { scope: "home_type", type: types[0] || null, types, bedrooms: level ? unit.bedrooms : unit.bedrooms ?? null,
          sizeSqftFrom: unit.sizeSqftFrom ?? null, sizeSqftTo: unit.sizeSqftTo ?? null },
      price: { kind: "starting_price", amountAed: unit.startingPriceAed, discount: "not_stated", currency: "AED", basis: unit.startingPriceBasis || project.startingPriceBasis || null },
      payment: project.paymentPlanAvailable === true ? { kind: "developer_plan", summary: project.paymentPlanSummary || null, scope: "project" } : { kind: "unknown", summary: null },
      availability: { status: "unknown" },
      source: { kind: "catalogue_listing", reference: project.source || null, record: unit.id },
      verifiedOn: String(project.lastVerified || "").slice(0, 10) || null, problems: [], supersedes: [], supersededBy: null,
      unitId: unit.id, maxAgeDays: policy.commercialDays
    });
  }
  return offers;
}
