import assert from "node:assert/strict";
import test from "node:test";
import { composeReplyWithModel } from "../src/conversation/llm.js";
import { validateBuyerResponse } from "../src/conversation/response-validation.js";
import { validateMessage } from "../src/facts/checker.js";
import { buildFactPack } from "../src/facts/retrieval.js";
import { renderProjectCard } from "../src/conversation/project-copy.js";
import { fallbackSafeText } from "../src/conversation/replies.js";
import { areaGuideClaims, findAreaEntry, loadAreaGuide } from "../src/facts/area-guide.js";

// Mirrors the live Nawayef record: no confirmed initial payment, plan with a source note.
const project = { id: "npv", name: "Nawayef Park Views", developerName: "Modon", area: "Hudayriyat Island", active: true,
  source: "Modon", lastVerified: new Date().toISOString(), status: "Off-plan", handover: "Q1 2028", paymentPlanAvailable: true,
  paymentPlanSummary: "60/40 plan: 10% down payment on booking, 50% in instalments during construction, 40% on handover (Modon official page, checked 2026-10-06; individual instalment dates not published)." };
const pack = buildFactPack({ project, unit: { id: "npv-1", projectId: "npv", active: true, bedrooms: 1, propertyType: "apartment", startingPriceAed: 2_000_000 }, bedroomLabel: "1" });
const buyer = { budgetAed: 5_000_000, useType: "investment" };
const allowedClaims = areaGuideClaims([findAreaEntry(loadAreaGuide(), "Hudayriyat Island")]);
const strategy = { type: "recommend", primary: { projectId: pack.projectId, unitId: pack.unitId } };
const requiredQuestion = { field: "advisoryNextAction", prompt: "Want me to break down the payment terms?" };
const context = { buyer, packs: [pack], allowedClaims, strategy, requiredQuestion, allowedActions: ["payment_details"],
  permittedRecommendations: [{ projectId: pack.projectId, unitId: pack.unitId }] };

function check(message) {
  const metadata = { askedQuestion: /\?/.test(message), questionField: /\?/.test(message) ? "advisoryNextAction" : null, claims: [], proposedActions: [] };
  const response = validateBuyerResponse(message, { ...context, metadata });
  const facts = validateMessage(message, [pack], { allowedClaims, buyer, allowedBuyerAmounts: [buyer.budgetAed] });
  return { ok: response.ok && facts.ok, violations: [...response.violations, ...facts.violations].map(v => v.type) };
}

function client(output) {
  return { apiKey: "test-only", model: "test-model", baseUrl: "https://example.test",
    fetchImpl: async () => ({ ok: true, json: async () => ({ content: [{ type: "text", text: JSON.stringify(output) }] }) }) };
}

test("true facts pass without the model labelling every source", () => {
  for (const message of [
    "My best overall pick for you is Nawayef Park Views by Modon. It's a 1 bedroom apartment on Hudayriyat Island, from AED 2,000,000. Hudayriyat is the family-friendly, fitness-first island. The plan is 60/40: 10% on booking, 50% during construction and 40% on handover, with handover in Q1 2028.\nWant me to break down the payment terms?",
    "I'd go with Nawayef Park Views. It sits on Hudayriyat Island, which suits families and people who want an active outdoor lifestyle. Entry starts from AED 2,000,000, well inside your AED 5,000,000 budget, and handover is Q1 2028. Want me to break down the payment terms?"
  ]) {
    const result = check(message);
    assert.equal(result.ok, true, `${message}\n${result.violations}`);
  }
});

test("false prices, invented amenities and unknown projects are still rejected", () => {
  for (const message of [
    "Nawayef Park Views starts from AED 1,800,000. Want me to break down the payment terms?",
    "Nawayef Park Views offers a private marina. Want me to break down the payment terms?",
    "I recommend Falcon Heights over Nawayef Park Views. Want me to break down the payment terms?",
    "Nawayef Park Views has a 20% booking payment. Want me to break down the payment terms?",
    "Nawayef Park Views hands over in Q3 2027. Want me to break down the payment terms?"
  ]) assert.equal(check(message).ok, false, message);
});

test("a reply with one bad sentence keeps the good ones instead of falling back", async () => {
  const output = { message: "My best overall pick for you is Nawayef Park Views on Hudayriyat Island, from AED 2,000,000. It also has a private marina. Handover is Q1 2028. Shall I compare it with something on Yas? Want me to break down the payment terms?",
    askedQuestion: true, questionField: "advisoryNextAction", claims: [], proposedActions: [] };
  const composed = await composeReplyWithModel(client(output), { ...context, validationOptions: {} });
  assert.ok(composed, "the reply is repaired, not rejected");
  assert.doesNotMatch(composed.message, /private marina|compare it with something on Yas/);
  assert.match(composed.message, /Nawayef Park Views on Hudayriyat Island, from AED 2,000,000/);
  assert.match(composed.message, /Handover is Q1 2028/);
  assert.equal((composed.message.match(/\?/g) || []).length, 1);
  assert.match(composed.message, /Want me to break down the payment terms\?$/);
});

test("a reply that only invents things is not salvaged into an empty shell", async () => {
  const output = { message: "Nawayef Park Views has a private marina and a rooftop cinema. Want me to break down the payment terms?",
    askedQuestion: true, questionField: "advisoryNextAction", claims: [], proposedActions: [] };
  assert.equal(await composeReplyWithModel(client(output), { ...context, validationOptions: {} }), null);
});

test("the listing card and last-resort fallback read as sentences, not data rows", () => {
  const card = renderProjectCard(pack);
  assert.match(card, /^Nawayef Park Views by Modon: 1 bedroom apartment on Hudayriyat Island, from AED 2,000,000\./);
  assert.match(card, /• Payment plan: 60\/40 plan: 10% down payment on booking, 50% in instalments during construction, 40% on handover$/m);
  assert.match(card, /• Handover: Q1 2028/);
  assert.doesNotMatch(card, / · |checked 2026|not confirmed yet/);
  const fallback = fallbackSafeText([pack]);
  assert.match(fallback, /Nawayef Park Views by Modon on Hudayriyat Island, from AED 2,000,000\./);
  assert.doesNotMatch(fallback, / · /);
});
