// A reply that answers and then stops leaves the buyer with nothing to do.
// After the answer, add at most one useful next step that fits this reply:
// a question, or an offer of the broker for what the data cannot confirm.
// Pauses, opt-outs, declines and natural endings ("thanks") stay as they are.

const QUIET_STAGES = new Set(["paused", "paused_advice", "permissions_updated", "handoff_declined", "acknowledged",
  "suggestion_declined", "identity", "conversation_repair", "call_requested", "follow_up_requested"]);

function say(buyer, en, ar) {
  return buyer.language === "ar" ? ar : en;
}

/** Whether a broker offer was made in the last few replies; it is not repeated. */
export function offeredRecently(turns = []) {
  return turns.filter(turn => turn.role === "assistant").slice(-3).some(turn => turn.questionField === "handoffOffer");
}

/**
 * The next step for a reply that has none, or null. Returns either a handoff
 * reason (the engine words the offer and checks it was not declined) or a
 * question to append.
 */
export function nextStepFor(draft, { buyer = {}, recentTurns = [] } = {}) {
  if (!draft || draft.nextQuestion || draft.pendingOffer || draft.handoffReason) return null;
  if (buyer.salesPathStopped || QUIET_STAGES.has(draft.stage)) return null;
  const canOffer = !offeredRecently(recentTurns);
  const offer = (reason, topic) => canOffer ? { handoffReason: reason, handoffTopic: topic } : null;
  const ask = (field, en, ar) => ({ question: { field, prompt: say(buyer, en, ar) } });

  if (draft.stage === "fact_answer" && draft.factMissing?.length) {
    const first = draft.factMissing[0];
    return offer("verify", `Confirm ${readable(first.topic)}${first.project ? ` for ${first.project}` : ""}`);
  }
  if (draft.stage === "knowledge_answer" && draft.unpriced) return offer("verify", "Confirm current pricing and home types");
  if (draft.stage === "comparison") {
    return ask("comparisonPreference", "Which of the two fits your priorities better?", "أي الخيارين يناسب أولوياتك أكثر؟");
  }
  if (["research_answer", "investment_risk"].includes(draft.stage)) return offer("research", "Project-specific investment evidence");
  if (["no_match", "objection_unresolved"].includes(draft.stage)) return offer("match", "Options outside the current listings");
  if (draft.stage === "catalog_unavailable") return offer("system", "Requirements kept while the listings were unavailable");
  return null;
}

function readable(topic) {
  return { paymentPlan: "the payment plan", initial: "the initial payment", price: "the price", handover: "the handover date",
    availability: "availability", rent: "rental figures" }[topic] || String(topic || "the details");
}
