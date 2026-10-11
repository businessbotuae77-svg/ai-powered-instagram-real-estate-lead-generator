import assert from "node:assert/strict";
import test from "node:test";
import { setupConversation, talk } from "./helpers.js";
import { classifyTurn, contactPermissions, isFinal, nextConversationState, permittedNextAction } from "../src/conversation/outcomes.js";

// Every reply must answer and, unless the buyer paused or opted out, leave one
// clear next step; the recorded outcome must match what actually happened.
const FILLER = /That's everything I have|No problem, take your time|No rush/;


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
