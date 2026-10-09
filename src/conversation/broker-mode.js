import { buildFactPack, buildProjectKnowledgePack } from "../facts/retrieval.js";
import { extractCommercialClaims, validateMessage } from "../facts/checker.js";
import { areaGuideClaims, areaGuideForModel, areasInText, findAreaEntry } from "../facts/area-guide.js";
import { advisorBudgetPolicy } from "./advisor-opportunities.js";
import { inferQuestionField, knownField, questionRequests, sanitizeBuyerLanguage, validateBuyerResponse } from "./response-validation.js";
import { isFlexiblePreference } from "./preference-state.js";
import { formatStages, packPaymentStages, stagePercentsFor } from "../facts/payment-stages.js";
import { recordModelException, recordModelHttpError, recordModelOutcome } from "./model-runtime.js";
import { extractFirstJsonObject } from "./llm.js";

// Broker mode: Claude answers the buyer directly from a compact, relevant slice
// of the catalogue, the area guide and the buyer's memory. The application
// still owns every fact and permission: each figure, date, percentage and
// project name is checked against the listings in that slice, contact and
// booking actions stay with the deterministic flows, and anything that fails
// is repaired sentence by sentence or replaced by the deterministic reply.

const DEFAULT_MODEL = "claude-sonnet-5";
const MAX_UNITS = 10;
const MAX_KNOWLEDGE = 6;

// Questions the broker may ask. Contact capture (phone, call) is never here:
// it belongs to the contact flow, which is never composed in broker mode.
export const BROKER_QUESTION_FIELDS = ["advisoryNextAction", "compare", "payment_details", "availability", "focus", "viewing",
  "areaInterest", "explorationTopic", "budgetAed", "cashAvailableAed", "preferredAreas", "propertyTypes", "bedrooms", "useType",
  "investmentObjective", "exitHorizon", "incomeRequirement", "financing", "moveInTimeline", "purchaseTimeline", "priorities"];
const OFFER_ACTIONS = new Set(["payment_details", "availability", "compare"]);

// Stages owned by deterministic flows: permissions, contact, stops and handoffs.
const DETERMINISTIC_STAGES = new Set(["paused", "paused_advice", "permissions_updated", "call_offer", "call_requested",
  "follow_up_channel", "follow_up_requested", "follow_up_phone", "handoff_declined", "suggestion_declined", "catalog_unavailable",
  "transaction_next_step", "trust_check", "objection_unresolved", "acknowledged", "welcome_back", "conversation_repair", "identity"]);

export function brokerEligible({ draft, contact, buyer, intents = [], scope = null, catalogError = null }) {
  if (contact || !draft || buyer.salesPathStopped || scope || catalogError) return false;
  if (intents.some(intent => ["start_fresh", "stop", "decline_call", "no_calls", "request_call", "agent", "reserve", "viewing"].includes(intent))) return false;
  if (draft.callRequest || draft.handoffReason || draft.submitted) return false;
  if (["phone", "handoffOffer", "contact_channel", "session_choice"].includes(draft.nextQuestion?.field)) return false;
  // Pending choice buttons (session, bedroom, project) belong to their own flows.
  if (draft.pendingOffer && draft.pendingOffer.type !== "advisory_next_action") return false;
  return !DETERMINISTIC_STAGES.has(draft.stage);
}

function confirmed(pack, key) {
  const fact = pack?.[key];
  return fact?.confirmed && fact.value !== null && fact.value !== undefined && fact.value !== "" ? fact.value : undefined;
}

function cleanPlan(value) {
  return value === undefined ? undefined : String(value).replace(/\s*\([^)]*\)/g, "").replace(/\s+/g, " ").trim().replace(/[.;,]$/, "");
}

function compact(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined && value !== null && value !== ""));
}

function unitPack(project, unit) {
  return buildFactPack({ project, unit, downPaymentAed: unit.initialPaymentAed ?? project.initialPaymentAed, bedroomLabel: String(unit.bedrooms) });
}

/** What Claude sees for one listing: confirmed fields only, written as the buyer would read them. */
function modelListing(pack, ceiling) {
  const price = confirmed(pack, "startingPriceAed");
  const from = confirmed(pack, "sizeSqftFrom");
  const to = confirmed(pack, "sizeSqftTo");
  const bedrooms = confirmed(pack, "bedrooms");
  return compact({
    projectId: pack.projectId,
    unitId: pack.unitId || undefined,
    name: confirmed(pack, "name"),
    developer: confirmed(pack, "developer"),
    area: confirmed(pack, "area"),
    status: confirmed(pack, "status"),
    unit: pack.unitId ? (bedrooms === 0 ? "studio" : `${bedrooms ?? ""} bedroom ${confirmed(pack, "propertyType") || ""}`.replace(/\s+/g, " ").trim()) : undefined,
    startingPrice: confirmed(pack, "startingPriceText"),
    size: from && to ? `${from} to ${to} sqft` : from ? `from ${from} sqft` : undefined,
    initialPayment: confirmed(pack, "downPaymentText"),
    paymentPlan: cleanPlan(confirmed(pack, "paymentPlanSummary")),
    paymentStages: formatStages(packPaymentStages(pack), confirmed(pack, "startingPriceText")) || undefined,
    handover: confirmed(pack, "handover"),
    availability: confirmed(pack, "availability"),
    features: confirmed(pack, "features"),
    description: confirmed(pack, "description"),
    quote: pack.unitId ? (price === undefined ? "price not confirmed: do not quote one" : undefined) : "no released price: describe the project, do not quote",
    withinBudget: ceiling && price !== undefined ? price <= ceiling : undefined
  });
}

/**
 * The relevant slice of the catalogue for this turn. Named projects, the active
 * recommendation, the engine's matches and in-budget units in the buyer's areas
 * come first; at most MAX_UNITS priced listings and MAX_KNOWLEDGE project-only entries.
 */
export function buildBrokerContext({ catalog, buyer, message, advisor = {}, draft = {}, recentTurns = [], areaGuide = [], now = Date.now() }) {
  const lower = String(message || "").toLowerCase();
  const recentText = recentTurns.slice(-6).map(turn => turn.text || "").join(" ").toLowerCase();
  const ceiling = advisorBudgetPolicy(buyer).ceilingAed;
  const projects = (catalog.projects || []).filter(p => p.active !== false && p.source && p.developerActive !== false && p.name);
  const byId = new Map(projects.map(p => [p.id, p]));
  const mentionedAreas = new Set([...(buyer.preferredAreas || []), ...areasInText(areaGuide, message).map(entry => entry.area)]);
  const named = new Set(projects.filter(p => lower.includes(p.name.toLowerCase())).map(p => p.id));
  const recent = new Set(projects.filter(p => recentText.includes(p.name.toLowerCase())).map(p => p.id));
  const interest = buyer.projectInterest ? projects.find(p => p.name.toLowerCase() === String(buyer.projectInterest).toLowerCase())?.id : null;
  const matched = new Map((advisor.matches || []).map((m, index) => [m.unit?.id, index]));
  const types = new Set((buyer.propertyTypes || []).map(t => String(t).toLowerCase()));
  const beds = new Set(buyer.bedrooms || []);
  const rejected = new Set(buyer.rejectedProjects || []);
  const family = (buyer.priorities || []).includes("family_space");

  const scored = [];
  for (const unit of catalog.units || []) {
    const project = byId.get(unit.projectId);
    if (!project || unit.active === false) continue;
    const pack = unitPack(project, unit);
    const price = confirmed(pack, "startingPriceAed");
    let score = 0;
    if (named.has(project.id)) score += 100;
    if (unit.id === buyer.activeRecommendationUnitId) score += 80;
    if (unit.id === advisor.primary?.unitId) score += 70;
    if (matched.has(unit.id)) score += 50 - Math.min(matched.get(unit.id), 10);
    if (project.id === interest) score += 45;
    if (recent.has(project.id)) score += 30;
    if (mentionedAreas.has(project.area)) score += 20;
    if (ceiling && price !== undefined) score += price <= ceiling ? 15 + Math.round(10 * price / ceiling) : -40;
    if (types.size && types.has(String(unit.propertyType || "").toLowerCase())) score += 10;
    if (beds.size && beds.has(unit.bedrooms)) score += 10;
    if (rejected.has(project.id) && !named.has(project.id)) score -= 60;
    if (family) score += unit.bedrooms >= 2 ? 15 + (/villa|townhouse/i.test(unit.propertyType || "") ? 10 : 0) : -30;
    if (price === undefined && !named.has(project.id)) score -= 10;
    scored.push({ pack, score, price });
  }
  scored.sort((a, b) => b.score - a.score);
  const unitPacks = scored.filter(row => row.score > -30).slice(0, MAX_UNITS).map(row => row.pack);
  const withUnits = new Set(unitPacks.map(pack => pack.projectId));
  const knowledge = projects.filter(p => !withUnits.has(p.id) && (named.has(p.id) || recent.has(p.id) || p.id === interest || mentionedAreas.has(p.area)))
    .sort((a, b) => Number(named.has(b.id)) - Number(named.has(a.id)) || Number(recent.has(b.id)) - Number(recent.has(a.id)))
    .slice(0, MAX_KNOWLEDGE).map(buildProjectKnowledgePack);
  const packs = [...unitPacks, ...knowledge];

  // What may be recommended: in budget, not rejected, and matching any property
  // type or minimum bedroom count the buyer actually set.
  const typeRequired = types.size && !isFlexiblePreference(buyer, "propertyTypes");
  const minBeds = beds.size && !isFlexiblePreference(buyer, "bedrooms") ? Math.min(...beds) : null;
  const permitted = packs.filter(pack => {
    if (rejected.has(pack.projectId)) return false;
    if (!pack.unitId) return true;
    const price = confirmed(pack, "startingPriceAed");
    if (ceiling && price !== undefined && price > ceiling) return false;
    if (typeRequired && !types.has(String(confirmed(pack, "propertyType") || "").toLowerCase())) return false;
    if (minBeds !== null && typeof confirmed(pack, "bedrooms") === "number" && confirmed(pack, "bedrooms") < minBeds) return false;
    if (family && typeof confirmed(pack, "bedrooms") === "number" && confirmed(pack, "bedrooms") < 2) return false;
    return true;
  }).map(pack => ({ projectId: pack.projectId, unitId: pack.unitId }));
  // Price and initial-payment differences between listings shown together are
  // application arithmetic on confirmed figures, so the broker may quote them.
  const derivedAmounts = new Set();
  const stageAmounts = {};
  for (const pack of unitPacks) {
    const stages = packPaymentStages(pack);
    if (stages.length) stageAmounts[`${pack.projectId}|${pack.unitId || ""}`] = stages.map(stage => stage.amountAed);
  }
  const bookingOf = pack => confirmed(pack, "downPaymentAed") ?? packPaymentStages(pack).find(stage => stage.key === "booking")?.amountAed;
  for (const a of unitPacks) for (const b of unitPacks) {
    if (a === b) continue;
    for (const key of ["startingPriceAed", "downPaymentAed"]) {
      const x = confirmed(a, key), y = confirmed(b, key);
      if (typeof x === "number" && typeof y === "number" && x > y) derivedAmounts.add(x - y);
    }
    // Totals for a two-unit spread: combined starting prices and booking amounts.
    const x = confirmed(a, "startingPriceAed"), y = confirmed(b, "startingPriceAed");
    if (typeof x === "number" && typeof y === "number") derivedAmounts.add(x + y);
    const bx = bookingOf(a), by = bookingOf(b);
    if (typeof bx === "number" && typeof by === "number") derivedAmounts.add(bx + by);
  }
  const areas = [...new Set([...mentionedAreas, ...packs.map(pack => confirmed(pack, "area")).filter(Boolean)])]
    .map(area => findAreaEntry(areaGuide, area)).filter(Boolean).slice(0, 6);
  const enginePicks = [advisor.primary, advisor.challenger].filter(Boolean)
    .map(pick => ({ projectId: pick.projectId, unitId: pick.unitId, role: pick === advisor.primary ? "primary" : "alternative" }))
    .filter(pick => packs.some(pack => pack.projectId === pick.projectId && pack.unitId === pick.unitId));
  // Nothing property-specific is in play: "that property" would be invented context.
  const noPropertyContext = ["education", "investment_education", "conversation_repair", "exploring"].includes(draft.stage) ||
    (!named.size && !recent.size && !interest && !buyer.activeRecommendationProjectId && !enginePicks.length);
  // A direct fact question must be answered: the figures in the engine's own
  // answer have to appear in the broker's reply.
  const requiredClaims = draft.stage === "fact_answer" && draft.text
    ? extractCommercialClaims(draft.text.replace(/\([^)]*\)/g, " ")).filter(claim => ["amount", "date", "percent", "split"].includes(claim.type) && !(claim.type === "date" && /^20\d\d$/.test(claim.value)))
      .map(claim => ({ type: claim.type, value: claim.value }))
    : [];
  // The subject when a sentence says "it": named now, else just discussed, else the active pick.
  const contextScope = [...named].length === 1 ? [...named] : recent.size === 1 ? [...recent] : interest ? [interest]
    : buyer.activeRecommendationProjectId ? [buyer.activeRecommendationProjectId] : [];
  return {
    packs, permitted, ceiling, derivedAmounts: [...derivedAmounts], stageAmounts, stagePercents: stagePercentsFor(unitPacks), noPropertyContext, requiredClaims, contextScope,
    allowedClaims: areaGuideClaims(areas, { now }),
    listings: packs.map(pack => modelListing(pack, ceiling)),
    areaGuide: areaGuideForModel(areas),
    allAreas: areaGuide.filter(entry => entry.tagline).map(entry => `${entry.area}: ${entry.tagline}`),
    enginePicks,
    engineDraft: draft.text || null,
    suggestedQuestion: draft.nextQuestion?.prompt || null
  };
}

const BUYER_FIELDS = ["language", "useType", "budgetAed", "cashAvailableAed", "preferredAreas", "openToOtherAreas", "bedrooms", "propertyTypes",
  "financing", "investmentObjective", "exitHorizon", "incomeRequirement", "moveInTimeline", "purchaseTimeline", "priorities", "concerns",
  "projectInterest", "shownProjects", "rejectedProjects", "activeRecommendationProjectId", "activeRecommendationUnitId", "noCalls",
  "contactDeclined", "preferredContactChannel", "familySize", "householdNotes"];

const SYSTEM = `You are the senior property advisor behind an Instagram DM account for Abu Dhabi property. You are the best broker in Abu Dhabi: warm, sharp, confident and concise, and you know every area's lifestyle and selling points. You are an AI assistant; never claim to be a person or a licensed agent, or to have visited a property.

ANSWER FIRST
- The first sentence answers exactly what the buyer just asked or asked for, with substance. Never reply with only a qualifying question.
- Then add the one or two points that matter most for their goal. Usually 2 to 5 short sentences; a compact list only for prices or payment stages. No filler ("No rush", "Got it", "That's everything I have").
- Use the conversation and buyer profile. "It", "that one", "the second one", "the top two" refer to what was just discussed or shown; never ask "which project?" when one is in the conversation. Never ask for anything in knownFields.
- Reply in replyLanguage. If the buyer writes Arabic, reply in Arabic (keep project names and AED figures as written).

SELL LIKE AN EXPERT
- Sell the location: say what the area is known for and who it suits (areaGuide), naming landmarks where useful.
- Recommend by fit, with conviction: choose listings where withinBudget is not false that match what the buyer told you. Family with children: 2+ bedrooms, villas or townhouses when listed, never a studio. Rental income from day one: ready property. Growth or selling at handover: off-plan, explain the payment plan and cash needed before handover. A large budget: propose a larger home or a spread of two or three listings, with the combined total. enginePicks are the system's ranking; follow them unless they contradict what the buyer said, then pick better.
- Give reasons tied to the buyer's stated goal (never invent a goal). "It is under your budget" is never the main reason.
- Price objection: first separate total price from cash needed now, then step down within the same project or area (smaller unit) before switching area.
- Payment questions: give the paymentStages amounts exactly as listed (they are worked out by the system on the starting price) plus the handover date; mention that exact instalment dates come from the developer.
- Comparisons: answer the angle asked (investment vs lifestyle), side by side on price, booking amount, payment plan and handover. Never "neither is better".
- When something is not available (no listing in an area, no released price, no rent data), say so in one sentence, offer that the team can source it, and suggest the closest listing with a reason.
- After a "yes": deliver the step you offered, then move one step forward (payment stages, then availability, then floor plans or speaking with the team).

FACT RULES (checked automatically; a sentence that breaks one is removed)
- Every price, amount, percentage, payment split, date, handover, size, bedroom count and availability you state must appear in listings exactly as written (copy "AED 2,000,000" as written), or be the buyer's own budget, a difference between two listing prices, or the combined price of listings you propose together.
- Never calculate other amounts yourself. Never state rent, yield, ROI, appreciation, resale prices, fees, service charges, distances, travel times, launch dates or amenities that are not in listings or areaGuide.
- Listings marked "do not quote" have no released price: describe them and say pricing is not released yet.
- Never name a project that is not in listings.
- No guarantees about returns, growth or resale; explain what drives value (area stage, developer, payment plan, handover timing) qualitatively.
- Never say a booking, reservation, EOI, viewing, call or message to the team has been arranged, sent or confirmed. Do not ask for phone numbers or offer calls; if the buyer wants a person, say you can connect them with the team.
- Never use internal words: fact pack, listing data, engine, catalogue, database, verified stock, evidence gap, enginePicks.

OUTPUT: one JSON object only, no markdown:
{"message": "the DM text", "recommended": [{"projectId": "...", "unitId": "..."}], "questionField": "advisoryNextAction|compare|payment_details|availability|budgetAed|preferredAreas|propertyTypes|bedrooms|useType|investmentObjective|exitHorizon|cashAvailableAed|moveInTimeline|areaInterest|null", "offer": "payment_details|availability|compare|null"}
recommended: the listings you recommend in this message (empty if none). offer: the next step your closing question offers, so a "yes" can be acted on.`;

function knownFields(buyer) {
  return ["budgetAed", "cashAvailableAed", "preferredAreas", "bedrooms", "propertyTypes", "financing", "useType", "investmentObjective", "exitHorizon"]
    .filter(field => knownField(buyer, field) || isFlexiblePreference(buyer, field));
}

export function brokerPayload({ buyer, message, recentTurns, context, permissions, ownerLine, alreadyAsked = [] }) {
  return {
    alreadyAsked,
    buyerMessage: message,
    conversation: recentTurns.slice(-10).map(turn => ({ role: turn.role, text: String(turn.text || "").slice(0, 700) })),
    buyer: Object.fromEntries(BUYER_FIELDS.filter(key => buyer[key] !== undefined && buyer[key] !== null && !(Array.isArray(buyer[key]) && !buyer[key].length)).map(key => [key, buyer[key]])),
    knownFields: knownFields(buyer),
    budgetCeilingAed: context.ceiling,
    listings: context.listings,
    enginePicks: context.enginePicks,
    areaGuide: context.areaGuide,
    allAreas: context.allAreas,
    permissions,
    ownerApprovedLine: ownerLine || null,
    fallbackDraft: context.engineDraft,
    suggestedQuestion: context.suggestedQuestion,
    replyLanguage: buyer.language === "ar" ? "Arabic" : "English"
  };
}

/** Checks a broker reply against the listings in context, permissions and question rules. */
// A question is a sentence ending in "?" (or a direct request for a detail).
export function brokerQuestions(text) {
  return String(text).split(/\n+|(?<=[.!?؟])\s+/).map(s => s.trim()).filter(Boolean)
    .filter(sentence => /[?؟]\s*$/.test(sentence) || /^(?:please\s+)?(?:tell me|share|send me|let me know)\b/i.test(sentence));
}

const NEXT_STEP = /availab|payment|plan|schedule|break ?down|stages|compare|side by side|floor ?plans?|details|walk you through|show you|shortlist|options/i;
export function brokerQuestionField(question) {
  if (/\b(?:connect|put you in touch|our team|the team)\b/i.test(question)) return "handoffOffer";
  if (NEXT_STEP.test(question)) return "advisoryNextAction";
  return inferQuestionField(question);
}

export function canOfferHandoff(buyer) {
  return !buyer.salesPathStopped && !buyer.contactDeclined && !buyer.declinedSuggestions?.includes("handoff");
}

export function validateBrokerReply(text, context, { buyer, buyerMessage = "", forbiddenActions = [], permittedContacts = null, configuredAmounts = [], configuredPercents = [] }) {
  const questions = brokerQuestions(text);
  const inferred = questions.length ? brokerQuestionField(questions.at(-1)) : null;
  const handoffOk = canOfferHandoff(buyer);
  const allowedFields = handoffOk ? [...BROKER_QUESTION_FIELDS, "handoffOffer"] : BROKER_QUESTION_FIELDS;
  const metadata = { askedQuestion: questions.length > 0, questionField: questions.length ? (allowedFields.includes(inferred) ? inferred : "advisoryNextAction") : null, claims: [], proposedActions: [] };
  const allowedBuyerAmounts = [buyer.budgetAed, buyer.cashAvailableAed].filter(value => value != null);
  const response = validateBuyerResponse(text, { buyer, packs: context.packs, metadata, allowedActions: allowedFields, forbiddenActions,
    questionList: questions, questionFieldOf: brokerQuestionField, skipDescriptionCheck: true, predicateMode: "amenities", contextScope: context.contextScope,
    offerFields: ["advisoryNextAction", "handoffOffer", "compare", "payment_details", "availability"],
    opportunities: [], strategy: null, permittedRecommendations: context.permitted, allowedClaims: context.allowedClaims, requiredQuestion: null,
    buyerMessage, permittedContacts, configuredAmounts, configuredPercents, allowedBuyerAmounts, derivedAmounts: context.derivedAmounts, stageAmounts: context.stageAmounts, stagePercents: context.stagePercents,
    noPropertyContext: context.noPropertyContext, implicitPropertyContext: !context.noPropertyContext });
  const facts = validateMessage(text, context.packs, { allowedBuyerAmounts, allowedClaims: context.allowedClaims, buyer, opportunities: [],
    configuredAmounts, configuredPercents, derivedAmounts: context.derivedAmounts, stageAmounts: context.stageAmounts, stagePercents: context.stagePercents,
    contextScope: context.contextScope });
  const violations = [...response.violations, ...facts.violations.filter(v => !response.violations.some(r => r.type === v.type && r.index === v.index))];
  // Phone numbers, calls and channels belong to the contact flow; an offer to
  // connect is allowed only when the buyer has not declined contact.
  if (questions.some(q => /\b(?:call you|give you a call|whatsapp|your (?:number|phone|mobile)|phone number)\b/i.test(q)) ||
      (!handoffOk && questions.some(q => brokerQuestionField(q) === "handoffOffer"))) violations.push({ type: "broker_contact_question" });
  return { ok: violations.length === 0, violations, metadata };
}

// Never repaired: the whole reply is dropped.
const UNREPAIRABLE = new Set(["no_calls", "unauthorized_call", "action_completion_claim", "invented_contact_permission", "invented_budget_flexibility",
  "sales_path_stopped", "unnecessary_contact_capture", "internal_language", "unresolved_template", "empty_message"]);

function sentencesOf(text) {
  return String(text).split(/\n+/).map(line => line.split(/(?<=[.!?؟])\s+(?=\S)/).map(s => s.trim()).filter(Boolean)).filter(line => line.length);
}

function join(lines) {
  return lines.filter(line => line.length).map(line => line.join(" ")).join("\n");
}

/** Drop the sentences that break a rule, keeping a valid closing question. */
export function repairBrokerReply(text, check) {
  let lines = sentencesOf(text);
  const originalSize = join(lines).length;
  let result = check(join(lines));
  if (result.ok) return { text: join(lines), result, removed: 0 };
  if (result.violations.some(v => UNREPAIRABLE.has(v.type))) return null;
  // More than one question: keep only the last one.
  const isQuestion = s => brokerQuestions(s).length > 0;
  const questionCount = lines.flat().filter(isQuestion).length;
  if (questionCount > 1) {
    let seen = 0;
    lines = lines.map(line => line.filter(s => !isQuestion(s) || ++seen === questionCount));
    result = check(join(lines));
  }
  // Best-first: each step removes the one sentence whose removal leaves the
  // fewest violations, preferring to keep as much of the reply as possible.
  let removed = 0;
  while (!result.ok && removed < 6) {
    let best = null;
    for (let li = 0; li < lines.length; li++) {
      for (let si = 0; si < lines[li].length; si++) {
        const without = lines.map((line, index) => index === li ? line.filter((_, k) => k !== si) : line);
        const candidate = check(join(without));
        const size = join(without).length;
        if (!best || candidate.violations.length < best.result.violations.length ||
            (candidate.violations.length === best.result.violations.length && size > best.size)) best = { lines: without, result: candidate, size };
      }
    }
    if (!best || best.result.violations.length >= result.violations.length) break;
    lines = best.lines; result = best.result; removed++;
  }
  const repaired = join(lines);
  if (!result.ok || repaired.length < originalSize * 0.45 || !repaired.trim()) return null;
  return { text: repaired, result, removed };
}

/**
 * Ask Claude for the broker reply and check it. Returns null when the model is
 * unavailable or nothing valid survives, so the caller keeps its own reply.
 */
export async function composeBrokerReply(client, { buyer, message, recentTurns = [], context, permissions = {}, ownerLine = null, validation = {}, alreadyAsked = [] }) {
  if (!client?.apiKey) return null;
  if (typeof client.onBroker === "function") client.onBroker({ buyer, message, recentTurns, context, permissions, ownerLine, validation });
  const payload = brokerPayload({ buyer, message, recentTurns, context, permissions, ownerLine, alreadyAsked });
  let response;
  try {
    response = await (client.fetchImpl || fetch)(`${client.baseUrl}/v1/messages`, {
      method: "POST",
      signal: AbortSignal.timeout(Number(process.env.BROKER_TIMEOUT_MS || 25000)),
      headers: { "content-type": "application/json", "x-api-key": client.apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: client.model || DEFAULT_MODEL, max_tokens: 900, system: SYSTEM,
        messages: [{ role: "user", content: JSON.stringify(payload) }] })
    });
  } catch (error) {
    recordModelException(client, "composition", error);
    return null;
  }
  if (!response.ok) {
    await recordModelHttpError(client, "composition", response);
    return null;
  }
  let data;
  try { data = await response.json(); } catch (error) { recordModelException(client, "composition", error); return null; }
  const raw = (data.content || []).filter(block => block.type === "text").map(block => block.text).join("\n").trim();
  let output = null;
  const json = extractFirstJsonObject(raw);
  if (json) {
    try { output = JSON.parse(json); } catch { output = null; }
  }
  if (!output || typeof output.message !== "string" || !output.message.trim()) {
    recordModelOutcome(client, "composition", { category: "invalid_response_shape" });
    console.warn("[broker] reply discarded: not a JSON message");
    return null;
  }
  const check = text => validateBrokerReply(text, context, { buyer, buyerMessage: message, ...validation });
  const text = sanitizeBuyerLanguage(output.message).trim();
  const first = check(text);
  const repaired = first.ok ? { text, result: first, removed: 0 } : repairBrokerReply(text, check);
  const types = result => [...new Set(result.violations.map(v => v.type))].join(",");
  if (!repaired) {
    recordModelOutcome(client, "composition", { category: "validation_rejected" });
    console.warn(`[broker] reply rejected: ${types(first)}`);
    return null;
  }
  const stated = extractCommercialClaims(repaired.text);
  // Every material figure in the deterministic answer must survive composition.
  const required = context.requiredClaims || [];
  const answered = required.every(claim => stated.some(row => row.type === claim.type && row.value === claim.value));
  if (required.length && !answered) {
    recordModelOutcome(client, "composition", { category: "validation_rejected" });
    console.warn("[broker] reply rejected: missing_answer");
    return null;
  }
  if (repaired.removed || !first.ok) console.warn(`[broker] reply repaired: removed=${repaired.removed} was=${types(first)}`);
  recordModelOutcome(client, "composition");
  const permittedKey = new Set(context.permitted.map(row => `${row.projectId}|${row.unitId || ""}`));
  const recommended = (Array.isArray(output.recommended) ? output.recommended : [])
    .filter(row => row && permittedKey.has(`${row.projectId}|${row.unitId || ""}`))
    .filter(row => {
      const pack = context.packs.find(p => p.projectId === row.projectId && (p.unitId || null) === (row.unitId || null));
      return pack?.name?.value && repaired.text.includes(String(pack.name.value));
    });
  const questions = questionRequests(repaired.text);
  const field = questions.length ? repaired.result.metadata.questionField : null;
  // The exact closing question, with its "?", as the buyer saw it.
  const questionText = questions.length ? (repaired.text.split(/\n+|(?<=[.!?؟])\s+/).map(s => s.trim()).filter(s => /[?؟]$/.test(s)).at(-1) || `${questions.at(-1)}?`) : null;
  // An offer counts only when the closing question actually offers that step.
  const offerWords = { payment_details: /payment|plan|schedule|break ?down|stages|instal/i, availability: /availab|units? left|still open/i, compare: /compare|side by side|versus|vs\b/i };
  const offer = questionText && OFFER_ACTIONS.has(output.offer) && offerWords[output.offer].test(questionText) ? output.offer : null;
  const handoff = field === "handoffOffer" && canOfferHandoff(buyer);
  return { message: repaired.text, recommended, questionField: offer ? "advisoryNextAction" : field, questionText, offer, handoff, validation: repaired.result };
}

/** Turn an accepted broker reply into the draft fields the engine persists. */
export function applyBrokerReply(draft, reply) {
  const primary = reply.recommended.find(row => row.unitId) || null;
  const choices = reply.questionField && reply.questionField === draft.nextQuestion?.field ? draft.nextQuestion.choices || null : null;
  return {
    ...draft,
    text: reply.message,
    polished: true,
    broker: true,
    template: draft,
    stage: primary ? "matched" : draft.stage,
    knowledgeOnly: false, commercialQuote: null, researchClaims: [], projectRelations: null, comparisonFacts: null,
    factTopic: null, educationalSplit: null, investmentTheses: null,
    nextQuestion: reply.questionField ? { field: reply.questionField, prompt: reply.questionText, choices } : null,
    // "Want me to connect you with our team?": a "yes" goes to the contact flow.
    pendingOffer: reply.offer ? { type: "advisory_next_action", action: reply.offer } : reply.handoff ? { type: "handoff_offer", reason: "tailored" } : null,
    advisoryExposure: primary ? {
      projectIds: [...new Set(reply.recommended.map(row => row.projectId))],
      primaryProjectId: primary.projectId, primaryUnitId: primary.unitId, upgradeProjectId: null
    } : null,
    allowsServiceSuggestion: false,
    serviceTopic: null
  };
}
