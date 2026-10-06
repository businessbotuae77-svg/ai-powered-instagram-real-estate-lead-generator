import assert from "node:assert/strict";
import test from "node:test";
import { composeReplyWithModel, polishReplyWithModel } from "../src/conversation/llm.js";
import { sanitizeBuyerLanguage, validateBuyerResponse } from "../src/conversation/response-validation.js";
import { validateMessage, collectOpportunityAmounts } from "../src/facts/checker.js";
import { buildFactPack } from "../src/facts/retrieval.js";

function pack(name, price = 1_900_000, initial = 190_000, id = "a") {
  return buildFactPack({
    project: { id, name, active: true, source: "Test developer document", lastVerified: new Date().toISOString(),
      area: "Yas Island", emirate: "Abu Dhabi", developerName: "Test Developer", status: "Off-plan", handover: "Q4 2027",
      paymentPlanAvailable: true, paymentPlanSummary: "80/20", availabilityNotes: "Available", features: "Community pool" },
    unit: { id: `${id}-unit`, projectId: id, active: true, bedrooms: 2, propertyType: "apartment", startingPriceAed: price, availability: "Available" },
    downPaymentAed: initial, bedroomLabel: "2 bedrooms"
  });
}
const buyer = { budgetAed: 2_000_000, budgetHardCap: true, budgetFirm: false, budgetFlexible: false,
  budgetFlexibilityAsked: false, preferredAreas: [], bedrooms: [], financing: "unknown" };
function result(message, extra = {}) { return { message, askedQuestion: false, questionField: null, claims: [], proposedActions: [], ...extra }; }
function client(output, observe = () => {}) {
  return { apiKey: "test-only", model: "test-model", baseUrl: "https://example.test", fetchImpl: async (_url, options) => {
    observe(JSON.parse(options.body));
    return { ok: true, json: async () => ({ content: [{ type: "text", text: typeof output === "string" ? output : JSON.stringify(output) }] }) };
  } };
}
function citation(p, text, field) { return { text, projectId: p.projectId, unitId: p.unitId, field, value: p[field].value }; }

test("model composes one semantic question and receives history, priorities, opportunities and permissions", async () => {
  let input;
  const output = result("We can keep the area open. Would you prefer rental income, long-term growth, or a mix?", {
    askedQuestion: true, questionField: "investmentObjective"
  });
  const response = await composeReplyWithModel(client(output, request => { input = JSON.parse(request.messages[0].content); }), {
    buyer: { ...buyer, useType: "investment", priorities: ["payment_leverage"], objections: [{ category: "initial_payment_too_high" }] },
    packs: [], message: "Best ROI", recentTurns: [{ role: "user", text: "2M" }], opportunities: [{ type: "no_push" }],
    allowedActions: ["compare"], forbiddenActions: ["call"], requiredQuestion: { field: "investmentObjective", prompt: "Income or growth?" }
  });
  assert.equal(response.message, output.message);
  assert.equal(response.validation.questionCount, 1);
  assert.equal(input.currentMessage, "Best ROI");
  assert.equal(input.buyer.budgetAed, 2_000_000);
  assert.deepEqual(input.buyer.priorities, ["payment_leverage"]);
  assert.equal(input.recentTurns[0].text, "2M");
  assert.equal(input.advisoryOpportunities[0].type, "no_push");
  assert.deepEqual(input.forbiddenActions, ["call"]);
});

test("missing structured question is rejected, never post-appended", async () => {
  const response = await polishReplyWithModel(client(result("Your AED 2M budget is remembered.")), {
    buyer, packs: [], requiredQuestion: { field: "investmentObjective", prompt: "Income or growth?" }
  });
  assert.equal(response, null);
  assert.equal(await composeReplyWithModel(client("Plain text is not a structured response"), { buyer }), null);
});

test("two semantically equivalent budget requests are rejected even without the second question mark", () => {
  const check = validateBuyerResponse("What budget are you working with? Tell me your price range.", { buyer: {} });
  assert.equal(check.ok, false);
  assert.ok(check.violations.some(row => row.type === "multiple_questions"));
  const oneSentence = validateBuyerResponse("What budget are you working with, how much do you want to spend?", { buyer: {} });
  assert.equal(oneSentence.ok, false);
});

test("known budget and area cannot be re-asked in question or capture wording", () => {
  for (const text of ["What budget are you working with?", "Tell me your budget.", "Which area are you leaning toward?"]) {
    const check = validateBuyerResponse(text, { buyer: { ...buyer, preferredAreas: ["Yas Island"] } });
    assert.equal(check.ok, false);
    assert.ok(check.violations.some(row => row.type === "known_field_question"));
  }
});

test("default hard cap permits one meaningful flexibility question, firm or asked cap does not", async () => {
  const text = "Is your AED 2M budget a hard ceiling, or would you stretch slightly?";
  const metadata = result(text, { askedQuestion: true, questionField: "budgetFlexible" });
  assert.equal((await composeReplyWithModel(client(metadata), { buyer, requiredQuestion: { field: "budgetFlexible", prompt: text } })).message, text);
  for (const state of [{ budgetFirm: true }, { budgetFlexibilityAsked: true }, { budgetFlexible: true }]) {
    assert.equal(validateBuyerResponse(text, { buyer: { ...buyer, ...state } }).ok, false);
  }
});

test("a known initial cash amount does not block an objection-solving payment alternative question", () => {
  const text = "Would you like to compare something with a lower initial payment?";
  assert.equal(validateBuyerResponse(text, { buyer: { ...buyer, cashAvailableAed: 150_000 } }).ok, true);
});

test("grounded model recommendation passes the final factual validator", async () => {
  const p = pack("Test Gardens");
  const fact = "Test Gardens starts from AED 1,900,000.";
  const output = result(`${fact} I prefer this fit inside your budget. Want me to break down the payment terms?`, {
    askedQuestion: true, questionField: "payment_details", proposedActions: ["payment_details"],
    claims: [citation(p, fact, "name"), citation(p, fact, "startingPriceAed")]
  });
  const response = await composeReplyWithModel(client(output), { buyer, packs: [p], allowedActions: ["payment_details"] });
  assert.ok(response);
  assert.equal(validateMessage(response.message, [p], { allowedBuyerAmounts: [buyer.budgetAed] }).ok, true);
});

test("model cannot borrow another project's price or swap price with initial payment", async () => {
  const a = pack("Test Gardens");
  const b = pack("Test Heights", 2_050_000, 100_000, "b");
  for (const text of ["Test Gardens starts from AED 2,050,000.", "Test Gardens starts from AED 190,000."]) {
    assert.equal(validateMessage(text, [a, b]).ok, false);
    assert.equal(await composeReplyWithModel(client(result(text, { claims: [citation(a, text, "name")] })), { buyer, packs: [a, b] }), null);
  }
});

test("model cannot invent ROI from a real payment-plan percentage", () => {
  const p = pack("Test Gardens");
  assert.equal(validateMessage("Test Gardens earns an 80% ROI.", [p]).ok, false);
  assert.equal(validateMessage("Test Gardens will deliver a 20% capital growth.", [p]).ok, false);
});

test("stale availability and unsupported payment plans remain rejected", async () => {
  const p = pack("Test Gardens");
  p.availability = { confirmed: false, value: null };
  for (const text of ["Test Gardens is available.", "Test Gardens offers a 60/40 plan.", "Test Gardens has only 2 units left."]) {
    assert.equal(await composeReplyWithModel(client(result(text, { claims: [citation(p, text, "name")] })), { buyer, packs: [p] }), null);
  }
});

test("citation metadata cannot bless an unknown project, feature or unconfirmed field", async () => {
  const p = pack("Test Gardens");
  const examples = [
    result("Phantom Residences is my preferred option."),
    result("Test Gardens has a private beach.", { claims: [citation(p, "Test Gardens has a private beach.", "name")] }),
    result("Test Gardens starts at AED 1,850,000.", { claims: [{ text: "Test Gardens starts at AED 1,850,000.", projectId: p.projectId, unitId: p.unitId, field: "startingPriceAed", value: 1_850_000 }] })
  ];
  for (const output of examples) assert.equal(await composeReplyWithModel(client(output), { buyer, packs: [p] }), null);
});

test("model cannot override no-call, stop, action permissions or claim execution", async () => {
  for (const output of [
    result("I will call you tomorrow."),
    result("I've submitted your EOI."),
    result("Want to compare these?", { askedQuestion: true, questionField: "compare", proposedActions: ["execute_reservation"] })
  ]) assert.equal(await composeReplyWithModel(client(output), { buyer: { ...buyer, noCalls: true }, allowedActions: ["compare"] }), null);
  assert.equal(await composeReplyWithModel(client(result("Want to compare these?", { askedQuestion: true, questionField: "compare" })), {
    buyer: { ...buyer, salesPathStopped: true }, allowedActions: ["compare"]
  }), null);
});

test("internal evidence phrases are rejected for model copy and sanitized deterministically", async () => {
  const text = "I don't have approved evidence or confirmed options in the approved catalogue.";
  assert.equal(await composeReplyWithModel(client(result(text)), { buyer }), null);
  assert.doesNotMatch(sanitizeBuyerLanguage(text), /approved evidence|confirmed options|approved catalogue/i);
});

test("exact opportunity differences must be independently recomputable from confirmed operands", () => {
  const a = pack("Test Gardens", 1_900_000, 190_000);
  const b = pack("Test Heights", 2_040_000, 180_000, "b");
  const opportunity = { type: "smart_upgrade", projectId: b.projectId, unitId: b.unitId,
    comparedTo: { projectId: a.projectId, unitId: a.unitId }, priceDifferenceAed: 140_000, cashDifferenceAed: -10_000 };
  const options = { buyer, opportunities: [opportunity] };
  assert.equal(validateMessage("The extra AED 140,000 reduces the initial commitment by AED 10,000.", [a, b], options).ok, true);
  assert.equal(validateMessage("The extra AED 150,000 reduces the initial commitment by AED 10,000.", [a, b], options).ok, false);
  assert.equal(collectOpportunityAmounts([a, b], [{ ...opportunity, priceDifferenceAed: 150_000 }], buyer).has(150_000), false);
  b.startingPriceAed = { value: null, confirmed: false };
  assert.equal(collectOpportunityAmounts([a, b], [opportunity], buyer).has(140_000), false);
});

test("educational composition cannot revive an unretrieved property or reset search from history", async () => {
  const recentTurns = [{ role: "assistant", text: "Yas Park Views was considered in your previous search." }];
  for (const message of [
    "I don't have current terms for that property yet.",
    "That property requires a larger initial payment.",
    "There are no suitable options for your last search.",
    "Yas remains your priority."
  ]) assert.equal(await composeReplyWithModel(client(result(message)), {
    buyer: { preferredAreas: [], budgetAed: null }, packs: [], recentTurns,
    message: "How do I make money from property?", strategy: { type: "education" }
  }), null);
  const explanation = "Rental income comes from rent; capital growth is a change in resale value over time.";
  assert.equal((await composeReplyWithModel(client(result(explanation)), {
    buyer: { preferredAreas: [], budgetAed: null }, packs: [], recentTurns,
    message: "How do I make money from property?", strategy: { type: "education" }
  })).message, explanation);
});

test("general education cannot declare an unnamed property unsuitable even when inventory packs exist", async () => {
  const p = pack("Test Gardens");
  for (const message of [
    "That property does not fit your budget.",
    "This property is not suitable for your investment goal.",
    "It doesn’t match what you need."
  ]) assert.equal(await composeReplyWithModel(client(result(message)), {
    buyer, packs: [p], message: "How do I make money from property?", strategy: { type: "education" }
  }), null);
  const message = "Property investors may earn rental income or benefit from a change in resale value. Those routes need different comparisons.";
  assert.equal((await composeReplyWithModel(client(result(message)), {
    buyer, packs: [p], message: "How do I make money from property?", strategy: { type: "education" }
  })).message, message);
});
