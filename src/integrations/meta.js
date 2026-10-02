import crypto from "node:crypto";

const DEFAULT_GRAPH_VERSION = "v21.0";

export function metaConfig(env = process.env) {
  return {
    verifyToken: env.META_VERIFY_TOKEN || "",
    appSecret: env.META_APP_SECRET || "",
    pageAccessToken: env.META_PAGE_ACCESS_TOKEN || "",
    pageId: env.META_PAGE_ID || "",
    graphVersion: env.META_GRAPH_VERSION || DEFAULT_GRAPH_VERSION,
    graphBaseUrl: env.META_GRAPH_BASE_URL || "https://graph.facebook.com"
  };
}

export function verifyWebhookChallenge(query, env = process.env) {
  const mode = String(query["hub.mode"] || "");
  const token = String(query["hub.verify_token"] || "");
  const challenge = String(query["hub.challenge"] || "");
  const expected = metaConfig(env).verifyToken;
  if (mode === "subscribe" && expected && token === expected) {
    return { ok: true, challenge };
  }
  return { ok: false, challenge: null };
}

export function verifySignature(rawBody, signatureHeader, env = process.env) {
  if (String(env.META_SKIP_SIGNATURE_VERIFY || "").toLowerCase() === "true") {
    return true;
  }

  const provided = String(signatureHeader || "");
  if (!provided.startsWith("sha256=")) return false;

  const bodyBuf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || ""), "utf8");
  const secrets = [
    env.META_APP_SECRET,
    env.META_APP_SECRET_ALT
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  for (const secret of [...new Set(secrets)]) {
    const expected = `sha256=${crypto.createHmac("sha256", secret).update(bodyBuf).digest("hex")}`;
    const a = Buffer.from(expected);
    const b = Buffer.from(provided);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  }
  return false;
}

/**
 * Extract inbound Instagram text messages from a Meta webhook payload.
 */
export function parseInstagramMessages(payload) {
  const events = [];
  const entries = Array.isArray(payload?.entry) ? payload.entry : [];
  for (const entry of entries) {
    const messaging = Array.isArray(entry.messaging) ? entry.messaging : [];
    for (const item of messaging) {
      const message = item.message;
      if (!message || message.is_echo) continue;
      const text = String(message.text || "").trim();
      if (!text) continue;
      const senderId = String(item.sender?.id || "").trim();
      const mid = String(message.mid || "").trim();
      if (!senderId || !mid) continue;
      events.push({
        mid,
        senderId,
        text,
        timestamp: item.timestamp || null,
        entryId: entry.id || null
      });
    }
  }
  return events;
}

function isInstagramUserToken(token) {
  return /^IGAA/i.test(String(token || ""));
}

/**
 * Instagram Login tokens use graph.instagram.com /me/messages.
 * Facebook Page tokens use graph.facebook.com /{page-id}/messages.
 */
export function instagramSendUrl(env = process.env) {
  const config = metaConfig(env);
  if (isInstagramUserToken(config.pageAccessToken)) {
    const igBase = env.META_IG_GRAPH_BASE_URL || "https://graph.instagram.com";
    return `${igBase}/${config.graphVersion}/me/messages`;
  }
  return `${config.graphBaseUrl}/${config.graphVersion}/${config.pageId}/messages`;
}

export async function sendInstagramText({
  recipientId,
  text,
  env = process.env,
  fetchImpl = fetch
} = {}) {
  const config = metaConfig(env);
  const igToken = isInstagramUserToken(config.pageAccessToken);
  if (!config.pageAccessToken || (!igToken && !config.pageId)) {
    throw new Error("META_PAGE_ACCESS_TOKEN and META_PAGE_ID are required to send Instagram replies");
  }
  const url = instagramSendUrl(env);
  const payload = {
    recipient: { id: String(recipientId) },
    message: { text: String(text || "").slice(0, 1000) }
  };
  if (!igToken) payload.messaging_type = "RESPONSE";

  const response = await fetchImpl(url, {
    method: "POST",
    signal: AbortSignal.timeout(15000),
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.pageAccessToken}`
    },
    body: JSON.stringify(payload)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = body?.error?.message || response.statusText || "Instagram send failed";
    const error = new Error(detail);
    error.status = response.status;
    error.retryable = response.status >= 500 || response.status === 429;
    throw error;
  }
  if (!body.message_id && !body.id) throw new Error("Instagram response did not confirm a message id");
  return {
    recipientId: body.recipient_id || recipientId,
    messageId: body.message_id || body.id || null
  };
}

/**
 * Ensure the Instagram professional account is subscribed to messaging webhook fields.
 * UI toggles alone are not always enough for Instagram Login apps.
 */
export async function subscribeInstagramMessaging({
  env = process.env,
  fetchImpl = fetch,
  fields = ["messages", "messaging_postbacks", "messaging_seen", "message_reactions"]
} = {}) {
  const config = metaConfig(env);
  if (!config.pageAccessToken) {
    return { skipped: true, reason: "missing_access_token" };
  }
  if (!isInstagramUserToken(config.pageAccessToken)) {
    return { skipped: true, reason: "not_instagram_user_token" };
  }
  const igBase = env.META_IG_GRAPH_BASE_URL || "https://graph.instagram.com";
  const url = `${igBase}/${config.graphVersion}/me/subscribed_apps?subscribed_fields=${encodeURIComponent(fields.join(","))}`;
  const response = await fetchImpl(url, {
    method: "POST",
    signal: AbortSignal.timeout(15000),
    headers: {
      authorization: `Bearer ${config.pageAccessToken}`
    }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = body?.error?.message || response.statusText || "subscribe failed";
    const error = new Error(detail);
    error.status = response.status;
    error.retryable = response.status >= 500 || response.status === 429;
    throw error;
  }
  return { skipped: false, ok: Boolean(body.success ?? true), body };
}

export async function getInstagramAccountIdentity({
  env = process.env,
  fetchImpl = fetch
} = {}) {
  const config = metaConfig(env);
  if (!config.pageAccessToken || !isInstagramUserToken(config.pageAccessToken)) {
    return { skipped: true, reason: "missing_instagram_user_token" };
  }
  const igBase = env.META_IG_GRAPH_BASE_URL || "https://graph.instagram.com";
  const url = `${igBase}/${config.graphVersion}/me?fields=id,username,account_type`;
  const response = await fetchImpl(url, {
    headers: { authorization: `Bearer ${config.pageAccessToken}` }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = body?.error?.message || response.statusText || "identity lookup failed";
    const error = new Error(detail);
    error.status = response.status;
    throw error;
  }
  return {
    skipped: false,
    id: body.id || null,
    username: body.username || null,
    accountType: body.account_type || null
  };
}
