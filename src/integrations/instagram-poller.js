/**
 * Fallback inbound path when Meta webhooks do not deliver message events.
 * Polls Instagram Conversations API with the existing IG user token.
 */

const DEFAULT_GRAPH_VERSION = "v21.0";

function igBase(env = process.env) {
  return env.META_IG_GRAPH_BASE_URL || "https://graph.instagram.com";
}

function graphVersion(env = process.env) {
  return env.META_GRAPH_VERSION || DEFAULT_GRAPH_VERSION;
}

function accessToken(env = process.env) {
  return String(env.META_PAGE_ACCESS_TOKEN || "").trim();
}

function isInstagramUserToken(token) {
  return /^IGAA/i.test(String(token || ""));
}

async function igGet(path, { env = process.env, fetchImpl = fetch } = {}) {
  const token = accessToken(env);
  const url = `${igBase(env)}/${graphVersion(env)}/${path}${path.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}`;
  const response = await fetchImpl(url);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = body?.error?.message || response.statusText || "Instagram GET failed";
    const error = new Error(detail);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

export async function fetchOwnInstagramIdentity({ env = process.env, fetchImpl = fetch } = {}) {
  if (!isInstagramUserToken(accessToken(env))) {
    return { skipped: true, reason: "missing_instagram_user_token" };
  }
  const body = await igGet("me?fields=id,username,account_type", { env, fetchImpl });
  return {
    skipped: false,
    id: body.id || null,
    username: body.username || null,
    accountType: body.account_type || null
  };
}

/**
 * Pull recent inbound text messages that still need a reply.
 */
export async function listRecentInboundMessages({
  env = process.env,
  fetchImpl = fetch,
  botId = null,
  conversationLimit = 8,
  messageLimit = 8
} = {}) {
  if (!isInstagramUserToken(accessToken(env))) {
    return { skipped: true, reason: "missing_instagram_user_token", events: [] };
  }

  let identity = botId ? { id: botId } : null;
  if (!identity?.id) {
    const me = await fetchOwnInstagramIdentity({ env, fetchImpl });
    if (me.skipped || !me.id) return { skipped: true, reason: "identity_unavailable", events: [] };
    identity = me;
  }

  const selfIds = new Set(
    [identity.id, env.META_PAGE_ID, env.META_IG_USER_ID]
      .map((value) => String(value || "").trim())
      .filter(Boolean)
  );

  const conversations = await igGet(
    `me/conversations?fields=id,updated_time,participants&limit=${conversationLimit}`,
    { env, fetchImpl }
  );

  const events = [];
  for (const conversation of conversations.data || []) {
    const conversationId = conversation.id;
    if (!conversationId) continue;

    let messagesPayload;
    try {
      messagesPayload = await igGet(
        `${conversationId}?fields=messages.limit(${messageLimit}){id,created_time,from,to,message}`,
        { env, fetchImpl }
      );
    } catch {
      // Older threads can fail message expansion; skip quietly.
      continue;
    }

    const messages = messagesPayload.messages?.data || [];
    for (const row of messages) {
      const mid = String(row.id || "").trim();
      const text = String(row.message || "").trim();
      const senderId = String(row.from?.id || "").trim();
      if (!mid || !text || !senderId) continue;
      if (selfIds.has(senderId)) continue;
      events.push({
        mid,
        senderId,
        text,
        timestamp: row.created_time ? Date.parse(row.created_time) : null,
        entryId: conversationId,
        source: "poller"
      });
    }
  }

  // Oldest first so memory builds naturally within a thread batch.
  events.sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));
  return { skipped: false, botId: identity.id, events };
}

export class InstagramConversationPoller {
  constructor({
    orchestrator,
    env = process.env,
    fetchImpl = fetch,
    intervalMs = Number(env.INSTAGRAM_POLL_INTERVAL_MS || 12000),
    log = null
  } = {}) {
    if (!orchestrator) throw new Error("InstagramConversationPoller requires orchestrator");
    this.orchestrator = orchestrator;
    this.env = env;
    this.fetchImpl = fetchImpl;
    this.intervalMs = Math.max(5000, Number(intervalMs) || 12000);
    this.log = log;
    this.timer = null;
    this.running = false;
    this.botId = null;
    this.cycle = Promise.resolve();
  }

  start() {
    if (this.timer) return;
    if (!isInstagramUserToken(accessToken(this.env))) return;
    if (String(this.env.INSTAGRAM_POLLER_ENABLED || "true").toLowerCase() === "false") return;

    const tick = () => {
      this.cycle = this.cycle
        .then(() => this.pollOnce())
        .catch(async (error) => {
          if (this.log) {
            await this.log.record({
              integration: "instagram",
              operation: "poll",
              status: "error",
              message: error.message,
              retryable: true
            });
          }
        });
    };

    tick();
    this.timer = setInterval(tick, this.intervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async pollOnce() {
    if (this.running) return { skipped: true, reason: "busy" };
    this.running = true;
    try {
      const listed = await listRecentInboundMessages({
        env: this.env,
        fetchImpl: this.fetchImpl,
        botId: this.botId
      });
      if (listed.botId) this.botId = listed.botId;
      if (listed.skipped) return listed;

      let processed = 0;
      for (const event of listed.events) {
        const outcome = await this.orchestrator.processMessageEvent(event, { useLlm: true });
        if (!outcome?.duplicate && !outcome?.skipped) processed += 1;
      }

      if (this.log && processed > 0) {
        await this.log.record({
          integration: "instagram",
          operation: "poll",
          status: "ok",
          message: `processed_${processed}`,
          retryable: false,
          meta: { scanned: listed.events.length, processed }
        });
      }
      return { skipped: false, scanned: listed.events.length, processed };
    } finally {
      this.running = false;
    }
  }
}
