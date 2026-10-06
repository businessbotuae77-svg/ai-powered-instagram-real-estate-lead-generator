/**
 * In-memory turn log keyed by Instagram user id.
 * Persists for the process lifetime; buyer card holds durable facts.
 */
export class ConversationMemory {
  constructor() {
    this.turns = new Map();
    this.pending = new Map();
    this.lastAsked = new Map();
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
    return field;
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
