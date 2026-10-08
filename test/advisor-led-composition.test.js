import assert from "node:assert/strict";
import test from "node:test";
import { composeReplyWithModel } from "../src/conversation/llm.js";
import { inferQuestionField, questionRequests, validateBuyerResponse } from "../src/conversation/response-validation.js";
import { buildFactPack } from "../src/facts/retrieval.js";

const buyer = {
  useType: "investment", budgetAed: 3_000_000, investmentStrategy: "UNDECIDED",
  preferenceStates: { budgetAed: "specified", investmentObjective: "flexible" },
  investmentPreferenceState: "flexible", advisorLed: true
};
const metadata = (message, extra = {}) => ({ message, askedQuestion: false, questionField: null,
  claims: [], proposedActions: [], ...extra });
function client(output, inspect = () => {}) {
  return { apiKey: "synthetic", baseUrl: "https://synthetic.example.test", fetchImpl: async (_url, options) => {
    const request = JSON.parse(options.body);
    inspect(JSON.parse(request.messages[0].content), request.system);
    return { ok: true, json: async () => ({ content: [{ type: "text", text: JSON.stringify(output) }] }) };
  } };
}

test("closed investment priority cannot survive as a stale required model question", async () => {
  let payload;
  const discoveryAnalysis = { dimensions: [{ key: "future_supply", status: "UNKNOWN" }] };
  const message = "That's fine — I'll do the filtering. With around AED 3M for investment, I'll compare entry position, cash deployment and resale evidence where supported.";
  const response = await composeReplyWithModel(client(metadata(message), input => { payload = input; }), {
    buyer, message: "I don't know", discoveryAnalysis,
    recentTurns: [{ role: "assistant", text: "What's your priority?", questionField: "advisoryPriority" }],
    requiredQuestion: { field: "advisoryPriority", prompt: "What matters most?" }
  });
  assert.ok(response);
  assert.equal(payload.requiredQuestion, null);
  assert.deepEqual(payload.buyer.preferenceStates, buyer.preferenceStates);
  assert.equal(payload.buyer.advisorLed, true);
  assert.equal(payload.recentTurns[0].questionField, "advisoryPriority");
  assert.deepEqual(payload.discoveryAnalysis, discoveryAnalysis);
});

test("priority choices keep one semantic priority even when a cash option is offered", () => {
  const question = "What should I optimise for — best overall, growth potential, lowest cash upfront, safer exit, or should I choose?";
  assert.equal(inferQuestionField(question), "investmentObjective");
  assert.equal(questionRequests(question).length, 1);
  assert.equal(validateBuyerResponse(question, { buyer }).ok, false);
});

for (const question of ["What matters most?", "What's your priority?", "What are you looking for in the investment?"]) {
  test(`explicit flexibility rejects the priority paraphrase: ${question}`, () => {
    const check = validateBuyerResponse(question, { buyer,
      metadata: metadata(question, { askedQuestion: true, questionField: "compare" }), allowedActions: ["compare"] });
    assert.ok(check.violations.some(row => row.type === "flexible_field_question"));
  });
}

test("analysis heading and a cash comparison next step count as one question", () => {
  const message = "What I'll compare: entry position, cash deployment and factual risks. Want me to compare the top two, or focus on how much cash each needs before handover?";
  const check = validateBuyerResponse(message, { buyer: { ...buyer, cashAvailableAed: 200_000 },
    requiredQuestion: { field: "advisoryNextAction" }, allowedActions: ["compare", "payment_details"],
    metadata: metadata(message, { askedQuestion: true, questionField: "advisoryNextAction" }) });
  assert.equal(check.ok, true, JSON.stringify(check.violations));
  assert.equal(check.questionCount, 1);
});

for (const [field, question] of [
  ["exitHorizon", "Would you hold or sell?"],
  ["cashDeploymentPreference", "Would you prefer lower construction cash or lowest total price?"],
  ["cashAvailableAed", "What's your initial cash?"],
  ["financing", "Are you financing or paying cash?"]
]) {
  test(`a flexible ${field} cannot be reasked using natural wording`, () => {
    const check = validateBuyerResponse(question, { buyer: { preferenceStates: { [field]: "flexible" } } });
    assert.ok(check.violations.some(row => row.type === "flexible_field_question" && row.field === field), JSON.stringify(check));
  });
}

test("canonical qualification aliases do not authorize unrelated action or contact metadata", () => {
  const message = "What number works best?";
  const check = validateBuyerResponse(message, { buyer: {}, requiredQuestion: { field: "phone" },
    metadata: metadata(message, { askedQuestion: true, questionField: "payment_details" }) });
  assert.ok(check.violations.some(row => row.type === "required_question_missing"));
});

test("known buyer budget cannot excuse an uncited property price with the same amount", async () => {
  const pack = buildFactPack({
    project: { id: "synthetic", name: "Synthetic Gardens", active: true, source: "Synthetic fixture",
      lastVerified: new Date().toISOString(), area: "Yas Island" },
    unit: { id: "synthetic-unit", projectId: "synthetic", active: true, startingPriceAed: 2_500_000 }
  });
  const message = "Synthetic Gardens starts at AED 3M.";
  const check = validateBuyerResponse(message, { buyer, packs: [pack], metadata: metadata(message, {
    claims: [{ text: message, projectId: pack.projectId, unitId: pack.unitId, field: "name", value: pack.name.value }]
  }) });
  assert.equal(check.ok, false, JSON.stringify(check.violations));
  assert.equal(await composeReplyWithModel(client(metadata("I recommend Phantom.")), { buyer }), null);
});

test("analysis-method wording is allowed while fabricated performance remains rejected", async () => {
  assert.ok(await composeReplyWithModel(client(metadata("I prefer to assess the entry position and documented cash exposure before making a shortlist.")), { buyer }));
  assert.equal(await composeReplyWithModel(client(metadata("I prefer to assess a guaranteed 20% appreciation.")), { buyer }), null);
});

test("advisor-led analysis cannot manufacture a numerical or qualitative investment score", () => {
  for (const message of ["Investment score: excellent.", "Investment rating is A+.",
    "Investment score 9 out of 10.", "This gets 9 out of 10 for investment.", "تقييم الاستثمار: ممتاز."]) {
    const check = validateBuyerResponse(message, { buyer });
    assert.ok(check.violations.some(row => row.type === "unsupported_investment_score"), message);
  }
  const packs = [buildFactPack({ project: { id: "scored", name: "Synthetic Gardens", active: true,
    source: "Synthetic fixture", lastVerified: new Date().toISOString() },
  unit: { id: "scored-unit", projectId: "scored", active: true } })];
  for (const message of ["Synthetic Gardens: 9 out of 10.", "Synthetic Gardens is rated 9 out of 10."]) {
    const check = validateBuyerResponse(message, { buyer, packs });
    assert.ok(check.violations.some(row => row.type === "unsupported_investment_score"), message);
  }
  assert.equal(validateBuyerResponse("I won't manufacture an investment score; I'll compare the documented entry position and cash exposure.", { buyer }).ok, true);
});
