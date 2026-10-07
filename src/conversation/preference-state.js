import { normalizeBuyerText } from "./text.js";

/** Semantic qualification slots, independent of how a question is worded. */
const QUESTION_FIELDS = {
  budget: "budgetAed", budgetAed: "budgetAed",
  cash: "cashAvailableAed", cashAvailableAed: "cashAvailableAed", initialCash: "cashAvailableAed",
  area: "preferredAreas", areas: "preferredAreas", preferredAreas: "preferredAreas", areaFlexibility: "preferredAreas",
  bedrooms: "bedrooms", bedroom: "bedrooms", size: "bedrooms",
  propertyType: "propertyTypes", propertyTypes: "propertyTypes", product: "propertyTypes",
  investmentObjective: "investmentObjective", investmentGoal: "investmentObjective", investmentStrategy: "investmentObjective",
  advisoryPriority: "investmentObjective", investmentPriority: "investmentObjective", priorities: "investmentObjective", growthPriority: "investmentObjective",
  exitHorizon: "exitHorizon", exitStrategy: "exitHorizon", holdingPeriod: "exitHorizon", handoverStrategy: "exitHorizon",
  riskTolerance: "riskTolerance", riskPreference: "riskTolerance", risk: "riskTolerance",
  cashDeploymentPreference: "cashDeploymentPreference", cashPreference: "cashDeploymentPreference",
  financing: "financing", financingPreference: "financing",
  liquidityPriority: "liquidityPriority", incomeRequirement: "incomeRequirement",
  useType: "useType", advisoryNextAction: "advisoryNextAction", discoveryFocus: "advisoryNextAction"
};

export function canonicalQuestionField(field) {
  return field ? QUESTION_FIELDS[String(field)] || null : null;
}

export function normalizePreferenceStates(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const states = {};
  for (const [field, state] of Object.entries(raw)) {
    const slot = canonicalQuestionField(field);
    if (slot && ["flexible", "specified"].includes(state)) states[slot] = state;
  }
  return states;
}

export function isFlexiblePreference(buyer, field) {
  const slot = canonicalQuestionField(field);
  if (!slot) return false;
  return buyer?.preferenceStates?.[slot] === "flexible" ||
    (slot === "investmentObjective" && buyer?.investmentPreferenceState === "flexible");
}

export const PREFERENCE_FACT_FIELDS = ["preferenceStates", "investmentPreferenceState", "advisorLed"];

export function normalizePreferenceFacts(input = {}) {
  const facts = {};
  if (input.preferenceStates && typeof input.preferenceStates === "object") facts.preferenceStates = normalizePreferenceStates(input.preferenceStates);
  if (["flexible", "specified"].includes(input.investmentPreferenceState)) facts.investmentPreferenceState = input.investmentPreferenceState;
  if (typeof input.advisorLed === "boolean") facts.advisorLed = input.advisorLed;
  return facts;
}

const UNCERTAINTY = /\b(?:idk|unsure|not (?:really )?sure|don'?t know|dont know|do not know|no idea|no preference|no particular preference|don'?t have (?:any|a) preference)\b/i;
const DELEGATION = /\b(?:you choose|whatever you think|best (?:overall|option)|choose for me|advise me|i(?:'m| am) open)\b/i;
const SHORT_FLEXIBLE = /^(?:(?:honestly|to be honest)[, ]+)?(?:(?:i(?:'m| am)|i honestly|i really|i)\s+)?(?:idk|unsure|not (?:really )?sure|don'?t know|dont know|do not know|no idea|no preference|no particular preference|don'?t have (?:any|a) preference|you choose|whatever you think(?: is best)?|best (?:overall|option)|choose for me|advise me|open|flexible|not bothered|anywhere|skip|maybe later)(?:\s+(?:really|yet|please|thanks|about that|what i want|what matters|which is best|at this point))?[.!?]*$/i;
const INVESTMENT_SLOTS = new Set(["investmentObjective", "exitHorizon", "riskTolerance", "cashDeploymentPreference", "liquidityPriority", "incomeRequirement"]);
const EXPLICIT_SLOTS = [
  ["budgetAed", /\bbudget\b/],
  ["preferredAreas", /\b(?:areas?|where|location)\b/],
  ["bedrooms", /\b(?:bedrooms?|beds?|size)\b/],
  ["propertyTypes", /\b(?:property types?|product types?|apartments?|villas?|townhouses?)\b/],
  ["investmentObjective", /\b(?:investment (?:priority|objective|goal)|priorit(?:y|ies)|what matters|growth or income|growth vs income)\b/],
  ["exitHorizon", /\b(?:exit|holding period|how long|hold or sell)\b/],
  ["riskTolerance", /\b(?:risk|risk tolerance)\b/],
  ["cashDeploymentPreference", /\b(?:cash preference|cash deployment|upfront vs|lower cash)\b/],
  ["cashAvailableAed", /\b(?:cash available|initial cash|initial payment|down payment|deposit)\b/],
  ["financing", /\b(?:financing|mortgage|finance)\b/],
  ["liquidityPriority", /\bliquidity\b/],
  ["incomeRequirement", /\b(?:income requirement|when.*income|immediate income)\b/]
];

export function isExplicitUncertainty(message) {
  return UNCERTAINTY.test(normalizeBuyerText(message));
}

export function isPropertyFactUncertainty(message) {
  const text = normalizeBuyerText(message).trim().toLowerCase();
  if (!UNCERTAINTY.test(text)) return false;
  return /\b(?:projects?|units?|listings?|developers?|availability|located|offers?|requires?)\b/.test(text) ||
    /\b(?:risk|initial payment|down payment|deposit|bedrooms?|size|financing)\s+(?:in|of|on|for)\b/.test(text);
}

/** Explicit uncertainty is a remembered answer, never consent to spend more. */
export function parseFlexiblePreferences(message, { buyer = null, lastAskedField = null } = {}) {
  const text = normalizeBuyerText(message).trim().toLowerCase();
  if (!text) return { facts: {}, unsure: [] };
  const short = SHORT_FLEXIBLE.test(text);
  const delegated = DELEGATION.test(text) && short;
  const uncertain = UNCERTAINTY.test(text);
  const explicit = uncertain ? EXPLICIT_SLOTS.filter(([, pattern]) => pattern.test(text)).map(([field]) => field) : [];
  // A question about a project's facts is not uncertainty about the buyer's preferences.
  if (!short && (!uncertain || !explicit.length || isPropertyFactUncertainty(text))) return { facts: {}, unsure: [] };

  const asked = canonicalQuestionField(lastAskedField);
  const investor = buyer?.useType === "investment" || /\binvest(?:ment|ing|or)?\b/.test(text);
  const fields = explicit.length ? explicit : asked ? [asked] : investor ? ["investmentObjective"] : [];
  const preferenceStates = Object.fromEntries(fields.map(field => [field, "flexible"]));
  const facts = fields.length ? { preferenceStates } : {};
  if (fields.includes("preferredAreas") || (delegated && investor && !buyer?.preferredAreas?.length)) {
    Object.assign(facts, { openToOtherAreas: true, areaFlexibility: "open" });
    preferenceStates.preferredAreas = "flexible";
  }
  if (fields.includes("bedrooms") || fields.includes("propertyTypes")) {
    facts.propertyTypeFlexibility = true;
    if (fields.includes("bedrooms")) facts.bedroomsRequired = false;
  }
  if (investor && (delegated || fields.some(field => INVESTMENT_SLOTS.has(field)))) {
    Object.assign(facts, { advisorLed: true, investmentPreferenceState: "flexible" });
    if (!buyer?.investmentObjective && (!buyer?.investmentStrategy || buyer.investmentStrategy === "UNDECIDED")) facts.investmentStrategy = "UNDECIDED";
    preferenceStates.investmentObjective = "flexible";
  }
  if (Object.keys(preferenceStates).length) facts.preferenceStates = preferenceStates;
  return { facts, unsure: Object.keys(preferenceStates) };
}
