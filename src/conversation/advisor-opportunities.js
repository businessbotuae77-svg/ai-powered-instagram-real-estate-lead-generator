import { safeCatalog } from "../facts/freshness.js";
import { buildFactPack } from "../facts/retrieval.js";
import { assessCandidate } from "./fit-assess.js";
import { bedroomLabel, normalizeArea, normalizePropertyType, sameText } from "../matching/normalize.js";
import { loadConversationPreferences } from "./preferences.js";

const numeric = value => typeof value === "number" && Number.isFinite(value);
const positive = value => numeric(value) && value > 0;
const value = (pack, key) => pack[key]?.confirmed ? pack[key].value : null;
const roundMoney = amount => Math.round(amount);
const SUITABILITY_OBJECTIONS = new Set(["too_expensive", "initial_payment_too_high", "wrong_area", "wrong_property_type", "too_small", "too_large", "handover_too_late", "handover_too_soon", "payment_plan_bad", "developer_concern"]);

/** A budget is a ceiling until the buyer explicitly permits a bounded stretch. */
export function advisorBudgetPolicy(buyer, options = {}) {
  const budget = positive(buyer.budgetAed) ? buyer.budgetAed : null;
  const configured = Number(options.defaultBudgetStretchPct ?? process.env.ADVISOR_DEFAULT_BUDGET_STRETCH_PCT ?? 5);
  const defaultPct = Number.isFinite(configured) ? Math.min(10, Math.max(0, configured)) : 5;
  const explicitPct = Number(buyer.budgetFlexibilityPct);
  const declaredStretch = positive(buyer.budgetStretchAed) ? buyer.budgetStretchAed : null;
  const explicitlyZero = buyer.budgetFlexible === true && buyer.budgetFlexibilityPct === 0 && !positive(buyer.budgetStretchAed);
  const pct = explicitlyZero ? 0 : explicitPct > 0 && Number.isFinite(explicitPct) ? Math.min(10, explicitPct) : declaredStretch !== null && budget !== null ? Math.min(10, declaredStretch / budget * 100) : defaultPct;
  const stretch = budget === null ? 0 : roundMoney(Math.min(declaredStretch ?? budget * pct / 100, budget * pct / 100, budget * 0.1));
  const flexible = buyer.budgetFlexible === true && buyer.budgetHardCap !== true && buyer.budgetFirm !== true;
  return {
    originalBudgetAed: budget,
    ceilingAed: budget === null ? null : roundMoney(budget + (flexible ? stretch : 0)),
    permissionCeilingAed: budget === null ? null : roundMoney(budget + stretch),
    flexible,
    firm: buyer.budgetFirm === true,
    stretchAed: flexible ? stretch : 0,
    flexibilityPct: flexible ? pct : 0
  };
}

function categories(buyer) {
  return new Set((buyer.objections || []).filter(item => !item?.resolved).map(item => typeof item === "string" ? item : item.category || item.type).filter(Boolean));
}

function priorities(buyer) {
  return new Set([...(buyer.priorities || []), ...(buyer.concerns || [])].filter(item => typeof item === "string"));
}

function wantsSpace(buyer, objectionCodes, priorityCodes) {
  return objectionCodes.has("too_small") || (buyer.useType === "end_use" && ["more_space", "space", "size", "unit_size", "larger_unit", "family_space", "extra_bedroom", "additional_bedroom"].some(code => priorityCodes.has(code)));
}

function wantsLowCash(buyer, objectionCodes, priorityCodes) {
  return objectionCodes.has("initial_payment_too_high") || objectionCodes.has("payment_plan_bad") || buyer.cashAvailableAed != null || buyer.financing === "payment_plan" || ["initial_cash", "low_initial_cash", "lower_initial_cash", "lower_initial_payment", "payment_leverage", "easier_payment"].some(code => priorityCodes.has(code));
}

function lowerPriceIsPriority(buyer, context) {
  return context.objections.has("too_expensive") || (buyer.useType === "investment" && buyer.investmentObjective === "growth") || ["entry_price", "lower_entry_price", "lower_cost", "low_cost", "affordability"].some(code => context.priorities.has(code));
}

function relevantChallengeBenefits(candidate, reference, buyer, context) {
  const benefits = compareBenefits(reference, candidate, buyer, context);
  if (!wantedAreaMatch(candidate, buyer) && !lowerPriceIsPriority(buyer, context)) return benefits.filter(item => item.code !== "lower_starting_price");
  return benefits;
}

function handoverRange(pack) {
  const text = String(value(pack, "handover") || "").trim();
  if (/^ready$/i.test(text) && sameText(value(pack, "status"), "Ready")) return { start: 0, end: 0 };
  const quarter = text.match(/^Q([1-4])\s+(20\d{2})$/i);
  if (quarter) {
    const year = Number(quarter[2]);
    const month = (Number(quarter[1]) - 1) * 3;
    return { start: Date.UTC(year, month, 1), end: Date.UTC(year, month + 3, 1) - 1 };
  }
  if (/^20\d{2}$/.test(text)) return { start: Date.UTC(Number(text), 0, 1), end: Date.UTC(Number(text) + 1, 0, 1) - 1 };
  return null;
}

function evidence(candidate, key) {
  const fact = candidate.factPack[key];
  if (!fact?.confirmed) return null;
  return {
    projectId: candidate.project.id,
    unitId: candidate.unit.id,
    field: key,
    value: fact.value,
    source: value(candidate.factPack, "source"),
    lastVerified: value(candidate.factPack, "lastVerified"),
    scope: key === "startingPriceAed" ? "unit_type_starting_price" : key === "downPaymentAed" ? (candidate.unit.initialPaymentAed != null ? "unit_type_initial_payment" : "project_initial_payment") : "catalogue_field"
  };
}

function dimensionDelta(code, field, reference, candidate, unit = null) {
  const from = value(reference.factPack, field);
  const to = value(candidate.factPack, field);
  return { code, field, from, to, delta: numeric(from) && numeric(to) ? roundMoney(to - from) : null, ...(unit ? { unit } : {}) };
}

function getCandidates(catalog, buyer, options) {
  const safe = safeCatalog(catalog, options);
  const result = [];
  for (const unit of safe.units) {
    const project = safe.projects.find(row => row.id === unit.projectId);
    if (!project || !unit.active || project.developerActive === false) continue;
    if (project.developerId && safe.developers?.length && !safe.developers.some(row => row.id === project.developerId && row.active)) continue;
    // A catalogue prohibition cannot be relaxed by sales or buyer flexibility.
    if (sameText(normalizeArea(project.area), "Hudayriyat Island") && (unit.bedrooms === 0 || normalizePropertyType(unit.propertyType) === "studio")) continue;
    const downPaymentAed = unit.initialPaymentAed ?? project.initialPaymentAed ?? null;
    const candidate = assessCandidate({ project, unit, downPaymentAed, bedroomLabel: bedroomLabel(unit.bedrooms) }, buyer);
    candidate.factPack = buildFactPack(candidate, options);
    result.push(candidate);
  }
  return result;
}

function isRejected(candidate, buyer, options) {
  const projectId = candidate.project.id;
  if ((options.explicitRequestedProjectIds || []).includes(projectId)) return false;
  const reasons = buyer.rejectionReasons?.[projectId];
  if (reasons?.resolved === true) return false;
  return (buyer.rejectedProjects || []).some(item => (typeof item === "string" ? item : item.projectId) === projectId) || Boolean(reasons && reasons.resolved !== true);
}

function wantedAreaMatch(candidate, buyer) {
  return !buyer.preferredAreas?.length || buyer.preferredAreas.some(area => sameText(normalizeArea(area), normalizeArea(candidate.project.area)));
}

function wantedProjectMatch(candidate, buyer) {
  return !buyer.projectInterest || sameText(candidate.project.name, buyer.projectInterest) || candidate.project.name.toLowerCase().includes(String(buyer.projectInterest).toLowerCase());
}

function wantedDeveloperMatch(candidate, buyer) {
  return !buyer.developerInterest || sameText(candidate.project.developerName, buyer.developerInterest);
}

function wantedTypeMatch(candidate, buyer) {
  return !buyer.propertyTypes?.length || buyer.propertyTypes.some(type => normalizePropertyType(type) === "studio" ? candidate.unit.bedrooms === 0 : sameText(normalizePropertyType(candidate.unit.propertyType), normalizePropertyType(type)));
}

function wantedBedroomsMatch(candidate, buyer) {
  return !buyer.bedrooms?.length || buyer.bedrooms.some(beds => Number(beds) === candidate.unit.bedrooms);
}

function eligibility(candidate, buyer, ceiling, options) {
  const reasons = [];
  const pack = candidate.factPack;
  const price = value(pack, "startingPriceAed");
  const initial = value(pack, "downPaymentAed");
  if (!positive(price)) reasons.push("price_unknown");
  else if (ceiling !== null && price > ceiling) reasons.push("over_budget_ceiling");
  if (buyer.preferredEmirate && !sameText(candidate.project.emirate, buyer.preferredEmirate)) reasons.push("wrong_emirate");
  if (sameText(value(pack, "availability"), "Sold out")) reasons.push("sold_out");
  if (isRejected(candidate, buyer, options)) reasons.push("previously_rejected");
  if (numeric(buyer.cashAvailableAed) && buyer.cashAvailableAed >= 0) {
    if (!numeric(initial) || initial < 0) reasons.push("initial_payment_unknown");
    else if (initial > buyer.cashAvailableAed) reasons.push("initial_payment_over_cash");
  }
  if (buyer.financing === "payment_plan" && (value(pack, "paymentPlanAvailable") !== true || !value(pack, "paymentPlanSummary"))) reasons.push("payment_plan_unconfirmed");
  if (buyer.moveInBy) {
    const deadline = Date.parse(buyer.moveInBy);
    const handover = handoverRange(pack);
    if (Number.isFinite(deadline) && (!handover || handover.end > deadline)) reasons.push("move_in_deadline");
  }
  return reasons;
}

function preferenceGaps(candidate, buyer) {
  const gaps = [];
  if (!wantedAreaMatch(candidate, buyer)) gaps.push("area");
  if (!wantedTypeMatch(candidate, buyer)) gaps.push("property_type");
  if (!wantedBedroomsMatch(candidate, buyer)) gaps.push("bedrooms");
  if (!wantedProjectMatch(candidate, buyer)) gaps.push("project");
  if (!wantedDeveloperMatch(candidate, buyer)) gaps.push("developer");
  return gaps;
}

function canChallenge(candidate, buyer, context) {
  const gaps = preferenceGaps(candidate, buyer);
  if (gaps.includes("area") && (buyer.areaFlexibility === "fixed" || buyer.areaFlexibility === false)) return false;
  if (gaps.includes("property_type") && buyer.propertyTypeFlexibility !== true) return false;
  if (gaps.includes("bedrooms")) {
    const largerAsRequested = context.space && candidate.unit.bedrooms > Math.max(...buyer.bedrooms.map(Number));
    const smallerAsRequested = context.objections.has("too_large") && candidate.unit.bedrooms < Math.min(...buyer.bedrooms.map(Number));
    if (!largerAsRequested && !smallerAsRequested) return false;
  }
  if (gaps.includes("project") && !context.objections.size && !buyer.projectFlexibility) return false;
  if (gaps.includes("developer") && !context.objections.has("developer_concern") && !buyer.developerFlexibility) return false;
  return true;
}

function ranking(candidate, buyer, context) {
  const pack = candidate.factPack;
  const codes = [];
  let score = 0;
  const initial = value(pack, "downPaymentAed");
  if (context.lowCash && numeric(initial) && context.maxInitial > 0) {
    score += 50 * (1 - initial / context.maxInitial);
    codes.push("lower_initial_commitment_priority");
  }
  if (context.objections.has("too_expensive") && context.maxPrice > 0) {
    score += 70 * (1 - value(pack, "startingPriceAed") / context.maxPrice);
    codes.push("lower_entry_price_priority");
  }
  if (buyer.useType === "investment" && buyer.investmentObjective === "growth") {
    // These are investment route characteristics, never predicted appreciation.
    if (sameText(value(pack, "status"), "Off-plan")) { score += 18; codes.push("off_plan_growth_route"); }
    if (value(pack, "paymentPlanAvailable") === true && value(pack, "paymentPlanSummary")) { score += 10; codes.push("documented_developer_plan"); }
  }
  if (buyer.useType === "investment" && ["rental_income", "income"].includes(buyer.investmentObjective)) {
    if (sameText(value(pack, "status"), "Ready") && handoverRange(pack)?.end === 0) { score += 25; codes.push("ready_income_route"); }
  }
  if (buyer.useType === "end_use") {
    if ((context.priorities.has("move_in_soon") || context.priorities.has("ready") || context.priorities.has("earlier_handover")) && handoverRange(pack)?.end === 0) { score += 30; codes.push("ready_move_in_route"); }
    const materiallyLarger = context.spaceReferences.some(reference => reference.unit.id !== candidate.unit.id && value(reference.factPack, "startingPriceAed") <= value(pack, "startingPriceAed") && (value(pack, "bedrooms") > value(reference.factPack, "bedrooms") || (positive(value(reference.factPack, "sizeSqftTo")) && positive(value(pack, "sizeSqftFrom")) && value(pack, "sizeSqftFrom") >= value(reference.factPack, "sizeSqftTo") * 1.1)));
    if (context.space && materiallyLarger && positive(value(pack, "sizeSqftFrom")) && context.maxSize > 0) { score += 30 * value(pack, "sizeSqftFrom") / context.maxSize; codes.push("more_space_priority"); }
  }
  if (!codes.length) codes.push("requirements_fit");
  return { score, codes };
}

function compareBenefits(reference, candidate, buyer, context) {
  if (!reference || reference.unit.id === candidate.unit.id) return [];
  const benefits = [];
  const from = reference.factPack;
  const to = candidate.factPack;
  const priceDifference = value(from, "startingPriceAed") - value(to, "startingPriceAed");
  if (priceDifference >= Math.max(25_000, value(from, "startingPriceAed") * 0.02)) benefits.push(dimensionDelta("lower_starting_price", "startingPriceAed", reference, candidate, "AED"));
  const cashFrom = value(from, "downPaymentAed");
  const cashTo = value(to, "downPaymentAed");
  if (context.lowCash && numeric(cashFrom) && numeric(cashTo) && cashFrom - cashTo >= Math.max(10_000, cashFrom * 0.1)) benefits.push(dimensionDelta("lower_initial_commitment", "downPaymentAed", reference, candidate, "AED"));
  if (context.space && numeric(value(from, "bedrooms")) && numeric(value(to, "bedrooms")) && value(to, "bedrooms") > value(from, "bedrooms")) benefits.push(dimensionDelta("additional_bedroom", "bedrooms", reference, candidate, "bedrooms"));
  // A minimum-size increase is only unambiguous if it exceeds the earlier maximum.
  const sizeFrom = value(from, "sizeSqftTo");
  const sizeTo = value(to, "sizeSqftFrom");
  if (context.space && positive(sizeFrom) && positive(sizeTo) && sizeTo >= sizeFrom * 1.1) benefits.push({ ...dimensionDelta("larger_supported_size_range", "sizeSqftFrom", reference, candidate, "sqft"), previousMaximumSqft: sizeFrom });
  if (context.objections.has("too_large")) {
    if (numeric(value(from, "bedrooms")) && numeric(value(to, "bedrooms")) && value(to, "bedrooms") < value(from, "bedrooms")) benefits.push(dimensionDelta("fewer_bedrooms_as_requested", "bedrooms", reference, candidate, "bedrooms"));
    const earlierMinimum = value(from, "sizeSqftFrom");
    const nextMaximum = value(to, "sizeSqftTo");
    if (positive(earlierMinimum) && positive(nextMaximum) && nextMaximum <= earlierMinimum * 0.9) benefits.push({ ...dimensionDelta("smaller_supported_size_range", "sizeSqftTo", reference, candidate, "sqft"), previousMinimumSqft: earlierMinimum });
  }
  if (context.objections.has("wrong_area") && !sameText(value(from, "area"), value(to, "area")) && (buyer.areaFlexibility !== "fixed" || (wantedAreaMatch(candidate, buyer) && !wantedAreaMatch(reference, buyer)))) benefits.push(dimensionDelta("different_area_as_requested", "area", reference, candidate));
  if (context.objections.has("wrong_property_type") && !sameText(value(from, "propertyType"), value(to, "propertyType")) && (buyer.propertyTypeFlexibility === true || (wantedTypeMatch(candidate, buyer) && !wantedTypeMatch(reference, buyer)))) benefits.push(dimensionDelta("property_type_as_requested", "propertyType", reference, candidate));
  if (context.objections.has("developer_concern") && value(from, "developer") && value(to, "developer") && !sameText(value(from, "developer"), value(to, "developer"))) benefits.push(dimensionDelta("different_developer_as_requested", "developer", reference, candidate));
  if ((context.lowCash || context.objections.has("payment_plan_bad")) && value(from, "paymentPlanAvailable") !== true && value(to, "paymentPlanAvailable") === true && value(to, "paymentPlanSummary")) benefits.push(dimensionDelta("documented_developer_plan", "paymentPlanAvailable", reference, candidate));
  const priorHandover = handoverRange(from);
  const nextHandover = handoverRange(to);
  if ((context.objections.has("handover_too_late") || context.priorities.has("move_in_soon") || context.priorities.has("ready") || context.priorities.has("earlier_handover")) && priorHandover && nextHandover && nextHandover.end < priorHandover.start) benefits.push(dimensionDelta("earlier_handover", "handover", reference, candidate));
  if (context.objections.has("handover_too_soon") && priorHandover && nextHandover && nextHandover.start > priorHandover.end) benefits.push(dimensionDelta("later_handover", "handover", reference, candidate));
  if (buyer.useType === "investment" && ["rental_income", "income"].includes(buyer.investmentObjective) && !sameText(value(from, "status"), "Ready") && sameText(value(to, "status"), "Ready") && nextHandover?.end === 0) benefits.push(dimensionDelta("ready_income_route", "status", reference, candidate));
  if (buyer.useType === "investment" && buyer.investmentObjective === "growth" && !sameText(value(from, "status"), "Off-plan") && sameText(value(to, "status"), "Off-plan") && value(to, "paymentPlanAvailable") === true && value(to, "paymentPlanSummary")) benefits.push(dimensionDelta("off_plan_with_documented_plan", "status", reference, candidate));
  return benefits;
}

function solvesObjection(benefits, context) {
  const codes = new Set(benefits.map(item => item.code));
  const required = [];
  if (context.objections.has("initial_payment_too_high")) required.push(codes.has("lower_initial_commitment"));
  if (context.objections.has("too_expensive")) required.push(codes.has("lower_starting_price"));
  if (context.objections.has("too_small")) required.push(codes.has("additional_bedroom") || codes.has("larger_supported_size_range"));
  if (context.objections.has("too_large")) required.push(codes.has("fewer_bedrooms_as_requested") || codes.has("smaller_supported_size_range"));
  if (context.objections.has("wrong_area")) required.push(codes.has("different_area_as_requested"));
  if (context.objections.has("wrong_property_type")) required.push(codes.has("property_type_as_requested"));
  if (context.objections.has("developer_concern")) required.push(codes.has("different_developer_as_requested"));
  if (context.objections.has("handover_too_late")) required.push(codes.has("earlier_handover"));
  if (context.objections.has("handover_too_soon")) required.push(codes.has("later_handover"));
  if (context.objections.has("payment_plan_bad")) required.push(codes.has("lower_initial_commitment") || codes.has("documented_developer_plan"));
  return !required.length || required.every(Boolean);
}

function tradeoffs(reference, candidate, buyer) {
  if (!reference) return [];
  const rows = [];
  const fields = [["higher_starting_price", "startingPriceAed", "AED"], ["higher_initial_commitment", "downPaymentAed", "AED"]];
  for (const [code, key, unit] of fields) {
    const from = value(reference.factPack, key);
    const to = value(candidate.factPack, key);
    if (numeric(from) && numeric(to) && to > from) rows.push(dimensionDelta(code, key, reference, candidate, unit));
  }
  for (const [code, field] of [["different_area", "area"], ["different_property_type", "propertyType"], ["different_developer", "developer"], ["different_handover", "handover"], ["different_payment_plan", "paymentPlanSummary"], ["different_bedroom_count", "bedrooms"]]) {
    const from = value(reference.factPack, field);
    const to = value(candidate.factPack, field);
    if (from != null && to != null && !sameText(from, to)) rows.push(dimensionDelta(code, field, reference, candidate));
  }
  if (!wantedAreaMatch(candidate, buyer)) rows.push({ code: "outside_preferred_area", field: "area", from: [...buyer.preferredAreas], to: value(candidate.factPack, "area"), delta: null });
  if (!value(candidate.factPack, "availability")) rows.push({ code: "current_availability_unknown", field: "availability", from: null, to: null, delta: null });
  if (!numeric(value(candidate.factPack, "downPaymentAed"))) rows.push({ code: "initial_commitment_unknown", field: "downPaymentAed", from: null, to: null, delta: null });
  return rows;
}

function opportunityType(candidate, reference, benefits) {
  const codes = new Set(benefits.map(item => item.code));
  if (reference && value(candidate.factPack, "startingPriceAed") > value(reference.factPack, "startingPriceAed")) return "smart_upgrade";
  if (codes.has("lower_initial_commitment")) return "easier_payment_alternative";
  if (codes.has("lower_starting_price")) return "lower_cost_alternative";
  if (codes.has("earlier_handover") || codes.has("later_handover")) return "better_timing_alternative";
  if (codes.has("ready_income_route")) return "cash_flow_alternative";
  if (codes.has("off_plan_with_documented_plan")) return "growth_alternative";
  return "strategic_alternative";
}

function makeOpportunity(type, candidate, reference, benefits, buyer, budgetPolicy, rankingCodes = []) {
  const price = value(candidate.factPack, "startingPriceAed");
  const cash = value(candidate.factPack, "downPaymentAed");
  const referencePrice = reference && value(reference.factPack, "startingPriceAed");
  const referenceCash = reference && value(reference.factPack, "downPaymentAed");
  const relevantFields = new Set(["startingPriceAed", "downPaymentAed", "area", "bedrooms", "propertyType", "status", "handover", "paymentPlanAvailable", "paymentPlanSummary", "availability", ...benefits.map(item => item.field)]);
  if (benefits.some(item => ["larger_supported_size_range", "smaller_supported_size_range"].includes(item.code))) {
    relevantFields.add("sizeSqftFrom");
    relevantFields.add("sizeSqftTo");
  }
  const facts = [candidate, ...(reference ? [reference] : [])].flatMap(row => [...relevantFields].map(key => evidence(row, key)).filter(Boolean));
  return {
    type,
    projectId: candidate.project.id,
    unitId: candidate.unit.id,
    comparedTo: reference ? { projectId: reference.project.id, unitId: reference.unit.id } : null,
    reasonCodes: [...new Set([...benefits.map(item => item.code), ...rankingCodes])],
    buyerBenefit: benefits,
    tradeoffs: tradeoffs(reference, candidate, buyer),
    priceDifferenceAed: numeric(referencePrice) ? roundMoney(price - referencePrice) : null,
    cashDifferenceAed: numeric(cash) && numeric(referenceCash) ? roundMoney(cash - referenceCash) : null,
    budgetStatus: budgetPolicy.originalBudgetAed === null ? "budget_unknown" : price > budgetPolicy.originalBudgetAed ? "above_original_with_permission" : "within_original_budget",
    amountBasis: "confirmed_starting_prices",
    initialCashBasis: "documented_initial_payment_only_fees_and_schedule_not_inferred",
    supportedFacts: facts,
    confidence: value(candidate.factPack, "availability") && numeric(cash) ? "high" : "medium"
  };
}

function noPush(reasonCodes) {
  return { type: "no_push", projectId: null, unitId: null, comparedTo: null, reasonCodes, buyerBenefit: [], tradeoffs: [], priceDifferenceAed: null, cashDifferenceAed: null, budgetStatus: "not_applicable", supportedFacts: [], confidence: "high" };
}

/**
 * Broker and sales decisions, with no generated prose or external side effects.
 * `matches` is the permitted display shortlist. `packs` additionally contains a
 * fresh comparison baseline when needed to validate arithmetic independently.
 * `permissionCandidate` is internal and must never be displayed before consent.
 */
export function buildAdvisorOpportunities(catalog, buyer, options = {}) {
  const budgetPolicy = advisorBudgetPolicy(buyer, options);
  const candidates = getCandidates(catalog, buyer, options);
  const objections = categories(buyer);
  const hasSuitabilityObjection = [...objections].some(category => SUITABILITY_OBJECTIONS.has(category));
  const priorityCodes = priorities(buyer);
  const context = {
    objections,
    priorities: priorityCodes,
    space: wantsSpace(buyer, objections, priorityCodes),
    lowCash: wantsLowCash(buyer, objections, priorityCodes),
    spaceReferences: candidates.filter(candidate => !preferenceGaps(candidate, buyer).length && !eligibility(candidate, buyer, budgetPolicy.ceilingAed, options).length),
    maxInitial: Math.max(0, ...candidates.map(row => value(row.factPack, "downPaymentAed") || 0)),
    maxPrice: Math.max(0, ...candidates.map(row => value(row.factPack, "startingPriceAed") || 0)),
    maxSize: Math.max(0, ...candidates.map(row => value(row.factPack, "sizeSqftFrom") || 0))
  };
  const assessments = candidates.map(candidate => ({ candidate, hardConstraintFailures: eligibility(candidate, buyer, budgetPolicy.ceilingAed, options), preferenceGaps: preferenceGaps(candidate, buyer) }));
  const base = { candidates, assessments, budgetPolicy, directMatches: [], matches: [], primary: null, challenger: null, opportunities: [], packs: [], upgradeAssessment: { permissionCandidate: null, opportunities: [], decision: "no_push", reasonCodes: [] } };
  if (buyer.salesPathStopped || objections.has("not_interested") || (!options.requestedRecommendation && ["needs_time", "already_has_agent"].some(code => objections.has(code)))) return { ...base, opportunities: [noPush(["respect_buyer_pace"])] };
  if (!options.requestedRecommendation && objections.has("trust_concern") && !hasSuitabilityObjection) return { ...base, opportunities: [noPush(["resolve_trust_before_recommending"])] };
  if (budgetPolicy.originalBudgetAed === null) return { ...base, opportunities: [noPush(["budget_unknown"])] };

  const sortByFit = rows => [...rows].sort((a, b) => {
    const scoreDifference = ranking(b, buyer, context).score - ranking(a, buyer, context).score;
    return scoreDifference || value(a.factPack, "startingPriceAed") - value(b.factPack, "startingPriceAed") || String(a.unit.id).localeCompare(String(b.unit.id));
  });
  const eligible = assessments.filter(row => !row.hardConstraintFailures.length).map(row => row.candidate);
  const directMatches = sortByFit(eligible.filter(candidate => !preferenceGaps(candidate, buyer).length));
  // Keep solving the objected-to property rather than treating each new primary
  // as another rejected baseline on subsequent payment/availability turns.
  const objectedTo = [...(buyer.objections || [])].reverse().find(item => item && typeof item === "object" && !item.resolved && item.projectId && SUITABILITY_OBJECTIONS.has(item.category || item.type));
  const referenceProjectId = objectedTo?.projectId || buyer.activeRecommendationProjectId;
  const referenceUnitId = objectedTo?.unitId || buyer.activeRecommendationUnitId;
  const reference = candidates.find(row => row.unit.id === referenceUnitId && row.project.id === referenceProjectId) || candidates.find(row => row.project.id === referenceProjectId) || null;
  const referenceFresh = reference && positive(value(reference.factPack, "startingPriceAed")) ? reference : null;
  const withinOriginal = candidate => value(candidate.factPack, "startingPriceAed") <= budgetPolicy.originalBudgetAed;
  const originalBudgetDirect = directMatches.filter(withinOriginal);
  const relevantDirect = referenceFresh && hasSuitabilityObjection ? originalBudgetDirect.filter(candidate => candidate.unit.id !== referenceFresh.unit.id && solvesObjection(compareBenefits(referenceFresh, candidate, buyer, context), context)) : originalBudgetDirect;
  let primaryCandidate = relevantDirect[0] || null;
  if (!primaryCandidate && referenceFresh) {
    primaryCandidate = sortByFit(eligible.filter(candidate => withinOriginal(candidate) && canChallenge(candidate, buyer, context) && relevantChallengeBenefits(candidate, referenceFresh, buyer, context).length && solvesObjection(relevantChallengeBenefits(candidate, referenceFresh, buyer, context), context)))[0] || null;
  }
  // Permission to stretch never supplies the missing "why spend more" evidence.
  // Prefer an in-budget primary; an over-original primary requires a real,
  // fresh, previously considered in-budget baseline and a material advantage.
  if (!primaryCandidate && budgetPolicy.flexible && referenceFresh && withinOriginal(referenceFresh)) {
    primaryCandidate = sortByFit(eligible.filter(candidate => !withinOriginal(candidate) && canChallenge(candidate, buyer, context) && relevantChallengeBenefits(candidate, referenceFresh, buyer, context).some(benefit => benefit.code !== "lower_starting_price") && solvesObjection(relevantChallengeBenefits(candidate, referenceFresh, buyer, context), context)))[0] || null;
  }
  if (!primaryCandidate) return { ...base, directMatches, opportunities: [noPush(["no_suitable_supported_option"])] };

  const baseline = referenceFresh && referenceFresh.unit.id !== primaryCandidate.unit.id ? referenceFresh : null;
  const primaryBenefits = compareBenefits(baseline, primaryCandidate, buyer, context);
  const primary = makeOpportunity("best_fit", primaryCandidate, baseline, primaryBenefits, buyer, budgetPolicy, ranking(primaryCandidate, buyer, context).codes);
  if (baseline && primaryBenefits.length && (preferenceGaps(primaryCandidate, buyer).length || !withinOriginal(primaryCandidate))) primary.type = opportunityType(primaryCandidate, baseline, primaryBenefits);

  const challengerRows = eligible.filter(candidate => candidate.unit.id !== primaryCandidate.unit.id && canChallenge(candidate, buyer, context)).map(candidate => ({ candidate, benefits: relevantChallengeBenefits(candidate, primaryCandidate, buyer, context) })).filter(row => row.benefits.length && solvesObjection(row.benefits, context));
  const usefulChallengers = challengerRows.filter(row => {
    const costsMore = value(row.candidate.factPack, "startingPriceAed") > value(primaryCandidate.factPack, "startingPriceAed");
    return !costsMore || (!buyer.upgradeDeclined && row.candidate.project.id !== buyer.lastUpgradeProjectId && row.benefits.some(item => item.code !== "lower_starting_price"));
  });
  usefulChallengers.sort((a, b) => {
    const priorityA = a.benefits.some(item => item.code === "lower_initial_commitment") && objections.has("initial_payment_too_high") ? 1 : 0;
    const priorityB = b.benefits.some(item => item.code === "lower_initial_commitment") && objections.has("initial_payment_too_high") ? 1 : 0;
    return priorityB - priorityA || ranking(b.candidate, buyer, context).score - ranking(a.candidate, buyer, context).score || value(a.candidate.factPack, "startingPriceAed") - value(b.candidate.factPack, "startingPriceAed");
  });
  const preferencesLimit = Number(loadConversationPreferences().maxProjectsToPitch || 2);
  const configuredLimit = Number(options.maxRecommendations ?? process.env.ADVISOR_MAX_RECOMMENDATIONS ?? preferencesLimit);
  const limit = Number.isFinite(configuredLimit) ? Math.min(2, Math.max(1, Math.floor(configuredLimit))) : 2;
  const challengerRow = limit > 1 ? usefulChallengers[0] : null;
  const challenger = challengerRow ? makeOpportunity(opportunityType(challengerRow.candidate, primaryCandidate, challengerRow.benefits), challengerRow.candidate, primaryCandidate, challengerRow.benefits, buyer, budgetPolicy) : null;
  const matches = [primaryCandidate, ...(challengerRow ? [challengerRow.candidate] : [])];

  const unhelpfulExtra = eligible.find(candidate => candidate.unit.id !== primaryCandidate.unit.id && value(candidate.factPack, "startingPriceAed") > value(primaryCandidate.factPack, "startingPriceAed") && canChallenge(candidate, buyer, context) && !compareBenefits(primaryCandidate, candidate, buyer, context).length);
  const upgradeAssessment = { permissionCandidate: null, opportunities: [], decision: challenger?.type === "smart_upgrade" ? "justified_upgrade" : "no_push", reasonCodes: [] };
  if (unhelpfulExtra) {
    const decision = makeOpportunity("no_push", unhelpfulExtra, primaryCandidate, [], buyer, budgetPolicy);
    decision.reasonCodes = ["no_material_buyer_benefit_for_extra_price"];
    upgradeAssessment.opportunities.push(decision);
    upgradeAssessment.reasonCodes.push("no_material_buyer_benefit_for_extra_price");
  }
  if (!budgetPolicy.flexible && !budgetPolicy.firm && !buyer.budgetFlexibilityAsked && !buyer.upgradeDeclined) {
    const permissionRows = candidates.filter(candidate => !eligibility(candidate, buyer, budgetPolicy.permissionCeilingAed, options).length && value(candidate.factPack, "startingPriceAed") > budgetPolicy.originalBudgetAed && canChallenge(candidate, buyer, context)).map(candidate => ({ candidate, benefits: relevantChallengeBenefits(candidate, primaryCandidate, buyer, context) })).filter(row => row.benefits.some(item => item.code !== "lower_starting_price") && solvesObjection(row.benefits, context));
    const permissionRow = permissionRows.sort((a, b) => value(a.candidate.factPack, "startingPriceAed") - value(b.candidate.factPack, "startingPriceAed"))[0];
    if (permissionRow) {
      const opportunity = makeOpportunity("smart_upgrade", permissionRow.candidate, primaryCandidate, permissionRow.benefits, buyer, budgetPolicy);
      opportunity.budgetStatus = "requires_budget_permission";
      upgradeAssessment.permissionCandidate = opportunity;
      upgradeAssessment.decision = "ask_budget_permission_once";
    }
  }
  const evidenceCandidates = new Map(matches.map(row => [row.unit.id, row]));
  if (baseline) evidenceCandidates.set(baseline.unit.id, baseline);
  if (unhelpfulExtra) evidenceCandidates.set(unhelpfulExtra.unit.id, unhelpfulExtra);
  return { ...base, directMatches, matches, primary, challenger, opportunities: [primary, ...(challenger ? [challenger] : [])], packs: [...evidenceCandidates.values()].map(row => row.factPack), upgradeAssessment };
}
