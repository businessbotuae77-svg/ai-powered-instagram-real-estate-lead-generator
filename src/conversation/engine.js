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
  shouldSendAdvisorAlert,
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
  }

  async handleMessage(instagramUserId, message, options = {}) {
    const text = String(message || "").trim();
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

    // A new search or fact update reopens a previously paused sales path.
    if (
      buyerWouldResume(facts, intents) &&
      (existingBuyer.salesPathStopped || existingBuyer.followUpStatus === "paused")
    ) {
      facts.salesPathStopped = false;
      if (!facts.followUpStatus) facts.followUpStatus = "none";
    }

    if (intents.includes("decline_call")) {
      facts.salesPathStopped = false;
      facts.followUpStatus = "none";
    }

    let callRequestSubmitted = Boolean(options.callRequestSubmitted);
    if (options.phone) {
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
      facts.phone
    ) {
      callRequestSubmitted = true;
      intents = [...new Set([...intents, "request_call", "call_submitted"])];
      signals = [...new Set([...signals, "request_call", "call_submitted"])];
    }

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

    if (intents.includes("continue") || intents.includes("start_fresh") || intents.includes("decline_call")) {
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
    const alertRecommended = shouldSendAdvisorAlert({
      callRequestSubmitted,
      buyer: { ...buyer, phone: facts.phone || buyer.phone }
    });
    const alertReason = alertRecommended ? "call_request" : null;

    const catalog = this.properties.catalog();
    const matchResult = resolveMatches(catalog, buyer);
    const packs = retrieveFacts(matchResult.matches);

    let draft;
    if (callRequestSubmitted && (facts.phone || buyer.phone)) {
      draft = {
        text: `Thanks. I have your number${facts.phone || buyer.phone ? ` (${facts.phone || buyer.phone})` : ""}. An advisor will call you back. I have not promised a specific time.`,
        stage: "call_requested",
        nextQuestion: null,
        pendingOffer: null,
        callRequest: null,
        handoffRequired: false
      };
      this.memory.setPendingOffer(instagramUserId, null);
    } else {
      draft = buildConversationReply({
        buyer,
        message: text,
        intents,
        packs,
        matches: matchResult.matches,
        matchMode: matchResult.mode,
        mismatches: matchResult.mismatches || [],
        highIntent,
        handoffRequested,
        offerCallRequest,
        pendingOffer: this.memory.getPendingOffer(instagramUserId),
        unsure,
        ack,
        lastAskedField,
        updatedFields
      });
    }

    if (draft.pendingOffer) {
      this.memory.setPendingOffer(instagramUserId, draft.pendingOffer);
    } else if (draft.stage === "matched" || draft.stage === "soft_match") {
      if (!draft.nextQuestion) this.memory.setPendingOffer(instagramUserId, null);
    }

    this.memory.setLastAskedField(instagramUserId, draft.nextQuestion?.field || null);

    // Keep call handoff copy exact — polish must not turn it back into a sales pitch.
    if (this.llm && options.useLlm !== false && draft.stage !== "call_requested") {
      const polished = await polishReplyWithModel(this.llm, {
        buyer,
        packs,
        draftText: draft.text,
        intents,
        requiredQuestion: draft.nextQuestion?.prompt || null
      });
      if (polished) draft = { ...draft, text: polished, polished: true };
    }

    const allowedBuyerAmounts = [buyer.budgetAed, buyer.cashAvailableAed].filter(
      (value) => value !== null && value !== undefined
    );

    let check = validateMessage(draft.text, packs, {
      handoffRequested,
      handoffReason: handoffRequested ? "buyer_requested" : null,
      allowedBuyerAmounts
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

    const followUpStatus = callRequestSubmitted
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
      salesPathStopped: false,
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
      salesPathStopped: false
    });

    const callSummary = callRequestSubmitted
      ? buildCallRequestSummary(buyer, {
          matches: matchResult.matches,
          reason: options.callReason || "Buyer submitted Request a Call"
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
      handoffRequired: Boolean(callRequestSubmitted),
      nextQuestion: draft.nextQuestion || null,
      pendingOffer: this.memory.getPendingOffer(instagramUserId),
      context: this.memory.recentContext(instagramUserId)
    };
  }

  async submitCallRequest(instagramUserId, phone, options = {}) {
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
      intents.includes("provide_facts")
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
