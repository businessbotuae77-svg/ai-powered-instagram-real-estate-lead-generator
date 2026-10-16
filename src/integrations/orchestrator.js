import { POLICY_VERSION } from "../conversation/policy.js";
import { recordCommercialEvent } from "../conversation/commercial-events.js";
import { createHash, randomUUID } from "node:crypto";
import { IntegrationLog } from "./integration-log.js";
import { ProcessedEventStore } from "./processed-events.js";
import { AlertLedger, CallRequestStore } from "./whatsapp.js";
import { sendAdvisorAlert } from "./alerts.js";
import { fetchInstagramProfileName, parseInstagramMessages, sendInstagramSenderAction, sendInstagramText, verifySignature, verifyWebhookChallenge } from "./meta.js";
import { firstNameFrom } from "../conversation/names.js";
import { runtimeRoot } from "./json-store.js";
import { KeyedQueue } from "../conversation/keyed-queue.js";
import { handoffConfirmation, handoffFailureNotice } from "../conversation/contact.js";
import { priceInquirySaved } from "../conversation/price-inquiry.js";

export function messageEventAgeMs(event, now = Date.now()) {
  const raw = Number(event?.timestamp);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const timestampMs = raw < 1_000_000_000_000 ? raw * 1000 : raw;
  return Math.max(0, now - timestampMs);
}

/** The parts of an engine result a retry or a duplicate lookup reads. */
export function retryResult(result) {
  const { reply, stage, intents, buyer, alertReason, alertRecommended, callRequest, callRequestSubmitted,
    followUpSubmitted, callSummary, catalogError, matchCount, handoffRequired, intentAlert, outcome } = result;
  return { reply, stage, intents, buyer: buyer ? { ...buyer, commercialEvents: undefined } : buyer, alertReason, alertRecommended, callRequest, callRequestSubmitted,
    followUpSubmitted, callSummary, catalogError, matchCount, handoffRequired, intentAlert: intentAlert || null, outcome: outcome || null, compact: true,
    commercialDecision: result.commercialDecision || null,
    instagramPriceRequest: result.instagramPriceRequest || null,
    // Quick-reply buttons are re-sent on a retry, so keep the question.
    nextQuestion: result.nextQuestion ? { field: result.nextQuestion.field, prompt: result.nextQuestion.prompt, choices: result.nextQuestion.choices || null } : null,
    matches: (result.matches || []).map(m => ({ project: { id: m.project?.id, name: m.project?.name }, unit: { id: m.unit?.id } })) };
}

/** Blocks webhook+poller double replies when Meta message ids differ. */
export function contentDedupKey(event) {
  const senderId = String(event?.senderId || "").trim();
  const text = String(event?.quickReplyLabel || event?.text || "").trim().toLowerCase();
  if (!senderId || !text) return null;
  const ageMs = messageEventAgeMs(event);
  const bucketMs = ageMs === null ? Date.now() : Date.now() - ageMs;
  const minute = Math.floor(bucketMs / 60_000);
  const hash = createHash("sha1").update(text).digest("hex").slice(0, 12);
  return `content:${senderId}:${hash}:${minute}`;
}

/**
 * Milestone 3 orchestrator: webhook -> engine -> IG reply.
 * Advisor alerts follow explicit channel-aware requests. Each integration has durable progress.
 */
export class IntegrationOrchestrator {
  constructor({
    engine,
    buyers,
    env = process.env,
    fetchImpl = fetch,
    rootDir = null,
    log = null,
    events = null,
    alerts = null,
    callRequests = null
  } = {}) {
    if (!engine) throw new Error("IntegrationOrchestrator requires engine");
    this.engine = engine;
    this.buyers = buyers;
    this.env = env;
    this.fetchImpl = fetchImpl;
    this.rootDir = rootDir || runtimeRoot(env);
    this.log = log || new IntegrationLog({ rootDir: this.rootDir });
    this.events = events || new ProcessedEventStore({ rootDir: this.rootDir });
    this.alerts = alerts || new AlertLedger({ rootDir: this.rootDir });
    this.callRequests = callRequests || new CallRequestStore({ rootDir: this.rootDir });
    // One sender's messages are handled in order; different senders in parallel.
    this.processing = new KeyedQueue();
  }

  handleVerify(query) {
    return verifyWebhookChallenge(query, this.env);
  }

  async handleWebhook({ rawBody, signatureHeader }) {
    const signatureOk = verifySignature(rawBody, signatureHeader, this.env);
    if (!signatureOk) {
      await this.log.record({
        integration: "meta",
        operation: "webhook",
        status: "error",
        message: "invalid_signature",
        retryable: false,
        meta: {
          hasSignature: Boolean(signatureHeader),
          bodyBytes: Buffer.byteLength(String(rawBody || ""), "utf8")
        }
      });
      return { ok: false, status: 403, error: "invalid_signature" };
    }
    let payload;
    try {
      payload = JSON.parse(String(rawBody || "{}"));
    } catch {
      await this.log.record({
        integration: "meta",
        operation: "webhook",
        status: "error",
        message: "invalid_json",
        retryable: false
      });
      return { ok: false, status: 400, error: "invalid_json" };
    }

    const messages = parseInstagramMessages(payload);
    await this.log.record({
      integration: "meta",
      operation: "webhook",
      status: "ok",
      message: `accepted_${messages.length}`,
      retryable: false,
      meta: {
        object: payload?.object || null,
        entryCount: Array.isArray(payload?.entry) ? payload.entry.length : 0,
        messageCount: messages.length,
        entryIds: [...new Set(messages.map((message) => message.entryId).filter(Boolean))],
        senderIds: [...new Set(messages.map((message) => message.senderId).filter(Boolean))]
      }
    });

    for (const event of messages) await this.events.enqueue(event);

    this.#processMessages(messages).catch(async (error) => {
      await this.log.record({
        integration: "orchestrator",
        operation: "queue",
        status: "error",
        message: error.message,
        retryable: false
      });
    });

    return { ok: true, status: 200, accepted: messages.length };
  }

  processMessageEvent(event, options = {}) {
    return this.processing.run(String(event?.senderId || ""), () => this.#processMessageEvent(event, options));
  }

  async retryPending() {
    for (const row of await this.events.pending()) await this.processMessageEvent(row.event, { retry: true });
  }

  async #processMessageEvent(event, options = {}) {
    const mid = event.mid;
    if (!mid || !event.senderId) throw new Error("Message event requires id and sender");
    const saved = await this.events.get(mid);
    const startedAt = saved?.at || new Date().toISOString();
    if (saved?.status === "completed") return { duplicate: true, mid };
    const resuming = saved && saved.status !== "queued";
    if (resuming && !options.retry) return { duplicate: true, mid, pending: true };
    const dedupe = contentDedupKey(event);
    if (dedupe && !resuming) {
      const priorContent = await this.events.get(dedupe);
      const sameTransport = priorContent && priorContent.source === (event.source || "webhook");
      const contentClaimed = sameTransport || await this.events.claim(dedupe, {
        mid,
        senderId: event.senderId,
        source: event.source || "webhook"
      });
      if (contentClaimed && !sameTransport) await this.events.complete(dedupe);
      if (!contentClaimed) {
        await this.events.claim(mid, { duplicateOf: dedupe, senderId: event.senderId });
        await this.events.complete(mid, { skipped: true, skipReason: "content_duplicate" });
        return { duplicate: true, mid, reason: "content_duplicate" };
      }
    }

    const claimed = resuming || await this.events.claim(mid, {
      senderId: event.senderId,
      text: String(event.text || "").slice(0, 120),
      source: event.source || "webhook"
    });
    if (!claimed) {
      return { duplicate: true, mid };
    }

    const previous = saved || {};
    await this.events.save(mid, { event, status: "processing", attempts: (previous.attempts || 0) + 1 });

    const defaultMaxAge = event.source === "poller" ? 15 * 60 * 1000 : 5 * 60 * 1000;
    const maxAgeMs = Number(this.env.META_MAX_EVENT_AGE_MS || defaultMaxAge);
    const ageMs = messageEventAgeMs(event, saved?.at ? Date.parse(saved.at) : Date.now());
    if (!resuming && ageMs !== null && Number.isFinite(maxAgeMs) && maxAgeMs >= 0 && ageMs > maxAgeMs) {
      await this.events.complete(mid, {
        skipped: true,
        skipReason: "stale_message",
        ageMs
      });
      await this.log.record({
        correlationId: mid,
        integration: "meta",
        operation: "message",
        status: "skipped",
        message: "stale_message",
        retryable: false,
        meta: { senderId: event.senderId, ageMs }
      });
      return { duplicate: false, skipped: true, reason: "stale_message", mid, ageMs };
    }

    // "Seen" and "typing…" straight away, so the buyer sees the reply coming.
    const presence = !event.callRequest && !previous.send ? this.#presence(event.senderId) : Promise.resolve();
    try {
      if (!previous.result && !event.callRequest) await this.#rememberProfileName(event.senderId);
      const result = previous.result || (event.callRequest
        ? await this.engine.submitCallRequest(event.senderId, event.phone, { useLlm: false })
        : await this.engine.handleMessage(event.senderId, event.text, { useLlm: options.useLlm }));
      // Store only what a retry needs. The full result carries the whole
      // catalogue analysis and made this file grow by megabytes per message.
      await this.events.save(mid, { result: retryResult(result) });
      if (result.commercialDecision?.selected) {
        await this.#recordCommercial(result, event, "home_type_selected", { selected: result.commercialDecision.selected,
          at: startedAt });
      }
      const alert = previous.alert || await this.#safeCallRequestAlert(result, event);
      const needsAlert = result.alertRecommended;
      const revoked = alert.reason === "permission_revoked";
      const alertOk = !alert.error && (!alert.skipped || alert.reason === "duplicate_alert" || revoked);
      const priceRequestSaved = Boolean(result.instagramPriceRequest && alert.recorded && !revoked);
      if (alertOk || !needsAlert) await this.events.save(mid, { alert });
      if (needsAlert) await this.#recordHandoff(result, alertOk && !revoked ? "delivered" : revoked ? "cancelled" : priceRequestSaved ? "requested" : "failed");
      if (needsAlert && alertOk && !revoked) {
        await this.#recordCommercial(result, event, "broker_request_delivered", { deliveryKey: alert.key, at: alert.deliveredAt || undefined });
        const serviceRequest = result.commercialDecision?.serviceRequest || result.buyer?.serviceRequest;
        if (serviceRequest?.status === "requested" && serviceRequest.serviceId) {
          await this.#recordCommercial(result, event, "service_request_delivered", { serviceId: serviceRequest.serviceId, deliveryKey: alert.key, at: alert.deliveredAt || undefined });
        }
      }
      let send = previous.send;
      // Typing indicators must land before the reply, never after it.
      await presence;
      // Never leave the buyer in silence: if the alert failed, say so once and
      // keep retrying. A confirmation is sent only after delivery succeeds.
      let notice = previous.notice;
      if (needsAlert && !alertOk && !priceRequestSaved && !notice) {
        const text = handoffFailureNotice(result.buyer, this.engine.broker, { unconfigured: /env incomplete/i.test(alert.reason || "") });
        notice = event.callRequest ? { uiOnly: true, text } : await this.#safeInstagramSend(event.senderId, text, mid);
        if (!notice.error && !notice.skipped) await this.events.save(mid, { notice: { ...notice, text } });
        if (event.callRequest) result.reply = text;
      }
      if (!send && (!needsAlert || alertOk || priceRequestSaved)) {
        const reply = revoked ? "Your contact preferences changed, so the earlier follow-up request was cancelled." : priceRequestSaved
          ? priceInquirySaved(result.instagramPriceRequest.projectName, result.buyer.language === "ar") : needsAlert
          ? handoffConfirmation(result.buyer, this.engine.broker)
          : result.reply;
        send = event.callRequest ? { skipped: false, uiOnly: true } : await this.#safeInstagramSend(
          event.senderId, reply, mid, result.callRequest,
          !needsAlert && !revoked ? result.nextQuestion?.choices : null, previous.sendProgress
        );
        if (!send.error && !send.skipped) await this.events.save(mid, { send });
        if (needsAlert && (alertOk || priceRequestSaved)) result.reply = reply;
      }
      // The internal lead alert goes after the buyer's reply, so a slow email or
      // WhatsApp provider never delays it. It is retried like any delivery and
      // never changes the reply.
      const intentAlert = previous.intentAlert?.ok ? previous.intentAlert : await this.#safeIntentAlert(result, event);
      if (intentAlert.ok) await this.events.save(mid, { intentAlert });
      const failed = (needsAlert && !alertOk && !priceRequestSaved) || Boolean(intentAlert.error) || !send || send.error || send.skipped;
      if (send && !send.error && !send.skipped && !send.uiOnly && result.commercialDecision?.comparisonId) {
        await this.#recordCommercial(result, event, "comparison_delivered", {
          comparisonId: result.commercialDecision.comparisonId, pair: result.commercialDecision.pair, at: send.confirmedAt || undefined
        });
      }
      if (failed) {
        await this.events.save(mid, { status: "failed", nextAttemptAt: Date.now() + Math.min(3600000, 30000 * 2 ** (previous.attempts || 0)) });
      } else {
        await this.events.complete(mid, { outboundMessageId: send.messageId || null, alertKey: alert.key || null });
      }
      await this.log.record({ correlationId: mid, integration: "conversation", operation: "decision", status: failed ? "pending" : "ok",
        meta: { policyVersion: POLICY_VERSION, intents: result.intents, stage: result.stage, matchCount: result.matchCount, sourceResultCount: result.projectKnowledge?.projectNames?.length || 0, handoffRequired: result.handoffRequired, catalogUnavailable: Boolean(result.catalogError), comparison: Boolean(result.commercialDecision?.comparisonId), selection: Boolean(result.commercialDecision?.selected) } });
      return { duplicate: false, mid, result, send, alert, intentAlert, pending: Boolean(failed) };
    } catch (error) {
      await this.events.fail(mid, { message: error.message });
      await this.events.save(mid, { nextAttemptAt: Date.now() + 30000 });
      await this.log.record({
        correlationId: mid,
        integration: "orchestrator",
        operation: "processMessageEvent",
        status: "error",
        message: error.message,
        retryable: Boolean(error.retryable),
        meta: { senderId: event.senderId }
      });
      throw error;
    }
  }

  /**
   * Deliver a handoff produced outside the webhook (the web test chat) and
   * return the honest buyer-facing outcome.
   */
  notifyAdvisor(result, { requestKey, senderId }) {
    return this.processing.run(String(senderId || result.buyer?.instagramUserId || ""), () => this.#notifyAdvisor(result, { requestKey, senderId }));
  }

  async #notifyAdvisor(result, { requestKey, senderId }) {
    if (!result.followUpSubmitted || !result.alertRecommended) return { alert: { skipped: true, reason: "not_a_submitted_call_request" }, reply: result.reply };
    const alert = await this.#safeCallRequestAlert(result, { mid: requestKey, senderId });
    const ok = !alert.error && (!alert.skipped || alert.reason === "duplicate_alert");
    const priceRequestSaved = Boolean(result.instagramPriceRequest && alert.recorded && alert.reason !== "permission_revoked");
    await this.#recordHandoff(result, ok ? "delivered" : priceRequestSaved ? "requested" : "failed");
    if (ok) {
      const event = { mid: requestKey, senderId };
      await this.#recordCommercial(result, event, "broker_request_delivered", { deliveryKey: alert.key, at: alert.deliveredAt || undefined });
      const service = result.commercialDecision?.serviceRequest || result.buyer?.serviceRequest;
      if (service?.status === "requested" && service.serviceId) await this.#recordCommercial(result, event, "service_request_delivered", { serviceId: service.serviceId, deliveryKey: alert.key, at: alert.deliveredAt || undefined });
    }
    const reply = priceRequestSaved ? priceInquirySaved(result.instagramPriceRequest.projectName, result.buyer.language === "ar")
      : ok ? handoffConfirmation(result.buyer, this.engine.broker)
      : handoffFailureNotice(result.buyer, this.engine.broker, { unconfigured: /env incomplete/i.test(alert.reason || "") });
    return { alert, ok: ok || priceRequestSaved, reply };
  }

  async processCallRequest({ userId, phone, messageId = null } = {}) {
    const event = { mid: messageId || `call_${userId}_${randomUUID()}`, senderId: userId, text: "Request a Call", phone, callRequest: true };
    const output = await this.processMessageEvent(event, { useLlm: false });
    if (output.duplicate) {
      const saved = await this.events.get(event.mid);
      return { ...output, result: saved.result, alert: { skipped: true, reason: "duplicate_alert" } };
    }
    return output;
  }

  async #processMessages(messages) {
    return Promise.all(messages.map(event => this.processMessageEvent(event)));
  }

  async #safeInstagramSend(recipientId, text, mid, callRequest = null, choices = null, sendProgress = null) {
    try {
      let outbound = text;
      if (callRequest?.offered) {
        outbound = `${text}\n\nRequest a Call: reply with the phone number you want us to use.`;
      }
      const replyHash = createHash("sha256").update(JSON.stringify({ text: outbound, choices })).digest("hex");
      const sent = await sendInstagramText({
        recipientId,
        text: outbound,
        choices,
        sentMessageIds: sendProgress?.replyHash === replyHash ? sendProgress.messageIds : [],
        onMessageSent: messageIds => this.events.save(mid, { sendProgress: { replyHash, messageIds } }),
        env: this.env,
        fetchImpl: this.fetchImpl
      });
      return { ...sent, confirmedAt: new Date().toISOString() };
    } catch (error) {
      await this.log.record({
        correlationId: mid,
        integration: "instagram",
        operation: "send",
        status: "error",
        message: error.message,
        retryable: Boolean(error.retryable),
        meta: { recipientId }
      });
      return { skipped: true, error: error.message };
    }
  }

  #presence(recipientId) {
    if (String(this.env.INSTAGRAM_TYPING_INDICATOR || "true").toLowerCase() === "false") return Promise.resolve();
    const act = action => sendInstagramSenderAction({ recipientId, action, env: this.env, fetchImpl: this.fetchImpl }).catch(() => null);
    return Promise.all([act("mark_seen"), act("typing_on")]);
  }

  // A first name lets the welcome greet the buyer personally. Looked up once.
  async #rememberProfileName(senderId) {
    if (!this.buyers?.getOrCreate || !this.buyers.patchBuyer) return;
    if (String(this.env.INSTAGRAM_PROFILE_NAMES || "true").toLowerCase() === "false") return;
    try {
      const buyer = await this.buyers.getOrCreate(senderId);
      if (buyer?.profileCheckedAt) return;
      const firstName = firstNameFrom(await fetchInstagramProfileName({ userId: senderId, env: this.env, fetchImpl: this.fetchImpl }));
      await this.buyers.patchBuyer(senderId, { profileCheckedAt: new Date().toISOString(), ...(firstName ? { firstName } : {}) });
    } catch {
      // A name is a nicety; the reply goes out without it.
    }
  }

  async #recordCommercial(result, event, type, details = {}) {
    const { deliveryKey, ...facts } = details;
    const id = deliveryKey ? `${deliveryKey}:${type}` : `${event.mid}:${type}`;
    const recorded = await recordCommercialEvent(this.buyers, event.senderId, {
      id, type, sessionId: result.buyer?.conversation?.sessionId, ...facts
    });
    if (type === "service_request_delivered" && recorded?.serviceRequest?.status === "requested" &&
        recorded.serviceRequest.serviceId === details.serviceId) {
      const deliveredAt = recorded.commercialEvents.find(row => row.id === id)?.at;
      await this.buyers.patchBuyer(event.senderId, { serviceRequest: { ...recorded.serviceRequest, status: "delivered", deliveredAt } });
    }
  }

  /** Handoff delivery status on the buyer record, for reporting. */
  async #recordHandoff(result, status) {
    if (!this.buyers?.patchBuyer || !result.buyer?.instagramUserId) return;
    const latest = await this.buyers.getOrCreate?.(result.buyer.instagramUserId);
    const at = new Date().toISOString();
    await this.buyers.patchBuyer(result.buyer.instagramUserId, { handoff: { ...(latest?.handoff || result.buyer.handoff || {}), status,
      ...(status === "delivered" ? { deliveredAt: at } : status === "failed" ? { failedAt: at } : {}) } });
  }

  /**
   * Internal lead alert for explicit human, call or purchase intent. The lead is
   * recorded before sending, so a failed send is retried, never lost.
   */
  async #safeIntentAlert(result, event) {
    if (!result.intentAlert) return { skipped: true, reason: "no_intent_alert" };
    const buyerId = result.buyer?.instagramUserId;
    try {
      const latest = await this.buyers?.getOrCreate?.(buyerId);
      if (latest?.salesPathStopped) return { skipped: true, reason: "opted_out" };
      await this.callRequests.record({ requestKey: `${event.mid}:intent`, kind: "intent", intent: result.intentAlert.kind,
        instagramUserId: buyerId, summary: result.intentAlert.summary, match: result.matches?.[0]?.project?.name || null });
      const alert = await sendAdvisorAlert({
        buyer: result.buyer, reason: `intent_${result.intentAlert.kind}`, matchName: result.matches?.[0]?.project?.name || "",
        messageId: event.mid, summaryText: result.intentAlert.summary, env: this.env, fetchImpl: this.fetchImpl, ledger: this.alerts
      });
      const ok = !alert.skipped || alert.reason === "duplicate_alert";
      await this.buyers?.patchBuyer?.(buyerId, { intentAlert: { ...(latest?.intentAlert || {}), status: ok ? "delivered" : "not_sent",
        reason: ok ? null : alert.reason || null } });
      return { ...alert, ok, recorded: true };
    } catch (error) {
      await this.log.record({ correlationId: event.mid, integration: "alerts", operation: "intent_alert", status: "error",
        message: error.message, retryable: Boolean(error.retryable), meta: { senderId: buyerId } });
      await this.buyers?.patchBuyer?.(buyerId, { intentAlert: { ...(result.buyer?.intentAlert || {}), status: "failed" } });
      return { skipped: true, error: error.message, recorded: true };
    }
  }

  async #safeCallRequestAlert(result, event) {
    if ((!result.callRequestSubmitted && !result.followUpSubmitted) || !result.alertRecommended) {
      return { skipped: true, reason: "not_a_submitted_call_request" };
    }

    let recorded = false;
    try {
      const latest = await this.buyers?.getOrCreate?.(result.buyer.instagramUserId);
      if (latest?.salesPathStopped || (latest?.preferredContactChannel && latest.preferredContactChannel !== result.buyer.preferredContactChannel) || (result.buyer.preferredContactChannel === "phone" && latest?.noCalls)) return { skipped: true, reason: "permission_revoked" };
      await this.callRequests.record({
        requestKey: event.mid,
        instagramUserId: result.buyer.instagramUserId,
        phone: result.buyer.phone,
        summary: result.callSummary,
        match: result.matches?.[0]?.project?.name || null
      });

      recorded = true;
      const alert = await sendAdvisorAlert({
        buyer: result.buyer,
        reason: result.alertReason || "call_request",
        matchName: result.matches?.[0]?.project?.name || "",
        messageId: event.mid,
        summaryText: result.callSummary || "",
        env: this.env,
        fetchImpl: this.fetchImpl,
        ledger: this.alerts
      });
      if (!alert.skipped && this.buyers?.patchBuyer) {
        await this.buyers.patchBuyer(result.buyer.instagramUserId, {
          lastAlertKey: alert.key,
          lastAlertAt: new Date().toISOString()
        });
      }
      return { ...alert, recorded: true };
    } catch (error) {
      await this.log.record({
        correlationId: event.mid,
        integration: "alerts",
        operation: "call_request_alert",
        status: "error",
        message: error.message,
        retryable: Boolean(error.retryable),
        meta: { senderId: result.buyer.instagramUserId }
      });
      return { skipped: true, error: error.message, recorded };
    }
  }
}
