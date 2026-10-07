import { CONVERSATION_POLICY } from "./policy.js";
import { normalizeBuyerText } from "./text.js";
/**
 * Claude (or local) understanding → structured buyer updates.
 * Matching, memory persistence, and commercial facts stay in code / Airtable.
 */

import { parseMoney, normalizeArea, normalizeBedrooms, normalizePropertyType, normalizeDeveloper } from "../matching/normalize.js";
import { FINANCING_VALUES, USE_TYPES } from "../schema/fields.js";
import { ADVISORY_FACT_FIELDS, parseAdvisoryFacts, normalizeAdvisoryFacts } from "./advisory-memory.js";
import { canonicalQuestionField, isPropertyFactUncertainty, parseFlexiblePreferences } from "./preference-state.js";

const DEFAULT_MODEL = "claude-sonnet-5";

const UNDERSTAND_SYSTEM = [CONVERSATION_POLICY,
  "You extract structured buyer requirements from Abu Dhabi off-plan property chat.",
  "Return ONLY valid JSON with this shape:",
  '{"facts":{"budget":number|null,"cash":number|null,"area":string|null,"areas":string[]|null,"bedrooms":number|number[]|null,"propertyType":string|null,"developer":string|null,"project":string|null,"financing":"cash"|"mortgage"|"payment_plan"|null,"useType":"investment"|"end_use"|null,"investmentObjective":"rental_income"|"growth"|"balanced"|null,"investmentGoal":"total_return"|"capital_appreciation"|"income"|"balanced"|null,"investmentStrategy":"OFF_PLAN_APPRECIATION"|"HANDOVER_EXIT"|"LONG_TERM_HOLD"|"INCOME_AFTER_HANDOVER"|"READY_INCOME"|"BALANCED"|"UNDECIDED"|null,"exitHorizon":"before_handover"|"handover"|"long_term"|null,"holdingPeriod":number|null,"incomeRequirement":"immediate"|"after_handover"|"none"|"flexible"|null,"growthPriority":"high"|"medium"|"low"|null,"liquidityPriority":"high"|"medium"|"low"|null,"riskTolerance":"low"|"medium"|"high"|null,"cashDeploymentPreference":"lower_initial"|"lower_construction"|"minimize_total_price"|"balanced"|null,"handoverStrategy":"sell"|"hold"|"rent"|null,"explorationState":boolean|null,"areaFlexibility":"open"|"preferred"|"fixed"|null,"propertyTypeFlexibility":boolean|null,"priorities":string[],"objections":[{"category":string}],"contactDeclined":boolean|null,"openToOtherAreas":boolean|null},"unsure":string[],"intents":string[],"signals":string[],"ack":string|null}',
  "Rules:",
  "- Convert money to AED numbers. around/about/roughly 2M → 2000000. 300k → 300000. no more than 150k down → cash 150000.",
  "- bedrooms studio → 0. Corrections like actually make that 2 bedrooms replace bedrooms.",
  "- If buyer says 1 or 2 bed / 1 or 2 bedrooms, set bedrooms to [1,2].",
  "- Extract any clearly named Abu Dhabi area, including Yas Island, Saadiyat Island, Hudayriyat Island, Ramhan Island, Fahid Island, Al Reem Island, Masdar City, Al Raha Beach, Al Maryah Island, Khalifa City, and Al Reef.",
  "- Canonicalize Masdar as Masdar City. If buyer says what about Masdar, forget Yas, or switch to Reem, set area to the newly requested area only.",
  "- If buyer says not sure / unsure / idk / I don't know / you choose / best option / no preference about a field, put that semantic field name in unsure (budget, cash, area, bedrooms, propertyType, financing, investmentObjective, exitHorizon, riskTolerance, cashDeploymentPreference) and leave facts for that field null. Treat uncertainty as flexible/advisor-led, never ask the same conceptual question again or invent a preference.",
  "- If the buyer does not know the area, also set openToOtherAreas true so the conversation moves forward across Abu Dhabi instead of asking area again.",
  "- Best ROI is umbrella total_return intent; capital appreciation and rental income are return drivers, not opposites to ROI. Do not pick a return driver or strategy from ROI alone. Never clear a known budget or choose an area on the buyer's behalf.",
  "- Extract volunteered investmentGoal, investmentStrategy, exitHorizon, incomeRequirement, growthPriority, liquidityPriority, riskTolerance, cashDeploymentPreference, handoverStrategy only when explicit. Short 'handover' after an exit question means handover exit; a project handover question does not. 'Hold 5 years' is a holding period, never a reservation request. A forecast question is not a preference.",
  "- 'I do not care about Yas anymore' removes that preference; do not set Yas as the requested area. Explicit 'only Yas' makes area fixed.",
  "- Exploring is a valid state. Set explorationState true; do not turn it into a home/investment objective without an explicit buyer preference.",
  "- holdingPeriod is years, only if buyer supplies it. Objections are buyer concerns, not permission to invent listing facts or contact consent.",
  "- If open to other areas while preferring one, set area plus openToOtherAreas true.",
  "- intents may include greet, unsure, search, correction, decline_contact, high_intent, reserve, viewing, ask_facts, continue, start_fresh.",
  "- ack is one short natural sentence acknowledging the update with NO prices, projects, or commercial claims. null if nothing useful.",
  "- Never invent listing prices, payment plans, handover dates, or availability."
].join(" ");

/**
 * Ask Claude for structured understanding of one buyer message.
 */
export async function understandMessageWithModel(client, { message, buyer, lastAskedField = null, recentTurns = [] }) {
  if (!client?.apiKey) return null;

  const user = JSON.stringify({
    message,
    lastAskedField,
    buyer: {
      language: buyer?.language,
      preferredContactChannel: buyer?.preferredContactChannel,
      noCalls: buyer?.noCalls,
      salesPathStopped: buyer?.salesPathStopped,
      budgetAed: buyer?.budgetAed ?? null,
      budgetHardCap: buyer?.budgetHardCap !== false,
      budgetFirm: buyer?.budgetFirm || false,
      budgetFlexible: buyer?.budgetFlexible || false,
      cashAvailableAed: buyer?.cashAvailableAed ?? null,
      preferredAreas: buyer?.preferredAreas || [],
      bedrooms: buyer?.bedrooms || [],
      financing: buyer?.financing || null,
      useType: buyer?.useType || null,
      investmentObjective: buyer?.investmentObjective || null,
      investmentGoal: buyer?.investmentGoal || null,
      investmentStrategy: buyer?.investmentStrategy || "UNDECIDED",
      preferenceStates: buyer?.preferenceStates || {},
      investmentPreferenceState: buyer?.investmentPreferenceState || null,
      advisorLed: buyer?.advisorLed === true,
      exitHorizon: buyer?.exitHorizon || null,
      holdingPeriod: buyer?.holdingPeriod || null,
      incomeRequirement: buyer?.incomeRequirement || null,
      growthPriority: buyer?.growthPriority || null,
      liquidityPriority: buyer?.liquidityPriority || null,
      riskTolerance: buyer?.riskTolerance || null,
      cashDeploymentPreference: buyer?.cashDeploymentPreference || null,
      handoverStrategy: buyer?.handoverStrategy || null,
      priorities: buyer?.priorities || [],
      concerns: buyer?.concerns || [],
      projectInterest: buyer?.projectInterest || null
    },
    recentTurns: recentTurns.slice(-6).map((t) => ({ role: t.role, text: t.text }))
  });

  try {
    const response = await fetch(`${client.baseUrl}/v1/messages`, {
      method: "POST",
      signal: AbortSignal.timeout(15000),
      headers: {
        "content-type": "application/json",
        "x-api-key": client.apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: client.model || DEFAULT_MODEL,
        max_tokens: 500,
        thinking: { type: "disabled" },
        system: UNDERSTAND_SYSTEM,
        messages: [{ role: "user", content: user }]
      })
    });
    if (!response.ok) return null;
    const data = await response.json();
    const text = (data.content || [])
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
    return normalizeUnderstanding(parseJsonObject(text), "claude");
  } catch {
    return null;
  }
}

/**
 * Local heuristics for imperfect phrasing when Claude is offline (tests / fallback).
 */
export function understandMessageLocally(message, { buyer = null, lastAskedField = null } = {}) {
  const text = normalizeBuyerText(message).trim();
  const facts = parseAdvisoryFacts(text, { buyer, lastAskedField });
  const unsure = [];
  const intents = [];
  const signals = [];
  let ack = null;

  if (!text) {
    return { facts, unsure, intents: ["empty"], signals, ack: null, source: "local" };
  }

  const askedField = mapAskedField(lastAskedField);
  const directAmount = text.match(
    /^\s*(?:AED|Dhs|Dh)?\s*(\d[\d,]*(?:\.\d+)?\s*[MmKk]?)\s*$/
  );
  if (directAmount && (askedField === "cash" || askedField === "budget")) {
    const amount = parseMoney(directAmount[1]);
    if (amount !== null && amount > 0) {
      facts[askedField] = amount;
      intents.push("provide_facts");
      ack =
        askedField === "cash"
          ? `Got it, you have around AED ${amount.toLocaleString("en-US")} for the initial payment.`
          : `Got it, your budget is around AED ${amount.toLocaleString("en-US")}.`;
    }
  }

  const areaUnsure =
    /\b(?:don'?t know|dont know|do not know|not sure|no idea)\b[\s\S]{0,48}\b(?:which\s+)?area\b/i.test(text) ||
    /\b(?:which\s+)?area\b[\s\S]{0,48}\b(?:don'?t know|dont know|not sure|no idea)\b/i.test(text) ||
    /\b(?:don'?t know|dont know|not sure|no idea)\b[\s\S]{0,32}\bwhere\b/i.test(text);

  const unsureOnly =
    /^(not sure|unsure|i'?m not sure|not really sure|idk|i dkn?t know|i don'?t know|dont know|do not know|no idea|not bothered|anywhere|you choose|maybe later|skip)([.!?]*)$/i.test(
      text
    ) ||
    (/^\s*(not sure|unsure|i dkn?t know|i don'?t know|dont know|no idea)\b/i.test(text) &&
      text.length < 48 &&
      !/\d/.test(text));

  if ((unsureOnly || areaUnsure) && !isPropertyFactUncertainty(text)) {
    const roiAdvisory = /\b(?:roi|return on investment|investment)\b/i.test(text);
    const safeAskedField = askedField === "budget" && (buyer?.budgetAed != null || roiAdvisory) ? null : askedField;
    const field = areaUnsure ? "area" : safeAskedField || (buyer?.budgetAed != null || roiAdvisory ? null : "budget");
    if (field) unsure.push(field);
    intents.push("unsure");
    if (field === "area") {
      facts.openToOtherAreas = true;
      facts.areaFlexibility = "open";
      signals.push("area_flexible");
    }
    ack =
      field === "budget"
        ? "No problem if the budget is still open."
        : field === "area"
          ? "No problem. I’ll keep the area flexible across Abu Dhabi."
          : field === "bedrooms"
            ? "No problem if the size is still open."
            : field === "cash"
              ? "No problem if the initial cash is still open."
              : "No problem if that detail is still open.";
  }

  const flexible = parseFlexiblePreferences(text, { buyer: { ...buyer, ...(facts.useType ? { useType: facts.useType } : {}) }, lastAskedField });
  Object.assign(facts, flexible.facts);
  unsure.push(...flexible.unsure.map(mapAskedField).filter(Boolean));
  if (flexible.unsure.length) {
    intents.push("unsure");
    if (facts.advisorLed) {
      intents.push("advisory");
      signals.push("advisor_led");
      ack = "That's fine — I'll do the filtering for you.";
    }
  }

  // around / about / roughly budget
  const aroundBudget = text.match(
    /\b(?:around|about|roughly|approx(?:imately)?|near(?:ly)?)\s*(?:AED|Dhs|Dh)?\s*(\d[\d,]*(?:\.\d+)?\s*[MmKk]?)\b/i
  );
  if (aroundBudget && !/\b(put\s+down|cash|down|initial|deposit)\b/i.test(text)) {
    const amount = parseMoney(aroundBudget[1]);
    if (amount !== null && amount >= 200_000) {
      facts.budget = amount;
      intents.push("provide_facts");
      ack = ack || `Got it, around AED ${amount.toLocaleString("en-US")}.`;
    }
  }

  // put down / deposit / can put about 300k
  const putDown = text.match(
    /\b(?:put\s+down|deposit|down\s*payment|initial)\b[\s\w]{0,24}?(?:about|around|roughly)?\s*(?:AED|Dhs|Dh)?\s*(\d[\d,]*(?:\.\d+)?\s*[MmKk]?)/i
  ) || text.match(
    /\b(?:about|around|roughly)\s*(?:AED|Dhs|Dh)?\s*(\d[\d,]*(?:\.\d+)?\s*[MmKk]?)\b(?=[\s\w,]{0,36}\b(?:put|down|cash|initial|deposit)\b)/i
  );
  if (putDown) {
    const amount = parseMoney(putDown[1]);
    if (amount !== null && amount > 0) {
      facts.cash = amount;
      intents.push("provide_facts");
      ack = ack || `Noted, about AED ${amount.toLocaleString("en-US")} for the initial payment.`;
    }
  }

  if (/\bopen to (other )?areas?\b/i.test(text) || /\bother areas? (work|fine|ok|okay)\b/i.test(text)) {
    facts.openToOtherAreas = true;
    signals.push("area_flexible");
    intents.push("provide_facts");
    ack = ack || "Happy to keep other Abu Dhabi areas in play.";
  }

  if (/\bmaybe\b.+\b(yas|saadiyat|hudayriyat|reem)\b/i.test(text) || /\b(yas|saadiyat|hudayriyat|reem)\b.+\b(maybe|open|flexible)\b/i.test(text)) {
    facts.openToOtherAreas = true;
    signals.push("area_flexible");
  }

  if (/\b(?:forget|ignore)\s+(?:about\s+)?(yas|hudayriyat|saadiyat|reem)\b/i.test(text)) {
    intents.push("correction");
    const nextArea = text.match(/\b(?:what about|how about|switch to|try)\s+(yas|hudayriyat|saadiyat|reem)(?:\s+island)?\b/i);
    if (nextArea) {
      const key = nextArea[1].toLowerCase();
      const map = {
        yas: "Yas Island",
        hudayriyat: "Hudayriyat Island",
        saadiyat: "Saadiyat Island",
        reem: "Al Reem Island"
      };
      facts.area = map[key];
      ack = ack || `Switching over to ${facts.area}.`;
    }
  }

  const multiBeds = text.match(/\b(\d+)\s*(?:or|\/)\s*(\d+)\s*(?:br|bed)/i);
  if (multiBeds) {
    facts.bedrooms = [Number(multiBeds[1]), Number(multiBeds[2])].sort((a, b) => a - b);
    intents.push("provide_facts");
    ack = ack || `Looking at ${facts.bedrooms.join(" or ")} bedroom options.`;
  }

  if (facts.investmentGoal || facts.investmentStrategy || facts.investmentObjective || facts.objections?.length || facts.budgetFlexible !== undefined || facts.explorationState === true) intents.push("advisory");
  if (facts.removedAreas?.length) intents.push("correction");
  if (facts.openToOtherAreas === true) signals.push("area_flexible");

  return normalizeUnderstanding({ facts, unsure, intents, signals, ack }, "local");
}

/**
 * Merge regex extract + local/Claude understanding into one fact/intent pack.
 * Understanding wins when it supplies a field. Unsure clears that field from facts.
 */
export function mergeUnderstanding(baseExtract, understanding) {
  const base = baseExtract || { facts: {}, signals: [], intents: [] };
  const u = normalizeUnderstanding(understanding || {}, understanding?.source || "none");

  let facts = { ...base.facts };
  const rawFacts = u.facts || {};

  if (rawFacts.budget != null) facts.budget = rawFacts.budget;
  if (rawFacts.cash != null) facts.cash = rawFacts.cash;
  if (rawFacts.area) facts.area = normalizeArea(rawFacts.area);
  if (Array.isArray(rawFacts.areas) && rawFacts.areas.length) {
    facts.areas = rawFacts.areas.map(normalizeArea).filter(Boolean);
    if (!facts.area) facts.area = facts.areas[0];
  }
  if (rawFacts.bedrooms !== null && rawFacts.bedrooms !== undefined) {
    if (Array.isArray(rawFacts.bedrooms)) {
      facts.bedrooms = rawFacts.bedrooms.map(normalizeBedrooms).filter((n) => n !== null);
    } else {
      facts.bedrooms = normalizeBedrooms(rawFacts.bedrooms);
    }
  }
  if (rawFacts.propertyType) facts.propertyType = normalizePropertyType(rawFacts.propertyType);
  if (rawFacts.developer) facts.developer = normalizeDeveloper(rawFacts.developer);
  if (rawFacts.project) facts.project = rawFacts.project;
  if (rawFacts.financing && FINANCING_VALUES.includes(rawFacts.financing)) {
    facts.financing = rawFacts.financing;
  }
  if (rawFacts.useType && USE_TYPES.includes(rawFacts.useType)) facts.useType = rawFacts.useType;
  if (rawFacts.contactDeclined === true) facts.contactDeclined = true;
  if (rawFacts.openToOtherAreas === true) {
    facts.openToOtherAreas = true;
  }
  if (rawFacts.openToOtherAreas === false) facts.openToOtherAreas = false;
  for (const field of ADVISORY_FACT_FIELDS) if (rawFacts[field] !== undefined) facts[field] = rawFacts[field];
  if (facts.removedAreas?.includes(facts.area)) delete facts.area;

  for (const field of u.unsure || []) {
    if (field === "budget") delete facts.budget;
    if (field === "cash") delete facts.cash;
    if (field === "area") {
      delete facts.area;
      delete facts.areas;
    }
    if (field === "bedrooms") delete facts.bedrooms;
    if (field === "financing") delete facts.financing;
    if (field === "propertyType") delete facts.propertyType;
    if (field === "investmentObjective") {
      for (const key of ["investmentObjective", "investmentGoal", "growthPriority"]) delete facts[key];
    }
    if (field === "exitHorizon") {
      for (const key of ["exitHorizon", "holdingPeriod", "handoverStrategy"]) delete facts[key];
    }
    if (["riskTolerance", "cashDeploymentPreference", "liquidityPriority", "incomeRequirement"].includes(field)) delete facts[field];
  }

  const intents = [...new Set([...(base.intents || []), ...(u.intents || [])])];
  const signals = [...new Set([...(base.signals || []), ...(u.signals || [])])];
  if (rawFacts.openToOtherAreas || signals.includes("area_flexible")) {
    signals.push("area_flexible");
    facts.intentSignals = [...new Set([...(facts.intentSignals || []), "area_flexible"])];
  }
  if (signals.length) facts.intentSignals = [...new Set([...(facts.intentSignals || []), ...signals])];

  return {
    facts,
    signals,
    intents,
    unsure: [...new Set([...(base.unsure || []), ...(u.unsure || [])].map(mapAskedField).filter(Boolean))],
    ack: u.ack || null,
    source: u.source || "none"
  };
}

export function normalizeUnderstanding(raw, source = "none") {
  const input = raw && typeof raw === "object" ? raw : {};
  const factsIn = input.facts && typeof input.facts === "object" ? input.facts : input;
  const facts = {};

  if (factsIn.budget != null) {
    const n = typeof factsIn.budget === "number" ? factsIn.budget : parseMoney(factsIn.budget);
    if (n !== null) facts.budget = n;
  }
  if (factsIn.cash != null) {
    const n = typeof factsIn.cash === "number" ? factsIn.cash : parseMoney(factsIn.cash);
    if (n !== null) facts.cash = n;
  }
  if (factsIn.area) facts.area = normalizeArea(factsIn.area);
  if (Array.isArray(factsIn.areas)) {
    facts.areas = factsIn.areas.map(normalizeArea).filter(Boolean);
  }
  if (factsIn.bedrooms !== null && factsIn.bedrooms !== undefined) {
    if (Array.isArray(factsIn.bedrooms)) {
      const beds = factsIn.bedrooms.map(normalizeBedrooms).filter((n) => n !== null);
      if (beds.length) facts.bedrooms = beds.length === 1 ? beds[0] : beds;
    } else {
      const beds = normalizeBedrooms(factsIn.bedrooms);
      if (beds !== null) facts.bedrooms = beds;
    }
  }
  if (factsIn.propertyType) facts.propertyType = normalizePropertyType(factsIn.propertyType);
  if (factsIn.developer) facts.developer = normalizeDeveloper(factsIn.developer);
  if (factsIn.project) facts.project = String(factsIn.project).trim();
  if (factsIn.financing && FINANCING_VALUES.includes(factsIn.financing)) {
    facts.financing = factsIn.financing;
  }
  if (factsIn.useType && USE_TYPES.includes(factsIn.useType)) facts.useType = factsIn.useType;
  if (factsIn.contactDeclined === true) facts.contactDeclined = true;
  if (typeof factsIn.openToOtherAreas === "boolean") facts.openToOtherAreas = factsIn.openToOtherAreas;
  Object.assign(facts, normalizeAdvisoryFacts(factsIn, { allowBudgetControls: source !== "claude" }));
  if (source === "claude") {
    for (const field of ["removedAreas", "bedroomsRequired", "initialCashHardCap", "financingRequired"]) delete facts[field];
  }

  const unsure = Array.isArray(input.unsure)
    ? input.unsure.map(mapAskedField).filter(Boolean)
    : [];
  const intents = Array.isArray(input.intents) ? input.intents.map(String) : [];
  const signals = Array.isArray(input.signals) ? input.signals.map(String) : [];
  const ack =
    typeof input.ack === "string" && input.ack.trim() && !looksCommercial(input.ack)
      ? input.ack.trim()
      : null;

  return { facts, unsure, intents, signals, ack, source };
}

function mapAskedField(field) {
  const canonical = canonicalQuestionField(field);
  return ({ budgetAed: "budget", cashAvailableAed: "cash", preferredAreas: "area", propertyTypes: "propertyType" })[canonical] || canonical;
}

function looksCommercial(text) {
  return /\b(AED|from AED|handover|payment plan|sqft|sold out|available units)\b/i.test(text);
}

function parseJsonObject(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}
