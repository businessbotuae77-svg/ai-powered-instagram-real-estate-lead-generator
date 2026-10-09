import assert from "node:assert/strict";
import test from "node:test";
import { composeReplyWithModel } from "../src/conversation/llm.js";
import { inferQuestionField, validateBuyerResponse } from "../src/conversation/response-validation.js";
import { buildFactPack } from "../src/facts/retrieval.js";
import { collectComparisonAmounts, collectComparisonDifferences, validateMessage } from "../src/facts/checker.js";
import { systemText } from "../src/conversation/model-request.js";

const buyer = { budgetAed: 2_000_000, budgetHardCap: true, budgetFlexible: false,
  useType: "investment", investmentGoal: "TOTAL_RETURN", investmentStrategy: "HANDOVER_EXIT",
  exitHorizon: "handover", preferredAreas: [], noCalls: true };
function factPack() {
  return buildFactPack({ project: { id: "elite-project", name: "Test Gardens", active: true,
    source: "Developer brochure", lastVerified: new Date().toISOString(), area: "Yas Island",
    paymentPlanSummary: "60/40", handover: "Q4 2028", features: "Community pool" },
  unit: { id: "elite-unit", projectId: "elite-project", active: true, bedrooms: 2,
    propertyType: "apartment", startingPriceAed: 1_900_000, availability: "Available" },
  bedroomLabel: "2 bedrooms", downPaymentAed: 190_000 });
}
const output = (message, extra = {}) => ({ message, askedQuestion: false, questionField: null,
  claims: [], proposedActions: [], ...extra });
function client(response, inspect = () => {}) {
  return { apiKey: "synthetic", model: "synthetic", baseUrl: "https://synthetic.test", fetchImpl: async (_url, request) => {
    const body = JSON.parse(request.body);
    inspect(JSON.parse(body.messages[0].content), systemText(body.system));
    return { ok: true, json: async () => ({ content: [{ type: "text", text: typeof response === "string" ? response : JSON.stringify(response) }] }) };
  } };
}
function nameClaim(pack, text) { return { text, projectId: pack.projectId, unitId: pack.unitId,
  field: "name", value: pack.name.value }; }

test("complete composer context includes off-plan strategy, thesis, comparison, objections and scoped evidence", async () => {
  let payload;
  let instructions;
  const thesis = { strategy: "HANDOVER_EXIT", projectId: "elite-project", liquidityCase: { confidence: "UNKNOWN" },
    bullCase: [], riskCase: [], unsupportedClaims: ["appreciation forecast"] };
  const comparison = { propertyA: "elite-project", propertyB: "alternative", differences: [] };
  const response = await composeReplyWithModel(client(output("For a handover exit, I'd compare entry timing, cash deployed and resale competition."), (value, system) => {
    payload = value; instructions = system;
  }), { buyer, conversationState: "COMPARING", investmentProfile: { strategy: "HANDOVER_EXIT" },
    investmentTheses: [thesis], comparisonFacts: comparison, objectionState: { category: "initial_payment_too_high" },
    allowedActions: ["payment_details"], forbiddenActions: ["call"], packs: [] });
  assert.ok(response);
  assert.equal(payload.buyer.exitHorizon, "handover");
  assert.equal(payload.buyer.investmentStrategy, "HANDOVER_EXIT");
  assert.equal(payload.conversationState, "COMPARING");
  assert.deepEqual(payload.investmentTheses, [thesis]);
  assert.deepEqual(payload.comparisonFacts, comparison);
  assert.equal(payload.objectionState.category, "initial_payment_too_high");
  assert.match(instructions, /ROI is umbrella return intent/);
  assert.match(instructions, /ASSUMPTION.*NOT FORECAST/);
  assert.match(instructions, /UNKNOWN.*unknown/);
});

const adversarial = [
  ["price", "Test Gardens starts at AED 1,500,000."],
  ["appreciation", "Test Gardens will appreciate 20%."],
  ["availability", "Test Gardens is sold out."],
  ["payment plan", "Test Gardens offers a 10/90 payment plan."],
  ["catalyst", "Test Gardens is near a new metro station."],
  ["resale demand", "Test Gardens has strong resale demand."],
  ["scarcity", "Test Gardens is selling fast."],
  ["contact permission", "You have agreed to a call, so I will call you."],
  ["budget flexibility", "Your budget is flexible, so you can stretch."],
  ["completed EOI", "Your EOI has been submitted."]
];
for (const [category, message] of adversarial) {
  test(`model cannot invent ${category}, including with a valid property-name citation`, async () => {
    const pack = factPack();
    const response = await composeReplyWithModel(client(output(message, { claims: message.includes(pack.name.value)
      ? [nameClaim(pack, message)] : [] })), { buyer, packs: [pack], allowedActions: ["compare"], forbiddenActions: ["call"] });
    assert.equal(response, null);
  });
}

test("forecasts remain rejected even when phrased as projected or likely appreciation", async () => {
  for (const message of ["Projected IRR is strong.", "This will see strong appreciation.", "Expected ROI is attractive."]) {
    assert.equal(await composeReplyWithModel(client(output(message)), { buyer }), null, message);
  }
});

test("known exit horizon cannot be re-asked and ROI cannot be rewritten as the binary gateway", async () => {
  const question = "Are you thinking of exiting around handover or holding longer?";
  assert.equal(inferQuestionField(question), "exitHorizon");
  const check = validateBuyerResponse(question, { buyer });
  assert.ok(check.violations.some(value => value.type === "known_field_question" && value.field === "exitHorizon"));
  const binary = output("Do you prefer rental income or capital growth?", { askedQuestion: true, questionField: "exitHorizon" });
  assert.equal(await composeReplyWithModel(client(binary), { buyer: { ...buyer, exitHorizon: null },
    requiredQuestion: { field: "exitHorizon", prompt: question } }), null);
});

test("a short capital-growth preference moves to strategy without defining the term", async () => {
  assert.equal(await composeReplyWithModel(client(output("Capital growth means the increase in resale value.")), {
    buyer, message: "Capital growth." }), null);
  const response = await composeReplyWithModel(client(output("Then I'd focus on appreciation and assess the entry point, cash deployed and resale competition for your handover exit.")), {
    buyer, message: "Capital growth." });
  assert.ok(response);
});

test("a scoped research citation is supported only by application-owned provenance and exact value", async () => {
  const value = "Announced museum";
  const evidence = { evidenceId: "area:record-1:catalysts", projectId: "elite-project", unitId: null,
    field: "catalysts", value, source: "Official authority announcement", recordId: "record-1",
    scope: "area", verifiedAt: new Date().toISOString() };
  const message = `${value} is part of the area's documented plans.`;
  const citation = { text: value, evidenceId: evidence.evidenceId, projectId: evidence.projectId,
    unitId: null, field: evidence.field, value };
  assert.ok(await composeReplyWithModel(client(output(message, { claims: [citation] })), {
    buyer, allowedClaims: [evidence] }));
  for (const broken of [{ ...evidence, verifiedAt: null }, { ...evidence, source: null },
    { ...evidence, recordId: null }, { ...evidence, scope: null }, { ...evidence, value: "UNKNOWN" }]) {
    assert.equal(await composeReplyWithModel(client(output(message, { claims: [citation] })), {
      buyer, allowedClaims: [broken] }), null);
  }
  assert.equal(await composeReplyWithModel(client(output(message, { claims: [{ ...citation, projectId: "another-project" }] })), {
    buyer, allowedClaims: [evidence] }), null);
});

test("source metadata cannot create evidence or convert a catalyst into appreciation", async () => {
  const message = "A new metro station guarantees appreciation.";
  assert.equal(await composeReplyWithModel(client(output(message, { claims: [{ text: message,
    evidenceId: "invented", projectId: "elite-project", field: "catalysts", value: message,
    source: "Invented government source", recordId: "invented", scope: "area", verifiedAt: new Date().toISOString() }] })), { buyer }), null);
});

test("computed payment citations preserve the exact cash window, not just a known amount", async () => {
  const pack = factPack();
  pack.cash6MonthsAed = { confirmed: true, value: 400_000 };
  pack.cash12MonthsAed = { confirmed: true, value: 800_000 };
  const message = "Test Gardens requires cash of AED 400,000 in the first 6 months.";
  const paymentClaim = { text: message, projectId: pack.projectId, unitId: pack.unitId,
    field: "cash6MonthsAed", value: 400_000 };
  const response = await composeReplyWithModel(client(output(message, { claims: [nameClaim(pack, "Test Gardens"), paymentClaim] })), {
    buyer, packs: [pack] });
  assert.ok(response);
  assert.equal(response.claims.find(row => row.field === "cash6MonthsAed").provenance.source, "Developer brochure");
  const wrongWindow = message.replace("6 months", "12 months");
  assert.equal(await composeReplyWithModel(client(output(wrongWindow, { claims: [nameClaim(pack, "Test Gardens"),
    { ...paymentClaim, text: wrongWindow }] })), { buyer, packs: [pack] }), null);
});

test("historical entry prices remain observations and cannot become current commercial quotes", async () => {
  const evidence = { evidenceId: "historic:price", projectId: "elite-project", unitId: null,
    field: "observedPriceAed", value: 1_650_000, source: "Dated price list", recordId: "history-1",
    scope: "historical_observation", verifiedAt: new Date().toISOString() };
  const message = "The historical observed price was AED 1,650,000.";
  const citation = { text: message, evidenceId: evidence.evidenceId, projectId: evidence.projectId,
    unitId: null, field: evidence.field, value: evidence.value };
  assert.ok(await composeReplyWithModel(client(output(message, { claims: [citation] })), { buyer, allowedClaims: [evidence] }));
  const current = "The current price is AED 1,650,000.";
  assert.equal(await composeReplyWithModel(client(output(current, { claims: [{ ...citation, text: current }] })), {
    buyer, allowedClaims: [evidence] }), null);
});

test("comparison differences are independently recomputed, never accepted from comparison metadata", async () => {
  const a = factPack();
  const b = { ...factPack(), projectId: "elite-challenger", unitId: "challenger-unit",
    name: { ...a.name, value: "Test Heights" }, startingPriceAed: { ...a.startingPriceAed, value: 2_050_000 },
    startingPriceText: { ...a.startingPriceText, value: "AED 2,050,000" } };
  const comparison = { propertyA: { projectId: a.projectId, unitId: a.unitId }, propertyB: { projectId: b.projectId, unitId: b.unitId },
    differences: [{ dimension: "price", field: "startingPriceAed", a: 1_900_000, b: 2_050_000, delta: 150_000 }] };
  assert.deepEqual([...collectComparisonAmounts([a, b], comparison)], [150_000]);
  const message = "The extra cost is AED 150,000.";
  assert.equal(validateMessage(message, [a, b], { comparisonFacts: comparison }).ok, true);
  assert.ok(await composeReplyWithModel(client(output(message)), { buyer, packs: [a, b], comparisonFacts: comparison }));
  const named = "Test Gardens and Test Heights differ in price by AED 150,000.";
  assert.ok(await composeReplyWithModel(client(output(named, { claims: [nameClaim(a, "Test Gardens"), nameClaim(b, "Test Heights")] })), {
    buyer, packs: [a, b], comparisonFacts: comparison }));
  for (const wrong of [
    { ...comparison, differences: [{ ...comparison.differences[0], delta: 200_000 }] },
    { ...comparison, differences: [{ ...comparison.differences[0], b: 2_100_000, delta: 200_000 }] },
    { ...comparison, propertyB: { ...comparison.propertyB, unitId: "different-unit" } },
    { ...comparison, differences: [{ ...comparison.differences[0], dimension: "initial_cash" }] }
  ]) {
    assert.deepEqual([...collectComparisonAmounts([a, b], wrong)], []);
    assert.equal(await composeReplyWithModel(client(output("The extra cost is AED 200,000.")), {
      buyer, packs: [a, b], comparisonFacts: wrong }), null);
  }
  assert.deepEqual([...collectComparisonAmounts([a, { ...b, startingPriceAed: { confirmed: false, value: 2_050_000 } }], comparison)], []);
  assert.equal(await composeReplyWithModel(client(output("The booking fee is AED 150,000.")), {
    buyer, packs: [a, b], comparisonFacts: comparison }), null);
});

test("size and bedroom differences cannot authorize monetary claims", () => {
  const a = factPack(), b = { ...factPack(), projectId: "second", unitId: "second-unit",
    bedrooms: { ...a.bedrooms, value: 3 } };
  const comparison = { propertyA: { projectId: a.projectId, unitId: a.unitId }, propertyB: { projectId: b.projectId, unitId: b.unitId },
    differences: [{ dimension: "bedrooms", field: "bedrooms", a: 2, b: 3, delta: 1 }] };
  assert.equal(collectComparisonDifferences([a, b], comparison).length, 1);
  assert.equal(collectComparisonAmounts([a, b], comparison).size, 0);
  assert.equal(validateMessage("The extra cost is AED 1.", [a, b], { comparisonFacts: comparison }).ok, false);
});

test("research absence remains unknown and generic diligence remains useful", async () => {
  const message = "I'd check competing supply and resale evidence before choosing a handover exit. I don't have enough evidence to rank appreciation.";
  assert.ok(await composeReplyWithModel(client(output(message)), { buyer, packs: [], investmentTheses: [{
    liquidityCase: { confidence: "UNKNOWN" }, supplyCase: { risks: [], evidence: [] } }] }));
});

test("no-call permission survives next-step suggestions and proposed actions", async () => {
  const response = await composeReplyWithModel(client(output("Want me to break down the payment schedule?", {
    askedQuestion: true, questionField: "payment_details", proposedActions: ["payment_details"] })), {
    buyer, allowedActions: ["payment_details"], forbiddenActions: ["call"] });
  assert.ok(response);
  assert.equal(await composeReplyWithModel(client(output("We can review the payment schedule.", {
    proposedActions: ["call"] })), { buyer, allowedActions: ["payment_details"], forbiddenActions: ["call"] }), null);
});

test("parse and transport failure logs never contain buyer or model private text", async () => {
  const originalWarn = console.warn;
  const logs = [];
  console.warn = (...args) => logs.push(args.join(" "));
  const privateText = "buyer@example.com token-secret-abc";
  try {
    assert.equal(await composeReplyWithModel(client(privateText), { message: privateText }), null);
    assert.equal(await composeReplyWithModel({ apiKey: "synthetic", fetchImpl: async () => { throw new Error(privateText); } }, {
      message: privateText }), null);
  } finally { console.warn = originalWarn; }
  assert.ok(logs.length);
  assert.ok(logs.every(log => !log.includes("buyer@example.com") && !log.includes("token-secret-abc")));
});
