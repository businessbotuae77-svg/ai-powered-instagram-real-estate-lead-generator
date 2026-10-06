import assert from "node:assert/strict";
import test from "node:test";
import { setupConversation } from "./helpers.js";
import { buildFactPack } from "../src/facts/retrieval.js";
import { validateBuyerResponse } from "../src/conversation/response-validation.js";
import { advisorBudgetPolicy } from "../src/conversation/advisor-opportunities.js";
import { parseAdvisoryFacts } from "../src/conversation/advisory-memory.js";

const offline = { useLlm: false };

// Fictional records used only in this isolated test process.
function record(id, { price = 1_800_000, initial = 300_000, bedrooms = 1, area = "Yas Island" } = {}) {
  return {
    project: { id, name: `Test ${id}`, developerId: "test-developer", active: true,
      area, emirate: "Abu Dhabi", propertyTypes: ["apartment"], status: "Off-plan",
      initialPaymentAed: initial, paymentPlanAvailable: true, paymentPlanSummary: "60/40",
      handover: "Q4 2028", source: "Synthetic safety test", lastVerified: new Date().toISOString(),
      features: ["Shared pool"] },
    unit: { id: `${id}-unit`, projectId: id, active: true, bedrooms, propertyType: "apartment",
      startingPriceAed: price, initialPaymentAed: initial, sizeSqftFrom: 800,
      sizeSqftTo: 900, availability: "Available" }
  };
}

async function fixture(records = [record("Alpha"), record("Beta", { price: 1_900_000, initial: 100_000 })]) {
  const services = await setupConversation();
  services.store.developers = [{ id: "test-developer", name: "Test Developer", active: true }];
  services.store.projects = records.map(row => row.project);
  services.store.units = records.map(row => row.unit);
  return services;
}

function packFor(row = record("Alpha")) {
  return buildFactPack({ ...row, downPaymentAed: row.unit.initialPaymentAed,
    bedroomLabel: String(row.unit.bedrooms) });
}

function modelCheck(message, fields = ["name"], pack = packFor()) {
  const claims = fields.map(field => ({ text: message, projectId: pack.projectId,
    unitId: pack.unitId, field, value: pack[field].value }));
  return validateBuyerResponse(message, { buyer: { budgetAed: 2_000_000 }, packs: [pack],
    metadata: { askedQuestion: false, questionField: null, proposedActions: [], claims } });
}

async function withModelUnderstanding(services, understanding, run) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body);
    const result = payload.system.includes("extract structured buyer requirements")
      ? understanding : { message: "I can help with that.", askedQuestion: false,
        questionField: null, claims: [], proposedActions: [] };
    return { ok: true, json: async () => ({ content: [{ type: "text", text: JSON.stringify(result) }] }) };
  };
  services.engine.llm = { apiKey: "synthetic-test-key", baseUrl: "https://synthetic.test" };
  try { return await run(); } finally { globalThis.fetch = originalFetch; }
}

test("negated follow-up never authorizes an advisor handoff through a saved channel", async () => {
  for (const message of ["Do not follow up", "I don't want follow-up", "Don't contact me on WhatsApp"]) {
    const { engine, buyers } = await fixture();
    await buyers.patchBuyer("decline", { preferredContactChannel: "instagram" });
    const result = await engine.handleMessage("decline", message, offline);
    assert.equal(result.followUpSubmitted, false, message);
    assert.equal(result.alertRecommended, false, message);
    assert.equal(result.nextQuestion, null, result.reply);
    assert.equal(result.pendingOffer, null);
  }
});

test("negated viewing does not become qualification or contact permission", async () => {
  for (const message of ["I do not want a viewing", "I don't want to arrange a viewing"]) {
    const { engine } = await fixture();
    const result = await engine.handleMessage("viewing-declined", message, offline);
    assert.equal(result.followUpSubmitted, false);
    assert.equal(result.alertRecommended, false);
    assert.equal(result.nextQuestion, null, result.reply);
    assert.ok(!result.intents.includes("viewing"));
  }
});

test("model interpretation cannot revoke no-call permission on an unrelated greeting", async () => {
  const services = await fixture();
  await services.buyers.patchBuyer("forged-call", { noCalls: true,
    preferredContactChannel: "instagram", phone: "+971501234567" });
  const result = await withModelUnderstanding(services,
    { facts: {}, intents: ["request_call"], signals: ["request_call", "callback_request"] },
    () => services.engine.handleMessage("forged-call", "Hi"));
  assert.equal(result.buyer.noCalls, true);
  assert.equal(result.buyer.preferredContactChannel, "instagram");
  assert.equal(result.callRequestSubmitted, false);
  assert.equal(result.alertRecommended, false);
});

test("a negated call request never revokes an existing no-call boundary", async () => {
  for (const message of ["Never call me", "Do not phone me", "Do not ring me", "I don't want a call"]) {
    const { engine, buyers } = await fixture();
    await buyers.patchBuyer("negated-call", { noCalls: true, preferredContactChannel: "instagram" });
    const result = await engine.handleMessage("negated-call", message, offline);
    assert.equal(result.buyer.noCalls, true, message);
    assert.notEqual(result.buyer.preferredContactChannel, "phone", message);
    assert.equal(result.pendingOffer, null, message);
    assert.equal(result.callRequestSubmitted, false);
    assert.equal(result.nextQuestion, null, result.reply);
  }
});

test("model interpretation cannot increase a firm budget without a buyer-supplied amount", async () => {
  const services = await fixture();
  await services.buyers.patchBuyer("forged-budget", { budgetAed: 2_000_000,
    budgetHardCap: true, budgetFirm: true, useType: "investment" });
  const result = await withModelUnderstanding(services,
    { facts: { budget: 3_000_000, cash: 1_000_000 }, intents: [] },
    () => services.engine.handleMessage("forged-budget", "Growth"));
  assert.equal(result.buyer.budgetAed, 2_000_000);
  assert.equal(result.buyer.budgetFirm, true);
  assert.equal(result.buyer.budgetHardCap, true);
  assert.equal(result.buyer.cashAvailableAed, null);
});

test("explicit zero permitted stretch remains a ceiling of the original budget", () => {
  const buyer = { budgetAed: 2_000_000 };
  const facts = parseAdvisoryFacts("I can stretch to 2M", { buyer });
  const policy = advisorBudgetPolicy({ ...buyer, ...facts });
  assert.equal(policy.ceilingAed, 2_000_000);
  assert.equal(policy.stretchAed, 0);
});

test("a negated growth objective preserves the positive rental-income objective", () => {
  const facts = parseAdvisoryFacts("I do not want growth. I want rental income", {
    buyer: { useType: "investment" }
  });
  assert.equal(facts.investmentObjective, "rental_income");
});

test("downpayment evidence cannot become a fabricated purchase price", () => {
  const result = modelCheck("Test Alpha costs AED 300,000.", ["name", "downPaymentAed"]);
  assert.equal(result.ok, false, JSON.stringify(result));
});

test("a confirmed plan ratio and downpayment cannot invent a monthly installment schedule", () => {
  const result = modelCheck("Test Alpha offers a 60/40 plan with monthly installments of AED 300,000.",
    ["name", "paymentPlanSummary", "downPaymentAed"]);
  assert.equal(result.ok, false, JSON.stringify(result));
});

test("a plan ratio cannot establish its booking or initial-payment percentage", () => {
  const result = modelCheck("Test Alpha has 60% as the initial payment.", ["name"]);
  assert.equal(result.ok, false, JSON.stringify(result));
});

test("a name citation cannot support invented amenities or capital-protection guarantees", () => {
  const result = modelCheck("Test Alpha has concierge service and is guaranteed to beat inflation.");
  assert.equal(result.ok, false, JSON.stringify(result));
});

test("plain availability statements require their own supported field citation", () => {
  const result = modelCheck("Test Alpha is available.");
  assert.equal(result.ok, false, JSON.stringify(result));
});

test("an unknown property name cannot borrow a genuine listing's price and citation", () => {
  const result = modelCheck("I prefer Falcon over Test Alpha at AED 1,800,000.",
    ["name", "startingPriceAed"]);
  assert.equal(result.ok, false, JSON.stringify(result));
});

test("uncited attributes remain forbidden when written as a terse listing label", () => {
  assert.equal(modelCheck("Test Alpha: concierge service.").ok, false);
});

test("unsupported recommendation names remain forbidden regardless of capitalization", () => {
  assert.equal(modelCheck("I recommend falcon over Test Alpha.").ok, false);
  assert.equal(modelCheck("Falcon makes more sense than Test Alpha.").ok, false);
});

test("question metadata cannot disguise a semantic re-ask of the known budget", () => {
  for (const message of ["Could you remind me of your budget?", "Would you mind telling me your spending limit?"]) {
    const result = validateBuyerResponse(message, { buyer: { budgetAed: 2_000_000 }, packs: [],
      requiredQuestion: { field: "advisoryNextAction", prompt: "Want me to compare these?" },
      allowedActions: ["compare"], metadata: { askedQuestion: true,
        questionField: "advisoryNextAction", proposedActions: [], claims: [] } });
    assert.equal(result.ok, false, message);
  }
});

test("Arabic advice keeps two displayed choices and discloses the exact upgrade benefit and budget gap", async () => {
  const services = await fixture([
    record("Alpha", { price: 1_980_000, initial: 100_000 }),
    record("Beta", { price: 2_080_000, initial: 100_000, bedrooms: 2 }),
    record("Extra", { price: 1_990_000, initial: 100_000 })
  ]);
  await services.buyers.patchBuyer("arabic-upgrade", { language: "ar", budgetAed: 2_000_000,
    preferredAreas: ["Yas Island"], bedrooms: [1], propertyTypes: ["apartment"], useType: "end_use",
    budgetFlexible: true, budgetHardCap: false, budgetFlexibilityPct: 5, priorities: ["more_space"] });
  const result = await services.engine.handleMessage("arabic-upgrade", "هل هناك خيار أفضل؟", offline);
  assert.equal(result.check.ok, true, JSON.stringify(result.check));
  assert.match(result.reply, /Test Alpha/);
  assert.match(result.reply, /Test Beta/);
  assert.doesNotMatch(result.reply, /Test Extra/);
  assert.match(result.reply, /100,000/);
  assert.match(result.reply, /2 غرف نوم بدلاً من 1/);
  assert.match(result.reply, /أعلى من ميزانيتك الأصلية/);
  assert.ok((result.reply.match(/[?؟]/g) || []).length <= 1);
});

test("a buyer asking for time clears the pending sales action and keeps later acknowledgments quiet", async () => {
  const { engine } = await fixture();
  const first = await engine.handleMessage("pause", "2M Yas 1 bedroom apartment", offline);
  assert.ok(first.nextQuestion);
  for (const message of ["I need some time to think about it", "thanks", "okay"]) {
    const result = await engine.handleMessage("pause", message, offline);
    assert.equal(result.nextQuestion, null);
    assert.equal(result.pendingOffer, null);
    assert.equal(result.followUpSubmitted, false);
  }
});

test("a buyer explicitly reopening a paused search resumes advice without undoing property rejections", async () => {
  const { engine } = await fixture();
  await engine.handleMessage("resume", "2M Yas 1 bedroom apartment", offline);
  const objection = await engine.handleMessage("resume", "The first payment is too high", offline);
  const rejected = [...objection.buyer.rejectedProjects];
  await engine.handleMessage("resume", "I'm good", offline);
  const quiet = await engine.handleMessage("resume", "thanks", offline);
  assert.equal(quiet.buyer.salesPathStopped, true);
  assert.equal(quiet.nextQuestion, null);
  const resumed = await engine.handleMessage("resume", "Show me your recommendations again", offline);
  assert.equal(resumed.buyer.salesPathStopped, false);
  assert.ok(resumed.advisor.primary, resumed.reply);
  assert.notEqual(resumed.stage, "paused_advice");
  assert.ok(rejected.every(projectId => resumed.buyer.rejectedProjects.includes(projectId)));
});

test("an unsolved objection cannot fall through to a legacy recommendation with the same problem", async () => {
  for (const message of ["I don't like this area", "I don't want an apartment",
    "This is too large", "I don't trust this developer"]) {
    const { engine } = await fixture();
    await engine.handleMessage("unsolved", "2M Yas 1 bedroom apartment", offline);
    const result = await engine.handleMessage("unsolved", message, offline);
    assert.equal(result.advisor.primary, null, message);
    assert.doesNotMatch(result.reply, /Test Beta|strong fit|cleaner fit|prefer Test/i, message);
    assert.notEqual(result.nextQuestion?.field, "cashAvailableAed", result.reply);
    assert.equal(result.followUpSubmitted, false);
    assert.equal(result.alertRecommended, false);
  }
});
