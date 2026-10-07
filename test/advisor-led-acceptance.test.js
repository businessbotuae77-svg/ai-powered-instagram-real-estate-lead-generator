import assert from "node:assert/strict";
import test from "node:test";
import { setupConversation } from "./helpers.js";
import { ConversationEngine } from "../src/conversation/engine.js";
import { ConversationMemory } from "../src/conversation/memory.js";
import { emptyBuyer } from "../src/schema/fields.js";
import { emptyIntelligence } from "../src/facts/intelligence.js";
import { commercialOfferGate } from "../src/facts/commercial-offers.js";
import { buildInvestmentStrategy } from "../src/conversation/investment-strategy.js";
import { advisoryReady } from "../src/conversation/advisor-strategy.js";
import { canPitchBuyer } from "../src/conversation/match-resolve.js";
import { canonicalQuestionField } from "../src/conversation/preference-state.js";
import { inferQuestionField, validateBuyerResponse } from "../src/conversation/response-validation.js";
import { composeReplyWithModel } from "../src/conversation/llm.js";

// Every property and commercial record below is fictional. These regressions
// exercise the production controller without contacting Airtable or an LLM.
const VERIFIED = new Date(Date.now() - 1000).toISOString();
const SOURCE = "https://synthetic.example.test/advisor-led-evidence";
const OFFLINE = { useLlm: false };
const PRIORITY_QUESTION = /(?:what matters most|what(?:'s| is) your priority|what are you looking for in (?:the|your) investment|which investment priority|what should i optimi[sz]e for)[^.!\n]*[?؟]/i;
const BUDGET_QUESTION = /(?:what budget|what(?:'s| is) your budget|how much[^.!\n]*(?:spend|budget))[^.!\n]*[?؟]/i;

function property(id, { price = 2_400_000, cash = 240_000, beds = 1, area = "Yas Island", ...patch } = {}) {
  return {
    project: { id, name: `Fixture ${id}`, active: true, developerId: "fixture-developer", developerName: "Fixture Developer", developerActive: true,
      emirate: "Abu Dhabi", area, status: "Off-plan", handover: "Q4 2028", source: SOURCE, lastVerified: VERIFIED,
      paymentPlanAvailable: true, paymentPlanSummary: "60/40", initialPaymentAed: cash,
      description: "A residential project documented in the fictional developer brochure.", features: [], ...patch },
    unit: { id: `${id}-unit`, projectId: id, active: true, bedrooms: beds, propertyType: "apartment", startingPriceAed: price,
      initialPaymentAed: cash, sizeSqftFrom: beds === 1 ? 850 : 1200, sizeSqftTo: beds === 1 ? 850 : 1200, availability: "Available" }
  };
}

async function setup(records = [property("entry"), property("lower-cash", { price: 2_750_000, cash: 150_000, beds: 2, area: "Al Reem Island" })]) {
  const services = await setupConversation();
  services.store.developers = [{ id: "fixture-developer", name: "Fixture Developer", active: true }];
  services.store.projects = records.map(row => row.project);
  services.store.units = records.map(row => row.unit);
  services.store.listIntelligence = () => emptyIntelligence();
  return services;
}

function safe(result) {
  assert.equal(result.check.ok, true, JSON.stringify(result.check.violations));
  assert.ok((result.reply.match(/[?؟]/g) || []).length <= 1, result.reply);
  assert.doesNotMatch(result.reply, /\b(?:will appreciate|guaranteed (?:return|growth)|expected appreciation|investment score|predicted (?:price|return))\b/i);
}

function delegated(result) {
  assert.equal(result.buyer.budgetAed, 3_000_000);
  assert.equal(result.buyer.useType, "investment");
  assert.equal(result.buyer.investmentPreferenceState, "flexible");
  assert.equal(result.buyer.advisorLed, true);
  assert.equal(result.investmentProfile.strategy, "UNDECIDED");
  assert.notEqual(canonicalQuestionField(result.nextQuestion?.field), "investmentObjective");
  assert.doesNotMatch(result.reply, PRIORITY_QUESTION);
  assert.doesNotMatch(result.reply, BUDGET_QUESTION);
  safe(result);
}

async function askPriority(services, id = "investor") {
  await services.buyers.remember(id, { useType: "investment", budget: 3_000_000 });
  services.memory.setLastAskedField(id, "investmentObjective");
  services.memory.addTurn(id, { role: "assistant", text: "What matters most to you in the investment?", stage: "qualifying", questionField: "investmentObjective" });
  return id;
}

async function acceptance(services, id, options = OFFLINE) {
  const fresh = await services.engine.handleMessage(id, "Start fresh", options);
  assert.equal(fresh.nextQuestion?.field, "useType", fresh.reply);
  safe(fresh);
  const investor = await services.engine.handleMessage(id, "Exploring investment opportunities", options);
  assert.equal(investor.buyer.useType, "investment");
  assert.equal(investor.nextQuestion?.field, "budgetAed", investor.reply);
  safe(investor);
  const budget = await services.engine.handleMessage(id, "3 million", options);
  assert.equal(budget.buyer.budgetAed, 3_000_000);
  safe(budget);
  const response = await services.engine.handleMessage(id, "I don't know", options);
  delegated(response);
  assert.match(response.reply, /open|filter|choose|compare|handle|take care|fine|shortlist/i);
  return response;
}

test("acceptance: start fresh, exploring investment, 3 million, I don't know produces useful candidates", async () => {
  const services = await setup();
  const result = await acceptance(services, "exact-production-flow");
  assert.ok(result.advisor.primary, result.reply);
  assert.ok(result.matches.length, result.reply);
  assert.match(result.reply, /Fixture /);
  assert.deepEqual(result.buyer.preferredAreas, []);
  assert.deepEqual(result.buyer.bedrooms, []);
  assert.doesNotMatch(result.reply, /outside your preferred area|your preferred area remains|different bedroom count|;\s+remains the priority/i);
  if (result.advisor.challenger) {
    assert.equal(result.advisor.challenger.role, "CHALLENGER");
    // Internal roles stay internal; the buyer sees a natural lead-in.
    assert.doesNotMatch(result.reply, /PRIMARY|CHALLENGER/);
    assert.match(result.reply, /One step up|A lower-cost option|An option with|A ready option|An off-plan alternative|Also worth a look/);
    assert.match(result.reply, /initial|cash/i);
  }
  assert.equal(result.investmentProfile.forecastAllowed, false);
});

for (const [index, message] of ["idk", "I don't know", "you choose", "best option", "not sure", "whatever you think", "I'm open", "no preference"].entries()) {
  test(`uncertainty: ${JSON.stringify(message)} delegates investment analysis without repeating priority`, async () => {
    const services = await setup();
    const id = await askPriority(services, `uncertainty-${index}`);
    const result = await services.engine.handleMessage(id, message, OFFLINE);
    delegated(result);
    assert.ok(result.advisor.primary, result.reply);
    assert.equal(result.buyer.preferenceStates.investmentObjective, "flexible");
  });
}

test("regression 5: repeated uncertainty preserves AED 3M and durable flexibility across controller restart", async () => {
  const services = await setup();
  const id = await askPriority(services, "restart-flexibility");
  await services.engine.handleMessage(id, "idk", OFFLINE);
  const restarted = new ConversationEngine({ buyers: services.buyers, properties: services.properties, memory: new ConversationMemory() });
  for (const message of ["I don't know", "Show me sensible options", "best option"]) {
    delegated(await restarted.handleMessage(id, message, OFFLINE));
  }
  const saved = services.store.getBuyer(id);
  assert.equal(saved.investmentPreferenceState, "flexible");
  assert.equal(saved.preferenceStates.investmentObjective, "flexible");
  assert.equal(saved.budgetAed, 3_000_000);
});

const slots = [
  ["budgetAed", "What budget are you working with?"],
  ["preferredAreas", "Which area are you leaning toward?"],
  ["bedrooms", "How many bedrooms would you prefer?"],
  ["propertyTypes", "Which property type would you prefer?"],
  ["investmentObjective", "What's your priority?"],
  ["exitHorizon", "What is your exit strategy?"],
  ["riskTolerance", "What risk level are you comfortable with?"],
  ["cashDeploymentPreference", "What cash deployment preference should I use?"],
  ["financing", "Do you prefer cash, mortgage, or a payment plan?"],
  ["advisoryPriority", "What should I optimise for?"]
];
for (const [field, prompt] of slots) {
  test(`regression 6: uncertainty answers the semantic ${field} slot rather than restarting it`, async () => {
    const services = await setup();
    const id = `semantic-${field}`;
    await services.buyers.remember(id, { useType: "investment", ...(field === "budgetAed" ? {} : { budget: 3_000_000 }) });
    services.memory.setLastAskedField(id, field);
    services.memory.addTurn(id, { role: "assistant", text: prompt, stage: "qualifying", questionField: field });
    const result = await services.engine.handleMessage(id, "idk", OFFLINE);
    const canonical = canonicalQuestionField(field);
    assert.equal(result.buyer.preferenceStates[canonical], "flexible", field);
    assert.notEqual(canonicalQuestionField(result.nextQuestion?.field), canonical, result.reply);
    assert.ok(!validateBuyerResponse(prompt, { buyer: result.buyer }).ok, prompt);
    safe(result);
    if (field === "budgetAed") {
      assert.equal(result.buyer.budgetAed, null, "Delegating an unknown budget cannot invent spending capacity");
      assert.equal(result.advisor.primary, null);
    } else {
      assert.equal(result.buyer.budgetAed, 3_000_000);
    }
  });
}

test("regression 6: priority paraphrases are the same answered qualification question", async () => {
  const services = await setup();
  const id = await askPriority(services, "priority-paraphrases");
  const result = await services.engine.handleMessage(id, "I don't know", OFFLINE);
  for (const prompt of ["What matters most?", "What's your priority?", "What are you looking for in the investment?", "What should I optimise for?"]) {
    assert.equal(canonicalQuestionField(inferQuestionField(prompt)), "investmentObjective", prompt);
    const check = validateBuyerResponse(prompt, { buyer: result.buyer });
    assert.equal(check.ok, false, `${prompt}: ${JSON.stringify(check.violations)}`);
  }
});

test("regression 7: unknown area remains flexible while investment options span areas", async () => {
  const services = await setup();
  const id = await askPriority(services, "area-flexible");
  services.memory.setLastAskedField(id, "preferredAreas");
  const result = await services.engine.handleMessage(id, "No preference", OFFLINE);
  assert.deepEqual(result.buyer.preferredAreas, []);
  assert.equal(result.buyer.preferenceStates.preferredAreas, "flexible");
  assert.notEqual(result.nextQuestion?.field, "preferredAreas");
  assert.ok(result.advisor.primary, result.reply);
  assert.ok(new Set(result.advisor.candidates.map(row => row.project.area)).size > 1);
  safe(result);
});

test("regression 8: unknown bedrooms stay product-flexible without inventing a bedroom requirement", async () => {
  const services = await setup();
  const id = await askPriority(services, "bedrooms-flexible");
  services.memory.setLastAskedField(id, "bedrooms");
  const result = await services.engine.handleMessage(id, "You choose", OFFLINE);
  assert.deepEqual(result.buyer.bedrooms, []);
  assert.deepEqual(result.buyer.propertyTypes, []);
  assert.equal(result.buyer.propertyTypeFlexibility, true);
  assert.ok(result.advisor.primary, result.reply);
  assert.ok(new Set(result.advisor.candidates.map(row => row.unit.bedrooms)).size > 1);
  assert.ok(!["bedrooms", "propertyTypes"].includes(result.nextQuestion?.field));
  safe(result);
});

test("regression 9: investment, known budget and flexible preferences suffice for matching and UNDECIDED analysis", async () => {
  const services = await setup();
  const id = await askPriority(services, "minimal-discovery");
  const result = await services.engine.handleMessage(id, "you choose", OFFLINE);
  assert.equal(advisoryReady(result.buyer), true);
  assert.equal(canPitchBuyer(result.buyer), true);
  const strategy = buildInvestmentStrategy(result.buyer);
  assert.equal(strategy.nextQuestionField, null);
  for (const dimension of ["entry_price", "project_stage", "area_maturation", "cash_deployed", "future_supply", "resale_competition"]) {
    assert.ok(strategy.priorities.includes(dimension), dimension);
  }
  assert.ok(result.advisor.primary, result.reply);
  assert.equal(result.advisor.primary.role, "PRIMARY");
  const dimensions = ["entry_position", "project_release_stage", "area_masterplan_maturity", "documented_catalysts", "product_differentiation",
    "payment_structure", "cash_deployment", "handover_timing", "competing_exit_supply", "transaction_resale_evidence", "rental_fallback", "factual_risks"];
  for (const row of result.advisor.discoveryAnalysis.candidates) {
    assert.deepEqual(row.comparison.map(value => value.dimension), dimensions);
    assert.equal(row.comparison.find(value => value.dimension === "documented_catalysts").status, "UNKNOWN");
    assert.equal(row.comparison.find(value => value.dimension === "transaction_resale_evidence").futureResaleConclusion, "UNKNOWN");
  }
  assert.equal(result.advisor.discoveryAnalysis.forecastAllowed, false);
  assert.equal(result.buyer.exitHorizon, null);
  assert.equal(result.buyer.riskTolerance, null);
  delegated(result);
});

function offer(id, patch = {}) {
  return { id, offerId: id, projectId: "offer-project", unitId: null, unitType: "apartment", bedrooms: 1,
    price: 2_200_000, priceBasis: "Starting", availability: "Available", checkedOn: VERIFIED,
    approval: "Approved", botEnabled: true, commercialSource: SOURCE, researchOnly: false, ...patch };
}

test("regression 10: advisor delegation cannot activate draft, disabled, expired or research-only offers", async () => {
  const records = [property("offer-project")];
  const services = await setup(records);
  services.store.units = [];
  const approved = offer("approved-live");
  const blocked = [offer("draft", { approval: "Draft", price: 1_111_000 }), offer("disabled", { botEnabled: false, price: 1_222_000 }),
    offer("research", { researchOnly: true, price: 1_333_000 }), offer("expired", { validUntil: "2020-01-01", price: 1_444_000 })];
  services.store.listIntelligence = () => ({ ...emptyIntelligence(), offers: [approved, ...blocked] });
  assert.equal(commercialOfferGate(approved).ok, true);
  assert.ok(blocked.every(row => !commercialOfferGate(row).ok));
  const id = await askPriority(services, "commercial-gates");
  const result = await services.engine.handleMessage(id, "I don't know", OFFLINE);
  delegated(result);
  assert.ok(result.advisor.primary, result.reply);
  assert.ok(result.advisor.candidates.every(row => row.unit.id === "offer:approved-live"));
  assert.doesNotMatch(result.reply, /1,111,000|1,222,000|1,333,000|1,444,000/);
  services.store.listIntelligence = () => ({ ...emptyIntelligence(), offers: blocked });
  const unavailable = await services.engine.handleMessage(id, "Show me options", OFFLINE);
  assert.equal(unavailable.advisor.primary, null);
  assert.equal(unavailable.matches.length, 0);
  assert.doesNotMatch(unavailable.reply, /1,111,000|1,222,000|1,333,000|1,444,000/);
  safe(unavailable);
});

function model(response, inspect = () => {}) {
  return { apiKey: "synthetic", model: "synthetic", baseUrl: "https://synthetic.test", fetchImpl: async (_url, request) => {
    const body = JSON.parse(request.body);
    const payload = JSON.parse(body.messages[0].content);
    inspect(payload);
    const value = typeof response === "function" ? response(payload) : response;
    return { ok: true, json: async () => ({ content: [{ type: "text", text: JSON.stringify(value) }] }) };
  } };
}
const output = (message, patch = {}) => ({ message, askedQuestion: false, questionField: null, claims: [], proposedActions: [], ...patch });

test("regression 11: uncited investment facts remain rejected during advisor-led discovery", async () => {
  const buyer = { ...emptyBuyer("safe-investor"), useType: "investment", budgetAed: 3_000_000, advisorLed: true, investmentPreferenceState: "flexible",
    preferenceStates: { investmentObjective: "flexible" } };
  for (const message of ["The area has a new metro station.", "There is limited competing supply at handover.", "This project has strong resale demand.", "Rental yield is 8%."]) {
    assert.equal(await composeReplyWithModel(model(output(message)), { buyer, investmentProfile: buildInvestmentStrategy(buyer) }), null, message);
  }
});

test("valid natural advisor analysis accepts a known buyer budget and one action choice", async () => {
  const buyer = { ...emptyBuyer("natural-advisor"), useType: "investment", budgetAed: 3_000_000, advisorLed: true,
    investmentPreferenceState: "flexible", preferenceStates: { investmentObjective: "flexible" } };
  const message = "That's fine — you're open, so I'll do the filtering for you. With around AED 3,000,000 for investment, I'll compare entry price, area development, payment cash exposure, competing supply, resale evidence and rental fallback where supported. Want me to compare the top two, or focus on how much cash each needs before handover?";
  const result = await composeReplyWithModel(model(output(message, { askedQuestion: true, questionField: "advisoryNextAction" })), {
    buyer, message: "I don't know", investmentProfile: buildInvestmentStrategy(buyer),
    requiredQuestion: { field: "advisoryNextAction", prompt: "Want me to compare the top two?" }, allowedActions: ["compare", "payment_details"]
  });
  assert.ok(result, message);
  assert.equal(result.askedQuestion, true);
});

test("unsupported recommendation subjects remain rejected after investment preferences become flexible", async () => {
  const buyer = { ...emptyBuyer("unknown-recommendation"), useType: "investment", budgetAed: 3_000_000, advisorLed: true,
    investmentPreferenceState: "flexible", preferenceStates: { investmentObjective: "flexible" } };
  for (const message of ["I recommend Fictional Heights because it fits your budget.", "I would choose Unlisted Villas for you."]) {
    assert.equal(await composeReplyWithModel(model(output(message)), { buyer }), null, message);
  }
});

test("regression 12: advisor-led discovery cannot fabricate appreciation forecasts or marketing scores", async () => {
  const services = await setup();
  const id = await askPriority(services, "no-appreciation-forecast");
  const discovery = await services.engine.handleMessage(id, "you choose", OFFLINE);
  for (const row of discovery.advisor.candidates) {
    assert.equal(row.investmentThesis.forecastAllowed, false);
    assert.deepEqual(row.investmentThesis.forecasts, []);
  }
  const answer = await services.engine.handleMessage(id, "Will this appreciate 20%?", OFFLINE);
  assert.match(answer.reply, /can't|cannot|forecast|promise|historical|assumption/i);
  safe(answer);
  for (const message of ["This will appreciate 20%.", "Expected appreciation is 20%.", "Projected IRR is 20%.", "The investment score is 95/100."]) {
    assert.equal(await composeReplyWithModel(model(output(message)), { buyer: discovery.buyer }), null, message);
  }
});

test("regression 13: candidate value precedes at most one useful action question", async () => {
  const services = await setup();
  const id = await askPriority(services, "value-first");
  const result = await services.engine.handleMessage(id, "best option", OFFLINE);
  delegated(result);
  assert.match(result.reply, /Fixture /);
  const questionAt = result.reply.search(/[?؟]/);
  assert.ok(questionAt < 0 || result.reply.indexOf("Fixture ") < questionAt, result.reply);
  assert.ok(!["preferredAreas", "bedrooms", "propertyTypes", "investmentObjective", "exitHorizon", "riskTolerance"].includes(result.nextQuestion?.field));
});

test("acceptance B: insufficient commercial evidence allows one different useful question", async () => {
  const services = await setup();
  services.store.units = [];
  const result = await acceptance(services, "insufficient-evidence");
  assert.equal(result.advisor.primary, null);
  assert.equal(result.matches.length, 0);
  assert.doesNotMatch(result.reply, /2,400,000|2,750,000|240,000|150,000/);
  assert.ok(result.nextQuestion, result.reply);
  assert.ok(!["investmentObjective", "advisoryPriority"].includes(result.nextQuestion.field));
});

test("regression 14: rejected model question loops fall back to advisor discovery across the exact flow", async t => {
  const services = await setup();
  const payloads = [];
  services.engine.llm = model(payload => "currentMessage" in payload
    ? output("What matters most to you? What's your priority?", { askedQuestion: true, questionField: "investmentObjective" })
    : { facts: {}, intents: [], signals: [], unsure: false, ack: false }, payload => payloads.push(payload));
  t.mock.method(globalThis, "fetch", services.engine.llm.fetchImpl);
  const result = await acceptance(services, "rejected-model-flow", {});
  assert.equal(result.polished, false);
  assert.ok(result.advisor.primary, result.reply);
  const composed = payloads.filter(payload => "currentMessage" in payload);
  const finalPayload = composed.at(-1);
  assert.equal(finalPayload.currentMessage, "I don't know");
  assert.equal(finalPayload.buyer.investmentPreferenceState, "flexible");
  assert.notEqual(canonicalQuestionField(finalPayload.requiredQuestion?.field), "investmentObjective");
  assert.equal(finalPayload.investmentProfile.strategy, "UNDECIDED");
  for (const message of ["idk", "not sure", "you choose"]) {
    delegated(await services.engine.handleMessage("rejected-model-flow", message, {}));
  }
});

test("regression 14: an unavailable model cannot erase uncertainty or repeat its qualification slot", async t => {
  const services = await setup();
  services.engine.llm = { apiKey: "synthetic", baseUrl: "https://synthetic.test", fetchImpl: async () => { throw new Error("Synthetic transport unavailable"); } };
  t.mock.method(globalThis, "fetch", services.engine.llm.fetchImpl);
  const result = await acceptance(services, "unavailable-model-flow", {});
  assert.equal(result.polished, false);
  assert.ok(result.advisor.primary, result.reply);
});
