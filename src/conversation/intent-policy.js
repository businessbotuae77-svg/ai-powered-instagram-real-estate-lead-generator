import { normalizeBuyerText } from "./text.js";
import { wantsHuman } from "./contact.js";
import { OUTCOME_LABELS, contactPermissions, permittedNextAction } from "./outcomes.js";
/**
 * Buyer intent and call-request policy for Milestone 3.
 * Buying interest is distinct from call permission.
 * Channel-aware follow-up is handled by contact.js.
 */

const HIGH_INTENT_SIGNALS = [
  "reserve_interest",
  "viewing_request",
  "callback_request",
  "agent_request",
  "buy_interest"
];

/**
 * Normalize intents/signals for one message.
 */
export function refineTurnIntent({ intents = [], signals = [], facts = {}, message = "" } = {}) {
  const text = normalizeBuyerText(message);
  let nextIntents = [...intents];
  let nextSignals = [...signals];
  const nextFacts = { ...facts };

  if (isInformationalEoi(text) && !wantsCallRequest(text)) {
    nextIntents = without(nextIntents, ["reserve", "viewing", "callback", "agent", "high_intent", "request_call"]);
    nextSignals = without(nextSignals, HIGH_INTENT_SIGNALS.concat(["high_intent", "request_call"]));
    if (!nextIntents.includes("eoi_info")) nextIntents.push("eoi_info");
    nextSignals.push("informational_eoi");
  }

  if (/\b(stop contacting|stop messaging|stop asking|leave me alone|do not contact|don't contact)\b/i.test(text) || /^(i'm good|im good|i am good|all good|stop|that's all|no thanks|no thank you|(?:i(?:'m| am) )?not interested)[.!?]*$/i.test(text.trim())) {
    nextIntents.push("stop");
    nextFacts.salesPathStopped = true;
  }
  if (/follow[ -]?up|whatsapp me|contact me|متابعة|واتساب/i.test(text)) nextIntents.push("follow_up");
  if (/\b(?:do not|don'?t|stop)\s+(?:want\s+(?:any\s+|a\s+)?|(?:to |please )?)(?:follow[ -]?up|contact(?:ing)?|messag(?:e|ing))\b|\bno\s+(?:unsolicited\s+)?follow[ -]?up\b/i.test(text)) {
    nextIntents = without(nextIntents, ["follow_up", "request_call", "callback", "agent", "high_intent"]);
    nextSignals = without(nextSignals, HIGH_INTENT_SIGNALS.concat(["high_intent", "request_call"]));
    nextIntents.push("decline_follow_up");
    nextFacts.contactDeclined = true;
    nextFacts.followUpStatus = "none";
  }
  if (isNegatedReserve(text)) {
    nextIntents = without(nextIntents, ["reserve", "high_intent", "request_call"]);
    nextSignals = without(nextSignals, ["reserve_interest", "high_intent", "request_call"]);
    if (!nextIntents.includes("decline_reserve")) nextIntents.push("decline_reserve");
    nextSignals.push("decline_reserve");
  }

  // Explicit EOI progression is a transaction discussion, never completed
  // submission or call consent. Educational and negated EOI stay excluded.
  if (!isInformationalEoi(text) && !isNegatedReserve(text) &&
      /\b(?:want|ready|please|let'?s|would like)\b.{0,45}\b(?:proceed with|submit|start|make|put in)\b.{0,20}\b(?:an?\s+)?eoi\b/i.test(text)) {
    nextIntents.push("reserve");
    nextSignals.push("reserve_interest");
  }
  // "book a viewing" is viewing research, not a reservation hold.
  if (/\b(book|booking)\b/i.test(text) && /\b(viewing|visit|tour|see it|site visit)\b/i.test(text)) {
    nextIntents = without(nextIntents, ["reserve"]);
    nextSignals = without(nextSignals, ["reserve_interest"]);
    if (!nextIntents.includes("viewing")) nextIntents.push("viewing");
    if (!nextSignals.includes("viewing_request")) nextSignals.push("viewing_request");
  }

  if (wantsCallRequest(text)) {
    if (!nextIntents.includes("request_call")) nextIntents.push("request_call");
    nextSignals.push("request_call");
    nextFacts.salesPathStopped = false;
  }

  if (isDeclineCallOffer(text)) {
    nextIntents = without(nextIntents, ["request_call", "callback", "agent", "high_intent"]);
    nextSignals = without(nextSignals, ["request_call", "callback_request", "agent_request", "high_intent"]);
    if (!nextIntents.includes("decline_call")) nextIntents.push("decline_call");
    nextSignals.push("decline_call");
    // "No calls" restricts one channel; it is not a refusal of all follow-up.
    if (rejectsCallsOnly(text)) nextSignals.push("calls_only");
    else nextFacts.contactDeclined = true;
  }

  const contactPrefs = extractContactPreferences(text);
  if (contactPrefs.preferredContactChannel) {
    nextFacts.preferredContactChannel = contactPrefs.preferredContactChannel;
  }
  if (contactPrefs.noCalls === true) {
    nextFacts.noCalls = true;
    nextIntents.push("no_calls");
  }
  if (contactPrefs.whatsappOnly === true) {
    nextFacts.preferredContactChannel = "whatsapp";
    nextFacts.noCalls = true;
  }
  if (contactPrefs.whatsappOnly || contactPrefs.noCalls) {
    nextIntents = without(nextIntents, ["decline_contact"]);
    nextSignals = without(nextSignals, ["contact_declined"]);
    delete nextFacts.contactDeclined;
  }

  if (isProcessQuestionOnly(text)) {
    nextIntents = without(nextIntents, ["reserve", "viewing", "high_intent"]);
    nextSignals = without(nextSignals, ["reserve_interest", "viewing_request", "high_intent"]);
  }
  if (/\b(?:do not|don'?t|no|cancel)\b.{0,35}\b(?:viewing|visit|tour)\b/i.test(text)) {
    nextIntents = without(nextIntents, ["viewing", "high_intent"]);
    nextSignals = without(nextSignals, ["viewing_request", "high_intent"]);
    nextIntents.push("decline_viewing");
  }

  // Buying interest is conversational only. It never becomes an alert by itself.
  if (hasBuyingInterest(nextIntents, nextSignals, text) && !nextIntents.includes("high_intent")) {
    nextIntents.push("high_intent");
  }
  if (hasBuyingInterest(nextIntents, nextSignals, text) && !nextSignals.includes("high_intent")) {
    nextSignals.push("high_intent");
  }

  nextFacts.intentSignals = [...new Set(nextSignals)];
  return {
    intents: [...new Set(nextIntents)],
    signals: [...new Set(nextSignals)],
    facts: nextFacts
  };
}

export function hasBuyingInterest(intents = [], signals = [], message = "") {
  if (intents.includes("decline_call") || intents.includes("decline_reserve") || intents.includes("eoi_info")) {
    return false;
  }
  return (
    intents.includes("reserve") ||
    intents.includes("viewing") ||
    intents.includes("agent") ||
    intents.includes("callback") ||
    intents.includes("request_call") ||
    /\b(want to buy|ready to buy|i want this|interested in buying)\b/i.test(String(message || "")) ||
    signals.some((s) => HIGH_INTENT_SIGNALS.includes(s))
  );
}

/**
 * Explicit call permission only. Human help and reservations do not imply a call.
 */
export function wantsCallRequest(text) {
  const value = normalizeBuyerText(text).trim();
  if (!value) return false;
  if (isDeclineCallOffer(value)) return false;
  if (isProcessQuestionOnly(value)) return false;

  return /\b(call me|phone me|ring me|can you call|please call|request a call|want a call)\b/i.test(value);

}

export function isProcessQuestionOnly(text) {
  const value = normalizeBuyerText(text);
  return (
    /\b(what|how|which|when|tell me)\b/i.test(value) &&
    /\b(reserve|reservation|eoi|payment plan|need to|required|documents?|process)\b/i.test(value) &&
    !/\b(call me|speak to|talk to|request a call)\b/i.test(value)
  );
}

/**
 * An internal alert for explicit human, call or purchase intent, at most once
 * per conversation session. It tells the broker about the lead; it never grants
 * permission to contact the buyer (that comes only from a confirmed request).
 * Budget, a shortlist or missing information alone never trigger it.
 */
export function intentAlertFor({ message = "", intents = [], moment = null, buyer = {}, followUpSubmitted = false, sessionId = null } = {}) {
  if (followUpSubmitted || buyer.salesPathStopped) return null;
  const kind = intents.includes("request_call") ? "call" : wantsHuman(message) ? "human" : moment === "buying" ? "purchase" : null;
  if (!kind) return null;
  if (sessionId && buyer.intentAlert?.sessionId === sessionId) return null;
  return { kind, evidence: String(message).trim().slice(0, 160) };
}

export function isInformationalEoi(text) {
  const value = normalizeBuyerText(text);
  return (
    /\b(expression of interest|eoi)\b/i.test(value) && /\b(info|information|about|what is|tell me)\b/i.test(value) ||
    (/\b(just\s+)?(interested|looking)\b/i.test(value) &&
      /\b(info|information|details|curious|browsing|for now)\b/i.test(value)) ||
    /\binformational\b/i.test(value)
  );
}

export function isNegatedReserve(text) {
  return /\b(don'?t|do not|not|never)\s+(want to\s+)?(reserve|book|hold|secure|submit\s+(?:an?\s+)?eoi|place\s+(?:an?\s+)?eoi)\b/i.test(normalizeBuyerText(text));
}

export function isDeclineCallOffer(text) {
  const value = normalizeBuyerText(text).trim();
  return (
    explicitlyRejectsCalls(value) ||
    /^(i'?m good|im good|i am good|all good|that'?s all|thats all|no thanks|no thank you)([.!?]*)$/i.test(value) ||
    /\b(i'?m good|im good|i am good)\b/i.test(value) && value.length < 48 ||
    /\b(just browsing|i'?ll let you know|no call|don'?t call|do not call)\b/i.test(value) ||
    /\b(just tell me here|just send (me )?the information|send (it|the info|the information) here|keep it here)\b/i.test(
      value
    ) ||
    /\b(no thanks).+\b(just|here|information|browsing)\b/i.test(value)
  );
}

/** @deprecated use isDeclineCallOffer — kept for older imports */
export function isStopSales(text) {
  return isDeclineCallOffer(text);
}

export function extractContactPreferences(text) {
  const value = normalizeBuyerText(text);
  const prefs = {};
  if (
    /\b(whatsapp only|only whatsapp|prefer whatsapp|whatsapp me|message me on whatsapp|wa only)\b/i.test(value)
  ) {
    prefs.preferredContactChannel = "whatsapp";
    prefs.whatsappOnly = true;
  } else if (/\b(call me|phone me|prefer a call|phone call)\b/i.test(value) && !isDeclineCallOffer(value)) {
    prefs.preferredContactChannel = "phone";
  }
  if (
    explicitlyRejectsCalls(value) || /\b(no calls?|don'?t call|do not call|no phone calls?|without (a )?call|prefer not to (be )?call)/i.test(
      value
    )
  ) {
    prefs.noCalls = true;
  }
  return prefs;
}

/** A call refusal with no wider decline ("no calls please", "don't call me"). */
export function rejectsCallsOnly(text) {
  const value = normalizeBuyerText(text).trim();
  const callWords = explicitlyRejectsCalls(value) || /\b(no calls?|no phone calls?|don'?t call|do not call)\b/i.test(value);
  const wider = /\b(no thanks|no thank you|just browsing|i'?ll let you know|i'?m good|im good|i am good|all good|that'?s all|just tell me here|just send|keep it here|send (it|the info|the information) here)\b/i.test(value);
  return callWords && !wider;
}

function explicitlyRejectsCalls(text) {
  return /\b(?:never|do not|don'?t|stop)\s+(?:(?:want|need)\s+(?:a\s+|any\s+)?|(?:ever |please |to )?)(?:call(?:ing|s)?|phone|ring|telephone)\b|\b(?:no|without)\s+(?:phone\s+|telephone\s+)?calls?\b|\b(?:do not|don'?t)\s+want\s+(?:you\s+)?to\s+(?:call|phone|ring)\b/i.test(normalizeBuyerText(text));
}

export function buildCallRequestSummary(buyer, { matches = [], reason = "Requested a call", intent = null } = {}) {
  const permissions = contactPermissions(buyer);
  const lines = [intent ? `LEAD ALERT: ${intent.kind} intent, contact not requested yet`
    : buyer.preferredContactChannel && buyer.preferredContactChannel !== "phone" ? "FOLLOW-UP REQUEST" : "CALL REQUEST"];
  lines.push(`Instagram ID: ${buyer.instagramUserId || "unknown"}`);
  // What the broker may do first: requested contact and restrictions come from the buyer's own words.
  lines.push(`Contact requested: ${permissions.contactRequested ? "yes" : "no"}`);
  lines.push(`Permitted next action: ${permittedNextAction(buyer)}`);
  if (permissions.restrictions.length) lines.push(`Restrictions: ${permissions.restrictions.join(", ")}`);
  if (intent?.evidence) lines.push(`Buyer said: "${intent.evidence}"`);
  lines.push(`Channel: ${buyer.preferredContactChannel || (intent ? "not chosen" : "phone")}; No calls: ${buyer.noCalls ? "yes" : "no"}`);
  if (buyer.phone) lines.push(`Phone: ${buyer.phone}`);
  if (buyer.name) lines.push(`Name: ${buyer.name}`);
  if (buyer.budgetAed) lines.push(`Budget: AED ${Number(buyer.budgetAed).toLocaleString("en-US")}`);
  if (buyer.preferredAreas?.length) lines.push(`Area: ${buyer.preferredAreas.join(", ")}`);
  if (buyer.bedrooms?.length) {
    const beds = buyer.bedrooms.map((n) => (n === 0 ? "studio" : `${n}BR`)).join(" or ");
    lines.push(`Looking for: ${beds}`);
  }
  if (buyer.propertyTypes?.length) lines.push(`Property type: ${buyer.propertyTypes.join(", ")}`);
  if (buyer.financing && buyer.financing !== "unknown") {
    lines.push(`Payment: ${buyer.financing === "payment_plan" ? "Developer payment plan" : buyer.financing}`);
  }
  if (buyer.cashAvailableAed != null) {
    lines.push(`Initial cash: AED ${Number(buyer.cashAvailableAed).toLocaleString("en-US")}`);
  }
  if (buyer.useType && buyer.useType !== "unknown") lines.push(`Use: ${buyer.useType}`);
  const goal = [buyer.investmentObjective, buyer.exitHorizon && `exit ${buyer.exitHorizon}`, buyer.holdingPeriod && `hold ${buyer.holdingPeriod} years`].filter(Boolean).map(readable);
  if (goal.length) lines.push(`Goal: ${goal.join(", ")}`);
  if (buyer.timeframe) lines.push(`Timeline: ${buyer.timeframe}`);
  if (buyer.priorities?.length) lines.push(`Priorities: ${buyer.priorities.map(readable).join(", ")}`);
  const concerns = (buyer.objections || []).filter(o => !o.resolved && !["no_calls", "not_interested"].includes(o.category)).map(o => readable(o.category));
  if (concerns.length) lines.push(`Concerns: ${[...new Set(concerns)].join(", ")}`);
  // What the human should answer, and what not to offer again.
  if (buyer.handoffTopics?.length) lines.push(`Open questions: ${buyer.handoffTopics.slice(-4).join("; ")}`);
  const unresolved = (buyer.conversation?.unresolved || []).map(row => [row.project, readable(row.topic)].filter(Boolean).join(": "));
  if (unresolved.length) lines.push(`Unconfirmed in our data: ${[...new Set(unresolved)].slice(-4).join("; ")}`);
  if (buyer.conversation?.outcome) lines.push(`Conversation so far: ${OUTCOME_LABELS[buyer.conversation.outcome] || buyer.conversation.outcome}`);
  const declined = (buyer.declinedSuggestions || []).filter(item => item.startsWith("service:")).map(item => readable(item.slice(8)));
  if (buyer.upgradeDeclined) declined.push("upgrade above budget");
  if (declined.length) lines.push(`Declined: ${declined.join(", ")}`);
  const project = matches[0]?.project?.name || buyer.projectInterest;
  if (project) lines.push(`Interested in: ${project}`);
  lines.push(`Requested action: ${buyer.requestedAction || reason}`);
  lines.push(`Reason: ${reason}`);
  if (buyer.conversationSummary) lines.push(`Summary: ${buyer.conversationSummary}`);
  return lines.join("\n");
}

function readable(value) {
  return String(value).replaceAll("_", " ");
}

function without(list, remove) {
  const drop = new Set(remove);
  return list.filter((item) => !drop.has(item));
}
