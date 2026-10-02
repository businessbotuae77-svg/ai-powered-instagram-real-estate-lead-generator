import { localizeDraft } from "./localize.js";
import { normalizeBuyerText, buyerLanguage } from "./text.js";
import { decideConversation } from "./decision.js";
import { contactDecision } from "./contact.js";
import { missingDataHandoff, validateMessage } from "../facts/checker.js";
import { extractFactsFromMessage } from "./extract.js";
import { ConversationMemory } from "./memory.js";
import { canPitchBuyer, resolveMatches } from "./match-resolve.js";
import { summarizeBuyer, isCoreQualified } from "./qualify.js";
import { buildConversationReply, fallbackSafeText } from "./replies.js";
import { polishReplyWithModel } from "./llm.js";
import { understandMessageWithModel, understandMessageLocally, mergeUnderstanding } from "./understand.js";
import { isAffirmation, resolveAffirmation } from "./affirmation.js";
import { retrieveFacts } from "../facts/retrieval.js";
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
  constructor({ buyers, properties, memory, llm = null } = {}) {
    if (!buyers || !properties) throw new Error("ConversationEngine requires buyers and properties");
    this.buyers = buyers;
    this.properties = properties;
    this.memory = memory || new ConversationMemory();
    this.llm = llm;
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
    const lastAskedField = this.memory.getLastAskedField(instagramUserId);
    const existingBuyer = await this.buyers.getOrCreate(instagramUserId);
    const recentTurns = this.memory.recentContext(instagramUserId, 6);

    let base = extractFactsFromMessage(text);

    const localUnderstanding = understandMessageLocally(text, {
      buyer: existingBuyer,
      lastAskedField
    });
    let understanding = localUnderstanding;

    if (this.llm && options.useLlm !== false) {
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
    facts.language = buyerLanguage(message) === "ar" ? "ar" : existingBuyer.language || "en";
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
    if (intents.includes("reserve")) facts.requestedAction = "Discuss reservation";
    else if (intents.includes("viewing")) facts.requestedAction = "Arrange viewing";
    else if (intents.includes("request_call")) facts.requestedAction = "Requested call";
    else if (intents.includes("follow_up")) facts.requestedAction = existingBuyer.requestedAction || "Requested follow-up";

    // A new search or fact update reopens a previously paused sales path.
    if (
      buyerWouldResume(facts, intents) &&
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
      facts = {};
      unsure = [];
      ack = null;
      callRequestSubmitted = false;
    }

    let buyer = await this.buyers.remember(instagramUserId, facts);
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
    const matchResult = resolveMatches(catalog, buyer);
    let packs = retrieveFacts(matchResult.matches);
    if (!packs.length && intents.includes("ask_facts") && buyer.projectInterest) {
      const project = catalog.projects.find(p => p.name.toLowerCase() === buyer.projectInterest.toLowerCase());
      const unit = project && catalog.units.find(u => u.projectId === project.id);
      if (unit) packs = retrieveFacts([{ project, unit, downPaymentAed: unit.initialPaymentAed ?? project.initialPaymentAed, bedroomLabel: String(unit.bedrooms) }]);
    }
    const contact = contactDecision({ message: text, buyer,
      pending: this.memory.getPendingOffer(instagramUserId),
      explicitCall: intents.includes("request_call"),
      highIntent: highIntent && !intents.includes("eoi_info"),
      phoneSubmitted: callRequestSubmitted
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
    let draft = decideConversation({ message: text, buyer, catalog, packs, intents, catalogError });
    if (contact && draft?.stage === "permissions_updated" && contact.channel === "whatsapp") draft = contact;
    if (!draft) draft = contact || buildConversationReply({
      buyer, message: text, intents, packs, matches: matchResult.matches,
      matchMode: matchResult.mode, mismatches: matchResult.mismatches || [],
      highIntent, handoffRequested, offerCallRequest,
      pendingOffer: this.memory.getPendingOffer(instagramUserId), unsure, ack, lastAskedField, updatedFields
    });
    if (draft.stage === "paused" || draft.stage === "permissions_updated" || contact?.submitted) {
      this.memory.setPendingOffer(instagramUserId, null);
    }

    if (draft.factPacks) packs = draft.factPacks;
    draft = localizeDraft(draft, buyer, packs);
    if (draft.pendingOffer) {
      this.memory.setPendingOffer(instagramUserId, draft.pendingOffer);
    } else if (draft.stage === "matched" || draft.stage === "soft_match") {
      if (!draft.nextQuestion) this.memory.setPendingOffer(instagramUserId, null);
    }

    this.memory.setLastAskedField(instagramUserId, draft.nextQuestion?.field || null);

    // Keep call handoff copy exact — polish must not turn it back into a sales pitch.
    if (this.llm && options.useLlm !== false && !["call_offer", "call_requested", "follow_up_requested", "paused", "permissions_updated", "education", "comparison", "exploring", "knowledge_answer", "follow_up_channel", "follow_up_phone", "catalog_unavailable"].includes(draft.stage)) {
      const polished = await polishReplyWithModel(this.llm, {
        buyer,
        packs,
        draftText: draft.text,
        intents,
        requiredQuestion: draft.nextQuestion?.prompt || null,
        language: buyer.language
      });
      if (polished) draft = { ...draft, text: polished, polished: true };
    }

    const allowedBuyerAmounts = [buyer.budgetAed, buyer.cashAvailableAed].filter(
      (value) => value !== null && value !== undefined
    );

    let check = validateMessage(draft.text, packs, {
      handoffRequested,
      handoffReason: handoffRequested ? "buyer_requested" : null,
      allowedBuyerAmounts,
      educationalSplit: draft.educationalSplit
    });

    let replyText = draft.text;
    if (!check.ok) {
      replyText = packs.length
        ? fallbackSafeText(packs)
        : "I can only share confirmed listing details. Tell me a budget and area and I will check what we have.";
      check = validateMessage(replyText, packs, {
        handoffRequested,
        handoffReason: handoffRequested ? "buyer_requested" : null,
        allowedBuyerAmounts
      });
      draft = { ...draft, text: replyText, stage: "fact_check_fallback", polished: false };
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

    const callSummary = followUpSubmitted
      ? buildCallRequestSummary(buyer, {
          matches: matchResult.matches,
          reason: options.callReason || (callRequestSubmitted ? "Buyer submitted Request a Call" : "Buyer requested follow-up")
        })
      : null;

    this.memory.addTurn(instagramUserId, {
      role: "assistant",
      text: replyText,
      stage: draft.stage,
      matchCount: matchResult.matchCount,
      factCheckOk: check.ok,
      pendingOffer: this.memory.getPendingOffer(instagramUserId)
    });

    if (this.memory.flush) await this.memory.flush();
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
    llm: options.llm || null
  });
}
