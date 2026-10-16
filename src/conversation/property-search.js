import { buildFactPack } from "../facts/retrieval.js";
import { lookupProjectSales, projectKnowledgeInMessage } from "../facts/project-knowledge.js";
import { districtKey, projectCommunity, projectDistrict, projectInArea, searchAreasIn } from "../facts/project-geography.js";
import { areaKey } from "../matching/area-names.js";
import { normalizePropertyType, sameText } from "../matching/normalize.js";
import { DECISIONS, SOFT_REASONS, assessHome, offerReasons, projectPriceEvidence } from "../pricing/assess.js";
import { pricingKey, recordState } from "../pricing/ledger.js";
import { catalogueKeys, catalogueProjectFor } from "../pricing/catalogue.js";
import { offerPack } from "../pricing/offer-pack.js";

const RESIDENTIAL = new Set(["apartment", "studio", "villa", "townhouse", "duplex", "penthouse"]);
// A full-payment price can still be listed for a payment-plan buyer, flagged as such, never as a fit.
const FULL_PAYMENT_ONLY = new Set(["needs_full_payment", "discount_needs_full_payment"]);
const fact = (pack, field) => pack?.[field]?.confirmed ? pack[field].value : null;
const identity = (name, area) => `${areaKey(name)}|${districtKey(projectDistrict(name, area))}`;
const bedCount = label => label === "Studio" ? 0 : /^[1-4] BR$/.test(label) ? Number(label[0]) : null;
const homeType = type => type === "studio" ? "apartment" : type;

/** A single scope for listings and recorded sales. Never relax an explicit filter. */
export function propertySearchScope({ buyer = {}, message = "", data = null, catalog = {} } = {}) {
  const areas = searchAreasIn(message, data);
  const named = [...projectKnowledgeInMessage(message, data).map(project => project.name),
    ...(catalog.projects || []).filter(project => message.toLowerCase().includes(project.name.toLowerCase())).map(project => project.name)];
  return { areas: areas.length ? areas : buyer.areaFlexibility === "open" ? [] : buyer.preferredAreas || [], bedrooms: buyer.bedrooms || [],
    types: (buyer.propertyTypes || []).map(normalizePropertyType), budget: buyer.budgetRange ? buyer.budgetRange.max : buyer.budgetAed || null,
    budgetMin: buyer.budgetRange?.min || null, financing: buyer.financing === "payment_plan" ? "payment_plan" : null,
    projects: [...new Set(named)], developer: buyer.developerInterest || null };
}

function fits(row, scope, { budget = true } = {}) {
  if (scope.projects.length && !scope.projects.some(name => areaKey(name) === areaKey(row.name))) return false;
  if (scope.areas.length && !scope.areas.some(area => projectInArea(row.name, row.district, area))) return false;
  if (scope.bedrooms.length && !scope.bedrooms.includes(row.bedrooms)) return false;
  if (scope.types.length && !scope.types.some(type => type === "studio" ? row.bedrooms === 0 : type === row.type)) return false;
  if (budget && scope.budget && row.price > scope.budget) return false;
  if (budget && scope.budgetMin && row.price < scope.budgetMin) return false;
  if (scope.developer && !sameText(scope.developer, row.developer)) return false;
  return true;
}

/**
 * Enumerate the entire eligible corpus, not the advisor's limited shortlist.
 * Three kinds of row stay apart: a current listing price, a current developer
 * offer, and a shortlist from recorded sales that still needs today's price.
 */
export function searchProperties({ buyer = {}, message = "", data = null, catalog = {}, exclude = [], limit = 3, priceBelow = null, now = Date.now() } = {}) {
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
  const evidenceCache = new Map();
  const evidenceFor = keys => {
    const key = keys.join("||");
    if (!evidenceCache.has(key)) evidenceCache.set(key, projectPriceEvidence({ keys, catalog }));
    return evidenceCache.get(key);
  };
  const rows = [];
  const quotes = new Set();
  for (const unit of units) {
    const project = projects.find(row => row.id === unit.projectId);
    if (!project || hidden(project) || unit.active === false || unit.approved === false || denied(project.name, project.id)) continue;
    const pack = buildFactPack({ project, unit, downPaymentAed: unit.initialPaymentAed ?? project.initialPaymentAed, bedroomLabel: String(unit.bedrooms) });
    const price = fact(pack, "startingPriceAed"), type = normalizePropertyType(fact(pack, "propertyType"));
    if (!(price > 0) || !RESIDENTIAL.has(type) || !fact(pack, "name")) continue;
    const row = { kind: "listing", name: project.name, district: project.area, area: projectCommunity(project.name, project.area),
      bedrooms: fact(pack, "bedrooms"), type: homeType(type), price,
      developer: project.developerName, project, unit, pack, id: identity(project.name, project.area), keys: catalogueKeys(project),
      // A listing price is current, but a payment-plan buyer still needs the plan confirmed.
      termsUnconfirmed: scope.financing === "payment_plan" && project.paymentPlanAvailable !== true,
      terms: scope.financing === "payment_plan" && project.paymentPlanAvailable !== true ? ["plan_unconfirmed"] : [] };
    for (const key of row.keys) quotes.add(`${key}|${row.type}|${row.bedrooms}`);
    quotes.add(`${row.id}|${row.type}|${row.bedrooms}`);
    if (fits(row, scope)) rows.push(row);
  }
  // Current developer offers from the price ledger: only approved, current and
  // unblocked prices for one home type, and only on the buyer's payment terms.
  for (const offer of catalog.pricing?.offers || []) {
    const home = offer.home || {};
    const state = recordState(offer, { now });
    // A note without a price (such as one contact's "no stock") is not a quote and hides nothing.
    if (!["home_type", "exact_unit"].includes(home.scope) || !state.usable || !state.priced) continue;
    const listed = catalogueProjectFor(catalog, offer.projectKey);
    if (hidden(listed) || denied(offer.project.name, listed?.id)) continue;
    const row = { kind: "offer", name: offer.project.name, district: offer.project.district, area: projectCommunity(offer.project.name, offer.project.district),
      bedrooms: home.bedrooms, type: home.type, price: offer.price.amountAed, developer: listed?.developerName || offer.project.developer || null,
      offer, id: identity(offer.project.name, offer.project.district), keys: offer.projectKeys };
    const reasons = offerReasons(offer, { type: home.type, bedrooms: home.bedrooms }, buyer, now);
    for (const key of row.keys) quotes.add(`${key}|${row.type}|${row.bedrooms}`);
    if (reasons.some(reason => !SOFT_REASONS.has(reason) && !FULL_PAYMENT_ONLY.has(reason))) continue;
    row.termsUnconfirmed = reasons.length > 0;
    row.terms = reasons;
    if (fits(row, scope)) rows.push({ ...row, pack: offerPack(offer, { now }) });
  }
  const recordedRows = lookupProjectSales(data, { period: "Last 12 months", saleSequence: "Primary", saleType: "Off-plan" });
  for (const sale of recordedRows) {
    const project = catalogueProjectFor(catalog, pricingKey(sale.project, sale.area));
    const type = normalizePropertyType(sale.type), bedrooms = bedCount(sale.bedrooms);
    // A thin sample, a mixed-bedroom total or a 5+ bucket cannot stand for a
    // specific home. They remain available in statistics answers.
    if (!RESIDENTIAL.has(type) || bedrooms === null || sale.reliability !== "OK" || !(sale.medianPriceAed > 0) || hidden(project) || denied(sale.project, project?.id)) continue;
    const keys = [...new Set([pricingKey(sale.project, sale.area), ...(project ? catalogueKeys(project) : [])])];
    const row = { kind: "recorded_sale", name: sale.project, district: sale.area, area: projectCommunity(sale.project, sale.area),
      bedrooms, type, price: sale.medianPriceAed, developer: project?.developerName, sale, id: identity(sale.project, sale.area), keys };
    // A current quote for the same home supersedes its recorded median, and a
    // recorded median never borrows that quote's payment plan.
    if (!fits(row, scope, { budget: false }) || keys.some(key => quotes.has(`${key}|${type}|${bedrooms}`))) continue;
    const assessment = assessHome({ buyer, home: { type, bedrooms }, evidence: evidenceFor(keys), recorded: sale, now });
    if (assessment.decision !== DECISIONS.HISTORY_WITHIN) continue;
    rows.push({ ...row, assessment, shortlist: true });
  }
  // One price order for every kind of row; each line still says what its figure is.
  const ranked = rows.filter(row => priceBelow == null || row.price < priceBelow)
    .sort((a, b) => a.price - b.price || a.name.localeCompare(b.name));
  const perProject = new Map();
  for (const row of ranked) if (!perProject.has(row.id)) perProject.set(row.id, row);
  const all = [...perProject.values()];
  const skipped = new Set(exclude);
  const remaining = all.filter(row => !skipped.has(row.id));
  return { picks: remaining.slice(0, limit), total: all.length, remaining: remaining.length,
    scope, scopeKey: JSON.stringify(scope) };
}
