import { canonicalQuestionField, normalizePreferenceStates } from "./preference-state.js";

/**
 * In-memory turn log keyed by Instagram user id.
 * Persists for the process lifetime; buyer card holds durable facts.
 */
export class ConversationMemory {
  constructor() {
    this.turns = new Map();
    this.pending = new Map();
    this.lastAsked = new Map();
    this.semanticQuestions = new Map();
  }

  getTurns(instagramUserId) {
    return this.turns.get(String(instagramUserId)) || [];
  }

  addTurn(instagramUserId, turn) {
    const id = String(instagramUserId);
    const list = this.getTurns(id);
    list.push({
      ...turn,
      at: turn.at || new Date().toISOString()
    });
    this.turns.set(id, list.slice(-40));
    return this.getTurns(id);
  }

  clear(instagramUserId) {
    this.turns.delete(String(instagramUserId));
    this.pending.delete(String(instagramUserId));
    this.lastAsked?.delete(String(instagramUserId));
    this.semanticQuestions?.delete(String(instagramUserId));
  }

  recentContext(instagramUserId, limit = 8) {
    return this.getTurns(instagramUserId).slice(-limit);
  }

  getPendingOffer(instagramUserId) {
    return this.pending.get(String(instagramUserId)) || null;
  }

  setPendingOffer(instagramUserId, offer) {
    const id = String(instagramUserId);
    if (!offer) {
      this.pending.delete(id);
      return null;
    }
    this.pending.set(id, offer);
    return offer;
  }

  getLastAskedField(instagramUserId) {
    return this.lastAsked?.get(String(instagramUserId)) || null;
  }

  getLastMeaningfulQuestion(instagramUserId) {
    for (const turn of [...this.getTurns(instagramUserId)].reverse()) {
      if (turn.role !== "assistant") continue;
      if (turn.questionField) return turn.questionField;
      if (!["conversation_repair", "education"].includes(turn.stage)) return null;
    }
    return null;
  }

  setLastAskedField(instagramUserId, field) {
    if (!this.lastAsked) this.lastAsked = new Map();
    const id = String(instagramUserId);
    if (!field) {
      this.lastAsked.delete(id);
      return null;
    }
    this.lastAsked.set(id, field);
    const slot = canonicalQuestionField(field);
    if (slot) {
      const history = { ...(this.semanticQuestions?.get(id) || {}) };
      const prior = history[slot];
      history[slot] = { ...prior, state: prior?.state === "flexible" ? "flexible" : "asked", asks: (prior?.asks || 0) + 1, lastAskedAt: new Date().toISOString() };
      this.semanticQuestions.set(id, history);
    }
    return field;
  }

  getQuestionState(instagramUserId, field) {
    const slot = canonicalQuestionField(field);
    return slot ? this.semanticQuestions?.get(String(instagramUserId))?.[slot]?.state || null : null;
  }

  getSemanticQuestionHistory(instagramUserId) {
    return structuredClone(this.semanticQuestions?.get(String(instagramUserId)) || {});
  }

  recordFlexibleFields(instagramUserId, fields = []) {
    return this.recordPreferenceStates(instagramUserId, Object.fromEntries(fields.map(field => [field, "flexible"])));
  }

  recordPreferenceStates(instagramUserId, states = {}) {
    const id = String(instagramUserId);
    const history = { ...(this.semanticQuestions?.get(id) || {}) };
    for (const [slot, state] of Object.entries(normalizePreferenceStates(states))) {
      if (history[slot]?.state === state) continue;
      history[slot] = { ...history[slot], state, answeredAt: new Date().toISOString() };
    }
    this.semanticQuestions.set(id, history);
    return this.getSemanticQuestionHistory(id);
  }

  buildSummary(instagramUserId, buyer) {
    const turns = this.getTurns(instagramUserId);
    const lastUser = [...turns].reverse().find((t) => t.role === "user");
    const parts = [];
    if (buyer?.conversationSummary) parts.push(buyer.conversationSummary);
    if (lastUser?.text) parts.push(`Last buyer message: ${lastUser.text}`);
    return parts.join(" | ").slice(0, 500) || null;
  }
}
