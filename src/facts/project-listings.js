import { normalizePropertyType } from "../matching/normalize.js";

// The bot sells projects, not units. A project with a published starting price
// becomes one project-level listing, so matching, ranking and the fact checker
// treat it like any other listing. Availability is never known at this level:
// exact units, unit prices and availability stay with the broker.

/** "1–3BR apartments; 4BR townhouses" → { min: 1, max: 4 }; studios count as 0. */
export function bedroomBounds(text) {
  if (!text) return null;
  const lower = String(text).toLowerCase();
  const counts = [...lower.matchAll(/(\d+)\s*(?:[-–to]+\s*(\d+)\s*)?(?:br|bed)/g)]
    .flatMap(match => [Number(match[1]), match[2] ? Number(match[2]) : null]).filter(n => n !== null);
  if (/studio/.test(lower)) counts.push(0);
  if (!counts.length) return null;
  return { min: Math.min(...counts), max: Math.max(...counts) };
}

export function projectListing(project) {
  if (typeof project.startingPriceAed !== "number" || !(project.startingPriceAed > 0)) return null;
  const bounds = bedroomBounds(project.bedroomRange);
  const types = (project.propertyTypes || []).map(normalizePropertyType).filter(Boolean);
  return {
    id: `${project.id}#project`,
    projectId: project.id,
    projectLevel: true,
    propertyType: types[0] || null,
    propertyTypes: types,
    bedrooms: bounds ? bounds.min : null,
    bedroomsMax: bounds ? bounds.max : null,
    bedroomRange: project.bedroomRange || null,
    startingPriceAed: project.startingPriceAed,
    startingPriceBasis: project.startingPriceBasis || null,
    sizeSqftFrom: null,
    sizeSqftTo: null,
    initialPaymentAed: null,
    availability: null,
    active: true
  };
}

/** One listing per priced project that has no unit rows (production has none). */
export function projectListings(projects, units = []) {
  const withUnits = new Set(units.map(unit => unit.projectId));
  return projects.filter(project => !withUnits.has(project.id)).map(projectListing).filter(Boolean);
}
