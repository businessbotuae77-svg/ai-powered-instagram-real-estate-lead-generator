import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { setupConversation } from "./helpers.js";
import { IntegrationOrchestrator } from "../src/integrations/orchestrator.js";

// Deliberately fictional records: these exist only in this test process. No
// catalogue writer or external service is used by the commercial acceptance suite.
function syntheticOption(id, name, { price = 1_890_000, initial = 300_000, beds = 1,
  area = "Yas Island", size = 800, status = "Off-plan", handover = "Q4 2028" } = {}) {
  return {
    project: { id, name, developerId: "test-developer", active: true,
      area, emirate: "Abu Dhabi", propertyTypes: ["apartment"], status,
      initialPaymentAed: initial, paymentPlanAvailable: true,
      paymentPlanSummary: "60/40", handover, source: "Synthetic test document",
      lastVerified: new Date().toISOString(), features: ["Shared pool"] },
    unit: { id: `${id}-unit`, projectId: id, active: true, bedrooms: beds,
      propertyType: "apartment", startingPriceAed: price, initialPaymentAed: initial,
      sizeSqftFrom: size, sizeSqftTo: size, availability: "Available" }
  };
}

async function advisorSetup(options = {}) {
  const services = await setupConversation();
  const records = options.records || [
    syntheticOption("test-yas-entry", "Test Yas Entry"),
    syntheticOption("test-yas-balanced", "Test Yas Balanced", { price: 1_980_000, initial: 150_000 }),
    syntheticOption("test-yas-larger", "Test Yas Larger", { price: 2_080_000, initial: 160_000, beds: 2, size: 1100 }),
    syntheticOption("test-reem-cash", "Test Reem Cash", { price: 1_920_000, initial: 100_000, area: "Al Reem Island" })
  ];
  services.store.developers = [{ id: "test-developer", name: "Test Developer", active: true }];
  services.store.projects = records.map(row => row.project);
  services.store.units = records.map(row => row.unit);
  return services;
}

const offline = { useLlm: false };
const internalLanguage = /approved evidence|approved matrix|confirmed options|fact pack|verified stock|matching engine|approved catalogue/i;
const budgetQuestion = /what budget|what(?:'s| is) your budget|budget (?:are you|do you)|how much.*(?:budget|spend)/i;
const areaQuestion = /which area|what area|area are you|where.*(?:buy|looking)/i;

function oneQuestion(result) {
  assert.ok((result.reply.match(/[?\u061f]/g) || []).length <= 1, result.reply);
  assert.equal(result.check.ok, true, JSON.stringify(result.check.violations));
  assert.doesNotMatch(result.reply, internalLanguage);
}

test("commercial regression: AED 2M stays remembered through ROI, growth and later advice", async () => {
  const { engine } = await advisorSetup();
  await engine.handleMessage("roi", "2M", offline);
  const roi = await engine.handleMessage("roi", "Idk. Im looking for the best roi", offline);
  assert.equal(roi.buyer.budgetAed, 2_000_000);
  assert.equal(roi.buyer.useType, "investment");
  assert.doesNotMatch(roi.reply, budgetQuestion);
  assert.doesNotMatch(roi.reply, areaQuestion);
  assert.equal(roi.nextQuestion?.field, "investmentObjective");
  oneQuestion(roi);

  const growth = await engine.handleMessage("roi", "Growth", offline);
  assert.equal(growth.buyer.budgetAed, 2_000_000);
  assert.equal(growth.buyer.investmentObjective, "growth");
  assert.notEqual(growth.nextQuestion?.field, "investmentObjective");
  assert.notEqual(growth.nextQuestion?.field, "budgetAed");
  assert.notEqual(growth.nextQuestion?.field, "preferredAreas");
  assert.ok(growth.advisor.primary, "A known objective should advance to supported options");
  oneQuestion(growth);

  const next = await engine.handleMessage("roi", "Show me your recommendation", offline);
  assert.equal(next.buyer.budgetAed, 2_000_000);
  assert.equal(next.buyer.investmentObjective, "growth");
  assert.doesNotMatch(next.reply, budgetQuestion);
  assert.doesNotMatch(next.reply, areaQuestion);
  oneQuestion(next);
});

test("commercial regression: explicit unknown area remains flexible without restarting qualification", async () => {
  const { engine } = await advisorSetup();
  const result = await engine.handleMessage("open-area", "I have 2M. I don't know the area. I want the best ROI", offline);
  assert.equal(result.buyer.budgetAed, 2_000_000);
  assert.deepEqual(result.buyer.preferredAreas, []);
  assert.equal(result.buyer.areaFlexibility, "open");
  assert.equal(result.buyer.openToOtherAreas, true);
  assert.equal(result.buyer.useType, "investment");
  assert.notEqual(result.nextQuestion?.field, "preferredAreas");
  assert.notEqual(result.nextQuestion?.field, "budgetAed");
  oneQuestion(result);
});

test("commercial regression: known area and budget are not re-asked during a useful direct recommendation", async () => {
  const { engine } = await advisorSetup({ records: [syntheticOption("test-only", "Test Only Fit", { beds: 2 })] });
  const result = await engine.handleMessage("exact", "I want a 2 bedroom apartment in Yas with a 2M budget", offline);
  assert.ok(result.advisor.primary);
  assert.equal(result.advisor.primary.projectId, "test-only");
  assert.match(result.reply, /Test Only Fit/);
  assert.match(result.reply, /prefer|recommend|start with|strong fit|cleaner fit/i);
  assert.doesNotMatch(result.reply, budgetQuestion);
  assert.doesNotMatch(result.reply, areaQuestion);
  assert.notEqual(result.nextQuestion?.field, "financing");
  assert.notEqual(result.nextQuestion?.field, "cashAvailableAed");
  oneQuestion(result);
});

test("firm budget is remembered and excludes an over-budget property through subsequent advice", async () => {
  const { engine } = await advisorSetup();
  await engine.handleMessage("firm", "2M, Yas apartment for investment", offline);
  const firm = await engine.handleMessage("firm", "My budget is firm. No stretch", offline);
  assert.equal(firm.buyer.budgetFlexible, false);
  assert.equal(firm.buyer.budgetHardCap, true);
  for (const message of ["Growth", "Show me the best option", "Anything better?"]) {
    const result = await engine.handleMessage("firm", message, offline);
    assert.equal(result.buyer.budgetHardCap, true);
    assert.equal(result.buyer.budgetFlexible, false);
    assert.ok(result.matches.every(row => row.unit.startingPriceAed <= 2_000_000));
    assert.doesNotMatch(result.reply, /Test Yas Larger|2,080,000|would you stretch|hard ceiling/i);
    oneQuestion(result);
  }
});

test("an authorised conservative stretch offers at most one supported upgrade and discloses the budget gap", async () => {
  const { engine } = await advisorSetup({ records: [
    syntheticOption("test-baseline", "Test Baseline", { price: 1_980_000, initial: 150_000 }),
    syntheticOption("test-upgrade", "Test Space Upgrade", { price: 2_080_000, initial: 160_000, beds: 2, size: 1100 })
  ] });
  await engine.handleMessage("stretch", "2M, Yas apartment, 1 bedroom for my home", offline);
  const result = await engine.handleMessage("stretch", "I can stretch a little for an extra bedroom", offline);
  assert.equal(result.buyer.budgetFlexible, true);
  assert.equal(result.buyer.budgetAed, 2_000_000);
  const upgrades = result.advisor.opportunities.filter(row => row.type === "smart_upgrade");
  assert.equal(upgrades.length, 1);
  assert.equal(upgrades[0].priceDifferenceAed, 100_000);
  assert.ok(upgrades[0].reasonCodes.length);
  assert.ok(upgrades[0].supportedFacts.length);
  assert.match(result.reply, /100,000/);
  assert.match(result.reply, /2 bedroom|extra bedroom|1BR.*2BR|1 bedroom.*2 bedroom/i);
  assert.match(result.reply, /above|over.*budget|stretch/i);
  oneQuestion(result);
});

test("one primary and one relevant challenger preserves the preferred area", async () => {
  const { engine } = await advisorSetup({ records: [
    syntheticOption("test-yas", "Test Yas Cash", { initial: 300_000 }),
    syntheticOption("test-reem", "Test Reem Easier", { price: 1_920_000, initial: 100_000, area: "Al Reem Island" })
  ] });
  await engine.handleMessage("challenger", "2M, Yas, 1 bedroom apartment", offline);
  const result = await engine.handleMessage("challenger", "The first payment is too high. I'm open to other areas if it helps", offline);
  assert.deepEqual(result.buyer.preferredAreas, ["Yas Island"]);
  assert.ok(result.advisor.primary);
  const offered = [result.advisor.primary, result.advisor.challenger].filter(Boolean);
  assert.ok(offered.some(row => row.projectId === "test-reem"));
  const reem = offered.find(row => row.projectId === "test-reem");
  assert.ok(reem.reasonCodes.length, "A cross-sell must have a stated buyer benefit");
  assert.match(result.reply, /initial|first payment|initial commitment/i);
  assert.match(result.reply, /Al Reem Island|Reem/);
  assert.ok(result.matches.length <= 2);
  oneQuestion(result);
});

test("the first-payment objection changes the recommendation and persists its rejection reason", async () => {
  const { engine } = await advisorSetup({ records: [
    syntheticOption("test-entry", "Test Cash Heavy", { initial: 300_000 }),
    syntheticOption("test-easier", "Test Easier Cash", { price: 1_980_000, initial: 100_000 })
  ] });
  const first = await engine.handleMessage("objection", "2M, Yas, 1 bedroom apartment", offline);
  assert.ok(first.advisor.primary);
  const rejectedId = first.advisor.primary.projectId;
  const next = await engine.handleMessage("objection", "The first payment is too high", offline);
  assert.notEqual(next.advisor.primary?.projectId, rejectedId);
  assert.ok(next.buyer.rejectedProjects.includes(rejectedId));
  assert.ok(JSON.stringify(next.buyer.rejectionReasons).includes("initial_payment_too_high"));
  assert.match(next.reply, /initial|first payment|commitment/i);
  const later = await engine.handleMessage("objection", "continue", offline);
  assert.ok(later.matches.every(row => row.project.id !== rejectedId));
  oneQuestion(next);
  oneQuestion(later);
});

test("declined upgrade is not repeatedly pushed and does not discard the original budget", async () => {
  const { engine } = await advisorSetup({ records: [
    syntheticOption("test-baseline", "Test Baseline", { price: 1_980_000, initial: 150_000 }),
    syntheticOption("test-upgrade", "Test Space Upgrade", { price: 2_080_000, initial: 160_000, beds: 2, size: 1100 })
  ] });
  await engine.handleMessage("declined", "2M, Yas apartment, 1 bedroom for my home", offline);
  await engine.handleMessage("declined", "I can stretch a little for an extra bedroom", offline);
  await engine.handleMessage("declined", "I don't want the upgrade", offline);
  const result = await engine.handleMessage("declined", "Show me the original option", offline);
  assert.equal(result.buyer.budgetAed, 2_000_000);
  assert.equal(result.buyer.upgradeDeclined, true);
  assert.ok(result.advisor.opportunities.every(row => row.type !== "smart_upgrade"));
  assert.doesNotMatch(result.reply, /Test Space Upgrade/);
  oneQuestion(result);
});

test("ordinary recommendation never dumps more than two projects", async () => {
  const records = Array.from({ length: 6 }, (_, i) => syntheticOption(`test-many-${i}`, `Test Choice ${i}`, {
    price: 1_500_000 + i * 50_000, initial: 150_000 + i * 5_000
  }));
  const { engine } = await advisorSetup({ records });
  const result = await engine.handleMessage("limit", "2M, Yas, 1 bedroom apartment", offline);
  assert.ok(result.advisor.primary);
  assert.ok(result.matches.length <= 2);
  const namedProjects = records.filter(row => result.reply.includes(row.project.name));
  assert.ok(namedProjects.length <= 2);
  oneQuestion(result);
});

test("the cheaper equally suitable option wins and the advisor says it would not pay extra", async () => {
  const { engine } = await advisorSetup({ records: [
    syntheticOption("test-cheaper", "Test Better Value", { price: 1_700_000, initial: 170_000, beds: 2 }),
    syntheticOption("test-costlier", "Test Costlier Equal", { price: 1_950_000, initial: 195_000, beds: 2 })
  ] });
  const result = await engine.handleMessage("value", "2M, Yas, 2 bedroom apartment for my home", offline);
  assert.equal(result.advisor.primary.projectId, "test-cheaper");
  assert.match(result.reply, /prefer Test Better Value/);
  assert.match(result.reply, /would not pay (?:the )?extra/i);
  assert.equal(result.advisor.challenger, null);
  assert.ok(result.advisor.upgradeAssessment.reasonCodes.includes("no_material_buyer_benefit_for_extra_price"));
  oneQuestion(result);
});

test("no-call permission survives recommendations, objections and reservation follow-up", async () => {
  const { engine } = await advisorSetup();
  await engine.handleMessage("no-calls", "No calls", offline);
  for (const message of ["2M, Yas, 1 bedroom apartment", "Growth", "The first payment is too high", "I want an EOI"]) {
    const result = await engine.handleMessage("no-calls", message, offline);
    assert.equal(result.buyer.noCalls, true);
    assert.equal(result.callRequestSubmitted, false);
    assert.doesNotMatch(result.reply, /will call|number.*call|call you/i);
    oneQuestion(result);
  }
  const result = await engine.handleMessage("no-calls", "Follow up here on Instagram", offline);
  assert.equal(result.followUpSubmitted, true);
  assert.equal(result.buyer.noCalls, true);
  assert.match(result.callSummary, /No calls: yes/);
  assert.equal(result.nextQuestion, null);
});

test("I'm good ends sales capture and later idle messages do not restart it", async () => {
  const { engine } = await advisorSetup();
  await engine.handleMessage("stop", "2M, Yas, 1 bedroom apartment", offline);
  for (const message of ["I'm good", "thanks"]) {
    const result = await engine.handleMessage("stop", message, offline);
    assert.equal(result.buyer.salesPathStopped, true);
    assert.equal(result.nextQuestion, null);
    assert.equal(result.pendingOffer, null);
    assert.equal(result.alertRecommended, false);
    assert.doesNotMatch(result.reply, /phone|budget|WhatsApp|payment schedule/i);
    oneQuestion(result);
  }
});

test("recommendation to payment plan to availability to EOI retains the selected property and buyer state", async () => {
  const { engine } = await advisorSetup({ records: [syntheticOption("test-selected", "Test Selected", { beds: 2 })] });
  const first = await engine.handleMessage("journey", "2M, Yas, 2 bedroom apartment for investment", offline);
  assert.equal(first.advisor.primary.projectId, "test-selected");
  for (const message of ["What's the payment plan?", "Is it available?", "I want to proceed with an EOI"]) {
    const result = await engine.handleMessage("journey", message, offline);
    assert.equal(result.buyer.budgetAed, 2_000_000);
    assert.deepEqual(result.buyer.preferredAreas, ["Yas Island"]);
    assert.deepEqual(result.buyer.bedrooms, [2]);
    assert.equal(result.buyer.useType, "investment");
    assert.equal(result.buyer.activeRecommendationProjectId, "test-selected");
    assert.doesNotMatch(result.reply, budgetQuestion);
    assert.doesNotMatch(result.reply, /reservation confirmed|reserved for you|EOI (?:is |was )?submitted/i);
    oneQuestion(result);
  }
  const plan = engine.memory.recentContext("journey", 8).find(row => row.role === "assistant" && /60\/40/.test(row.text));
  assert.ok(plan, "The plan answer should use the selected property's supported terms");
  const done = await engine.handleMessage("journey", "Here on Instagram", offline);
  assert.equal(done.followUpSubmitted, true);
  assert.equal(done.callRequestSubmitted, false);
  assert.equal(done.buyer.budgetAed, 2_000_000);
  assert.equal(done.nextQuestion, null);
});

test("an EOI handoff refers to the displayed property even if a payment-plan answer changes internal ranking", async () => {
  const { engine } = await advisorSetup({ records: [
    syntheticOption("test-discussed", "Test Discussed", { price: 1_800_000, initial: 300_000, beds: 2 }),
    syntheticOption("test-not-selected", "Test Unselected", { price: 1_950_000, initial: 100_000, beds: 2 })
  ] });
  const first = await engine.handleMessage("selected-context", "2M, Yas, 2 bedroom apartment", offline);
  assert.equal(first.advisor.primary.projectId, "test-discussed");
  const plan = await engine.handleMessage("selected-context", "What's its payment plan?", offline);
  assert.match(plan.reply, /Test Discussed/);
  assert.equal(plan.buyer.activeRecommendationProjectId, "test-discussed");
  await engine.handleMessage("selected-context", "I want to proceed with an EOI", offline);
  const done = await engine.handleMessage("selected-context", "Here on Instagram", offline);
  assert.equal(done.followUpSubmitted, true);
  assert.equal(done.buyer.activeRecommendationProjectId, "test-discussed");
  assert.equal(done.matches[0]?.project.id, "test-discussed", "CRM and alert adapters receive this same selected property");
  assert.match(done.callSummary, /Interested in: Test Discussed/);
  assert.doesNotMatch(done.callSummary, /Interested in: Test Unselected/);
  oneQuestion(done);
});

test("stale and missing commercial facts do not become advisory prices, plans or availability", async () => {
  const expired = syntheticOption("test-stale", "Test Stale");
  expired.project.lastVerified = "2000-01-01";
  const missing = syntheticOption("test-missing", "Test Missing");
  missing.unit.startingPriceAed = null;
  missing.project.paymentPlanSummary = null;
  missing.unit.availability = "Unknown";
  const { engine } = await advisorSetup({ records: [expired, missing] });
  const result = await engine.handleMessage("missing", "2M, Yas, 1 bedroom apartment. What can you recommend?", offline);
  assert.equal(result.advisor.primary, null);
  assert.doesNotMatch(result.reply, /1,890,000|60\/40|available now|ready to move|\d+(?:\.\d+)?%.*(?:ROI|return|yield)/i);
  oneQuestion(result);
});

test("duplicate webhook executes one advisory turn and one requested handoff", async () => {
  const { engine, buyers } = await advisorSetup();
  await engine.handleMessage("duplicate", "2M, Yas, 1 bedroom apartment", offline);
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "commercial-idempotency-"));
  const sent = [];
  const env = { META_PAGE_ACCESS_TOKEN: "synthetic-test-token", META_PAGE_ID: "test-page",
    HUBSPOT_ACCESS_TOKEN: "synthetic-test-token", WHATSAPP_ACCESS_TOKEN: "synthetic-test-token",
    WHATSAPP_PHONE_NUMBER_ID: "test-wa", WHATSAPP_ALERT_TO: "971500000000", WHATSAPP_TEMPLATE_NAME: "test_alert" };
  const fetchImpl = async (url, options) => {
    sent.push({ url, body: JSON.parse(options.body) });
    return { ok: true, json: async () => url.includes("hubapi")
      ? { results: [{ id: "test-contact" }] }
      : { message_id: "test-ig", messages: [{ id: "test-wa" }] } };
  };
  const original = engine.handleMessage.bind(engine);
  let turns = 0;
  engine.handleMessage = (...args) => { turns++; return original(...args); };
  const orchestrator = new IntegrationOrchestrator({ engine, buyers, rootDir, env, fetchImpl });
  const event = { mid: "commercial-replay", senderId: "duplicate", text: "Follow up here on Instagram", source: "webhook" };
  const first = await orchestrator.processMessageEvent(event, offline);
  assert.equal(first.pending, false);
  const replay = await orchestrator.processMessageEvent(event, offline);
  assert.equal(replay.duplicate, true);
  assert.equal(turns, 1);
  assert.equal(sent.filter(row => row.url.includes("hubapi")).length, 1);
  assert.equal(sent.filter(row => row.url.includes("/test-wa/")).length, 1);
  assert.equal(sent.filter(row => row.body.recipient).length, 1);
});

function mockModel(t, engine, compose) {
  const calls = [];
  const transport = async (_url, request) => {
    const payload = JSON.parse(JSON.parse(request.body).messages[0].content);
    const answer = payload.draftReply === undefined
      ? { facts: {}, unsure: [], intents: [], signals: [], ack: null }
      : compose(payload);
    calls.push(payload);
    return { ok: true, json: async () => ({ content: [{ type: "text", text: JSON.stringify(answer) }] }) };
  };
  t.mock.method(globalThis, "fetch", transport);
  engine.llm = { apiKey: "synthetic-test-key", model: "test-model", baseUrl: "https://model.example.test", fetchImpl: transport };
  return calls;
}

test("model composes a complete paraphrased ROI question once without appending the deterministic question", async t => {
  const { engine } = await advisorSetup();
  await engine.handleMessage("model-roi", "2M", offline);
  const modelReply = "We can keep the area open and compare investment routes. Do you prefer rental income, long-term growth, or a balance?";
  const calls = mockModel(t, engine, payload => ({
    message: modelReply, askedQuestion: true, questionField: payload.requiredQuestion.field,
    claims: [], proposedActions: []
  }));
  const result = await engine.handleMessage("model-roi", "Idk. Im looking for the best roi");
  assert.equal(result.polished, true);
  assert.equal(result.reply, modelReply);
  assert.equal(result.buyer.budgetAed, 2_000_000);
  assert.equal(result.nextQuestion.field, "investmentObjective");
  assert.ok(calls.some(payload => payload.currentMessage && Array.isArray(payload.recentTurns)));
  oneQuestion(result);
});

test("model advisory response has current buyer context and passes final factual validation", async t => {
  const { engine } = await advisorSetup({ records: [syntheticOption("test-model-fit", "Test Model Fit", { beds: 2 })] });
  const modelReply = "For your priorities, I prefer Test Model Fit at AED 1,890,000. Want me to explain the payment terms?";
  const calls = mockModel(t, engine, payload => {
    const pack = payload.factPacks.find(row => row.projectId === "test-model-fit");
    const claim = (text, field) => ({ text, projectId: pack.projectId, unitId: pack.unitId, field, value: pack[field].value });
    return { message: modelReply, askedQuestion: true, questionField: payload.requiredQuestion.field,
      claims: [claim("Test Model Fit", "name"), claim("AED 1,890,000", "startingPriceAed")], proposedActions: [] };
  });
  const result = await engine.handleMessage("model-fit", "2M, Yas, 2 bedroom apartment");
  assert.equal(result.polished, true);
  assert.equal(result.reply, modelReply);
  assert.equal(result.advisor.primary.projectId, "test-model-fit");
  const composition = calls.find(payload => payload.draftReply);
  assert.equal(composition.buyer.budgetAed, 2_000_000);
  assert.ok(Array.isArray(composition.advisoryOpportunities));
  assert.ok(Array.isArray(composition.allowedActions));
  assert.ok(Array.isArray(composition.forbiddenActions));
  assert.ok(composition.factPacks.every(pack => pack.projectId && pack.unitId));
  oneQuestion(result);
});

test("model duplicate or invented commercial copy falls back to the safe complete response", async t => {
  const { engine } = await advisorSetup({ records: [syntheticOption("test-model-safe", "Test Model Safe", { beds: 2 })] });
  const unsafe = [
    "Test Model Safe costs AED 1,234,567. Want me to explain the payment terms?",
    "Test Model Safe guarantees a 9% ROI. Want me to explain the payment terms?",
    "Test Model Safe is sold out. Want me to explain the payment terms?",
    "Test Model Safe has a 90/10 payment plan. Want me to explain the payment terms?",
    "I recommend Invented Marina Palace. Want me to explain the payment terms?",
    "What budget are you working with? How much do you want to spend?"
  ];
  let index = 0;
  mockModel(t, engine, payload => ({ message: unsafe[index++], askedQuestion: true,
    questionField: payload.requiredQuestion.field, claims: [], proposedActions: [] }));
  for (let turn = 0; turn < unsafe.length; turn++) {
    const result = await engine.handleMessage(`model-unsafe-${turn}`, "2M, Yas, 2 bedroom apartment");
    assert.equal(result.polished, false, unsafe[turn]);
    assert.equal(result.buyer.budgetAed, 2_000_000);
    assert.match(result.reply, /Test Model Safe/);
    assert.doesNotMatch(result.reply, /1,234,567|9%|sold out|90\/10|Invented Marina Palace/);
    assert.doesNotMatch(result.reply, budgetQuestion);
    assert.equal(result.alertRecommended, false);
    oneQuestion(result);
  }
});

test("a valid citation cannot carry invented amenities in the same sentence", async t => {
  const { engine } = await advisorSetup({ records: [syntheticOption("test-feature", "Test Feature", { beds: 2 })] });
  const fabricated = "I prefer Test Feature. Test Feature has a shared pool and a private beach. Want me to explain the payment terms?";
  mockModel(t, engine, payload => {
    const pack = payload.factPacks.find(row => row.projectId === "test-feature");
    return {
      message: fabricated, askedQuestion: true, questionField: payload.requiredQuestion.field,
      proposedActions: [], claims: [
        { text: "Test Feature", projectId: pack.projectId, unitId: pack.unitId, field: "name", value: pack.name.value },
        { text: "Test Feature has a shared pool and a private beach", projectId: pack.projectId, unitId: pack.unitId,
          field: "features", value: pack.features.value }
      ]
    };
  });
  const result = await engine.handleMessage("forged-feature", "2M, Yas, 2 bedroom apartment");
  assert.equal(result.polished, false);
  assert.doesNotMatch(result.reply, /private beach/);
  assert.match(result.reply, /Test Feature/);
  oneQuestion(result);
});
