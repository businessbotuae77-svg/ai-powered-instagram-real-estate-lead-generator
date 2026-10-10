// How a conversation ended, kept apart from the reply stage, lead status,
// contact permissions and handoff status. Each turn may move the outcome; the
// outcome of a session is the highest-precedence one reached in it.

/** Highest first. A later turn only replaces the outcome with a higher one. */
export const OUTCOME_PRECEDENCE = [
  "opted_out",            // buyer asked to stop all contact
  "call_requested",       // buyer confirmed a call and a usable number (not an appointment)
  "follow_up_requested",  // buyer confirmed Instagram, or WhatsApp with a usable number
  "info_missing",         // buyer asked something the data cannot confirm
  "shortlist_shown",      // matching options were actually shown
  "no_match",             // requirements were clear and nothing fits
  "not_now",              // buyer paused, declined the handoff or has an agent
  "info_provided",        // buyer asked a question and got a confirmed answer
  "qualifying",           // buyer is sharing requirements; no shortlist yet
  "system_issue",         // the catalogue could not be read
  "browsing"              // general questions, no requirements shared
];

export const OUTCOME_LABELS = {
  opted_out: "Opted out",
  call_requested: "Call requested",
  follow_up_requested: "Follow-up requested",
  info_missing: "Information missing",
  shortlist_shown: "Shortlist shown",
  no_match: "No match",
  not_now: "Not now",
  info_provided: "Information provided",
  qualifying: "Qualifying",
  system_issue: "System issue",
  browsing: "Browsing"
};

/** Hours without a buyer message after which a session's outcome is final. */
export const DEFAULT_FINAL_AFTER_HOURS = 48;

export function finalAfterMs(env = process.env) {
  const hours = Number(env.OUTCOME_FINAL_AFTER_HOURS);
  return (Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_FINAL_AFTER_HOURS) * 3600000;
}

const rank = outcome => {
  const index = OUTCOME_PRECEDENCE.indexOf(outcome);
  return index < 0 ? OUTCOME_PRECEDENCE.length : index;
};

export function higherOutcome(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return rank(b) < rank(a) ? b : a;
}

const BROWSING_STAGES = new Set(["exploring", "welcome_back", "area_guide", "education", "identity", "acknowledged",
  "conversation_repair", "trust_check", "investment_advice", "qualifying", "clarify", "advisor_discovery"]);
const ANSWER_STAGES = new Set(["comparison", "knowledge_answer", "research_answer", "investment_risk", "professional_topic",
  "transaction_next_step"]);

function sharedRequirements(buyer = {}) {
  return Boolean(buyer.budgetAed || buyer.preferredAreas?.length || buyer.bedrooms?.length || buyer.propertyTypes?.length ||
    buyer.projectInterest || buyer.cashAvailableAed);
}

/**
 * What this turn actually achieved. Null = the turn does not change the outcome
 * (a channel question mid-handoff, a permission change, "no thanks" to a service).
 */
export function classifyTurn({ stage, buyer = {}, followUpSubmitted = false, callRequestSubmitted = false,
  shortlistShown = false, factMissing = [] } = {}) {
  if (buyer.salesPathStopped && stage === "paused") return "opted_out";
  if (followUpSubmitted) return callRequestSubmitted ? "call_requested" : "follow_up_requested";
  if (stage === "catalog_unavailable") return "system_issue";
  if (stage === "fact_check_fallback") return "info_missing";
  if (factMissing.length) return "info_missing";
  if (["matched", "soft_match"].includes(stage)) return shortlistShown ? "shortlist_shown" : "info_provided";
  if (["no_match", "objection_unresolved"].includes(stage)) return "no_match";
  if (["paused_advice", "handoff_declined"].includes(stage)) return "not_now";
  if (stage === "fact_answer" || ANSWER_STAGES.has(stage)) return "info_provided";
  if (BROWSING_STAGES.has(stage)) return sharedRequirements(buyer) ? "qualifying" : "browsing";
  return null;
}

/**
 * Fold one turn into the buyer's conversation record. A buyer returning after
 * the inactivity threshold starts a new session; the old one is kept, final.
 */
export function nextConversationState(previous, { outcome, buyer = {}, unresolved = null, now = Date.now(), env = process.env } = {}) {
  const at = new Date(now).toISOString();
  const limit = finalAfterMs(env);
  let state = previous && previous.sessionId ? { ...previous, unresolved: [...(previous.unresolved || [])], history: [...(previous.history || [])] } : null;
  if (state && now - Date.parse(state.lastActivityAt) >= limit) {
    state.history = [...state.history, { sessionId: state.sessionId, outcome: state.outcome, startedAt: state.startedAt,
      endedAt: state.lastActivityAt }].slice(-20);
    state = { ...state, sessionId: null };
  }
  if (!state || !state.sessionId) {
    state = { sessionId: `s_${now}`, startedAt: at, outcome: null, outcomeAt: null, unresolved: [], history: state?.history || [] };
  }
  // A buyer who opted out and later writes back of their own accord lifts the opt-out.
  const current = state.outcome === "opted_out" && !buyer.salesPathStopped ? null : state.outcome;
  const next = higherOutcome(current, outcome);
  if (next !== state.outcome) state.outcomeAt = at;
  state.outcome = next;
  state.lastActivityAt = at;
  if (unresolved) {
    const key = `${unresolved.projectId || ""}:${unresolved.topic}`;
    if (!state.unresolved.some(row => `${row.projectId || ""}:${row.topic}` === key)) state.unresolved = [...state.unresolved, { ...unresolved, at }].slice(-10);
  }
  return state;
}

export function isFinal(state, { now = Date.now(), env = process.env } = {}) {
  return Boolean(state?.lastActivityAt) && now - Date.parse(state.lastActivityAt) >= finalAfterMs(env);
}

/** What the broker may do, derived from the buyer's own words; never from an alert. */
export function contactPermissions(buyer = {}) {
  const optedOut = Boolean(buyer.salesPathStopped);
  const phone = Boolean(buyer.phone);
  const restrictions = [];
  if (optedOut) restrictions.push("opted out of all contact");
  if (buyer.noCalls) restrictions.push("no calls");
  if (buyer.contactDeclined) restrictions.push("declined follow-up");
  const handoff = buyer.handoff?.status || "none";
  return {
    contactRequested: ["requested", "delivered", "failed"].includes(handoff),
    channel: buyer.preferredContactChannel || null,
    instagram: !optedOut,
    whatsapp: !optedOut && !buyer.contactDeclined && phone,
    call: !optedOut && !buyer.contactDeclined && !buyer.noCalls && phone,
    restrictions
  };
}

/** The one action the broker is allowed to take next, in plain words. */
export function permittedNextAction(buyer = {}) {
  const p = contactPermissions(buyer);
  if (p.restrictions.includes("opted out of all contact")) return "Do not contact";
  if (!p.contactRequested) return "Review only: the buyer has not asked to be contacted. Reply on Instagram only if they message again.";
  if (p.channel === "phone" && p.call) return `Call ${buyer.phone}`;
  if (p.channel === "whatsapp" && p.whatsapp) return `Message on WhatsApp ${buyer.phone}${buyer.noCalls ? " (no calls)" : ""}`;
  return "Reply on Instagram";
}
