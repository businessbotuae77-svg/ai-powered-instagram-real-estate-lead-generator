import { buildFactPack } from "../facts/retrieval.js";
import { lookupProjectSales, projectKnowledgeInMessage } from "../facts/project-knowledge.js";
import { districtKey, projectCommunity, projectDistrict, projectInArea, searchAreasIn } from "../facts/project-geography.js";
import { areaKey } from "../matching/area-names.js";
import { normalizePropertyType, sameText } from "../matching/normalize.js";

const RESIDENTIAL = new Set(["apartment", "studio", "villa", "townhouse", "duplex", "penthouse"]);
const fact = (pack, field) => pack?.[field]?.confirmed ? pack[field].value : null;
const identity = (name, area) => `${areaKey(name)}|${districtKey(projectDistrict(name, area))}`;
const bedCount = label => label === "Studio" ? 0 : /^[1-4] BR$/.test(label) ? Number(label[0]) : null;

/** A single scope for listings and recorded sales. Never relax an explicit filter. */
export function propertySearchScope({ buyer = {}, message = "", data = null, catalog = {} } = {}) {
  const areas = searchAreasIn(message, data);
  const named = [...projectKnowledgeInMessage(message, data).map(project => project.name),
    ...(catalog.projects || []).filter(project => message.toLowerCase().includes(project.name.toLowerCase())).map(project => project.name)];
  return { areas: areas.length ? areas : buyer.areaFlexibility === "open" ? [] : buyer.preferredAreas || [], bedrooms: buyer.bedrooms || [],
    types: (buyer.propertyTypes || []).map(normalizePropertyType), budget: buyer.budgetAed || null,
    projects: [...new Set(named)], developer: buyer.developerInterest || null };
}

function fits(row, scope) {
  if (scope.projects.length && !scope.projects.some(name => areaKey(name) === areaKey(row.name))) return false;
  if (scope.areas.length && !scope.areas.some(area => projectInArea(row.name, row.district, area))) return false;
  if (scope.bedrooms.length && !scope.bedrooms.includes(row.bedrooms)) return false;
  if (scope.types.length && !scope.types.some(type => type === "studio" ? row.bedrooms === 0 : type === row.type)) return false;
  if (scope.budget && row.price > scope.budget) return false;
  if (scope.developer && !sameText(scope.developer, row.developer)) return false;
  return true;
}

/**
 * Enumerate the entire eligible corpus, not the advisor's limited shortlist.
 * Current quotes and sale medians remain different, labelled evidence types.
 */
export function searchProperties({ buyer = {}, message = "", data = null, catalog = {}, exclude = [], limit = 3, priceBelow = null } = {}) {
  const scope = propertySearchScope({ buyer, message, data, catalog });
  const projects = catalog.projects || [], units = catalog.units || [];
  const rejected = new Set((buyer.rejectedProjects || []).flatMap(item => {
    const id = typeof item === "string" ? item : item.projectId;
    const project = projects.find(row => row.id === id);
    return [id, project?.name].filter(Boolean).map(areaKey);
  }));
  const hidden = project => project && (project.active === false || project.approved === false || project.developerActive === false ||
    project.emirate && !sameText(project.emirate, "Abu Dhabi"));
  const denied = (name, id) => rejected.has(areaKey(id)) || rejected.has(areaKey(name)) || rejected.has(areaKey(`sales:${name}`));
  const rows = [];
  const quotes = new Set();
  for (const unit of units) {
    const project = projects.find(row => row.id === unit.projectId);
    if (!project || hidden(project) || unit.active === false || unit.approved === false || denied(project.name, project.id)) continue;
    const pack = buildFactPack({ project, unit, downPaymentAed: unit.initialPaymentAed ?? project.initialPaymentAed, bedroomLabel: String(unit.bedrooms) });
    const price = fact(pack, "startingPriceAed"), type = normalizePropertyType(fact(pack, "propertyType"));
    if (!(price > 0) || !RESIDENTIAL.has(type) || !fact(pack, "name")) continue;
    const row = { kind: "listing", name: project.name, district: project.area, area: projectCommunity(project.name, project.area),
      bedrooms: fact(pack, "bedrooms"), type: type === "studio" ? "apartment" : type, price,
      developer: project.developerName, project, unit, pack, id: identity(project.name, project.area) };
    quotes.add(`${row.id}|${row.type}|${row.bedrooms}`);
    if (fits(row, scope)) rows.push(row);
  }
  for (const sale of lookupProjectSales(data, { period: "Last 12 months", saleSequence: "Primary", saleType: "Off-plan" })) {
    const project = projects.find(row => areaKey(row.name) === areaKey(sale.project) && districtKey(projectDistrict(row.name, row.area)) === districtKey(sale.area));
    const type = normalizePropertyType(sale.type), bedrooms = bedCount(sale.bedrooms);
    // A thin sample, a mixed-bedroom total or a 5+ bucket cannot establish
    // the price of a specific home. They remain available in statistics answers.
    if (!RESIDENTIAL.has(type) || bedrooms === null || sale.reliability !== "OK" || !(sale.medianPriceAed > 0) || hidden(project) || denied(sale.project, project?.id)) continue;
    const row = { kind: "recorded_sale", name: sale.project, district: sale.area, area: projectCommunity(sale.project, sale.area),
      bedrooms, type, price: sale.medianPriceAed, developer: project?.developerName, sale, id: identity(sale.project, sale.area) };
    // A confirmed quote supersedes the median for the same home, not other
    // bedroom counts in that project, and never borrows its payment plan.
    if (fits(row, scope) && !quotes.has(`${row.id}|${type}|${bedrooms}`)) rows.push(row);
  }
  const ranked = rows.filter(row => priceBelow == null || row.price < priceBelow).sort((a, b) => a.price - b.price || a.name.localeCompare(b.name));
  const perProject = new Map();
  for (const row of ranked) if (!perProject.has(row.id)) perProject.set(row.id, row);
  const all = [...perProject.values()];
  const skipped = new Set(exclude);
  const remaining = all.filter(row => !skipped.has(row.id));
  return { picks: remaining.slice(0, limit), total: all.length, remaining: remaining.length,
    scope, scopeKey: JSON.stringify(scope) };
}
