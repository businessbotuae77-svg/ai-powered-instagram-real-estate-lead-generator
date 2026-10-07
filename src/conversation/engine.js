import { localizeDraft } from "./localize.js";
import { normalizeBuyerText, buyerLanguage } from "./text.js";
import { decideConversation } from "./decision.js";
import { conversationalScope } from "./question-scope.js";
import { contactDecision, wantsHuman } from "./contact.js";
import { missingDataHandoff, validateMessage } from "../facts/checker.js";
import { extractFactsFromMessage } from "./extract.js";
import { ConversationMemory } from "./memory.js";
import { canPitchBuyer, resolveMatches } from "./match-resolve.js";
import { summarizeBuyer, isCoreQualified } from "./qualify.js";
import { buildConversationReply, buildAdvisorReply, fallbackSafeText } from "./replies.js";
import { composeReplyWithModel } from "./llm.js";
import { buildAdvisorOpportunities, commercialEvidenceState, commercialEvidenceFingerprint } from "./advisor-opportunities.js";
import { advisoryReady, determineAdvisorStrategy } from "./advisor-strategy.js";
import { knownField, sanitizeBuyerLanguage, validateBuyerResponse } from "./response-validation.js";
import { buildFactPack } from "../facts/retrieval.js";
import { commercialOfferGate } from "../facts/commercial-offers.js";
import { thesisClaims } from "../facts/advisor-claims.js";
import { buildInvestmentStrategy, INVESTMENT_PROFILE_FIELDS } from "./investment-strategy.js";
import { conversationState } from "./conversation-state.js";
import { knowledgeAdvice } from "./knowledge-advice.js";
import { researchReply } from "./research-reply.js";
import { isAreaComparison } from "./area-answers.js";
import { areaGuideClaims, areaGuideForModel, areaGuideFromCatalog, findAreaEntry } from "../facts/area-guide.js";
import { isFlexiblePreference, PREFERENCE_FACT_FIELDS } from "./preference-state.js";
import { understandMessageWithModel, understandMessageLocally, mergeUnderstanding } from "./understand.js";
import { isAffirmation, resolveAffirmation } from "./affirmation.js";
import { retrieveFacts } from "../facts/retrieval.js";
import { brokerLabel, brokerProfile, directContactLine, permittedContactDetails } from "./broker-profile.js";
import { declinesOffer, handoffOffer, handoffTopic, transactionAnswer, transactionMoment } from "./sales-moments.js";
import { configuredServiceTerms, declinedServiceIds, loadServices, suggestService } from "./services.js";
import {
  buildCallRequestSummary,
  hasBuyingInterest,
  refineTurnIntent,
  wantsCallRequest
} from "./intent-policy.js";

function hasHighIntent(intents, signals = []) {
  return hasBuyingInterest(intents, signals);
}

function leadStatusFor(buyer, intents, signals, matchCount, callRequestSubmitted = false) {
  if (callRequestSubmitted && buyer.phone) return "call_requested";
  if (hasHighIntent(intents, signals)) return "engaged";
  if (matchCount > 0 && isCoreQualified(buyer)) return "qualified";
  if (canPitchBuyer(buyer)) return "engaged";
  if (buyer.budgetAed || buyer.preferredAreas?.length) return "engaged";
  return buyer.leadStatus || "new";
}

/**
 * Conversation engine.
 * Claude understands natural messages into structured updates.
 * Matching, memory, and commercial facts stay in code / Airtable.
 */
export class ConversationEngine {
  constructor({ buyers, properties, memory, llm = null, advisorOptions = {}, logger = null, broker = null, services = null } = {}) {
    if (!buyers || !properties) throw new Error("ConversationEngine requires buyers and properties");
    this.buyers = buyers;
    this.properties = properties;
    this.memory = memory || new ConversationMemory();
    this.llm = llm;
    this.advisorOptions = advisorOptions;
    // The human the bot hands off to, and the owner-approved complementary services.
    this.broker = broker || brokerProfile();
    this.services = services || loadServices();
    this.logger = logger || (process.env.NODE_ENV === "production" ? event => console.info("[advisor]", JSON.stringify(event)) : null);
    this.turnQueue = Promise.resolve();
  }

  handleMessage(instagramUserId, message, options = {}) {
    const task = () => this.processTurn(instagramUserId, message, options);
    const result = this.turnQueue.then(task, task);
    this.turnQueue = result.catch(() => {});
    return result;
  }

  async processTurn(instagramUserId, message, options = {}) {
    const text = normalizeBuyerText(message).trim();
    if (this.memory.ensureReady) await this.memory.ensureReady();
    let lastAskedField = this.memory.getLastAskedField(instagramUserId) || this.memory.getLastMeaningfulQuestion?.(instagramUserId);
    const existingBuyer = await this.buyers.getOrCreate(instagramUserId);
    let recentTurns = this.memory.recentContext(instagramUserId, 6);

    let base = extractFactsFromMessage(text, { buyer: existingBuyer, lastAskedField });
    const scope = conversationalScope(text);

    const localUnderstanding = understandMessageLocally(text, {
      buyer: existingBuyer,
      lastAskedField
    });
    let understanding = localUnderstanding;

    if (this.llm && options.useLlm !== false && !base.intents.includes("start_fresh") && !scope) {
      const claudeUnderstanding = await understandMessageWithModel(this.llm, {
        message: text,
        buyer: existingBuyer,
        lastAskedField,
        recentTurns
      });
      if (claudeUnderstanding) {
        understanding = mergeUnderstanding(localUnderstanding, claudeUnderstanding);
      }
    }

    const merged = mergeUnderstanding(base, understanding);
    let { facts, signals, intents, unsure, ack } = merged;
    // Understanding output is advisory input, never permission. Only the local
    // interpretation of the buyer's actual words can authorize or revoke an
    // action/channel, reset a search, or resume a stopped sales path.
    const deterministic = mergeUnderstanding(base, localUnderstanding);
    const protectedIntents = new Set(["reserve", "viewing", "request_call", "callback", "agent", "high_intent",
      "follow_up", "no_calls", "stop", "decline_call", "decline_reserve", "decline_contact", "call_submitted",
      "start_fresh", "continue", "decline_follow_up", "decline_viewing"]);
    intents = [...new Set([...intents.filter(i => !protectedIntents.has(i)), ...deterministic.intents.filter(i => protectedIntents.has(i))])];
    const protectedSignals = /(?:call|callback|agent|reserve|viewing|high_intent|buy_interest|contact_declined)/;
    signals = [...new Set([...signals.filter(s => !protectedSignals.test(s)), ...deterministic.signals.filter(s => protectedSignals.test(s))])];
    for (const field of ["noCalls", "salesPathStopped", "preferredContactChannel", "contactDeclined", "requestedAction", "phone",
      "investmentObjective", "useType", "budget", "cash", "budgetHardCap", "budgetFirm", "budgetFlexible", "budgetStretchAed", "budgetFlexibilityPct", "upgradeDeclined",
      ...INVESTMENT_PROFILE_FIELDS, ...PREFERENCE_FACT_FIELDS]) {
      delete facts[field];
      if (deterministic.facts[field] !== undefined) facts[field] = deterministic.facts[field];
    }
    // A model cannot undo explicit uncertainty or manufacture permission to
    // choose preferences. Flexible answers come from the buyer's actual words.
    unsure = [...new Set(deterministic.unsure || [])];
    if (deterministic.intents.includes("ask_facts") && deterministic.facts.project) {
      // A listing question cannot infer new requirements from words in its
      // name. Preserve only preferences explicitly supplied outside that name.
      for (const field of ["area", "areas", "bedrooms", "propertyType", "openToOtherAreas", "areaFlexibility"]) {
        delete facts[field];
        if (deterministic.facts[field] !== undefined) facts[field] = deterministic.facts[field];
      }
    }
    // A contextual exit answer is a strategy preference, not a project's handover-date question.
    if (deterministic.facts.exitHorizon && ["exitHorizon", "handoverStrategy"].includes(lastAskedField)) {
      intents = [...new Set([...intents.filter(i => i !== "ask_facts"), "advisory"])];
    }
    facts.language = buyerLanguage(message) === "ar" ? "ar" : existingBuyer.language || "en";
    if (isAreaComparison(text)) {
      delete facts.area;
      delete facts.areas;
    }
    const directCashReply =
      (lastAskedField === "cashAvailableAed" || lastAskedField === "cash") &&
      /^\s*(?:AED|Dhs|Dh)?\s*\d[\d,]*(?:\.\d+)?\s*[MmKk]?\s*$/i.test(text);
    if (
      directCashReply &&
      localUnderstanding.facts?.cash !== null &&
      localUnderstanding.facts?.cash !== undefined
    ) {
      delete facts.budget;
      facts.cash = localUnderstanding.facts.cash;
    }
    // Budget phrasing like "I have about 3 million" must not invent matching cash.
    const cashMarker =
      /\b(cash|down\s*payment|deposit|initial(?:\s+payment)?|available now|ready now|put\s+down|have\s+now)\b/i.test(
        text
      );
    if (
      facts.cash != null &&
      facts.budget != null &&
      Number(facts.cash) === Number(facts.budget) &&
      !cashMarker &&
      base.facts?.cash === undefined
    ) {
      delete facts.cash;
    }
    // "500k cash available" is initial cash, not a full-cash purchase.
    if (
      facts.financing === "cash" &&
      /\b(cash\s+available|available\s+(?:now\s+)?cash|\d[\d,]*.{0,20}cash|cash.{0,20}\d|initial|down|deposit)\b/i.test(
        text
      ) &&
      !/\b(all\s+cash|cash\s+buyer|full\s+cash|pay(?:ing)?\s+(in\s+)?cash|100%\s+cash)\b/i.test(text)
    ) {
      delete facts.financing;
    }
    // Keep explicit "no cash yet" even if Claude marks cash as unsure.
    if (/\b(no cash|don'?t have (any )?cash|do not have (any )?cash|without cash|zero cash|no money (now|yet)|not ready with cash|no cash yet)\b/i.test(text)) {
      facts.cash = 0;
      delete facts.financing;
      unsure = unsure.filter((field) => field !== "cash");
    }
    // "I don't know" after an area question means area-flexible, not "ask area again".
    // Enforce this in code even if the optional model omits openToOtherAreas.
    if (unsure.includes("area") && !(facts.area || facts.areas)) {
      facts.openToOtherAreas = true;
      signals = [...new Set([...signals, "area_flexible"])];
    }
    if ((facts.area || facts.areas) && facts.openToOtherAreas !== true) {
      facts.openToOtherAreas = false;
    }
    const refined = refineTurnIntent({ intents, signals, facts, message: text });
    facts = refined.facts;
    signals = refined.signals;
    intents = refined.intents;
    // "No thanks" to a connection offer declines that offer only; it does not
    // end the conversation. An explicit request for a person always wins.
    const pendingAtStart = this.memory.getPendingOffer(instagramUserId);
    const humanRequest = wantsHuman(text);
    if (pendingAtStart?.type === "handoff_offer" && declinesOffer(text) && !humanRequest) {
      intents = [...intents.filter(i => !["stop", "decline_call", "decline_contact"].includes(i)), "decline_handoff"];
      delete facts.salesPathStopped;
      facts.contactDeclined = true;
      facts.declinedSuggestions = ["handoff"];
    }
    if (pendingAtStart?.type === "handoff_offer" && isAffirmation(text)) {
      facts.requestedAction = existingBuyer.handoffTopics?.at(-1) || "Accepted an offer to connect";
    }
    if (humanRequest) {
      intents = [...new Set([...intents.filter(i => !["stop", "decline_contact"].includes(i)), "agent"])];
      facts.contactDeclined = false;
      facts.salesPathStopped = false;
      if (!facts.requestedAction) facts.requestedAction = "Asked to speak with a person";
    }
    const declinedServices = declinedServiceIds(text, this.services);
    if (declinedServices.length) facts.declinedSuggestions = [...(facts.declinedSuggestions || []), ...declinedServices.map(id => `service:${id}`)];
    if (intents.includes("reserve")) facts.requestedAction = "Discuss reservation";
    else if (intents.includes("viewing")) facts.requestedAction = "Arrange viewing";
    else if (intents.includes("request_call")) facts.requestedAction = "Requested call";
    else if (intents.includes("follow_up")) facts.requestedAction = existingBuyer.requestedAction || "Requested follow-up";

    // A new search or fact update reopens a previously paused sales path.
    const pacingRefusalThisTurn = deterministic.facts.objections?.some(o =>
      ["not_interested", "needs_time", "already_has_agent"].includes(o.category)) || intents.includes("stop");
    if (
      (buyerWouldResume(deterministic.facts, deterministic.intents) || ["request_call", "follow_up", "reserve", "viewing", "agent"].some(i => intents.includes(i))) &&
      !pacingRefusalThisTurn &&
      (existingBuyer.salesPathStopped || existingBuyer.followUpStatus === "paused")
    ) {
      facts.salesPathStopped = false;
      if (!facts.followUpStatus) facts.followUpStatus = "none";
    }

    if (intents.includes("decline_call") || intents.includes("stop")) {
      facts.followUpStatus = "none";
    }

    let callRequestSubmitted = Boolean(options.callRequestSubmitted);
    if (options.phone && !existingBuyer.noCalls && !existingBuyer.salesPathStopped) {
      facts.phone = options.phone;
      callRequestSubmitted = true;
      intents = [...new Set([...intents, "request_call", "call_submitted"])];
      signals = [...new Set([...signals, "request_call", "call_submitted"])];
    }

    // Phone typed while a call request is pending counts as submission.
    const pendingBefore = this.memory.getPendingOffer(instagramUserId);
    if (
      !callRequestSubmitted &&
      pendingBefore?.type === "call_request" &&
      !existingBuyer.noCalls && !facts.noCalls && !existingBuyer.salesPathStopped &&
      facts.phone
    ) {
      callRequestSubmitted = true;
      intents = [...new Set([...intents, "request_call", "call_submitted"])];
      signals = [...new Set([...signals, "request_call", "call_submitted"])];
    }

    if (intents.includes("stop")) {
      facts.salesPathStopped = true;
      facts.followUpStatus = "paused";
    }
    if (intents.includes("stop") || intents.includes("decline_call") || facts.noCalls === true) {
      callRequestSubmitted = false;
      this.memory.setPendingOffer(instagramUserId, null);
    }
    if (intents.includes("request_call") && !facts.noCalls && !options.callRequestSubmitted) {
      facts.noCalls = false;
      facts.contactDeclined = false;
      facts.preferredContactChannel = "phone";
    }
    if (intents.includes("follow_up") && !intents.includes("stop")) facts.contactDeclined = false;

    const updatedFields = [];
    if (facts.budget !== undefined) updatedFields.push("budget");
    if (facts.cash !== undefined) updatedFields.push("cash");
    if (facts.area || facts.areas) updatedFields.push("area");
    if (facts.bedrooms !== undefined) updatedFields.push("bedrooms");
    if (facts.financing) updatedFields.push("financing");
    if (facts.preferredContactChannel) updatedFields.push("contact_channel");
    if (facts.noCalls === true) updatedFields.push("no_calls");

    if (!ack) {
      const acknowledgements = [];
      if (facts.budget !== undefined && Number.isFinite(Number(facts.budget))) {
        acknowledgements.push(
          `your budget is around AED ${Number(facts.budget).toLocaleString("en-US")}`
        );
      }
      if (facts.cash !== undefined && Number.isFinite(Number(facts.cash))) {
        acknowledgements.push(
          `you have around AED ${Number(facts.cash).toLocaleString("en-US")} for the initial payment`
        );
      }
      if (acknowledgements.length) {
        ack = `Got it, ${acknowledgements.join(" and ")}.`;
      }
    }

    const pendingOffer = this.memory.getPendingOffer(instagramUserId);
    if (isAffirmation(text) && pendingOffer) {
      const resolved = resolveAffirmation(pendingOffer, text);
      if (resolved?.facts) facts = { ...facts, ...resolved.facts };
      if (resolved?.clearPending) this.memory.setPendingOffer(instagramUserId, null);
      if (!intents.includes("affirm")) intents = [...intents, "affirm"];
    }

    if (/^both$/i.test(text) && pendingOffer?.type === "bedroom_choice") {
      this.memory.setPendingOffer(instagramUserId, null);
    }

    if (intents.includes("continue") || intents.includes("start_fresh") || intents.includes("decline_call") || intents.includes("stop")) {
      this.memory.setPendingOffer(instagramUserId, null);
    }

    if (intents.includes("start_fresh")) {
      await this.buyers.resetCriteria(instagramUserId);
      this.memory.clear(instagramUserId);
      facts = { explorationState: true };
      recentTurns = [];
      lastAskedField = null;
      intents = ["start_fresh"];
      signals = [];
      unsure = [];
      ack = null;
      callRequestSubmitted = false;
    }

    let buyer = await this.buyers.remember(instagramUserId, facts);
    this.memory.recordPreferenceStates?.(instagramUserId, buyer.preferenceStates);
    const explicitResume = buyerWouldResume(deterministic.facts, deterministic.intents) ||
      ["request_call", "follow_up", "reserve", "viewing", "agent"].some(i => intents.includes(i));
    if (explicitResume && !pacingRefusalThisTurn && buyer.objections?.some(o => !o.resolved && ["not_interested", "needs_time", "already_has_agent"].includes(o.category))) {
      buyer = await this.buyers.patchBuyer(instagramUserId, { objections: buyer.objections.map(o =>
        ["not_interested", "needs_time", "already_has_agent"].includes(o.category) ? { ...o, resolved: true } : o) });
    }
    if (facts.openToOtherAreas === true || signals.includes("area_flexible")) {
      buyer = await this.buyers.updateMeta(instagramUserId, {
        intentSignals: ["area_flexible"]
      });
      buyer = {
        ...buyer,
        openToOtherAreas: true,
        intentSignals: [...new Set([...(buyer.intentSignals || []), "area_flexible"])]
      };
    } else if (facts.area || facts.areas) {
      // A definite area correction supersedes an earlier "open to other areas"
      // preference. Without this, stale flexibility can bring the old area back.
      buyer = await this.buyers.replaceIntentSignals(
        instagramUserId,
        (buyer.intentSignals || []).filter((signal) => signal !== "area_flexible")
      );
    }

    if (facts.bedrooms !== undefined || facts.project || facts.area) {
      if (facts.bedrooms !== undefined || facts.project) {
        const pending = this.memory.getPendingOffer(instagramUserId);
        if (pending?.type !== "call_request") {
          this.memory.setPendingOffer(instagramUserId, null);
        }
      }
    }
    this.memory.addTurn(instagramUserId, {
      role: "user",
      text,
      intents,
      signals,
      understandingSource: understanding?.source || null
    });

    const handoffRequested = false;
    const highIntent = hasHighIntent(intents, signals);
    const offerCallRequest =
      Boolean(options.offerCallRequest) ||
      intents.includes("request_call") ||
      wantsCallRequest(text);
    let catalogError = null;
    if (this.properties.refresh) {
      try { await this.properties.refresh(); } catch (error) { catalogError = error.message; }
    }
    const catalog = catalogError ? { developers: [], projects: [], units: [] } : this.properties.catalog();
    const namedProjects = catalog.projects.filter(p => text.toLowerCase().includes(p.name.toLowerCase()));
    if (namedProjects.length === 1 && !/\bcompare\b/i.test(text) && !/\b(?:don'?t|do not|not|reject|skip)\b/i.test(text) &&
        /\b(?:prefer|pick|choose|focus|interested|reserve|eoi|viewing|want|show|review)\b/i.test(text)) {
      facts.project = namedProjects[0].name;
      buyer = await this.buyers.remember(instagramUserId, { project: facts.project });
    }
    // Bind objections to the last displayed primary, never to a freshly ranked
    // candidate. Contact boundaries are handled independently below.
    for (const objection of facts.objections || []) {
      if (["no_calls", "not_interested", "needs_time", "already_has_agent", "trust_concern"].includes(objection.category)) continue;
      const projectId = buyer.activeRecommendationProjectId;
      if (projectId && this.buyers.recordObjection) {
        const project = catalog.projects.find(p => p.id === projectId);
        const unit = catalog.units.find(u => u.id === buyer.activeRecommendationUnitId && u.projectId === projectId);
        const rejected = project && unit ? { project, unit, factPack: buildFactPack({ project, unit,
          downPaymentAed: unit.initialPaymentAed ?? project.initialPaymentAed, bedroomLabel: String(unit.bedrooms) }) } : null;
        buyer = await this.buyers.recordObjection(instagramUserId, {
          projectId, unitId: buyer.activeRecommendationUnitId,
          category: objection.category,
          ...(rejected ? { factFingerprint: commercialEvidenceFingerprint(rejected), evidenceState: commercialEvidenceState(rejected) } : {})
        });
      }
    }
    if (facts.upgradeDeclined && buyer.lastUpgradeProjectId && this.buyers.recordObjection) {
      buyer = await this.buyers.recordObjection(instagramUserId, {
        projectId: buyer.lastUpgradeProjectId, category: "too_expensive"
      });
    }
    let matchResult = resolveMatches(catalog, buyer);
    const explicitRequestedProjectIds = catalog.projects.filter(p => text.toLowerCase().includes(p.name.toLowerCase()) &&
      /\b(show|review|reconsider|back to|tell me|focus|want)\b/i.test(text)).map(p => p.id);
    const advisor = buildAdvisorOpportunities(catalog, buyer, { ...this.advisorOptions, explicitRequestedProjectIds,
      requestedRecommendation: /\b(recommend|show|compare|options|keep looking)\b/i.test(text) });
    advisor.areaGuide = areaGuideFromCatalog(catalog);
    const strategy = determineAdvisorStrategy({ buyer, advisor, message: text,
      intents, recentTurns, pendingOffer: this.memory.getPendingOffer(instagramUserId) });
    if (advisoryReady(buyer) && advisor.primary) {
      matchResult = { ...matchResult, matches: advisor.matches, matchCount: advisor.matches.length,
        mode: advisor.matches[0]?.fit?.tier || "exact", fitTier: advisor.matches[0]?.fit?.tier || "exact",
        compromises: advisor.matches.flatMap(m => m.fit?.compromises || []),
        mismatches: advisor.matches.flatMap(m => (m.fit?.compromises || []).map(c => c.text)) };
    }
    if (!advisor.primary && (buildInvestmentStrategy(buyer).strategy === "READY_INCOME" ||
        matchResult.matches.some(m => m.fit?.hardConstraintFailures?.length || m.fit?.compromises?.some(c => c.key === "area")) ||
        (buyer.rejectedProjects?.length && !intents.includes("ask_facts")))) {
      matchResult = { ...matchResult, matches: [], matchCount: 0, mode: "none", fitTier: "none", compromises: [], mismatches: [] };
    }
    let packs = retrieveFacts(matchResult.matches);
    // A follow-up about "it" uses the same exact offer. Do not replace it with
    // another unit while answering plan/price/availability questions.
    if (intents.includes("ask_facts") && facts.bedrooms === undefined && buyer.activeRecommendationProjectId &&
        (!facts.project || catalog.projects.some(p => p.id === buyer.activeRecommendationProjectId && p.name.toLowerCase() === facts.project.toLowerCase()))) {
      const project = catalog.projects.find(p => p.id === buyer.activeRecommendationProjectId);
      const unit = catalog.units.find(u => u.id === buyer.activeRecommendationUnitId && u.projectId === project?.id);
      if (project && unit) packs = [buildFactPack({ project, unit,
        downPaymentAed: unit.initialPaymentAed ?? project.initialPaymentAed,
        bedroomLabel: String(unit.bedrooms) })];
    }
    if (!packs.length && intents.includes("ask_facts") && buyer.projectInterest) {
      const project = catalog.projects.find(p => p.name.toLowerCase() === buyer.projectInterest.toLowerCase());
      const unit = project && catalog.units.find(u => u.projectId === project.id);
      if (unit) packs = retrieveFacts([{ project, unit, downPaymentAed: unit.initialPaymentAed ?? project.initialPaymentAed, bedroomLabel: String(unit.bedrooms) }]);
    }
    const contact = contactDecision({ message: text, buyer,
      pending: this.memory.getPendingOffer(instagramUserId),
      explicitCall: intents.includes("request_call"),
      highIntent: highIntent && !intents.includes("eoi_info"),
      phoneSubmitted: callRequestSubmitted,
      broker: this.broker
    });
    const followUpSubmitted = Boolean(contact?.submitted);
    callRequestSubmitted = followUpSubmitted && contact.channel === "phone";
    if (contact?.channel) {
      if (contact.channel === "whatsapp") facts.noCalls = true;
      buyer = await this.buyers.patchBuyer(instagramUserId, { preferredContactChannel: contact.channel, ...(contact.channel === "whatsapp" ? { noCalls: true } : {}) });
    }
    const alertRecommended = followUpSubmitted && !buyer.salesPathStopped &&
      (contact.channel !== "phone" || !buyer.noCalls);
    const alertReason = alertRecommended ? (callRequestSubmitted ? "call_request" : "follow_up") : null;
    const turnObjections = (facts.objections || []).map(o => o.category);
    const askedFields = new Set(this.memory.getTurns(instagramUserId).map(turn => turn.role === "assistant" && turn.questionField).filter(Boolean));
    let draft = decideConversation({ message: text, buyer, catalog, packs, intents, catalogError, advisor, lastAskedField, broker: this.broker,
      askedFields });
    if (!contact && ["resolve_objection", "trust_check"].includes(strategy?.type) && !["paused", "permissions_updated", "education", "conversation_repair", "catalog_unavailable", "exploring", "welcome_back"].includes(draft?.stage)) {
      draft = buildAdvisorReply({ buyer, advisor, strategy, message: text, turnObjections, lastAskedField, askedFields });
      matchResult = { ...matchResult, matches: [], matchCount: 0, mode: "none", fitTier: "none", compromises: [], mismatches: [] };
      packs = [];
    }
    if (contact && !["paused", "permissions_updated"].includes(draft?.stage)) draft = contact;
    if (contact && draft?.stage === "permissions_updated" && contact.channel === "whatsapp") draft = contact;
    // Buying intent, a quote or a discount question: answer what is known about
    // the option under discussion, then offer the human who can confirm it.
    // A message carrying new search criteria is a search, not a transaction step.
    const searchUpdate = ["budget", "area", "areas", "bedrooms", "propertyType", "propertyTypes"].some(field => facts[field] !== undefined);
    const moment = !contact && !buyer.salesPathStopped && !searchUpdate ? transactionMoment(text) : null;
    // "No need for property management" on its own: acknowledge and move on.
    if (declinedServices.length && !moment && !searchUpdate && !contact && !/[?؟]/.test(text) && text.split(/\s+/).length <= 10) {
      const names = this.services.filter(s => declinedServices.includes(s.id)).map(s => s.name.toLowerCase());
      draft = { text: buyer.language === "ar" ? "تمام، سأستبعد ذلك." : `Understood, I'll leave ${names.join(" and ")} out.`, stage: "suggestion_declined",
        nextQuestion: null, pendingOffer: null, callRequest: null };
      matchResult = { ...matchResult, matches: [], matchCount: 0, mode: "none", fitTier: "none", compromises: [], mismatches: [] };
      packs = [];
    }
    if (moment && !["paused", "permissions_updated", "education", "conversation_repair", "catalog_unavailable", "welcome_back", "identity", "professional_topic", "handoff_declined"].includes(draft?.stage)) {
      const project = catalog.projects.find(p => p.id === buyer.activeRecommendationProjectId);
      const unit = project && catalog.units.find(u => u.id === buyer.activeRecommendationUnitId && u.projectId === project.id);
      const pack = unit ? buildFactPack({ project, unit, downPaymentAed: unit.initialPaymentAed ?? project.initialPaymentAed, bedroomLabel: String(unit.bedrooms) }) : null;
      draft = { text: transactionAnswer({ moment, buyer, pack, broker: this.broker }), stage: "transaction_next_step",
        factPacks: pack ? [pack] : [], nextQuestion: null, pendingOffer: null, callRequest: null,
        handoffReason: moment, handoffTopic: handoffTopic(moment, pack) };
      matchResult = { ...matchResult, matches: [], matchCount: 0, mode: "none", fitTier: "none", compromises: [], mismatches: [] };
      packs = draft.factPacks;
    }
    // Named commercial comparisons can run before buyer qualification creates
    // advisor.primary. Their concrete fact packs retain the existing gates.
    const concreteComparison = draft?.stage === "comparison" && draft.comparisonFacts &&
      draft.factPacks?.length >= 2 && draft.factPacks.every(pack => pack.unitId && !pack.knowledgeOnly);
    if (!contact && !concreteComparison && !["paused", "paused_advice", "permissions_updated", "education", "conversation_repair", "catalog_unavailable", "welcome_back"].includes(draft?.stage)) {
      const research = researchReply({ buyer, catalog, message: text, advisor });
      if (research) draft = research;
    }
    if (!draft && !contact && strategy && (advisoryReady(buyer) || strategy.type === "no_push")) {
      draft = buildAdvisorReply({ buyer, advisor, strategy, message: text, turnObjections, lastAskedField, askedFields });
      if (draft) packs = draft.factPacks || advisor.packs;
    }
    if (!draft && !contact && !advisor.primary) draft = knowledgeAdvice({ buyer, catalog, message: text, advisor });
    // The external handoff uses the offer already discussed, even if a newly
    // volunteered payment preference would otherwise change internal ranking.
    if (contact && buyer.activeRecommendationProjectId && !facts.project) {
      const selected = advisor.candidates.find(m => m.project.id === buyer.activeRecommendationProjectId && m.unit.id === buyer.activeRecommendationUnitId);
      if (selected) matchResult = { ...matchResult, matches: [selected], matchCount: 1,
        mode: selected.fit.tier, fitTier: selected.fit.tier,
        compromises: selected.fit.compromises, mismatches: selected.fit.compromises.map(c => c.text) };
    }
    if (!draft) draft = contact || buildConversationReply({
      buyer, message: text, intents, packs, matches: matchResult.matches,
      matchMode: matchResult.mode, mismatches: matchResult.mismatches || [],
      highIntent, handoffRequested, offerCallRequest,
      pendingOffer: this.memory.getPendingOffer(instagramUserId), unsure, ack, lastAskedField, updatedFields
    });
    // An unanswered connection offer lapses once the conversation moves on, so a
    // later "yes" to something else is never read as consent to be contacted.
    if (pendingAtStart?.type === "handoff_offer" && !draft.pendingOffer && !contact) this.memory.setPendingOffer(instagramUserId, null);
    if (["paused", "paused_advice", "permissions_updated", "objection_unresolved", "trust_check", "handoff_declined"].includes(draft.stage) || contact?.submitted) {
      this.memory.setPendingOffer(instagramUserId, null);
    }

    if (!contact && (scope || intents.includes("start_fresh") || draft.stage === "welcome_back")) {
      // General advice and a reset do not expose a listing selection.
      packs = [];
      matchResult = { ...matchResult, matches: [], matchCount: 0, mode: "none", fitTier: "none", compromises: [], mismatches: [] };
    }
    if (draft.factPacks) packs = draft.factPacks;
    if (draft.stage === "fact_answer" && ["paymentPlan", "initial"].includes(draft.factTopic) && buyer.activeRecommendationProjectId && !buyer.salesPathStopped) {
      const prompt = buyer.language === "ar" ? "هل تريد التحقق من التوفر الحالي؟" : "Want me to check current availability?";
      draft = { ...draft, text: `${draft.text}\n${prompt}`, nextQuestion: { field: "advisoryNextAction", prompt },
        pendingOffer: { type: "advisory_next_action", action: "availability" } };
    }
    // Last-line protection also applies to deterministic and offline replies.
    // Rephrasing a closed qualification slot cannot restart the interview.
    if (draft.nextQuestion && (isFlexiblePreference(buyer, draft.nextQuestion.field) || knownField(buyer, draft.nextQuestion.field) ||
        this.memory.getQuestionState?.(instagramUserId, draft.nextQuestion.field) === "flexible")) {
      const prompt = draft.nextQuestion.prompt;
      const textWithoutQuestion = prompt && draft.text.includes(prompt)
        ? draft.text.replace(prompt, "").trim()
        : draft.text.replace(/[^.!?\n]*[?؟]/g, "").trim();
      draft = { ...draft, text: textWithoutQuestion || "You're open, so I'll work with the details you've shared and explain the choices as we go.",
        nextQuestion: null, pendingOffer: null };
      this.memory.setPendingOffer(instagramUserId, null);
      // A bare acknowledgement is a dead end: offer a concrete next step instead.
      if (draft.text.length < 60 && buyer.budgetAed && !draft.advisoryExposure && !buyer.salesPathStopped) {
        const amount = Number(buyer.budgetAed).toLocaleString("en-US");
        const prompt = buyer.language === "ar" ? "أيهما أفيد لك؟" : "Which would help more?";
        draft = { ...draft, text: buyer.language === "ar"
          ? `لا مشكلة. بميزانية حوالي AED ${amount} يمكنني أن أعرض ما تتيحه في مناطق مختلفة، أو أشرح خطوات الشراء. ${prompt}`
          : `No problem. With around AED ${amount}, I can show you what that buys in different areas, or explain how buying works. ${prompt}`,
          nextQuestion: { field: "explorationTopic", prompt } };
      }
    }
    // At most one relevant complementary service, then at most one connection
    // offer. Both are skipped when the buyer declined them or paused.
    let serviceSuggestion = null;
    // Selective: never in a turn where the buyer declined one, nor within two replies of the last.
    const recentService = this.memory.recentContext(instagramUserId, 4).some(turn => turn.role === "assistant" && turn.serviceId);
    if (!contact && (draft.allowsServiceSuggestion || draft.serviceTopic) && !buyer.salesPathStopped && !declinedServices.length && !recentService) {
      const primaryPack = packs.find(p => p.projectId === buyer.activeRecommendationProjectId) || (draft.advisoryExposure ? packs.find(p => p.projectId === advisor.primary?.projectId) : null);
      serviceSuggestion = suggestService({ buyer, topic: draft.serviceTopic || null, pack: primaryPack || null, services: this.services });
      if (serviceSuggestion) draft = { ...draft, text: insertBeforeQuestion(draft.text, serviceSuggestion.line, draft.nextQuestion?.prompt) };
    }
    if (draft.handoffReason) {
      const offer = handoffOffer({ buyer, broker: this.broker, reason: draft.handoffReason, lastAskedField });
      if (offer) draft = { ...draft, text: `${draft.text}\n${offer.line}`, nextQuestion: offer.nextQuestion, pendingOffer: offer.pendingOffer };
      else if (draft.handoffReason === "buying" && !buyer.salesPathStopped) {
        // The buyer declined a follow-up earlier: give direct details instead of asking again.
        const direct = directContactLine(this.broker, buyer.language);
        if (direct) draft = { ...draft, text: `${draft.text}\n${direct}` };
      }
    }
    draft = localizeDraft(draft, buyer, packs);
    if (draft.pendingOffer) {
      this.memory.setPendingOffer(instagramUserId, draft.pendingOffer);
    } else if (["matched", "soft_match", "transaction_next_step", "identity", "professional_topic", "handoff_declined", "suggestion_declined", "acknowledged"].includes(draft.stage)) {
      if (!draft.nextQuestion) this.memory.setPendingOffer(instagramUserId, null);
    }

    draft = { ...draft, text: sanitizeBuyerLanguage(draft.text) };
    const allowedActions = allowedResponseActions(buyer, draft);
    const forbiddenActions = ["execute_reservation", "collect_payment", "claim_action_completed",
      ...(buyer.noCalls ? ["call"] : []), ...(buyer.salesPathStopped ? ["capture", "follow_up"] : [])];
    const responseStrategy = draft.advisoryExposure ? strategy : { type: draft.stage };
    const investmentProfile = buildInvestmentStrategy(buyer);
    const state = conversationState({ buyer, message: text, intents, recentTurns, advisor });
    const investmentTheses = draft.investmentTheses || (draft.advisoryExposure || draft.stage === "fact_answer" || draft.stage === "investment_risk" ? advisor.investmentTheses || [] : []);
    // Owner-approved area knowledge for the areas in play this turn.
    const areaGuide = advisor.areaGuide;
    const areaEntries = [...new Set([...(draft.areaGuideAreas || []), ...packs.map(p => p.area?.value), ...(buyer.preferredAreas || [])])]
      .map(area => findAreaEntry(areaGuide, area)).filter(Boolean).slice(0, 6);
    const allowedClaims = [...thesisClaims(investmentTheses), ...areaGuideClaims(areaEntries)];
    const comparisonFacts = draft.comparisonFacts || advisor.comparison || null;
    const validationOpportunities = [...advisor.opportunities, ...(advisor.upgradeAssessment?.opportunities || [])];
    const responseOpportunities = draft.advisoryExposure || draft.stage === "fact_answer" ? validationOpportunities : [];
    const serviceTerms = configuredServiceTerms(this.services);
    const permittedContacts = permittedContactDetails(this.broker);
    if (buyer.phone) permittedContacts.phones.push(String(buyer.phone).replace(/\D/g, ""));
    const validationOptions = { buyer, opportunities: responseOpportunities, allowedClaims, comparisonFacts,
      configuredAmounts: serviceTerms.amounts, configuredPercents: serviceTerms.percents, permittedContacts,
      allowedBuyerAmounts: [buyer.budgetAed, buyer.cashAvailableAed].filter(v => v != null),
      educationalSplit: draft.educationalSplit,
      permittedRecommendations: ["matched", "soft_match"].includes(draft.stage)
        ? matchResult.matches.map(m => ({ projectId: m.project.id, unitId: m.unit.id })) : [],
      requiredAdvisory: draft.advisoryExposure && strategy?.type !== "answer_action" ? advisor.opportunities : [] };
    // Every deterministic stage can be expressed naturally. The model composes
    // one complete message; rejected output leaves the safe strategy unchanged.
    if (this.llm && options.useLlm !== false) {
      const composed = await composeReplyWithModel(this.llm, {
        buyer,
        packs,
        draftText: draft.text,
        message: text,
        recentTurns,
        intents,
        investmentProfile, conversationState: state, investmentTheses, discoveryAnalysis: advisor.discoveryAnalysis || null,
        handoffContact: { label: brokerLabel(this.broker, buyer.language), directContact: directContactLine(this.broker, buyer.language) },
        comparisonFacts, objectionState: buyer.objections || [], allowedClaims,
        requiredQuestion: draft.nextQuestion || null,
        opportunities: responseOpportunities,
        strategy: responseStrategy,
        allowedActions,
        forbiddenActions,
        validationOptions,
        language: buyer.language,
        areaGuide: areaGuideForModel(areaEntries)
      });
      if (composed) draft = { ...draft, text: composed.message, polished: true };
    }

    const allowedBuyerAmounts = [buyer.budgetAed, buyer.cashAvailableAed].filter(
      (value) => value !== null && value !== undefined
    );

    let check = validateMessage(draft.text, packs, {
      handoffRequested,
      handoffReason: handoffRequested ? "buyer_requested" : null,
      allowedBuyerAmounts,
      educationalSplit: draft.educationalSplit,
      allowedClaims, comparisonFacts,
      buyer,
      opportunities: validationOpportunities,
      configuredAmounts: serviceTerms.amounts, configuredPercents: serviceTerms.percents
    });
    const responseCheck = validateBuyerResponse(draft.text, { ...validationOptions,
      packs, requiredQuestion: draft.nextQuestion, allowedActions, forbiddenActions });
    if (!responseCheck.ok) check = { ...check, ok: false, violations: [...check.violations, ...responseCheck.violations] };

    let replyText = draft.text;
    // Never send the same reply twice in a row; move the conversation on instead.
    // Compared without a trailing question, so new information is never treated as a repeat.
    const body = text => String(text || "").trim().replace(/\n[^\n]*[?؟]\s*$/, "").trim();
    const recentReplies = this.memory.getTurns(instagramUserId).filter(turn => turn.role === "assistant").slice(-3).map(turn => body(turn.text));
    if (check.ok && replyText && recentReplies.includes(body(replyText)) && !contact && !["paused", "permissions_updated", "acknowledged"].includes(draft.stage)) {
      const name = draft.advisoryExposure && advisor.primary ? packs.find(p => p.projectId === advisor.primary.projectId)?.name?.value : null;
      const ar = buyer.language === "ar";
      const alternatives = [
        ...(draft.advisoryExposure ? [ar ? "لا مشكلة. يبقى ترشيحي كما هو. عندما تكون مستعداً يمكنني شرح جدول السداد أو مقارنة الخيارين."
          : `No problem. My recommendation stays ${name ? `with ${name}` : "the same"}. When you're ready, I can break down the payment schedule or compare the options side by side.`] : []),
        ar ? "لا داعي للعجلة. اسألني عن أي شيء يخص عقارات أبوظبي متى كنت مستعداً." : "No rush. Ask me anything about Abu Dhabi property whenever you're ready."
      ];
      // A pending offer or open question survives the rewording, so a later
      // "yes" still has something to accept instead of meeting "No rush".
      const leads = ar ? ["تمام.", "لا مشكلة، خذ وقتك."]
        : draft.pendingOffer ? ["That's everything I have on that so far.", "No problem, take your time."] : ["Got it.", "No problem, take your time."];
      const keepQuestions = draft.nextQuestion?.prompt && !buyer.salesPathStopped ? leads.map(lead => `${lead}\n${draft.nextQuestion.prompt}`) : [];
      const fresh = [...keepQuestions, ...alternatives].find(text => !recentReplies.includes(body(text)));
      if (fresh && keepQuestions.includes(fresh)) {
        replyText = fresh;
        draft = { ...draft, text: fresh };
      } else if (fresh) {
        replyText = fresh;
        const offer = fresh.includes("break down the payment schedule") ? { type: "advisory_next_action", action: "payment_details" } : null;
        draft = { ...draft, text: fresh, nextQuestion: offer ? { field: "advisoryNextAction", prompt: fresh } : null, pendingOffer: offer };
      }
    }
    if (!check.ok) {
      this.logger?.({ event: "response_validation", rejectionReasons: check.violations.map(v => v.type) });
      const fallbackPacks = draft.advisoryExposure ? packs.filter(p => matchResult.matches.some(m => m.project.id === p.projectId && m.unit.id === p.unitId)).slice(0, 2) : packs.slice(0, 2);
      replyText = fallbackPacks.length
        ? fallbackSafeText(fallbackPacks)
        : buyer.advisorLed
          ? "You're open, so I'll do the filtering using the budget and constraints you've shared. I don't have enough current evidence for a reliable shortlist yet. I'll check entry price, payment commitments, timing and resale evidence before suggesting a property."
          : "I can't give a reliable property comparison from the details available right now. I can still help explain the buying choices.";
      check = validateMessage(replyText, packs, {
        handoffRequested,
        handoffReason: handoffRequested ? "buyer_requested" : null,
        allowedBuyerAmounts,
        buyer,
        opportunities: validationOpportunities
      });
      draft = { ...draft, text: replyText, stage: "fact_check_fallback", polished: false, nextQuestion: null, pendingOffer: null };
      this.memory.setPendingOffer(instagramUserId, null);
    }
    this.memory.setLastAskedField(instagramUserId, draft.nextQuestion?.field || null);
    if (check.ok && draft.advisoryExposure && strategy?.type === "budget_permission" && draft.stage !== "fact_check_fallback") {
      buyer = await this.buyers.patchBuyer(instagramUserId, { budgetFlexibilityAsked: true });
    }
    // Remember what was suggested so it is not repeated, and what the human should pick up.
    if (check.ok && draft.stage !== "fact_check_fallback" && (serviceSuggestion || draft.handoffTopic)) {
      buyer = await this.buyers.remember(instagramUserId, {
        ...(serviceSuggestion ? { servicesSuggested: [serviceSuggestion.record] } : {}),
        ...(draft.handoffTopic ? { handoffTopics: [draft.handoffTopic] } : {})
      });
    }
    if (check.ok && draft.advisoryExposure && this.buyers.recordAdvisoryExposure) {
      buyer = await this.buyers.recordAdvisoryExposure(instagramUserId, draft.advisoryExposure);
    }

    const status = leadStatusFor(buyer, intents, signals, matchResult.matchCount, callRequestSubmitted);
    const summary = this.memory.buildSummary(instagramUserId, {
      ...buyer,
      conversationSummary: summarizeBuyer(buyer)
    });

    const followUpStatus = buyer.salesPathStopped ? "paused" : followUpSubmitted ? (callRequestSubmitted ? "call_requested" : "follow_up_requested") : callRequestSubmitted
      ? "call_requested"
      : intents.includes("decline_call")
        ? "none"
        : offerCallRequest && !callRequestSubmitted
          ? "call_offer_pending"
          : buyer.followUpStatus === "call_requested"
            ? buyer.followUpStatus
            : buyer.followUpStatus === "paused"
              ? "none"
              : buyer.followUpStatus || "none";

    const durableSignals = (signals || []).filter(
      (signal) =>
        ![
          "high_intent",
          "reserve_interest",
          "viewing_request",
          "callback_request",
          "agent_request",
          "request_call",
          "call_submitted"
        ].includes(signal)
    );

    buyer = await this.buyers.remember(instagramUserId, {
      intentSignals: durableSignals,
      contactDeclined:
        intents.includes("decline_contact") || intents.includes("decline_call") ? true : undefined,
      preferredContactChannel: facts.preferredContactChannel,
      noCalls: facts.noCalls,
      salesPathStopped: buyer.salesPathStopped,
      phone: facts.phone
    });
    buyer = await this.buyers.replaceIntentSignals(instagramUserId, [
      ...durableSignals,
      ...(facts.openToOtherAreas || signals.includes("area_flexible") ? ["area_flexible"] : [])
    ]);
    buyer = await this.buyers.updateMeta(instagramUserId, {
      leadStatus: status,
      conversationSummary: summary,
      followUpStatus,
      preferredContactChannel: facts.preferredContactChannel || buyer.preferredContactChannel,
      noCalls: facts.noCalls === true ? true : buyer.noCalls,
      salesPathStopped: buyer.salesPathStopped
    });

    const activeProject = catalog.projects.find(p => p.id === buyer.activeRecommendationProjectId);
    const activeUnit = catalog.units.find(u => u.id === buyer.activeRecommendationUnitId && u.projectId === activeProject?.id);
    const handoffMatches = activeProject && activeUnit ? [{ project: activeProject, unit: activeUnit,
      downPaymentAed: activeUnit.initialPaymentAed ?? activeProject.initialPaymentAed }] : matchResult.matches;
    const callSummary = followUpSubmitted
      ? buildCallRequestSummary(buyer, {
          matches: handoffMatches,
          reason: options.callReason || (callRequestSubmitted ? "Buyer submitted Request a Call" : "Buyer requested follow-up")
        })
      : null;

    this.memory.addTurn(instagramUserId, {
      role: "assistant",
      text: replyText,
      stage: draft.stage,
      matchCount: matchResult.matchCount,
      factCheckOk: check.ok,
      pendingOffer: this.memory.getPendingOffer(instagramUserId),
      questionField: draft.nextQuestion?.field || null,
      serviceId: serviceSuggestion && check.ok && draft.stage !== "fact_check_fallback" ? serviceSuggestion.id : null
    });

    if (this.memory.flush) await this.memory.flush();
    this.logger?.({ event: "advisor_turn", conversationStrategy: state, investmentStrategy: investmentProfile.strategy,
      primaryRecommendation: draft.advisoryExposure ? advisor.primary?.projectId || null : null,
      challenger: draft.advisoryExposure ? advisor.challenger?.projectId || null : null,
      opportunityType: draft.advisoryExposure ? advisor.opportunities.map(o => o.type) : [],
      objectionCategory: strategy?.objection || null, llm: draft.polished ? "used" : this.llm ? "fallback" : "disabled",
      factSourceCategory: [...new Set(packs.map(p => p.knowledgeOnly ? "project_knowledge" : p.offerId ? "commercial_offer" : "legacy_unit"))],
      commercialGateRejection: [...new Set((catalog.intelligence?.offers || []).flatMap(o => commercialOfferGate(o).reasons))],
      nextAction: strategy?.nextAction || draft.pendingOffer?.action || null });
    return {
      reply: replyText,
      stage: draft.stage,
      polished: Boolean(draft.polished),
      understood: Boolean(understanding?.source && understanding.source !== "none"),
      understandingSource: understanding?.source || null,
      buyer,
      intents,
      signals,
      unsure,
      alertReason,
      alertRecommended,
      callRequest: draft.callRequest || null,
      callRequestSubmitted,
      followUpSubmitted,
      catalogError,
      callSummary,
      criteria: matchResult.criteria,
      matchCount: matchResult.matchCount,
      matchMode: matchResult.mode,
      fitTier: matchResult.fitTier || matchResult.mode,
      matches: matchResult.matches,
      mismatches: matchResult.mismatches || [],
      compromises: matchResult.compromises || [],
      packs,
      advisor,
      strategy,
      conversationState: state, investmentProfile, investmentTheses, comparison: comparisonFacts,
      researchClaims: draft.researchClaims || [], projectRelations: draft.projectRelations || null,
      knowledgeOnly: draft.knowledgeOnly === true, commercialQuote: draft.commercialQuote ?? null,
      check,
      missingData: missingDataHandoff(packs),
      handoffRequired: followUpSubmitted,
      nextQuestion: draft.nextQuestion || null,
      pendingOffer: this.memory.getPendingOffer(instagramUserId),
      context: this.memory.recentContext(instagramUserId)
    };
  }

  async submitCallRequest(instagramUserId, phone, options = {}) {
    if (!/^\+?[1-9]\d{6,14}$/.test(String(phone || "").replace(/[\s()-]/g, ""))) throw new Error("A valid phone number is required");
    return this.handleMessage(instagramUserId, options.message || "Request a Call", {
      ...options,
      phone: String(phone || "").trim(),
      callRequestSubmitted: true,
      callReason: options.callReason || "Buyer submitted Request a Call",
      useLlm: false
    });
  }
}

function buyerWouldResume(facts, intents) {
  return Boolean(
    facts.budget !== undefined ||
      facts.cash !== undefined ||
      facts.area ||
      facts.areas ||
      facts.bedrooms !== undefined ||
      facts.project ||
      intents.includes("search") ||
      intents.includes("start_fresh") ||
      intents.includes("continue") ||
      intents.includes("provide_facts") ||
      intents.includes("follow_up") ||
      intents.includes("request_call")
  );
}

export function createConversationEngine(services, options = {}) {
  return new ConversationEngine({
    buyers: services.buyers,
    properties: services.properties,
    memory: options.memory,
    llm: options.llm || null,
    advisorOptions: options.advisorOptions || {},
    broker: options.broker || null,
    services: options.services || null
  });
}

function insertBeforeQuestion(text, line, prompt) {
  if (prompt && text.endsWith(prompt)) return `${text.slice(0, -prompt.length).trimEnd()}\n${line}\n${prompt}`;
  return `${text}\n${line}`;
}

function allowedResponseActions(buyer, draft) {
  if (buyer.salesPathStopped || ["paused", "permissions_updated", "catalog_unavailable"].includes(draft.stage)) return [];
  if (draft.nextQuestion?.field === "phone") return ["request_phone"];
  if (draft.nextQuestion?.field === "handoffOffer") return ["handoffOffer"];
  if (["call_requested", "follow_up_requested"].includes(draft.stage)) return [];
  return ["compare", "payment_details", "availability", "focus", "eoi", "viewing", "contact_channel"];
}
