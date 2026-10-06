import assert from "node:assert/strict";
import test from "node:test";
import { setupConversation } from "./helpers.js";
import { extractFactsFromMessage } from "../src/conversation/extract.js";

const offline = { useLlm: false };
const inventedContext = /confirmed option.*(?:fits|details)|for that property|which project|what project|which details|approved evidence|approved matrix/i;
const qualificationFields = new Set(["budgetAed", "preferredAreas", "propertyTypes", "bedrooms", "cashAvailableAed", "financing", "phone"]);

test("generic project requests retain explicit area, budget and bedroom criteria", () => {
  const { facts } = extractFactsFromMessage("Show me a project with 2 bedrooms in Yas under 2M");
  assert.equal(facts.budget, 2_000_000);
  assert.equal(facts.area, "Yas Island");
  assert.equal(facts.bedrooms, 2);
});

function coherent(result) {
  assert.equal(result.check.ok, true, JSON.stringify(result.check));
  assert.ok((result.reply.match(/[?؟]/g) || []).length <= 1, result.reply);
  assert.equal(result.alertRecommended, false);
  assert.equal(result.followUpSubmitted, false);
  assert.equal(result.callRequestSubmitted, false);
  assert.doesNotMatch(result.reply, inventedContext);
}

async function previousSearch() {
  const services = await setupConversation();
  await services.engine.handleMessage("screenshot", "2M Yas 1 bedroom apartment for investment", offline);
  await services.buyers.patchBuyer("screenshot", { noCalls: true, preferredContactChannel: "instagram" });
  return services;
}

test("screenshot regression: Hi then Fresh leaves an open conversation without a failed property search", async () => {
  const { engine } = await previousSearch();
  const greeting = await engine.handleMessage("screenshot", "Hi", offline);
  assert.equal(greeting.buyer.budgetAed, 2_000_000);
  assert.equal(greeting.buyer.noCalls, true);
  assert.equal(greeting.stage, "welcome_back");
  assert.match(greeting.reply, /continue.*fresh/i);
  assert.equal(greeting.matches.length, 0);
  const fresh = await engine.handleMessage("screenshot", "Fresh", offline);
  coherent(fresh);
  assert.equal(fresh.buyer.budgetAed, null);
  assert.deepEqual(fresh.buyer.preferredAreas, []);
  assert.deepEqual(fresh.buyer.bedrooms, []);
  assert.deepEqual(fresh.buyer.propertyTypes, []);
  assert.equal(fresh.buyer.activeRecommendationProjectId, null);
  assert.equal(fresh.buyer.activeRecommendationUnitId, null);
  assert.equal(fresh.buyer.noCalls, true);
  assert.equal(fresh.buyer.preferredContactChannel, "instagram");
  assert.equal(fresh.matches.length, 0);
  assert.ok(!qualificationFields.has(fresh.nextQuestion?.field), fresh.reply);
  assert.match(fresh.reply, /fresh|start|explor|understand|help/i);
});

test("screenshot regression: clarification and correction cannot invent an unnamed property", async () => {
  const { engine } = await previousSearch();
  await engine.handleMessage("screenshot", "Hi", offline);
  await engine.handleMessage("screenshot", "Fresh", offline);
  for (const message of ["Which details", "Im not asking"]) {
    const result = await engine.handleMessage("screenshot", message, offline);
    coherent(result);
    assert.equal(result.buyer.budgetAed, null);
    assert.equal(result.buyer.projectInterest, null);
    assert.ok(!qualificationFields.has(result.nextQuestion?.field), result.reply);
  }
});

test("screenshot regression: How do I make money answers the investment question after a fresh search", async () => {
  const { engine } = await previousSearch();
  for (const message of ["Hi", "Fresh", "Which details", "Im not asking"]) {
    await engine.handleMessage("screenshot", message, offline);
  }
  const result = await engine.handleMessage("screenshot", "How do I make money", offline);
  coherent(result);
  assert.match(result.reply, /rent(?:al)?(?: income)?/i);
  assert.match(result.reply, /growth|resale|appreciation|sell|value/i);
  assert.match(result.reply, /cost|risk|fee|guarantee|return/i);
  assert.ok(!qualificationFields.has(result.nextQuestion?.field), result.reply);
  assert.equal(result.buyer.noCalls, true);
  assert.equal(result.buyer.preferredContactChannel, "instagram");
  assert.equal(result.buyer.budgetAed, null);
  assert.equal(result.buyer.projectInterest, null);
  assert.equal(result.matches.length, 0);
});

test("general property-investment education works without prior inventory or qualification", async () => {
  for (const message of ["How do I make money", "How can I make money from real estate?", "How does property investing work?"]) {
    const { engine } = await setupConversation();
    const result = await engine.handleMessage("new-explorer", message, offline);
    coherent(result);
    assert.match(result.reply, /rent|income/i);
    assert.match(result.reply, /growth|resale|appreciation|sell|value/i);
    assert.ok(!qualificationFields.has(result.nextQuestion?.field), result.reply);
    assert.doesNotMatch(result.reply, /AED\s*\d|\d+(?:\.\d+)?%.*(?:yield|roi|return)/i);
  }
});

test("model ask_facts misclassification cannot replace broad investment education with missing-property copy", async () => {
  const services = await setupConversation();
  await services.buyers.patchBuyer("model-explorer", { noCalls: true, preferredContactChannel: "instagram" });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body);
    const result = payload.system.includes("extract structured buyer requirements")
      ? { facts: {}, intents: ["ask_facts"], signals: [] }
      : { message: "I don't have current confirmed terms for that property yet. Which project are you asking about?",
        askedQuestion: true, questionField: "comparisonProjects", claims: [], proposedActions: [] };
    return { ok: true, json: async () => ({ content: [{ type: "text", text: JSON.stringify(result) }] }) };
  };
  services.engine.llm = { apiKey: "synthetic-test-key", baseUrl: "https://synthetic.test" };
  try {
    const result = await services.engine.handleMessage("model-explorer", "How do I make money");
    coherent(result);
    assert.match(result.reply, /rent|income/i);
    assert.match(result.reply, /growth|resale|appreciation|sell|value/i);
    assert.equal(result.buyer.noCalls, true);
    assert.equal(result.buyer.preferredContactChannel, "instagram");
    assert.equal(result.buyer.projectInterest, null);
    assert.equal(result.polished, false);
  } finally { globalThis.fetch = originalFetch; }
});

test("fresh-search reset preserves stored contact permissions and contact identity", async () => {
  const { engine, buyers } = await previousSearch();
  await buyers.patchBuyer("screenshot", { preferredContactChannel: "whatsapp", noCalls: true,
    contactDeclined: true, name: "Test Buyer", phone: "+971501234567" });
  const result = await engine.handleMessage("screenshot", "Start fresh", offline);
  coherent(result);
  assert.equal(result.buyer.budgetAed, null);
  assert.equal(result.buyer.preferredContactChannel, "whatsapp");
  assert.equal(result.buyer.noCalls, true);
  assert.equal(result.buyer.contactDeclined, true);
  assert.equal(result.buyer.name, "Test Buyer");
  assert.equal(result.buyer.phone, "+971501234567");
  assert.equal(result.callRequest, null);
  assert.equal(result.pendingOffer, null);
  assert.doesNotMatch(result.reply, /number|call you|follow.up request/i);
});

test("reset model context cannot resurrect the previous search on Fresh or the next educational turn", async () => {
  const services = await previousSearch();
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body);
    const input = JSON.parse(payload.messages[0].content);
    requests.push(input);
    const isUnderstanding = payload.system.includes("extract structured buyer requirements");
    const result = isUnderstanding ? { facts: {}, intents: [], signals: [] }
      : { message: input.draftReply, askedQuestion: Boolean(input.requiredQuestion),
        questionField: input.requiredQuestion?.field || null, claims: [], proposedActions: [] };
    return { ok: true, json: async () => ({ content: [{ type: "text", text: JSON.stringify(result) }] }) };
  };
  services.engine.llm = { apiKey: "synthetic-test-key", baseUrl: "https://synthetic.test" };
  try {
    const fresh = await services.engine.handleMessage("screenshot", "Fresh");
    coherent(fresh);
    assert.equal(fresh.buyer.budgetAed, null);
    const education = await services.engine.handleMessage("screenshot", "How do I make money");
    coherent(education);
    assert.equal(education.buyer.budgetAed, null);
    assert.equal(education.buyer.projectInterest, null);
    assert.ok(requests.length > 0, "The test must inspect at least one model payload");
    for (const input of requests) {
      assert.equal(input.buyer.budgetAed, null);
      assert.deepEqual(input.buyer.preferredAreas, []);
      assert.doesNotMatch(JSON.stringify(input.recentTurns || []), /2M|Yas|1 bedroom|1,200,000/i);
      assert.equal(input.buyer.noCalls, true);
      assert.equal(input.buyer.preferredContactChannel, "instagram");
    }
  } finally { globalThis.fetch = originalFetch; }
});

test("general investment education remembers an existing budget while leaving the area open", async () => {
  const { engine } = await setupConversation();
  await engine.handleMessage("known-budget-education", "2M", offline);
  const result = await engine.handleMessage("known-budget-education", "How do I make money", offline);
  coherent(result);
  assert.equal(result.buyer.budgetAed, 2_000_000);
  assert.deepEqual(result.buyer.preferredAreas, []);
  assert.match(result.reply, /rent|income/i);
  assert.match(result.reply, /growth|resale|appreciation|sell|value/i);
  assert.notEqual(result.nextQuestion?.field, "budgetAed");
  assert.notEqual(result.nextQuestion?.field, "preferredAreas");
  assert.doesNotMatch(result.reply, /what budget|what.*budget.*working|which area/i);
});

test("real named-project price questions still use the selected fresh fact pack", async () => {
  const { engine } = await setupConversation();
  const selected = await engine.handleMessage("named-price", "2M Yas 1 bedroom apartment", offline);
  assert.ok(selected.advisor.primary);
  const pack = selected.packs.find(row => row.projectId === selected.buyer.activeRecommendationProjectId
    && row.unitId === selected.buyer.activeRecommendationUnitId);
  assert.ok(pack?.startingPriceAed.confirmed);
  const result = await engine.handleMessage("named-price", `What is the price of ${pack.name.value}?`, offline);
  assert.equal(result.check.ok, true, JSON.stringify(result.check));
  assert.match(result.reply, new RegExp(pack.name.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.ok(result.reply.includes(pack.startingPriceText.value), result.reply);
  assert.doesNotMatch(result.reply, /general.*invest|rental income.*long.term growth|how.*make money/i);
  assert.equal(result.buyer.budgetAed, 2_000_000);
  assert.deepEqual(result.buyer.bedrooms, [1]);
  assert.deepEqual(result.buyer.propertyTypes, ["apartment"]);
  assert.equal(result.buyer.activeRecommendationUnitId, pack.unitId);
  assert.equal(result.alertRecommended, false);
  assert.equal(result.followUpSubmitted, false);
});

test("a named-project price question with an explicit new bedroom count uses that unit's facts", async () => {
  const { engine, store } = await setupConversation();
  const selected = await engine.handleMessage("changed-unit-price",
    "2M Yas Island 1 bedroom apartment in Yas Park Views", offline);
  const projectId = selected.buyer.activeRecommendationProjectId;
  const project = store.projects.find(row => row.id === projectId);
  const differentUnit = store.units.find(row => row.projectId === projectId && row.bedrooms === 2 && row.active);
  assert.ok(project && differentUnit, "The selected project must have a supported 2BR test option");
  const result = await engine.handleMessage("changed-unit-price",
    `What is the price of a 2 bedroom in ${project.name}?`, offline);
  assert.equal(result.check.ok, true, JSON.stringify(result.check));
  assert.deepEqual(result.buyer.bedrooms, [2]);
  assert.equal(result.buyer.budgetAed, 2_000_000);
  assert.ok(result.packs.some(pack => pack.unitId === differentUnit.id), result.reply);
  assert.ok(result.reply.includes(`AED ${differentUnit.startingPriceAed.toLocaleString("en-US")}`), result.reply);
  assert.equal(result.followUpSubmitted, false);
  assert.equal(result.alertRecommended, false);
});

test("a request for fresh inventory does not reset the buyer's remembered search", async () => {
  const { engine } = await previousSearch();
  const result = await engine.handleMessage("screenshot", "Do you have fresh inventory in Yas?", offline);
  assert.equal(result.buyer.budgetAed, 2_000_000);
  assert.deepEqual(result.buyer.preferredAreas, ["Yas Island"]);
  assert.deepEqual(result.buyer.bedrooms, [1]);
  assert.deepEqual(result.buyer.propertyTypes, ["apartment"]);
  assert.equal(result.buyer.noCalls, true);
  assert.equal(result.buyer.preferredContactChannel, "instagram");
  assert.ok(!result.intents.includes("start_fresh"));
  assert.doesNotMatch(result.reply, /starting fresh|fresh start|what budget are you working/i);
  assert.equal(result.check.ok, true, JSON.stringify(result.check));
});

test("How much can I make is investment education rather than the selected unit's asking price", async () => {
  const { engine } = await previousSearch();
  const before = await engine.buyers.getOrCreate("screenshot");
  const result = await engine.handleMessage("screenshot", "How much can I make?", offline);
  coherent(result);
  assert.equal(result.stage, "education");
  assert.match(result.reply, /rent|income/i);
  assert.match(result.reply, /growth|resale|appreciation|sell|value/i);
  assert.match(result.reply, /cost|risk|guarantee|holding period/i);
  assert.doesNotMatch(result.reply, /starting price|AED\s*\d|\d+(?:\.\d+)?%.*(?:yield|roi|return)/i);
  assert.equal(result.buyer.budgetAed, 2_000_000);
  assert.deepEqual(result.buyer.preferredAreas, ["Yas Island"]);
  assert.equal(result.buyer.activeRecommendationProjectId, before.activeRecommendationProjectId);
  assert.equal(result.buyer.activeRecommendationUnitId, before.activeRecommendationUnitId);
  assert.equal(result.matches.length, 0);
});

test("model understanding cannot turn a project name into new bedroom or type requirements", async () => {
  const { engine } = await setupConversation();
  const before = await engine.handleMessage("model-price", "2M Yas 1 bedroom apartment", offline);
  const selectedPack = before.packs.find(p => p.unitId === before.buyer.activeRecommendationUnitId);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body);
    const data = payload.system.includes("extract structured buyer requirements")
      ? { facts: { project: selectedPack.name.value, bedrooms: 0, propertyType: "studio" }, intents: ["ask_facts"], signals: [] }
      : { message: "Malformed composition", askedQuestion: false, questionField: null };
    return { ok: true, json: async () => ({ content: [{ type: "text", text: JSON.stringify(data) }] }) };
  };
  engine.llm = { apiKey: "synthetic-test-key", baseUrl: "https://synthetic.test" };
  try {
    const result = await engine.handleMessage("model-price", `What is the price of ${selectedPack.name.value}?`);
    assert.equal(result.check.ok, true);
    assert.deepEqual(result.buyer.bedrooms, [1]);
    assert.deepEqual(result.buyer.propertyTypes, ["apartment"]);
    assert.equal(result.packs[0].unitId, selectedPack.unitId);
    assert.ok(result.reply.includes(selectedPack.startingPriceText.value), result.reply);
    assert.equal(result.buyer.noCalls, before.buyer.noCalls);
    assert.equal(result.alertRecommended, false);
  } finally { globalThis.fetch = originalFetch; }
});
