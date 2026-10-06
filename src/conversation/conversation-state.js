// Conversation state describes the decision at hand, never action permission.
export function conversationState({ buyer = {}, message = "", intents = [], recentTurns = [], advisor = {} } = {}) {
  const text = String(message).toLowerCase();
  if (buyer.salesPathStopped || intents.includes("stop")) return "STOPPED";
  if (intents.some(i => ["request_call", "follow_up", "agent", "callback"].includes(i))) return "HANDOFF";
  if (intents.some(i => ["reserve", "viewing"].includes(i))) return "TRANSACTION_PREP";
  if (/\b(?:want to proceed|ready to proceed|let'?s proceed|ready to buy)\b/.test(text) && !/\b(?:not|don'?t|do not)\b/.test(text)) return "HIGH_INTENT";
  if (/\b(?:compare|which.*better|which would you buy|worth|pay.*more)\b/.test(text)) return "COMPARING";
  if (buyer.objections?.some(o => !o.resolved && !["no_calls", "not_interested"].includes(o.category))) return "OBJECTING";
  if (/\b(?:risks?|why|should i|appreciat)\b/.test(text)) return "EVALUATING";
  if (/\b(?:how|what.*mean|explain|learn)\b/.test(text)) return "LEARNING";
  if (buyer.activeRecommendationProjectId || advisor.primary) return "SHORTLISTING";
  if (/\b(?:show|find|search|options|recommend)\b/.test(text)) return "SEARCHING";
  return "EXPLORING";
}
