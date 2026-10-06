import assert from "node:assert/strict";
import test from "node:test";
import { setupConversation } from "./helpers.js";
import { buildInvestmentStrategy } from "../src/conversation/investment-strategy.js";
import { buildInvestmentThesis } from "../src/conversation/investment-thesis.js";
import { analyzePaymentSchedule } from "../src/conversation/payment-analysis.js";
import { compareProperties } from "../src/conversation/comparison.js";
import { buildAdvisorOpportunities } from "../src/conversation/advisor-opportunities.js";
import { buildFactPack } from "../src/facts/retrieval.js";
import { normalizePriceHistory, normalizeMarketSnapshot } from "../src/facts/intelligence.js";
import { composeReplyWithModel } from "../src/conversation/llm.js";

// Fictional evidence throughout: no production inventory or network is used.
const NOW = Date.now();
const VERIFIED = new Date(NOW - 1000).toISOString();
const SOURCE = "https://synthetic.example.test/elite-broker-sheet";
const offline = { useLlm: false };
const knownBudgetQuestion = /what(?:'s| is) your budget|what budget|how much.*(?:spend|budget)/i;
const binaryGateway = /(?:rental income|income).{0,25}(?:or|versus|vs).{0,25}(?:capital growth|growth)/i;
function option(id, { price = 1_800_000, cash = 180_000, beds = 1, size = 800, area = "Yas Island", handover = "Q4 2028", status = "Off-plan", ...patch } = {}) {
  const project = { id, name: `Fixture ${id}`, active: true, developerId: "fixture-developer", developerName: "Fixture Developer", developerActive: true,
    emirate: "Abu Dhabi", area, status, handover, source: SOURCE, lastVerified: VERIFIED,
    paymentPlanAvailable: true, paymentPlanSummary: "60/40", initialPaymentAed: cash,
    features: ["Shared pool"], description: "A documented residential community.", ...patch };
  const unit = { id: `${id}-unit`, projectId: id, active: true, bedrooms: beds, propertyType: "apartment",
    startingPriceAed: price, initialPaymentAed: cash, sizeSqftFrom: size, sizeSqftTo: size, availability: "Available" };
  const row = { project, unit, downPaymentAed: cash };
  row.factPack = buildFactPack(row, { now: NOW });
  return row;
}
function catalog(records) {
  return { developers: [{ id: "fixture-developer", name: "Fixture Developer", active: true }], projects: records.map(row => row.project), units: records.map(row => row.unit) };
}
async function setup(records = [option("entry"), option("easier", { price: 1_950_000, cash: 100_000 })]) {
  const services = await setupConversation();
  Object.assign(services.store, catalog(records));
  return services;
}
function safe(result) {
  assert.equal(result.check.ok, true, JSON.stringify(result.check.violations));
  assert.ok((result.reply.match(/[?؟]/g) || []).length <= 1, result.reply);
  assert.doesNotMatch(result.reply, /approved evidence|fact pack|matching engine|approved catalogue/i);
}
function thesis(row = option("entry"), buyer = {}, intelligence = {}) {
  return buildInvestmentThesis({ ...row, buyer: { useType: "investment", ...buyer }, intelligence, now: NOW });
}
function paymentPlan(patch = {}) {
  return { id: "fixture-plan", planId: "fixture-plan", projectId: "entry", source: SOURCE, checkedOn: VERIFIED, approved: true, botEnabled: true,
    milestones: [{ id: "booking", kind: "booking", percent: 10, daysFromBooking: 0 },
      { id: "construction", kind: "construction", percent: 50, monthsFromBooking: 6 },
      { id: "handover", kind: "handover", percent: 40, monthsFromBooking: 24 }], ...patch };
}

test("elite context: Hold after exit question cannot become a reservation", async () => {
  const { engine, store } = await setup();
  store.units = [];
  await engine.handleMessage("elite-context-hold", "2M. Best ROI.", offline);
  const result = await engine.handleMessage("elite-context-hold", "Hold.", offline);
  assert.equal(result.buyer.investmentStrategy, "LONG_TERM_HOLD");
  assert.ok(!result.intents.includes("reserve"));
  assert.ok(!result.intents.includes("high_intent"));
  assert.equal(result.callRequest, null);
  safe(result);
});

test("elite context: explicit call request remains actionable without live units", async () => {
  const { engine, store } = await setup();
  store.units = [];
  await engine.handleMessage("elite-context-call", "2M. Best ROI.", offline);
  await engine.handleMessage("elite-context-call", "Hold.", offline);
  const result = await engine.handleMessage("elite-context-call", "Please call me.", offline);
  assert.equal(result.stage, "call_offer");
  assert.equal(result.callRequest.offered, true);
  assert.equal(result.nextQuestion.field, "phone");
  assert.equal(result.alertRecommended, false);
  assert.equal(result.buyer.investmentStrategy, "LONG_TERM_HOLD");
  safe(result);
});

test("elite 01: 2M best ROI is umbrella return intent, with one exit question and no budget re-ask", async () => {
  const { engine } = await setup();
  const result = await engine.handleMessage("elite-01", "2M. Best ROI.", offline);
  assert.equal(result.buyer.budgetAed, 2_000_000);
  assert.equal(result.buyer.investmentGoal, "total_return");
  assert.equal(result.buyer.investmentObjective, null);
  assert.deepEqual(result.buyer.preferredAreas, []);
  assert.equal(result.nextQuestion?.field, "exitHorizon");
  assert.doesNotMatch(result.reply, knownBudgetQuestion);
  assert.doesNotMatch(result.reply, binaryGateway);
  safe(result);
});

test("elite 02: capital growth is remembered as a driver and advances strategy without a definition", async () => {
  const { engine } = await setup();
  await engine.handleMessage("elite-02", "2M. Best ROI.", offline);
  const result = await engine.handleMessage("elite-02", "Capital growth.", offline);
  assert.equal(result.buyer.investmentGoal, "total_return");
  assert.equal(result.buyer.investmentStrategy, "OFF_PLAN_APPRECIATION");
  assert.equal(result.nextQuestion?.field, "exitHorizon");
  assert.doesNotMatch(result.reply, /capital growth (?:means|is)|capital appreciation (?:means|is)/i);
  assert.doesNotMatch(result.reply, knownBudgetQuestion);
  safe(result);
});

test("elite 03: contextual handover answer stores exit strategy and emphasizes timing and liquidity", async () => {
  const { engine } = await setup();
  await engine.handleMessage("elite-03", "2M. Best ROI.", offline);
  const result = await engine.handleMessage("elite-03", "Handover.", offline);
  assert.equal(result.buyer.exitHorizon, "handover");
  assert.equal(result.buyer.handoverStrategy, "sell");
  assert.notEqual(result.stage, "fact_answer");
  assert.equal(result.buyer.investmentStrategy, "HANDOVER_EXIT");
  const strategy = buildInvestmentStrategy(result.buyer);
  assert.ok(strategy.priorities.includes("liquidity"));
  assert.ok(strategy.priorities.includes("resale_competition"));
  assert.notEqual(result.nextQuestion?.field, "exitHorizon");
  safe(result);
});

test("elite 04: a five-year hold changes weights toward maturation, product and rental fallback", async () => {
  const { engine } = await setup();
  await engine.handleMessage("elite-04", "2M. Best ROI.", offline);
  const result = await engine.handleMessage("elite-04", "I'll hold 5 years.", offline);
  assert.equal(result.buyer.holdingPeriod, 5);
  assert.equal(result.buyer.investmentStrategy, "LONG_TERM_HOLD");
  const strategy = buildInvestmentStrategy(result.buyer);
  const exit = buildInvestmentStrategy({ useType: "investment", exitHorizon: "handover" });
  assert.ok(strategy.weights.area > exit.weights.area);
  assert.ok(strategy.priorities.includes("rental_fallback"));
  safe(result);
});

test("elite 05: income from day one selects a documented ready option", async () => {
  const { engine } = await setup([option("offplan"), option("ready", { status: "Ready", handover: "Ready", price: 1_950_000 })]);
  const result = await engine.handleMessage("elite-05", "2M. I want rental income from day one.", offline);
  assert.equal(result.buyer.investmentStrategy, "READY_INCOME");
  assert.equal(result.advisor.primary?.projectId, "ready");
  assert.ok(result.matches.every(row => row.project.status === "Ready"));
  assert.doesNotMatch(result.reply, /guaranteed rent|income starts immediately|will appreciate/i);
  safe(result);
});

test("elite 06: why spend 200k exposes the exact delta, gain and an evidence-backed opinion", async () => {
  const result = compareProperties(option("reference"), option("upgrade", { price: 2_000_000, beds: 2, size: 1100 }), { priorities: ["more_space"], budgetAed: 2_000_000 });
  assert.equal(result.upgradeAssessment.extraCostAed, 200_000);
  assert.ok(result.upgradeAssessment.supportedBenefits.some(row => row.code === "additional_bedroom"));
  assert.ok(result.upgradeAssessment.tradeoffs.some(row => row.code === "higher_starting_price"));
  assert.equal(result.buyerPreference.projectId, "upgrade");
  const { engine } = await setup([option("reference"), option("upgrade", { price: 2_000_000, beds: 2, size: 1100 })]);
  await engine.handleMessage("elite-06", "2M Yas 1 bedroom apartment for my home. More space matters.", offline);
  const response = await engine.handleMessage("elite-06", "Why should I pay 200k more?", offline);
  assert.equal(response.buyer.budgetAed, 2_000_000);
  assert.match(response.reply, /200,000/);
  assert.match(response.reply, /bedroom|space|larger/i);
  assert.match(response.reply, /prefer|would|worth|start/i);
  safe(response);
});

test("elite 07: initial-payment objection changes the recommendation to lower cash", async () => {
  const { engine } = await setup([option("cash-heavy", { cash: 300_000 }), option("cash-light", { price: 1_950_000, cash: 100_000 })]);
  const first = await engine.handleMessage("elite-07", "2M Yas 1 bedroom apartment", offline);
  const result = await engine.handleMessage("elite-07", "Initial payment is too high.", offline);
  assert.notEqual(result.advisor.primary?.projectId, first.advisor.primary?.projectId);
  assert.equal(result.advisor.primary?.projectId, "cash-light");
  assert.ok(result.buyer.rejectedProjects.includes("cash-heavy"));
  assert.match(JSON.stringify(result.buyer.rejectionReasons), /initial_payment_too_high/);
  safe(result);
});

test("elite 08: dropping Yas opens the area rather than treating the old preference as fixed", async () => {
  const { engine } = await setup();
  await engine.handleMessage("elite-08", "2M. I only want Yas. 1 bedroom apartment.", offline);
  const result = await engine.handleMessage("elite-08", "I don't care about Yas anymore.", offline);
  assert.deepEqual(result.buyer.preferredAreas, []);
  assert.equal(result.buyer.areaFlexibility, "open");
  safe(result);
});

test("elite 09: only Yas prevents a cross-area challenger even with cheaper cash", async () => {
  const { engine } = await setup([option("yas", { cash: 300_000 }), option("reem", { area: "Al Reem Island", cash: 100_000 })]);
  const result = await engine.handleMessage("elite-09", "2M. I only want Yas. 1 bedroom apartment. Low initial cash matters.", offline);
  assert.equal(result.buyer.areaFlexibility, "fixed");
  assert.ok(result.matches.every(row => row.project.area === "Yas Island"));
  assert.notEqual(result.advisor.challenger?.projectId, "reem");
  safe(result);
});

test("elite 10: which would you buy produces an evidence-backed preference", async () => {
  const { engine } = await setup([option("cleaner"), option("costlier", { price: 1_950_000 })]);
  await engine.handleMessage("elite-10", "2M Yas 1 bedroom apartment. Best ROI. Sell around handover.", offline);
  const result = await engine.handleMessage("elite-10", "Which would you buy?", offline);
  assert.equal(result.buyer.exitHorizon, "handover");
  assert.equal(result.buyer.investmentStrategy, "HANDOVER_EXIT");
  assert.match(result.reply, /prefer|start with|choose|would buy/i);
  assert.match(result.reply, /Fixture cleaner/);
  assert.doesNotMatch(result.reply, /both are equally good|depends entirely|cannot recommend/i);
  safe(result);
});

test("elite 11: risk advice names diligence and evidence gaps without reassuring them away", async () => {
  const { engine } = await setup();
  await engine.handleMessage("elite-11", "2M. Best ROI. Sell around handover.", offline);
  const result = await engine.handleMessage("elite-11", "What are the risks?", offline);
  assert.match(result.reply, /supply|resale|handover|payment|cash|evidence/i);
  assert.doesNotMatch(result.reply, /risk[- ]free|no risk|guaranteed|don't worry/i);
  safe(result);
});

test("elite 12: a 20% appreciation question cannot become a return promise", async () => {
  const { engine } = await setup();
  await engine.handleMessage("elite-12", "2M. Best ROI.", offline);
  const result = await engine.handleMessage("elite-12", "Will this appreciate 20%?", offline);
  assert.match(result.reply, /cannot|can't|not a forecast|won't|historical|assumption|promise/i);
  assert.doesNotMatch(result.reply, /will appreciate 20|expected.*20|guaranteed/i);
  safe(result);
});

test("elite 13: no active units still permits useful project and strategy advice", async () => {
  const { engine, store } = await setup([option("knowledge")]);
  store.units = [];
  await engine.handleMessage("elite-13", "2M. Best ROI.", offline);
  const result = await engine.handleMessage("elite-13", "Tell me about Fixture knowledge", offline);
  assert.equal(result.advisor.primary, null);
  assert.match(result.reply, /Yas Island/);
  assert.match(result.reply, /positioning|strategy|community/i);
  assert.doesNotMatch(result.reply, /1,800,000|60\/40|available now|can't help|cannot help/i);
  safe(result);
});

test("elite 14: a known budget is not re-asked during repeated advice", async () => {
  const { engine } = await setup();
  await engine.handleMessage("elite-14", "2M. Best ROI.", offline);
  for (const message of ["Capital growth.", "Sell around handover.", "Show me your recommendation."]) {
    const result = await engine.handleMessage("elite-14", message, offline);
    assert.equal(result.buyer.budgetAed, 2_000_000);
    assert.notEqual(result.nextQuestion?.field, "budgetAed");
    assert.doesNotMatch(result.reply, knownBudgetQuestion);
    safe(result);
  }
});

test("elite 15: a known exit horizon is not re-asked without a preference change", async () => {
  const { engine } = await setup();
  await engine.handleMessage("elite-15", "2M. Best ROI. Sell around handover.", offline);
  for (const message of ["Capital growth.", "What would you recommend?"]) {
    const result = await engine.handleMessage("elite-15", message, offline);
    assert.equal(result.buyer.exitHorizon, "handover");
    assert.notEqual(result.nextQuestion?.field, "exitHorizon");
    assert.doesNotMatch(result.reply, /exiting around handover or holding|exit around handover or hold/i);
    safe(result);
  }
});

test("elite 16: a rejected upgrade is not pushed again", async () => {
  const { engine } = await setup([option("original", { price: 1_980_000 }), option("larger", { price: 2_080_000, beds: 2, size: 1100 })]);
  await engine.handleMessage("elite-16", "2M Yas 1 bedroom apartment for my home", offline);
  await engine.handleMessage("elite-16", "I can stretch a little for an extra bedroom", offline);
  await engine.handleMessage("elite-16", "I don't want the upgrade", offline);
  const result = await engine.handleMessage("elite-16", "Show me the original option", offline);
  assert.equal(result.buyer.upgradeDeclined, true);
  assert.ok(result.advisor.opportunities.every(row => row.type !== "smart_upgrade"));
  assert.doesNotMatch(result.reply, /Fixture larger/);
  safe(result);
});

test("elite 17: no-call state survives advice, objections and high intent", async () => {
  const { engine } = await setup();
  await engine.handleMessage("elite-17", "No calls", offline);
  for (const message of ["2M Yas 1 bedroom apartment", "Initial payment is too high", "I want to proceed", "Follow up here on Instagram"]) {
    const result = await engine.handleMessage("elite-17", message, offline);
    assert.equal(result.buyer.noCalls, true);
    assert.equal(result.callRequestSubmitted, false);
    assert.doesNotMatch(result.reply, /will call|call you/i);
    safe(result);
  }
});

test("elite 18: I'm good stops sales capture through the next idle turn", async () => {
  const { engine } = await setup();
  await engine.handleMessage("elite-18", "2M Yas 1 bedroom apartment", offline);
  for (const message of ["I'm good", "Thanks"]) {
    const result = await engine.handleMessage("elite-18", message, offline);
    assert.equal(result.buyer.salesPathStopped, true);
    assert.equal(result.nextQuestion, null);
    assert.equal(result.pendingOffer, null);
    assert.doesNotMatch(result.reply, /phone|budget|payment schedule/i);
    safe(result);
  }
});

test("elite 19: comparable sourced price history informs observed movement only", () => {
  const history = (id, observationDate, priceAed) => normalizePriceHistory({ id, fields: { Project: ["entry"], "Observation date": observationDate, "Price AED": priceAed,
    "Price type": "Developer price", Bedrooms: 1, "Property type": "apartment", "Size sqft": 800, "Source URL": SOURCE, Verified: true, Confidence: "High" } }, { now: NOW });
  const result = thesis(option("entry"), {}, { priceHistory: [history("launch", "2025-01-01", 1_500_000), history("current", "2026-10-01", 1_800_000)] });
  assert.equal(result.entryCase.historicalMovement.deltaAed, 300_000);
  assert.equal(result.entryCase.historicalMovement.basis, "historical_observations_not_forecast");
  assert.deepEqual(result.forecasts, []);
});

test("elite 20: missing price history means unknown movement rather than an appreciation narrative", () => {
  const result = thesis();
  assert.equal(result.entryCase.historicalMovement, null);
  assert.ok(result.unknowns.includes("comparable_historical_price_movement"));
  assert.deepEqual(result.forecasts, []);
});

test("elite 21: a weak market sample cannot establish median, trend or liquidity", () => {
  const snapshot = normalizeMarketSnapshot({ id: "weak", fields: { Project: ["entry"], "Snapshot date": "2026-10-01", "Source URL": SOURCE, Confidence: "High",
    "Transactions 12M": 2, "Transaction median AED": 2_000_000, "Trend 12M %": 20, "Latest transaction date": "2026-09-30" } }, { now: NOW });
  assert.equal(snapshot.transactionMedianAed, null);
  assert.equal(snapshot.trend12m, null);
  assert.equal(thesis(option("entry"), {}, { marketSnapshots: [snapshot] }).liquidityCase.status, "UNKNOWN");
});

test("elite 22: documented area catalysts enter the thesis without guaranteed appreciation", () => {
  const areas = [{ id: "fixture-area", name: "Yas Island", usable: true, source: SOURCE, verifiedOn: VERIFIED,
    catalysts: [{ description: "Synthetic announced transport project", usable: true, source: SOURCE, verifiedOn: VERIFIED }] }];
  const result = thesis(option("entry"), {}, { areas });
  assert.equal(result.areaCase.catalysts.length, 1);
  assert.equal(result.areaCase.catalysts[0].evidence.source, SOURCE);
  assert.equal(result.forecastAllowed, false);
});

test("elite 23: a complete reconciled payment schedule calculates cash deployment once", () => {
  const result = analyzePaymentSchedule(paymentPlan(), { priceAed: 2_000_000, projectId: "entry", now: NOW });
  assert.equal(result.status, "COMPLETE");
  assert.equal(result.purchasePricePercent, 100);
  assert.equal(result.bookingAed, 200_000);
  assert.equal(result.cashBeforeHandoverAed, 1_200_000);
  assert.equal(result.cashAtHandoverAed, 800_000);
  assert.equal(result.cash6MonthsAed, 1_200_000);
});

test("elite 24: a ratio or incomplete milestones cannot invent installments", () => {
  for (const plan of [{ paymentPlanSummary: "60/40" }, paymentPlan({ milestones: [{ id: "booking", kind: "booking", percent: 10 }, { id: "handover", kind: "handover", percent: 80 }] })]) {
    const result = analyzePaymentSchedule(plan, { priceAed: 2_000_000, now: NOW });
    assert.notEqual(result.status, "COMPLETE");
    assert.equal(result.cashBeforeHandoverAed, null);
    assert.equal(result.cash6MonthsAed, null);
  }
});

test("elite 25: one primary and at most one relevant challenger preserve the preference", () => {
  const result = buildAdvisorOpportunities(catalog([option("yas", { cash: 300_000 }), option("reem", { price: 1_950_000, cash: 100_000, area: "Al Reem Island" }), option("third", { cash: 250_000 })]),
    { budgetAed: 2_000_000, preferredAreas: ["Yas Island"], areaFlexibility: "preferred", propertyTypes: ["apartment"], bedrooms: [1], priorities: ["lower_initial_cash"] }, { now: NOW });
  assert.ok(result.primary);
  assert.ok(result.matches.length <= 2);
  if (result.challenger) assert.ok(result.challenger.reasonCodes.length);
});

test("elite 26: a more expensive equal option produces no upsell", () => {
  const result = buildAdvisorOpportunities(catalog([option("cheaper"), option("costlier", { price: 1_950_000 })]), { budgetAed: 2_000_000, useType: "end_use", propertyTypes: ["apartment"], bedrooms: [1] }, { now: NOW });
  assert.equal(result.primary.projectId, "cheaper");
  assert.equal(result.challenger, null);
  assert.ok(result.opportunities.every(row => row.type !== "smart_upgrade"));
});

test("elite 27: the cheaper equally suitable option wins in actual broker copy", async () => {
  const { engine } = await setup([option("cheaper"), option("costlier", { price: 1_950_000 })]);
  const result = await engine.handleMessage("elite-27", "2M Yas 1 bedroom apartment for my home", offline);
  assert.equal(result.advisor.primary.projectId, "cheaper");
  assert.match(result.reply, /prefer Fixture cheaper/);
  assert.match(result.reply, /would not pay.*extra/i);
  safe(result);
});

test("elite 28: two-property comparison includes a structured difference and buyer tradeoff", async () => {
  const result = compareProperties(option("price", { cash: 300_000 }), option("cash", { price: 1_950_000, cash: 100_000 }), { priorities: ["lower_initial_cash"] });
  assert.equal(result.differences.find(row => row.dimension === "price").delta, 150_000);
  assert.equal(result.differences.find(row => row.dimension === "initial_cash").delta, -200_000);
  assert.equal(result.buyerPreference.projectId, "cash");
  assert.ok(result.tradeoffs.some(row => row.code === "higher_starting_price"));
  const { engine } = await setup([option("price", { cash: 300_000 }), option("cash", { price: 1_950_000, cash: 100_000 })]);
  await engine.handleMessage("elite-28", "2M Yas 1 bedroom apartment. Low initial cash matters.", offline);
  const response = await engine.handleMessage("elite-28", "Compare these two options.", offline);
  assert.ok(response.advisor.comparison?.differences.some(row => row.dimension === "price"));
  assert.match(response.reply, /150,000|200,000|trade-off|more.*price|less.*cash/i);
  assert.match(response.reply, /prefer|start with/i);
  safe(response);
});

test("elite 29: high intent moves to availability or permitted transaction preparation without requalification", async () => {
  const { engine } = await setup([option("selected")]);
  await engine.handleMessage("elite-29", "2M Yas 1 bedroom apartment", offline);
  const result = await engine.handleMessage("elite-29", "I want to proceed.", offline);
  assert.equal(result.buyer.activeRecommendationProjectId, "selected");
  assert.match(result.reply, /availability|EOI|next step|proceed/i);
  assert.doesNotMatch(result.reply, knownBudgetQuestion);
  assert.doesNotMatch(result.reply, /reservation confirmed|reserved for you|EOI (?:is |was )?submitted/i);
  safe(result);
});

test("elite 30: an invented model feature is rejected and the deterministic response survives", async t => {
  const { engine } = await setup([option("safe")]);
  const transport = async (_url, request) => {
    const payload = JSON.parse(JSON.parse(request.body).messages[0].content);
    const answer = payload.draftReply === undefined ? { facts: {}, unsure: [], intents: [], signals: [], ack: null } : {
      message: "Fixture safe has a private beach. Want me to explain the payment terms?", askedQuestion: true, questionField: payload.requiredQuestion?.field,
      claims: [{ text: "Fixture safe", projectId: "safe", unitId: "safe-unit", field: "name", value: "Fixture safe" }], proposedActions: []
    };
    return { ok: true, json: async () => ({ content: [{ type: "text", text: JSON.stringify(answer) }] }) };
  };
  t.mock.method(globalThis, "fetch", transport);
  engine.llm = { apiKey: "synthetic", model: "synthetic", baseUrl: "https://synthetic.example.test", fetchImpl: transport };
  const result = await engine.handleMessage("elite-30", "2M Yas 1 bedroom apartment");
  assert.equal(result.polished, false);
  assert.doesNotMatch(result.reply, /private beach/i);
  assert.match(result.reply, /Fixture safe/);
  safe(result);
});

for (const [category, message] of [
  ["price", "Fixture safe starts at AED 1,234,567."], ["appreciation", "Fixture safe will appreciate 20%."],
  ["availability", "Fixture safe is sold out."], ["payment plan", "Fixture safe has a 10/90 payment plan."],
  ["catalyst", "Fixture safe is beside a new metro station."], ["resale demand", "Fixture safe has strong resale demand."],
  ["scarcity", "Fixture safe is selling fast."], ["call consent", "You have agreed to a call, so I will call you."],
  ["budget flexibility", "Your budget is flexible, so you can stretch."], ["completed EOI", "Your EOI has been submitted."]
]) {
  test(`elite adversarial: model cannot invent ${category}`, async () => {
    const row = option("safe"), pack = row.factPack;
    const response = { message, askedQuestion: false, questionField: null, proposedActions: [], claims: message.includes("Fixture safe")
      ? [{ text: "Fixture safe", projectId: "safe", unitId: "safe-unit", field: "name", value: "Fixture safe" }] : [] };
    const client = { apiKey: "synthetic", model: "synthetic", baseUrl: "https://synthetic.example.test", fetchImpl: async () => ({ ok: true, json: async () => ({ content: [{ type: "text", text: JSON.stringify(response) }] }) }) };
    assert.equal(await composeReplyWithModel(client, { buyer: { budgetAed: 2_000_000, budgetHardCap: true, budgetFlexible: false, noCalls: true }, packs: [pack], forbiddenActions: ["call"] }), null);
  });
}
