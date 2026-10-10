import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { setupConversation } from "./helpers.js";
import { IntegrationOrchestrator } from "../src/integrations/orchestrator.js";
import { classifyTurn, contactPermissions, isFinal, nextConversationState, permittedNextAction } from "../src/conversation/outcomes.js";
import { buildDailyReport, formatDailyReport, reportDeliveryConfig } from "../src/reporting/outcome-report.js";

// Every reply must answer and, unless the buyer paused or opted out, leave one
// clear next step; the recorded outcome must match what actually happened.
const FILLER = /That's everything I have|No problem, take your time|No rush/;

async function talk(messages, id = "buyer") {
  const services = await setupConversation();
  const turns = [];
  for (const message of messages) turns.push(await services.engine.handleMessage(id, message, { useLlm: false }));
  return { ...services, turns, last: turns.at(-1) };
}

test("exact match shows a shortlist and offers one next step", async () => {
  const { last } = await talk(["Budget 2M, 2 bedroom in Yas"]);
  assert.equal(last.stage, "matched");
  assert.equal(last.outcome, "shortlist_shown");
  assert.equal((last.reply.match(/\?/g) || []).length, 1);
  assert.equal(last.intentAlert, null, "a budget and a shortlist alone never alert the broker");
});

test("near match after an objection is still a shortlist, with the trade-off stated", async () => {
  const { last } = await talk(["Budget 2M, 2 bedroom in Yas", "That is too expensive"]);
  assert.equal(last.stage, "soft_match");
  assert.equal(last.outcome, "shortlist_shown");
  assert.match(last.reply, /Keep in mind/);
});

test("no match offers broker help instead of stopping", async () => {
  const { last } = await talk(["Villa on Hudayriyat, 6 bedrooms, budget 3M"]);
  assert.equal(last.stage, "no_match");
  assert.equal(last.outcome, "no_match");
  assert.match(last.reply, /look beyond what I have listed here/);
  assert.equal(last.buyer.handoff.status, "offered");
  assert.equal(contactPermissions(last.buyer).contactRequested, false, "an offer is not a request");
});

test("a comparison ends with one question about the buyer's priorities", async () => {
  const { last } = await talk(["Compare Yas Park Views and Yas Studio One"]);
  assert.equal(last.stage, "comparison");
  assert.equal(last.outcome, "info_provided");
  assert.equal(last.nextQuestion.field, "comparisonPreference");
  assert.equal(last.check.ok, true);
});

test("missing project details: says what is unknown, offers verification, records the question", async () => {
  const { last } = await talk(["How much is Yas Waterfront Residences?"]);
  assert.equal(last.stage, "fact_answer");
  assert.equal(last.outcome, "info_missing");
  assert.match(last.reply, /starting price is not confirmed yet/);
  assert.match(last.reply, /check this with the developer/);
  assert.doesNotMatch(last.reply, /AED/);
  assert.deepEqual(last.buyer.conversation.unresolved.map(row => row.topic), ["price"]);
});

test("missing details in Arabic: the unknown is named and verification is offered in Arabic", async () => {
  const { turns, last } = await talk(["كم سعر Yas Waterfront Residences؟", "نعم", "هنا على إنستغرام"]);
  assert.match(turns[0].reply, /سعر البداية غير مؤكد بعد/);
  assert.match(turns[0].reply, /هل تريد أن أوصلك به؟/);
  assert.doesNotMatch(turns[0].reply, /not confirmed/);
  assert.equal(turns[1].stage, "follow_up_channel");
  assert.equal(last.stage, "follow_up_requested");
  assert.equal(last.outcome, "follow_up_requested");
  assert.equal(last.buyer.preferredContactChannel, "instagram");
});

test("'I want to buy' raises an internal lead alert but is not a contact request", async () => {
  const { last } = await talk(["Budget 2M, 2 bedroom in Yas", "I want to buy this"]);
  assert.equal(last.stage, "transaction_next_step");
  assert.equal(last.intentAlert.kind, "purchase");
  assert.match(last.intentAlert.summary, /Contact requested: no/);
  assert.match(last.intentAlert.summary, /Permitted next action: Review only/);
  assert.equal(last.followUpSubmitted, false);
  assert.equal(last.outcome, "shortlist_shown");
});

test("a human request on WhatsApp asks for a number once, then records the request", async () => {
  const { turns, last } = await talk(["Can I talk to someone?", "WhatsApp", "0501234567"]);
  assert.equal(turns[0].intentAlert.kind, "human");
  assert.equal(turns[1].stage, "follow_up_phone");
  assert.equal(turns[1].outcome, null, "asking for a number is not a booked follow-up");
  assert.equal(last.outcome, "follow_up_requested");
  assert.equal(last.buyer.handoff.status, "requested");
  assert.match(last.callSummary, /Permitted next action: Message on WhatsApp/);
});

test("Arabic human request on WhatsApp", async () => {
  const { turns, last } = await talk(["أريد التحدث مع شخص", "واتساب", "0501234567"]);
  assert.equal(turns[0].intentAlert.kind, "human");
  assert.equal(turns[1].stage, "follow_up_phone");
  assert.equal(last.outcome, "follow_up_requested");
});

test("a call is 'requested', never 'booked', and only once a number is submitted", async () => {
  const { engine, turns } = await talk(["Call me"]);
  assert.equal(turns[0].stage, "call_offer");
  assert.equal(turns[0].outcome, null);
  const submitted = await engine.submitCallRequest("buyer", "+971501234567");
  assert.equal(submitted.stage, "call_requested");
  assert.equal(submitted.outcome, "call_requested");
  assert.equal(permittedNextAction(submitted.buyer), "Call +971501234567");
});

test("an ambiguous 'yes' with nothing pending does not hand off or alert", async () => {
  const { last } = await talk(["yes"]);
  assert.equal(last.followUpSubmitted, false);
  assert.equal(last.intentAlert, null);
  assert.equal(last.outcome, "browsing");
});

test("repeating a human request does not alert twice in one session", async () => {
  const { turns } = await talk(["Can I talk to a human?", "Can I talk to a human?"]);
  assert.equal(turns[0].intentAlert.kind, "human");
  assert.equal(turns[1].intentAlert, null);
  for (const turn of turns) assert.doesNotMatch(turn.reply, FILLER);
});

test("a declined handoff is not offered again", async () => {
  const { turns } = await talk(["How much is Yas Waterfront Residences?", "no thanks", "What is the handover for Yas Waterfront Residences?"]);
  assert.equal(turns[1].stage, "handoff_declined");
  assert.equal(turns[1].buyer.handoff.status, "declined");
  assert.doesNotMatch(turns[2].reply, /Want me to connect you/);
  assert.match(turns[2].reply, /handover is not confirmed yet/);
});

test("'not now' after a shortlist keeps the shortlist outcome and asks nothing", async () => {
  const { last } = await talk(["Budget 2M, 2 bedroom in Yas", "I need time to think"]);
  assert.equal(last.stage, "paused_advice");
  assert.equal(last.turnOutcome, "not_now");
  assert.equal(last.outcome, "shortlist_shown");
  assert.equal(last.nextQuestion, null);
});

test("'no calls' is a channel restriction, not an opt-out or a declined handoff", async () => {
  const { last } = await talk(["No calls please"]);
  assert.equal(last.buyer.noCalls, true);
  assert.notEqual(last.buyer.handoff?.status, "declined");
  const permissions = contactPermissions({ ...last.buyer, phone: "+971501234567" });
  assert.equal(permissions.call, false);
  assert.equal(permissions.instagram, true);
  assert.deepEqual(permissions.restrictions, ["no calls"]);
});

test("full opt-out ends quietly; the buyer's own later request lifts it", async () => {
  const { turns } = await talk(["Budget 2M in Yas", "stop", "Call me"]);
  assert.equal(turns[1].outcome, "opted_out");
  assert.equal(turns[1].nextQuestion, null);
  assert.equal(permittedNextAction(turns[1].buyer), "Do not contact");
  assert.equal(turns[2].stage, "call_offer");
});

test("Airtable failure keeps requirements and offers a retry through the broker", async () => {
  const { engine } = await setupConversation();
  await engine.handleMessage("outage", "Budget 3M Yas 2 bedrooms", { useLlm: false });
  engine.properties.refresh = async () => { throw new Error("timeout"); };
  const result = await engine.handleMessage("outage", "Show me options", { useLlm: false });
  assert.equal(result.stage, "catalog_unavailable");
  assert.equal(result.turnOutcome, "system_issue");
  assert.match(result.reply, /kept your requirements/);
  assert.match(result.reply, /take your requirements now/);
  assert.doesNotMatch(result.reply, /catalogue/);
  assert.equal(result.buyer.budgetAed, 3000000);
});

test("a thank-you ends naturally", async () => {
  const { last } = await talk(["thanks"]);
  assert.equal(last.stage, "acknowledged");
  assert.equal(last.nextQuestion, null);
});

test("outcome precedence, finality and a returning buyer", () => {
  const t0 = Date.parse("2026-10-10T08:00:00Z");
  let state = nextConversationState(null, { outcome: "browsing", now: t0 });
  state = nextConversationState(state, { outcome: "shortlist_shown", now: t0 + 60000 });
  state = nextConversationState(state, { outcome: "not_now", now: t0 + 120000 });
  assert.equal(state.outcome, "shortlist_shown", "a lower outcome never replaces a higher one");
  assert.equal(isFinal(state, { now: t0 + 3600000 }), false);
  assert.equal(isFinal(state, { now: t0 + 49 * 3600000 }), true, "default: final after 48 hours");
  assert.equal(isFinal(state, { now: t0 + 3 * 3600000, env: { OUTCOME_FINAL_AFTER_HOURS: "2" } }), true);
  const back = nextConversationState(state, { outcome: "browsing", now: t0 + 72 * 3600000 });
  assert.notEqual(back.sessionId, state.sessionId, "a returning buyer starts a new session");
  assert.equal(back.outcome, "browsing");
  assert.equal(back.history.at(-1).outcome, "shortlist_shown");
  assert.equal(classifyTurn({ stage: "fact_check_fallback" }), "info_missing");
  assert.equal(classifyTurn({ stage: "professional_topic" }), "info_provided", "a professional topic is answered, not missing");
  assert.equal(classifyTurn({ stage: "investment_risk" }), "info_provided");
  assert.equal(classifyTurn({ stage: "exploring", buyer: { budgetAed: 2000000 } }), "qualifying");
  assert.equal(classifyTurn({ stage: "exploring" }), "browsing");
});

const ENV = { META_PAGE_ACCESS_TOKEN: "test", META_PAGE_ID: "page", WHATSAPP_ACCESS_TOKEN: "test", WHATSAPP_PHONE_NUMBER_ID: "wa",
  WHATSAPP_ALERT_TO: "971500000000", WHATSAPP_TEMPLATE_NAME: "alert" };

function transport(calls, state) {
  return async (url, options) => {
    const service = url.includes("/wa/") ? "whatsapp" : "instagram";
    calls.push({ service, body: JSON.parse(options.body) });
    if (service === "whatsapp" && state.whatsappDown) return { ok: false, status: 503, json: async () => ({ error: { message: "outage" } }) };
    return { ok: true, json: async () => ({ message_id: "ig-out", messages: [{ id: `wa-${calls.length}` }] }) };
  };
}

test("a failed lead alert is retried until delivered, never duplicated, and the buyer reply is sent once", async () => {
  const { engine, buyers } = await setupConversation();
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "outcome-alerts-"));
  const calls = [], state = { whatsappDown: true };
  const orchestrator = new IntegrationOrchestrator({ engine, buyers, rootDir, env: ENV, fetchImpl: transport(calls, state) });
  const event = { mid: "m-human", senderId: "ig_lead", text: "Can I talk to a human?" };
  const first = await orchestrator.processMessageEvent(event, { useLlm: false });
  assert.equal(first.pending, true);
  assert.equal((await buyers.getOrCreate("ig_lead")).intentAlert.status, "failed");
  state.whatsappDown = false;
  const retried = await orchestrator.processMessageEvent(event, { retry: true });
  assert.equal(retried.pending, false);
  assert.equal((await buyers.getOrCreate("ig_lead")).intentAlert.status, "delivered");
  await orchestrator.processMessageEvent(event, { retry: true });
  const delivered = calls.filter(call => call.service === "whatsapp" && !state.whatsappDown);
  assert.equal(calls.filter(call => call.service === "instagram").length, 1, "the buyer's reply is not resent on retry");
  assert.ok(delivered.length >= 1);
  const summaries = calls.filter(call => call.service === "whatsapp").map(call => call.body.template.components[0].parameters.at(-1).text);
  assert.match(summaries.at(-1), /^LEAD ALERT: human intent, contact not requested yet/);
  assert.match(summaries.at(-1), /Buyer said: "Can I talk to a human\?"/);
});

test("a delivered follow-up request is marked delivered and appears in the daily report", async () => {
  const { engine, buyers, store } = await setupConversation();
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "outcome-report-"));
  const calls = [];
  const orchestrator = new IntegrationOrchestrator({ engine, buyers, rootDir, env: ENV, fetchImpl: transport(calls, {}) });
  let i = 0;
  const send = text => orchestrator.processMessageEvent({ mid: `r${i++}`, senderId: "ig_report", text }, { useLlm: false });
  await send("How much is Yas Waterfront Residences?");
  await send("yes");
  await send("Here on Instagram");
  const buyer = await buyers.getOrCreate("ig_report");
  assert.equal(buyer.handoff.status, "delivered");
  await engine.handleMessage("ig_open", "What is the handover for Yas Waterfront Residences?", { useLlm: false });
  const day = new Date(Date.now() + 4 * 3600000).toISOString().slice(0, 10);
  const report = buildDailyReport({ buyers: store.snapshot().buyers, callRequests: await orchestrator.callRequests.list(), day });
  assert.equal(report.outcomes.follow_up_requested, 1);
  assert.equal(report.outcomes.info_missing, 1);
  assert.equal(report.handoffs.delivered, 1);
  assert.deepEqual(report.unresolved.map(row => row.buyer), ["ig_open"], "a delivered handoff is no longer an open lead");
  assert.match(formatDailyReport(report), /Unanswered questions to follow up \(1\)/);
  assert.equal(reportDeliveryConfig({}).enabled, false, "delivery stays off until configured");
  assert.equal(reportDeliveryConfig({ REPORT_DELIVERY_ENABLED: "true", REPORT_RECIPIENT: "9715", REPORT_HOUR_DUBAI: "9" }).enabled, true);
});
