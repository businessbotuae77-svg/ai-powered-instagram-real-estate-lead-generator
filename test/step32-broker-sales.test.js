import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { setupServices } from "./helpers.js";
import { ConversationEngine } from "../src/conversation/engine.js";
import { ConversationMemory } from "../src/conversation/memory.js";
import { IntegrationOrchestrator } from "../src/integrations/orchestrator.js";
import { brokerProfile, directContactLine } from "../src/conversation/broker-profile.js";
import { normalizeServices, suggestService } from "../src/conversation/services.js";
import { contactDetailViolations } from "../src/conversation/response-validation.js";
import { validateMessage } from "../src/facts/checker.js";

const BROKER_ENV = {
  BROKER_NAME: "Sam Haddad", BROKER_ROLE: "Senior property consultant",
  BROKER_WHATSAPP: "+971 50 123 4567", BROKER_EMAIL: "sam@example.com", BROKER_BOOKING_URL: "https://cal.example.com/sam"
};
const SERVICES = normalizeServices([
  { id: "property_management", enabled: true, name: "Leasing and property management", pitch: "Our leasing and property management service can handle tenant search, contracts and rent collection.", feeText: "5% of the annual rent", triggers: ["rental_investor"], keywords: ["property management", "management"] },
  { id: "mortgage_advice", enabled: true, name: "Mortgage advice", pitch: "Our mortgage advice service can compare bank offers before you commit.", feeText: null, triggers: ["mortgage_buyer", "mortgage_question"], keywords: ["mortgage advice"] },
  { id: "snagging_inspection", enabled: true, name: "Snagging inspection", pitch: "Our snagging inspection checks the unit for defects before you accept the keys.", feeText: "AED 1,500", triggers: ["off_plan_purchase", "ready_purchase"], keywords: ["snagging", "inspection"] },
  { id: "not_offered", enabled: false, name: "Disabled service", pitch: "Never shown.", triggers: ["rental_investor"] }
]);
const INTERNAL_LABELS = /\b(?:challenger|upsell|cross-?sell|smart[_ ]upgrade|opportunity|handoff_offer|advisoryNextAction)\b/i;

async function setup({ broker = BROKER_ENV, services = SERVICES } = {}) {
  const store = await setupServices();
  const engine = new ConversationEngine({ buyers: store.buyers, properties: store.properties, memory: new ConversationMemory(),
    broker: brokerProfile(broker), services });
  return { ...store, engine };
}

async function chat(engine, userId, messages) {
  const replies = [];
  for (const message of messages) {
    const result = await engine.handleMessage(userId, message, { useLlm: false });
    assert.doesNotMatch(result.reply, INTERNAL_LABELS, `internal label in reply to "${message}"`);
    replies.push(result);
  }
  return replies;
}

test("step 32a the assistant is transparent that it is AI, not a licensed broker", async () => {
  const { engine } = await setup();
  for (const question of ["Are you a real person?", "Are you a licensed broker?", "Am I talking to a bot?"]) {
    const [reply] = await chat(engine, `identity_${question}`, [question]);
    assert.equal(reply.stage, "identity");
    assert.match(reply.reply, /AI property assistant, not a person or a licensed broker/);
    assert.match(reply.reply, /Sam Haddad, our senior property consultant,/);
    assert.doesNotMatch(reply.reply, /What budget/i);
  }
});

test("step 32b an immediate request for a person is honored with configured direct details", async () => {
  const { engine } = await setup();
  const [reply] = await chat(engine, "human_now", ["Can I speak to a human?"]);
  assert.equal(reply.stage, "follow_up_channel");
  assert.match(reply.reply, /connect you with Sam Haddad, our senior property consultant/);
  assert.match(reply.reply, /\+971 50 123 4567/);
  assert.match(reply.reply, /sam@example\.com/);
  assert.match(reply.reply, /https:\/\/cal\.example\.com\/sam/);
  assert.match(reply.reply, /Instagram or on WhatsApp\?$/);
  assert.equal((reply.reply.match(/\?/g) || []).length, 1);
});

test("step 32c without configuration the bot never invents a name or contact detail", async () => {
  const { engine } = await setup({ broker: {} });
  const [human] = await chat(engine, "no_config", ["I want to talk to someone"]);
  assert.match(human.reply, /connect you with our team/);
  assert.doesNotMatch(human.reply, /\+?\d{7,}|@|https?:/);
  const [identity] = await chat(engine, "no_config_identity", ["Are you a bot?"]);
  assert.match(identity.reply, /our team can help/);
  assert.equal(brokerProfile({ BROKER_PHONE: "call me", BROKER_EMAIL: "nope", BROKER_BOOKING_URL: "http://insecure.example" }).directContact, false);
});

test("step 32d invented contact details are rejected by validation", () => {
  const permitted = { phones: ["971501234567"], emails: ["sam@example.com"] };
  assert.deepEqual(contactDetailViolations("Reach Sam on +971 50 123 4567 or sam@example.com.", permitted), []);
  assert.equal(contactDetailViolations("Call +971 55 999 0000 now.", permitted).length, 1);
  assert.equal(contactDetailViolations("Email sales@other.example today.", permitted).length, 1);
  // Phone numbers are not mistaken for prices or years.
  assert.equal(validateMessage("Reach Sam on +971 50 202 4567.", []).ok, true);
});

test("step 32e buying intent gets the next step first, then one connection offer", async () => {
  const { engine } = await setup();
  const [, buy] = await chat(engine, "buyer_intent", ["2M budget 2 bed Reem", "I want to buy this"]);
  assert.equal(buy.stage, "transaction_next_step");
  assert.match(buy.reply, /^To move ahead on Reem Gate, the next step/);
  assert.match(buy.reply, /Nothing has been reserved yet/);
  assert.match(buy.reply, /Want me to connect you\?$/);
  assert.equal(buy.pendingOffer?.type, "handoff_offer");
  assert.equal(buy.handoffRequired, false);
});

test("step 32f a quote request uses listing facts and flags what still needs confirming", async () => {
  const { engine } = await setup();
  const [, quote] = await chat(engine, "quote", ["Looking for a 2 bedroom apartment in Yas, budget 2.5M, payment plan, 400k cash", "Can you send me a quote?"]);
  assert.match(quote.reply, /Yas Park Views starts from AED 1,900,000/);
  assert.match(quote.reply, /needs confirming before a quote can be issued/);
  assert.match(quote.reply, /send you a written quote/);
  assert.equal(quote.check.ok, true);
  const { engine: fresh } = await setup();
  const [noContext] = await chat(fresh, "quote_missing", ["Can I get a quote?"]);
  assert.match(noContext.reply, /needs a specific unit/);
  assert.doesNotMatch(noContext.reply, /AED \d/);
});

test("step 32g discounts and urgency are never invented", async () => {
  const { engine } = await setup();
  const [, discount] = await chat(engine, "discount", ["2M budget 2 bed Reem", "Can you get me a discount?"]);
  assert.match(discount.reply, /can't confirm any discount/);
  assert.doesNotMatch(discount.reply, /\b\d+\s*%\s*off|limited time|last unit|only today/i);
});

test("step 32h professional questions are answered generally, with a relevant service and offer", async () => {
  const { engine } = await setup();
  const [mortgage] = await chat(engine, "mortgage", ["Can I get a mortgage as a non-resident?"]);
  assert.equal(mortgage.stage, "professional_topic");
  assert.match(mortgage.reply, /only a bank or mortgage adviser can confirm/);
  assert.match(mortgage.reply, /mortgage advice service/);
  assert.match(mortgage.reply, /Want me to connect you\?$/);
  const [visa] = await chat(engine, "visa", ["Will buying get me a golden visa?"]);
  assert.match(visa.reply, /can't confirm eligibility for your case/);
  assert.doesNotMatch(visa.reply, /AED \d|guarantee/i);
});

test("step 32i a declined connection offer keeps the conversation going and is not repeated", async () => {
  const { engine } = await setup();
  const [, , declined, next, buyAgain] = await chat(engine, "decline_offer", [
    "2M budget 2 bed Reem", "I want to buy this", "no thanks", "What's the handover?", "I want to buy this"]);
  assert.equal(declined.stage, "handoff_declined");
  assert.equal(declined.buyer.salesPathStopped, false);
  assert.equal(declined.pendingOffer, null);
  assert.doesNotMatch(next.reply, /connect you/i);
  // Interest again: direct details instead of asking for permission again.
  assert.doesNotMatch(buyAgain.reply, /Want me to connect you/);
  assert.match(buyAgain.reply, /You can reach Sam directly/);
});

test("step 32j an explicit request after a decline or a pause is still honored", async () => {
  const { engine } = await setup();
  const [, , , human] = await chat(engine, "decline_then_human", ["2M budget 2 bed Reem", "I want to buy this", "no thanks", "Actually, can I talk to someone?"]);
  assert.equal(human.stage, "follow_up_channel");
  const [, , paused] = await chat(engine, "pause_then_human", ["2M budget 2 bed Reem", "I'm good", "I want to speak to an advisor"]);
  assert.equal(paused.stage, "follow_up_channel");
  assert.equal(paused.buyer.salesPathStopped, false);
});

test("step 32k accepting the offer collects only what the follow-up needs and summarises the lead", async () => {
  const { engine } = await setup();
  const replies = await chat(engine, "accept", ["I want to invest, budget 3M, rental income, open on area", "I want to buy this", "yes", "WhatsApp please", "+971501112233"]);
  const [, , channel, number, done] = replies;
  assert.equal(channel.stage, "follow_up_channel");
  assert.equal(number.nextQuestion.field, "phone");
  assert.match(number.reply, /WhatsApp number for Sam/);
  assert.equal(done.stage, "follow_up_requested");
  assert.equal(done.handoffRequired, true);
  assert.match(done.reply, /I'll confirm here once it's through/);
  assert.doesNotMatch(done.reply, /has reached|has been sent/);
  for (const line of [/Budget: AED 3,000,000/, /Goal: rental income/, /Open questions: Next steps to buy Reem Gate/, /Channel: whatsapp/, /Phone: \+971501112233/]) {
    assert.match(done.callSummary, line);
  }
});

test("step 32l a relevant service is suggested once, with its configured fee, and a decline sticks", async () => {
  const { engine } = await setup();
  const [first, why, declined, later] = await chat(engine, "services", [
    "I want to invest, budget 3M, rental income, open on area", "Why that one?", "no need for property management", "Why do you prefer it?"]);
  // A two-option reply stays focused; the service follows in a shorter reply.
  assert.doesNotMatch(first.reply, /property management service/);
  assert.match(why.reply, /leasing and property management service.*The fee is 5% of the annual rent\./s);
  assert.equal(why.check.ok, true);
  assert.equal(declined.stage, "suggestion_declined");
  assert.match(declined.reply, /leave leasing and property management out/);
  assert.ok(declined.buyer.declinedSuggestions.includes("service:property_management"));
  assert.doesNotMatch(later.reply, /property management/);
  assert.doesNotMatch(later.reply, /snagging/, "no new service right after a decline");
});

test("step 32m services are only suggested when relevant and enabled", () => {
  const buyer = { useType: "end_use", declinedSuggestions: [], servicesSuggested: [] };
  assert.equal(suggestService({ buyer, services: SERVICES }), null);
  const investor = { useType: "investment", investmentObjective: "rental_income", declinedSuggestions: [], servicesSuggested: [] };
  assert.equal(suggestService({ buyer: investor, services: SERVICES }).id, "property_management");
  assert.equal(suggestService({ buyer: { ...investor, servicesSuggested: ["property_management:rental_investor"] }, services: SERVICES }), null);
  assert.equal(suggestService({ buyer: { ...investor, salesPathStopped: true }, services: SERVICES }), null);
  assert.equal(SERVICES.some(service => service.id === "not_offered"), false);
});

test("step 32n a relevant upgrade states its extra cost and benefit; no upgrade is pushed without benefit", async () => {
  const { engine } = await setup({ services: [] });
  const [, bigger] = await chat(engine, "upgrade", ["I'm buying to live in, budget 2.8M, Yas, 2 bedrooms", "anything bigger?"]);
  assert.match(bigger.reply, /One step up: Hudayriyat Shores/);
  assert.match(bigger.reply, /extra AED 500,000 in starting price moves you from 2 bedrooms to 3 bedrooms/);
  assert.match(bigger.reply, /trade-off: outside your preferred area/);
  const { engine: tight } = await setup({ services: [] });
  const [, none, , again] = await chat(tight, "no_upgrade", ["2 bed apartment in Yas, budget 2M", "Is there something bigger?", "I don't want to stretch", "anything bigger?"]);
  assert.match(none.reply, /don't have a larger option that fits your budget/);
  assert.equal(again.buyer.upgradeDeclined, true);
  assert.doesNotMatch(again.reply, /One step up/);
});

test("step 32o objections get a specific answer before alternatives", async () => {
  const { engine } = await setup({ services: [] });
  const [, delays] = await chat(engine, "delays", ["budget 3M 2 bed Yas", "I'm worried about developer delays"]);
  assert.match(delays.reply, /^That's a fair concern with off-plan\. A ready home removes construction-delay risk/);
  assert.match(delays.reply, /delay terms in the sale contract/);
  const { engine: price } = await setup({ services: [] });
  const [, , , expensive] = await chat(price, "price", ["I want to invest, budget 3M, rental income, open on area", "Why that one?", "Is there something bigger?", "That's too expensive"]);
  assert.match(expensive.reply, /^Understood\. Let's bring the entry price down/);
  assert.match(expensive.reply, /because it keeps the entry price lower/);
});

test("step 32p budget changes replace the old budget and are explained honestly", async () => {
  const { engine } = await setup({ services: [] });
  const [, lower] = await chat(engine, "budget_change", ["2 bed Yas budget 3M", "actually my budget is 1.5M"]);
  assert.equal(lower.buyer.budgetAed, 1_500_000);
  assert.match(lower.reply, /AED 1,500,000/);
  assert.match(lower.reply, /You asked for 2 bedrooms; this option is 1 bedroom/);
  assert.doesNotMatch(lower.reply, /AED 3,000,000/);
});

test("step 32q a reason is explained without repeating the card or the same question", async () => {
  const { engine } = await setup({ services: [] });
  const [first, why] = await chat(engine, "why", ["I want to invest, budget 3M, rental income, open on area", "Why that one?"]);
  assert.equal(first.nextQuestion.field, "exitHorizon");
  assert.match(why.reply, /^I lean towards Reem Gate because it is ready/);
  assert.match(why.reply, /rental figures still need checking/);
  assert.doesNotMatch(why.reply, /sqft|exiting around handover/);
});

test("step 32r browsing never triggers a handoff offer by message count", async () => {
  const { engine } = await setup();
  const replies = await chat(engine, "browser", ["Hi", "just exploring", "what areas do you cover?", "what projects do you have?",
    "tell me about Yas Park Views", "explain 60/40", "what does EOI mean?", "ok thanks"]);
  for (const reply of replies) {
    assert.notEqual(reply.nextQuestion?.field, "handoffOffer");
    assert.doesNotMatch(reply.reply, /connect you|reach Sam/);
  }
  assert.match(replies[2].reply, /areas I cover include/);
  assert.equal(replies.at(-1).stage, "acknowledged");
});

test("step 32s different customers never share memory, offers or declines", async () => {
  const { engine } = await setup();
  await chat(engine, "customer_a", ["2M budget 2 bed Reem", "I want to buy this"]);
  await chat(engine, "customer_b", ["I want to invest, budget 3M, rental income, open on area"]);
  const [aDecline] = await chat(engine, "customer_a", ["no thanks"]);
  const [bYes] = await chat(engine, "customer_b", ["yes"]);
  assert.equal(aDecline.stage, "handoff_declined");
  assert.notEqual(bYes.stage, "follow_up_channel", "B never received an offer to accept");
  assert.equal(bYes.buyer.budgetAed, 3_000_000);
  assert.equal(aDecline.buyer.budgetAed, 2_000_000);
  assert.deepEqual(bYes.buyer.declinedSuggestions, []);
});

const ENV = { META_PAGE_ACCESS_TOKEN: "test", META_PAGE_ID: "page", WHATSAPP_ACCESS_TOKEN: "test", WHATSAPP_PHONE_NUMBER_ID: "wa", WHATSAPP_ALERT_TO: "971500000000", WHATSAPP_TEMPLATE_NAME: "alert" };
function transport(calls, { whatsappFails = false } = {}) {
  return async (url, options) => {
    const service = url.includes("/wa/") ? "whatsapp" : "instagram";
    calls.push({ service, body: JSON.parse(options.body) });
    if (service === "whatsapp" && whatsappFails) return { ok: false, status: 503, json: async () => ({ error: { message: "outage" } }) };
    return { ok: true, json: async () => ({ message_id: "ig-out", messages: [{ id: "wa-out" }] }) };
  };
}

async function handoffThroughInstagram({ env = ENV, whatsappFails = false } = {}) {
  const { engine, buyers } = await setup();
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "broker-handoff-"));
  const calls = [];
  const orchestrator = new IntegrationOrchestrator({ engine, buyers, rootDir, env, fetchImpl: transport(calls, { whatsappFails }) });
  let index = 0;
  const send = text => orchestrator.processMessageEvent({ mid: `m${index++}`, senderId: "ig_handoff", text }, { useLlm: false });
  await send("2M budget 2 bed Reem");
  await send("I want to buy this");
  await send("yes");
  const outcome = await send("Please follow up here on Instagram");
  const instagram = calls.filter(call => call.service === "instagram").map(call => call.body.message.text);
  return { outcome, calls, instagram };
}

test("step 32t a successful handoff is confirmed only after the alert is delivered", async () => {
  const { outcome, calls, instagram } = await handoffThroughInstagram();
  assert.equal(outcome.pending, false);
  assert.equal(calls.filter(call => call.service === "whatsapp").length, 1);
  assert.match(instagram.at(-1), /^Your request has reached Sam\. Sam will follow up here on Instagram\.$/);
  const summary = calls.find(call => call.service === "whatsapp").body.template.components[0].parameters.at(-1).text;
  assert.match(summary, /Open questions: Next steps to buy Reem Gate/);
});

test("step 32u a failed handoff is reported honestly with direct details, never as sent", async () => {
  const { outcome, instagram } = await handoffThroughInstagram({ whatsappFails: true });
  assert.equal(outcome.pending, true);
  assert.match(instagram.at(-1), /Your request is saved, but I couldn't pass it to Sam just now/);
  assert.match(instagram.at(-1), /If it's urgent: you can reach Sam directly on WhatsApp at \+971 50 123 4567/);
  assert.doesNotMatch(instagram.at(-1), /request has reached|will follow up/);
});

test("step 32v an unconfigured alert channel is not hidden behind a retry promise", async () => {
  const { outcome, instagram } = await handoffThroughInstagram({ env: { META_PAGE_ACCESS_TOKEN: "test", META_PAGE_ID: "page" } });
  assert.equal(outcome.pending, true);
  assert.match(instagram.at(-1), /can't notify Sam automatically right now, so I can't confirm when it will be seen/);
  assert.doesNotMatch(instagram.at(-1), /I'll confirm here/);
});

test("step 32w direct contact line lists only configured channels", () => {
  assert.equal(directContactLine(brokerProfile({ BROKER_NAME: "Sam", BROKER_EMAIL: "sam@example.com" })), "You can reach Sam directly by email at sam@example.com.");
  assert.equal(directContactLine(brokerProfile({ BROKER_BOOKING_URL: "https://cal.example.com/x" })), "You can book a time at https://cal.example.com/x");
  assert.equal(directContactLine(brokerProfile({})), null);
});

test("step 32x ordinary questions are not mistaken for sales or professional moments", async () => {
  const { judgmentTopic, transactionMoment, isIdentityQuestion } = await import("../src/conversation/sales-moments.js");
  for (const text of ["Does the building have a spa?", "Is it a residence for families?", "I will use a mortgage from my bank, what is the price?",
    "Yas Grove Residences?", "I want to buy a 2 bed in Yas", "What is the handover date?"]) {
    assert.equal(judgmentTopic(text), null, text);
    assert.equal(transactionMoment(text), null, text);
    assert.equal(isIdentityQuestion(text), false, text);
  }
  assert.equal(judgmentTopic("Can you review the SPA?"), "legal");
  assert.equal(transactionMoment("Is the price negotiable?"), "discount");
  assert.equal(isIdentityQuestion("Who are you?"), true);
});
