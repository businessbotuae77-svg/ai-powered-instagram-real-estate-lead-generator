import { buildFactPack } from "../facts/retrieval.js";
import { normalizeArea, normalizePropertyType, sameText } from "../matching/normalize.js";
import { sourcedCandidatePrice } from "./comparison-evidence.js";
import { compareProperties } from "./comparison.js";
import { comparisonReply } from "./comparison-reply.js";
import { isAffirmation } from "./affirmation.js";

const lowest = text => /\b(?:cheapest|lowest[- ]priced?|least expensive|most affordable)\b|أرخص|ارخص|أقل سعر|اقل سعر/i.test(text);
const ready = text => /\bready\b|جاهز|جاهزة/i.test(text);
const sameHome = (a, b) => a.unit.bedrooms === b.unit.bedrooms && sameText(a.unit.propertyType, b.unit.propertyType);
const identity = candidate => ({ projectId: candidate.project.id, unitId: candidate.unit.id });
const key = candidate => `${candidate.project.id}|${candidate.unit.id}`;

export function asksAvailability(text) {
  return /\b(?:available|availability|stock|sold out|units? left)\b|متاح|متوفر|التوفر/i.test(text);
}

export function isListingRequest(text) {
  return lowest(text) && (ready(text) || asksAvailability(text));
}

export function acceptsListingComparison(text, pendingOffer) {
  return pendingOffer?.type === "listing_comparison" && (isAffirmation(text) || /^(?:compare|قارن|قارنهم)[.!?؟]*$/i.test(text));
}

function scopeFor(buyer) {
  return {
    areas: buyer.preferredAreas || [], bedrooms: buyer.bedrooms || [], types: buyer.propertyTypes || [],
    project: buyer.projectInterest || null, developers: buyer.developerInterest ? [buyer.developerInterest] : [],
    budget: buyer.budgetAed ?? null, cash: buyer.cashAvailableAed ?? null, financing: buyer.financing || null
  };
}

// Enumerate every eligible listing; ranking elsewhere may deliberately limit a shortlist.
function candidates(catalog, scope, { readyOnly = false, availableOnly = false, projects = null } = {}) {
  return catalog.units.flatMap(unit => {
    const project = catalog.projects.find(row => row.id === unit.projectId);
    if (!project || !project.active || project.developerActive === false || unit.active === false ||
        unit.approved === false || unit.projectLevel || !sameText(project.emirate, "Abu Dhabi")) return [];
    if (projects && !projects.some(row => row.id === project.id)) return [];
    if (scope.areas.length && !scope.areas.some(area => sameText(normalizeArea(area), normalizeArea(project.area)))) return [];
    if (scope.project && !sameText(scope.project, project.name)) return [];
    if (scope.developers.length && !scope.developers.some(name => sameText(name, project.developerName))) return [];
    if (scope.bedrooms.length && !scope.bedrooms.includes(unit.bedrooms)) return [];
    if (scope.types.length && !scope.types.some(type => sameText(normalizePropertyType(type), normalizePropertyType(unit.propertyType)))) return [];
    const factPack = buildFactPack({ project, unit, downPaymentAed: unit.initialPaymentAed ?? project.initialPaymentAed,
      bedroomLabel: String(unit.bedrooms) });
    const candidate = { project, unit, factPack };
    if (!sourcedCandidatePrice(candidate)) return [];
    if (readyOnly && !(factPack.status.confirmed && sameText(factPack.status.value, "Ready") &&
        factPack.handover.confirmed && /^ready$/i.test(factPack.handover.value))) return [];
    if (availableOnly && !(factPack.availability.confirmed && /^available$/i.test(factPack.availability.value))) return [];
    if (scope.budget != null && factPack.startingPriceAed.value > scope.budget) return [];
    if (scope.cash != null && (!factPack.downPaymentAed.confirmed || factPack.downPaymentAed.value > scope.cash)) return [];
    if (scope.financing === "payment_plan" && !(factPack.paymentPlanAvailable.confirmed && factPack.paymentPlanAvailable.value)) return [];
    return [candidate];
  }).sort((a, b) => a.factPack.startingPriceAed.value - b.factPack.startingPriceAed.value || key(a).localeCompare(key(b)));
}

export function listingLabel(pack, language = "en") {
  const ar = language === "ar", beds = pack.bedrooms.value;
  const type = ar ? ({ apartment: "شقة", villa: "فيلا", townhouse: "تاون هاوس", studio: "استوديو" })[pack.propertyType.value] : pack.propertyType.value;
  if (beds === 0) return ar ? "استوديو" : "studio";
  return ar ? `${type || "وحدة"} ${beds === 1 ? "بغرفة نوم" : beds === 2 ? "بغرفتين" : `بـ${beds} غرف نوم`}` : `${beds} bedroom ${type || "home"}`;
}

function sizeText(pack, ar) {
  if (!pack.sizeSqftFrom.confirmed) return ar ? "المساحة تحتاج تأكيداً" : "size needs confirming";
  const from = pack.sizeSqftFrom.value.toLocaleString("en-US");
  const to = pack.sizeSqftTo.confirmed && pack.sizeSqftTo.value !== pack.sizeSqftFrom.value ? `–${pack.sizeSqftTo.value.toLocaleString("en-US")}` : "";
  return ar ? `المساحة ${from}${to} قدم مربعة` : `${from}${to} sqft`;
}

function comparisonDraft(pair, buyer) {
  const comparisonFacts = compareProperties(pair[0], pair[1], buyer);
  return { text: comparisonReply(comparisonFacts, { language: buyer.language }), stage: "comparison",
    factPacks: pair.map(row => row.factPack), comparisonFacts, nextQuestion: null, pendingOffer: null, callRequest: null };
}

/** Named projects use the same bedroom and home type, never each project's cheapest unrelated unit. */
export function compareNamedListings(projects, catalog, buyer) {
  const scope = { ...scopeFor(buyer), areas: [], project: null, developers: [], budget: null, cash: null, financing: null };
  const rows = candidates(catalog, scope, { projects });
  const pairs = rows.filter(row => row.project.id === projects[0].id).flatMap(a => rows
    .filter(b => b.project.id === projects[1].id && sameHome(a, b)).map(b => [a, b]));
  pairs.sort((a, b) => a[0].unit.bedrooms - b[0].unit.bedrooms ||
    a[0].factPack.startingPriceAed.value + a[1].factPack.startingPriceAed.value - b[0].factPack.startingPriceAed.value - b[1].factPack.startingPriceAed.value);
  if (pairs.length) return comparisonDraft(pairs[0], buyer);
  const ar = buyer.language === "ar";
  const prompt = ar ? "أي نوع وحدة تبي نقارنه؟" : "Which home type would you like to compare?";
  return { text: `${ar ? "ما عندي أسعار حديثة ومؤكدة لنفس نوع الوحدة وعدد الغرف في المشروعين." : "I don't have current, confirmed prices for the same home type and bedroom count in both projects."} ${prompt}`,
    stage: "comparison", factPacks: [], suppressCommercial: true,
    nextQuestion: { field: "comparisonHomeType", prompt }, pendingOffer: null, callRequest: null };
}

/** A comparison offer retains exact identities and is checked again when accepted. */
export function answerListingRequest({ message, catalog, buyer, pendingOffer = null }) {
  const accepted = acceptsListingComparison(message, pendingOffer);
  if (!isListingRequest(message) && !accepted) return null;
  const ar = buyer.language === "ar", scope = scopeFor(buyer);
  const filters = accepted ? pendingOffer.filters : { readyOnly: ready(message), availableOnly: false };
  const rows = candidates(catalog, scope, filters);
  if (accepted) {
    const pair = pendingOffer.pair.map(id => rows.find(row => row.project.id === id.projectId && row.unit.id === id.unitId));
    if (JSON.stringify(scope) === JSON.stringify(pendingOffer.scope) && pair.every(Boolean) && sameHome(...pair)) {
      const prompt = ar ? "أي فرق يهمك أكثر في المقارنة؟" : "Which difference matters most to you?";
      return { ...comparisonDraft(pair, buyer), suppressCommercial: true, nextQuestion: { field: "comparisonPreference", prompt },
        text: `${comparisonReply(compareProperties(...pair, buyer), { language: buyer.language })}\n${prompt}` };
    }
    return { text: ar ? "المقارنة السابقة تحتاج تحديثاً لأن المتطلبات أو تفاصيل القوائم تغيّرت. أقدر أراجع الخيارات الحالية هنا."
      : "That comparison needs refreshing because the requirements or listing details have changed. I can review the current options here.",
    stage: "fact_answer", factTopic: "availability", factMissing: [{ topic: "availability" }], factPacks: [],
    suppressCommercial: true, nextQuestion: null, pendingOffer: null, callRequest: null };
  }
  const scopeLabel = scope.areas.join(ar ? "، " : ", ") || "Abu Dhabi";
  if (!rows.length) {
    const priced = candidates(catalog, scope, { ...filters, availableOnly: false });
    const unknown = priced.find(row => !row.factPack.availability.confirmed);
    const detail = unknown ? (ar
      ? `${unknown.project.name}: يبدأ من ${unknown.factPack.startingPriceText.value} لـ${listingLabel(unknown.factPack, "ar")}؛ ${sizeText(unknown.factPack, true)}. التوفر الحالي يحتاج تحققاً حديثاً.`
      : `${unknown.project.name}: from ${unknown.factPack.startingPriceText.value} for a ${listingLabel(unknown.factPack)}; ${sizeText(unknown.factPack, false)}. Current availability needs a fresh check.`) : (ar
      ? "حالة الجاهزية والتوفر والسعر تحتاج تأكيداً حديثاً قبل تحديد أقل خيار." : "Ready status, availability and price need current confirmation before I can identify the lowest match.");
    const prompt = ar ? "تبي نراجع تفاصيل مشروع معيّن؟" : "Is there a particular project you'd like to review?";
    return { text: `${ar ? `ما أقدر أؤكد خياراً${filters.readyOnly ? " جاهزاً" : ""} ومتاحاً ضمن ${scopeLabel}.` : `I can't confirm ${filters.readyOnly ? "a ready, available" : "an available"} match within ${scopeLabel}.`} ${detail} ${prompt}`,
      stage: "fact_answer", factTopic: "availability", factMissing: [{ topic: "availability", project: unknown?.project.name }],
      factPacks: unknown ? [unknown.factPack] : [], suppressCommercial: true,
      nextQuestion: { field: "factProject", prompt }, pendingOffer: null, callRequest: null };
  }
  const first = rows[0], pack = first.factPack;
  const second = rows.find(row => sameHome(first, row) && row.factPack.startingPriceAed.value > pack.startingPriceAed.value);
  const text = ar
    ? `أقل خيار${filters.readyOnly ? " جاهز" : ""} أقدر أؤكده ضمن ${scopeLabel} هو ${first.project.name} في ${pack.area.value}، بسعر يبدأ من ${pack.startingPriceText.value} لـ${listingLabel(pack, "ar")}؛ ${sizeText(pack, true)}.`
    : `The lowest-priced ${filters.readyOnly ? "ready " : ""}match I can confirm within ${scopeLabel} is ${first.project.name} in ${pack.area.value}, from ${pack.startingPriceText.value} for a ${listingLabel(pack)}; ${sizeText(pack, false)}.`;
  const prompt = second ? (ar ? "تبي أقارنه بأقرب خيار أعلى سعراً من نفس نوع الوحدة وعدد الغرف؟" : "Want me to compare it with the next-priced option of the same home type and bedroom count?") : null;
  return { text: [text, prompt].filter(Boolean).join("\n"), stage: "matched", factPacks: [pack], listingMatches: [first], suppressCommercial: true,
    buyerPatch: { activeRecommendationProjectId: first.project.id, activeRecommendationUnitId: first.unit.id },
    nextQuestion: prompt ? { field: "advisoryNextAction", prompt } : null,
    pendingOffer: second ? { type: "listing_comparison", pair: [identity(first), identity(second)], scope, filters } : null, callRequest: null };
}
