import assert from "node:assert/strict";
import test from "node:test";
import { setupConversation } from "./helpers.js";
import { brokerPayload, buildBrokerContext, brokerEligible, repairBrokerReply, validateBrokerReply } from "../src/conversation/broker-mode.js";
import { loadAreaGuide } from "../src/facts/area-guide.js";

// A fake Claude for broker mode: `reply(payload)` returns the JSON it should send.
function brokerClient(reply, seen = []) {
  return {
    apiKey: "test-only", model: "test-model", baseUrl: "https://example.test",
    fetchImpl: async (_url, request) => {
      const body = JSON.parse(request.body);
      if (!/senior property advisor/.test(body.system)) return { ok: false, status: 503, json: async () => ({}) };
      const payload = JSON.parse(body.messages[0].content);
      seen.push(payload);
      const output = reply(payload);
      return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: typeof output === "string" ? output : JSON.stringify(output) }] }) };
    }
  };
}

async function contextFor(engineSetup, userId, messages) {
  for (const message of messages) await engineSetup.engine.handleMessage(userId, message, { useLlm: false });
  const buyer = await engineSetup.buyers.getOrCreate(userId);
  const catalog = engineSetup.properties.catalog();
  return { buyer, catalog };
}

test("broker context is compact, in-budget first, and carries only confirmed listing facts", async () => {
  const setup = await setupConversation();
  const { buyer, catalog } = await contextFor(setup, "ctx", ["Invest", "5M"]);
  const context = buildBrokerContext({ catalog, buyer, message: "Best overall", areaGuide: loadAreaGuide() });
  assert.ok(context.listings.length > 0 && context.listings.length <= 16);
  assert.ok(context.listings.every(row => row.withinBudget !== false), JSON.stringify(context.listings.map(r => [r.name, r.startingPrice])));
  const payload = brokerPayload({ buyer, message: "Best overall", recentTurns: [], context, permissions: {} });
  assert.ok(JSON.stringify(payload).length < 25_000, String(JSON.stringify(payload).length));
  assert.ok(context.areaGuide.length > 0);
  for (const row of context.listings) assert.doesNotMatch(JSON.stringify(row), /checked 20\d\d/);
});

test("true broker sentences pass; invented figures, amenities and projects do not", async () => {
  const setup = await setupConversation();
  const { buyer, catalog } = await contextFor(setup, "val", ["Invest", "3M", "Yas"]);
  const context = buildBrokerContext({ catalog, buyer, message: "What would you pick?", areaGuide: loadAreaGuide() });
  const check = text => validateBrokerReply(text, context, { buyer, buyerMessage: "What would you pick?" });
  const good = "For a 3M budget on Yas, I'd go with Yas Park Views. The 2 bedroom apartment starts from AED 1,900,000 with an 80/20 plan and handover in Q4 2027. Yas is Abu Dhabi's entertainment island, so it rents well to young professionals. Want me to break down the payment terms?";
  const result = check(good);
  assert.equal(result.ok, true, JSON.stringify(result.violations));
  for (const bad of [
    "Yas Park Views 2 bedroom starts from AED 1,400,000.",
    "Yas Park Views has a private marina.",
    "Yas Park Views will appreciate 20% by handover.",
    "I'd go with Falcon Heights instead.",
    "Yas Park Views hands over in Q2 2026.",
    "I've reserved a unit for you at Yas Park Views."
  ]) assert.equal(check(bad).ok, false, bad);
});

test("a repaired broker reply keeps the good sentences and one closing question", async () => {
  const setup = await setupConversation();
  const { buyer, catalog } = await contextFor(setup, "rep", ["Invest", "3M", "Yas"]);
  const context = buildBrokerContext({ catalog, buyer, message: "Options?", areaGuide: loadAreaGuide() });
  const check = text => validateBrokerReply(text, context, { buyer, buyerMessage: "Options?" });
  const repaired = repairBrokerReply("Yas Park Views is my pick, from AED 1,900,000 for a 2 bedroom apartment. It also has a private marina. Should I compare it with Reem? Want me to break down the payment terms?", check);
  assert.ok(repaired, "repairable");
  assert.doesNotMatch(repaired.text, /private marina|compare it with Reem/);
  assert.match(repaired.text, /Want me to break down the payment terms\?$/);
  assert.equal(repairBrokerReply("I've booked a viewing for you at Yas Park Views. Want me to send details?", check), null, "an action claim is never repaired");
});

test("deterministic flows stay deterministic: contact, permissions and stops are never composed", () => {
  const buyer = {};
  assert.equal(brokerEligible({ draft: { stage: "call_offer" }, contact: null, buyer }), false);
  assert.equal(brokerEligible({ draft: { stage: "matched" }, contact: { stage: "follow_up_channel" }, buyer }), false);
  assert.equal(brokerEligible({ draft: { stage: "matched", nextQuestion: { field: "phone" } }, contact: null, buyer }), false);
  assert.equal(brokerEligible({ draft: { stage: "matched" }, contact: null, buyer: { salesPathStopped: true } }), false);
  assert.equal(brokerEligible({ draft: { stage: "matched", handoffReason: "buying" }, contact: null, buyer }), false);
  assert.equal(brokerEligible({ draft: { stage: "matched" }, contact: null, buyer }), true);
  assert.equal(brokerEligible({ draft: { stage: "knowledge_answer" }, contact: null, buyer }), true);
});

test("engine sends the broker reply, remembers its pick and lets 'yes' accept its offer", async () => {
  const setup = await setupConversation();
  await setup.engine.handleMessage("eng", "Invest", { useLlm: false });
  await setup.engine.handleMessage("eng", "5M", { useLlm: false });
  const seen = [];
  setup.engine.llm = brokerClient(payload => {
    const pick = payload.listings.find(row => row.name === "Yas Park Views" && /3 bedroom/.test(row.unit));
    if (payload.buyerMessage === "Best overall") return { message: `With 5M I'd use more of the budget than a studio: Yas Park Views, a 3 bedroom apartment from ${pick.startingPrice}, handover ${pick.handover}. Yas is Abu Dhabi's entertainment island, popular with families and young professionals. Want me to break down the payment terms?`,
      recommended: [{ projectId: pick.projectId, unitId: pick.unitId }], questionField: "advisoryNextAction", offer: "payment_details" };
    return { message: `Here's the payment picture for Yas Park Views: from ${pick.startingPrice}, initial payment ${pick.initialPayment}, plan ${pick.paymentPlan}, handover ${pick.handover}. Want me to check current availability?`,
      recommended: [], questionField: "availability", offer: "availability" };
  }, seen);
  const best = await setup.engine.handleMessage("eng", "Best overall");
  assert.equal(best.check.ok, true, JSON.stringify(best.check));
  assert.match(best.reply, /Yas Park Views, a 3 bedroom apartment from AED 2,600,000/);
  assert.equal(best.buyer.activeRecommendationProjectId, "prj_yas_park_views");
  assert.equal(best.pendingOffer?.action, "payment_details");
  const yes = await setup.engine.handleMessage("eng", "Sure");
  assert.match(yes.reply, /payment picture for Yas Park Views/);
  assert.equal(yes.pendingOffer?.action, "availability");
  assert.ok(seen.every(payload => JSON.stringify(payload).length < 40_000));
  assert.equal(seen[1].buyer.activeRecommendationUnitId, best.buyer.activeRecommendationUnitId, "the next turn knows the pick");
});

test("a broker reply that fails every check falls back to the deterministic reply, never a raw error", async () => {
  const setup = await setupConversation();
  setup.engine.llm = brokerClient(() => ({ message: "Yas Park Views starts from AED 999,999 and will double in value.", recommended: [], questionField: null, offer: null }));
  const result = await setup.engine.handleMessage("fall", "2M Yas 2 bedroom");
  assert.equal(result.check.ok, true);
  assert.doesNotMatch(result.reply, /999,999|double in value/);
  assert.equal(result.polished, false);
});

test("broker mode can be switched off", async () => {
  const setup = await setupConversation();
  setup.engine.brokerMode = false;
  let called = false;
  setup.engine.llm = brokerClient(() => { called = true; return { message: "x", recommended: [] }; });
  await setup.engine.handleMessage("off", "2M Yas 2 bedroom");
  assert.equal(called, false);
});
