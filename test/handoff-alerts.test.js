import assert from "node:assert/strict";
import test from "node:test";
import { setupOrchestrator } from "./helpers.js";
import { sendAdvisorAlert, sendDailyReport } from "../src/integrations/alerts.js";
import { reportDeliveryConfig } from "../src/reporting/outcome-report.js";

// The buyer is told a request reached the team only after the alert was
// delivered; failures are honest and retried; nothing is alerted twice.

test("an Instagram follow-up is confirmed only after the broker alert is delivered", async () => {
  const { send, sent, alertText, buyers } = await setupOrchestrator();
  await send("ig_ok", "How much is Yas Waterfront Residences?");
  await send("ig_ok", "yes");
  const outcome = await send("ig_ok", "Here on Instagram");
  assert.equal(outcome.pending, false);
  const replies = sent("instagram").map(call => call.body.message.text);
  assert.match(replies.at(-1), /^Your request has reached our team\. We'll follow up here on Instagram\.$/);
  const alert = alertText(sent("whatsapp").at(-1));
  assert.match(alert, /^FOLLOW-UP REQUEST/);
  assert.match(alert, /Contact requested: yes/);
  assert.match(alert, /Permitted next action: Reply on Instagram/);
  assert.match(alert, /Unconfirmed in our data: Yas Waterfront Residences: price/);
  assert.equal((await buyers.getOrCreate("ig_ok")).handoff.status, "delivered");
});

test("a failed alert is reported honestly to the buyer and never as sent", async () => {
  const { send, sent, buyers } = await setupOrchestrator({ state: { down: ["whatsapp"] } });
  await send("ig_fail", "Can I talk to someone?");
  const outcome = await send("ig_fail", "Here on Instagram");
  assert.equal(outcome.pending, true);
  const last = sent("instagram").at(-1).body.message.text;
  assert.match(last, /Your request is saved, but I couldn't pass it to our team just now/);
  assert.doesNotMatch(last, /request has reached|We'll follow up/);
  assert.equal((await buyers.getOrCreate("ig_fail")).handoff.status, "failed");
});

test("a lead alert for 'talk to a human' is retried until delivered, sent once, reply not repeated", async () => {
  const { orchestrator, sent, alertText, buyers, state } = await setupOrchestrator({ state: { down: ["whatsapp"] } });
  const event = { mid: "m-human", senderId: "ig_lead", text: "Can I talk to a human?" };
  assert.equal((await orchestrator.processMessageEvent(event, { useLlm: false })).pending, true);
  assert.equal((await buyers.getOrCreate("ig_lead")).intentAlert.status, "failed");
  state.down = [];
  assert.equal((await orchestrator.processMessageEvent(event, { retry: true })).pending, false);
  await orchestrator.processMessageEvent(event, { retry: true });
  assert.equal((await buyers.getOrCreate("ig_lead")).intentAlert.status, "delivered");
  assert.equal(sent("instagram").length, 1, "the buyer reply is not resent on retry");
  const alert = alertText(sent("whatsapp").at(-1));
  assert.match(alert, /^LEAD ALERT: human intent, contact not requested yet/);
  assert.match(alert, /Contact requested: no/);
  assert.match(alert, /Buyer said: "Can I talk to a human\?"/);
});

test("'I want to buy' alerts the broker but grants no contact permission", async () => {
  const { send, sent, alertText } = await setupOrchestrator();
  await send("ig_buy", "Budget 2M, 2 bedroom in Yas");
  await send("ig_buy", "I want to buy this");
  const alert = alertText(sent("whatsapp").at(-1));
  assert.match(alert, /^LEAD ALERT: purchase intent/);
  assert.match(alert, /Permitted next action: Review only/);
});

test("a budget or a shortlist alone never alerts the broker", async () => {
  const { send, sent } = await setupOrchestrator();
  await send("ig_quiet", "Budget 2M, 2 bedroom in Yas");
  await send("ig_quiet", "Tell me more about the payment plan");
  assert.equal(sent("whatsapp").length, 0);
});

test("WhatsApp handoff asks for a number once, then records the request; no calls are permitted", async () => {
  const { send, sent, alertText, buyers } = await setupOrchestrator();
  await send("ig_wa", "Can someone follow up on WhatsApp?");
  await send("ig_wa", "0501234567");
  const buyer = await buyers.getOrCreate("ig_wa");
  assert.equal(buyer.noCalls, true);
  assert.equal(buyer.handoff.status, "delivered");
  assert.match(alertText(sent("whatsapp").at(-1)), /Permitted next action: Message on WhatsApp .* \(no calls\)/);
});

test("opting out stops lead alerts", async () => {
  const { send, sent } = await setupOrchestrator();
  await send("ig_stop", "stop");
  const before = sent("whatsapp").length;
  await send("ig_stop", "Budget 2M in Yas");
  assert.equal(sent("whatsapp").length, before);
});

test("interest with a previously preferred contact channel never starts phone collection", async () => {
  const { send, buyers, sent } = await setupOrchestrator();
  await buyers.patchBuyer("interest-only", { preferredContactChannel: "whatsapp" });
  await send("interest-only", "Budget 2M, 2 bedroom in Yas");
  await send("interest-only", "I want to buy this");
  const buyer = await buyers.getOrCreate("interest-only");
  assert.equal(buyer.phone, null);
  assert.notEqual(buyer.handoff.status, "requested");
  assert.doesNotMatch(sent("instagram").at(-1).body.message.text, /phone number|WhatsApp number|what number/i);
});

test("English and Gulf Arabic stops cancel pending handoff and qualification", async () => {
  for (const refusal of ["I'm good", "no thanks", "لا شكراً", "خلاص"]) {
    const { send, sent, buyers, engine } = await setupOrchestrator();
    await send("decline", "Call me");
    const before = sent("whatsapp").length;
    await send("decline", refusal);
    const buyer = await buyers.getOrCreate("decline");
    assert.equal(engine.memory.getPendingOffer("decline"), null, refusal);
    assert.equal(buyer.phone, null);
    assert.equal(sent("whatsapp").length, before, refusal);
    assert.doesNotMatch(sent("instagram").at(-1).body.message.text, /[?؟]|phone number|budget|ميزاني|رقم/i);
  }
});

test("no-call preferences cancel a pending call and persist during later advice", async () => {
  for (const refusal of ["No calls please", "لا تتصل علي", "ما أبي مكالمات"]) {
    const { send, sent, buyers, engine } = await setupOrchestrator();
    await send("no-calls", "Call me");
    await send("no-calls", refusal);
    assert.equal((await buyers.getOrCreate("no-calls")).noCalls, true, refusal);
    assert.equal(engine.memory.getPendingOffer("no-calls"), null);
    await send("no-calls", "What is the price of Yas Studio One?");
    assert.equal((await buyers.getOrCreate("no-calls")).noCalls, true);
    assert.doesNotMatch(sent("instagram").at(-1).body.message.text, /call you|phone number|arrange a call|موعد|رقم/i);
  }
});

// Email delivery (Resend) for alerts and the daily report.
const EMAIL_ENV = { RESEND_API_KEY: "re_test", ALERT_EMAIL_TO: "broker@example.com" };
function memoryLedger() {
  const keys = new Set();
  return { has: async key => keys.has(key), mark: async key => { keys.add(key); return true; } };
}
function resend(calls, { fail = false } = {}) {
  return async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body), auth: options.headers.authorization });
    return fail ? { ok: false, status: 503, json: async () => ({}) } : { ok: true, json: async () => ({ id: "email_1" }) };
  };
}
const buyer = { instagramUserId: "ig_1", budgetAed: 2000000 };

test("an alert is emailed once, with the summary's first line as the subject", async () => {
  const calls = [], ledger = memoryLedger();
  const summary = "LEAD ALERT: human intent, contact not requested yet\nContact requested: no";
  const first = await sendAdvisorAlert({ buyer, reason: "intent_human", summaryText: summary, env: EMAIL_ENV, fetchImpl: resend(calls), ledger });
  assert.equal(first.channels.email, "sent");
  assert.deepEqual(calls[0].body.to, ["broker@example.com"]);
  assert.match(calls[0].body.subject, /^LEAD ALERT: human intent/);
  const again = await sendAdvisorAlert({ buyer, reason: "intent_human", summaryText: summary, env: EMAIL_ENV, fetchImpl: resend(calls), ledger });
  assert.equal(again.reason, "duplicate_alert");
  assert.equal(calls.length, 1);
});

test("a failed email is retried later, and alerts without any channel are reported as not sent", async () => {
  const ledger = memoryLedger();
  await assert.rejects(sendAdvisorAlert({ buyer, reason: "follow_up", summaryText: "x", env: EMAIL_ENV, fetchImpl: resend([], { fail: true }), ledger }));
  assert.equal((await sendAdvisorAlert({ buyer, reason: "follow_up", summaryText: "x", env: EMAIL_ENV, fetchImpl: resend([]), ledger })).skipped, false);
  assert.match((await sendAdvisorAlert({ buyer, reason: "follow_up", env: {} })).reason, /env incomplete/);
});

test("the daily report is emailed once a day at the configured hour, and is off until configured", async () => {
  const env = { ...EMAIL_ENV, REPORT_DELIVERY_ENABLED: "true", REPORT_HOUR_DUBAI: "11" };
  const delivery = reportDeliveryConfig(env);
  assert.deepEqual(delivery, { enabled: true, channel: "email", recipient: "broker@example.com", hour: 11 });
  const calls = [], ledger = memoryLedger();
  await sendDailyReport({ text: "report", day: "2026-10-10", delivery, env, fetchImpl: resend(calls), ledger });
  assert.equal((await sendDailyReport({ text: "report", day: "2026-10-10", delivery, env, fetchImpl: resend(calls), ledger })).reason, "already_sent");
  assert.equal(calls.length, 1);
  assert.equal(reportDeliveryConfig({}).enabled, false);
  assert.equal(reportDeliveryConfig({ ...EMAIL_ENV, REPORT_DELIVERY_ENABLED: "true" }).enabled, false, "no hour, no delivery");
});
