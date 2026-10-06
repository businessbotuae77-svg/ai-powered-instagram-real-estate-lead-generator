import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { emptyBuyer } from "../src/schema/fields.js";
import { BuyerService, mergeBuyer } from "../src/services/buyer-service.js";
import { LocalStore } from "../src/store/local-store.js";
import { extractFactsFromMessage } from "../src/conversation/extract.js";
import { parseAdvisoryFacts } from "../src/conversation/advisory-memory.js";
import { mergeUnderstanding, normalizeUnderstanding, understandMessageLocally } from "../src/conversation/understand.js";
import { buildInvestmentStrategy, deriveInvestmentStrategy, normalizeInvestmentProfile, parseInvestmentFacts } from "../src/conversation/investment-strategy.js";

function update(message, buyer = emptyBuyer("investor"), lastAskedField = null) {
  return mergeUnderstanding(extractFactsFromMessage(message, { buyer, lastAskedField }), understandMessageLocally(message, { buyer, lastAskedField }));
}
function service() {
  const records = new Map();
  return new BuyerService({ getBuyer: id => records.get(id), saveBuyer: async buyer => { records.set(buyer.instagramUserId, buyer); return buyer; } });
}

test("2M best ROI stores umbrella return intent without selecting income versus growth", async () => {
  const buyers = service();
  const result = update("2M. Best ROI.");
  const buyer = await buyers.remember("investor", result.facts);
  assert.equal(buyer.budgetAed, 2_000_000);
  assert.equal(buyer.investmentGoal, "total_return");
  assert.equal(buyer.investmentObjective, null);
  assert.equal(buyer.investmentStrategy, "UNDECIDED");
  assert.deepEqual(buyer.preferredAreas, []);
  assert.equal(buildInvestmentStrategy(buyer).nextQuestionField, "exitHorizon");
});

test("capital growth is a return driver under the remembered ROI goal", async () => {
  const buyers = service();
  let buyer = await buyers.remember("investor", update("2M. Best ROI.").facts);
  buyer = await buyers.remember("investor", update("Capital growth.", buyer, "exitHorizon").facts);
  assert.equal(buyer.investmentGoal, "total_return");
  assert.equal(buyer.investmentObjective, "growth");
  assert.equal(buyer.growthPriority, "high");
  assert.equal(buyer.investmentStrategy, "OFF_PLAN_APPRECIATION");
  assert.equal(buyer.budgetAed, 2_000_000);
  assert.deepEqual(buildInvestmentStrategy(buyer).returnDrivers, ["capital_appreciation", "rental_income", "costs"]);
});

test("short handover answer is contextual and changes strategy emphasis", async () => {
  const buyers = service();
  let buyer = await buyers.remember("investor", { budget: 2_000_000, useType: "investment", investmentObjective: "growth" });
  const answer = update("Handover.", buyer, "exitHorizon");
  buyer = await buyers.remember("investor", answer.facts);
  assert.equal(buyer.exitHorizon, "handover");
  assert.equal(buyer.handoverStrategy, "sell");
  assert.equal(buyer.investmentStrategy, "HANDOVER_EXIT");
  const strategy = buildInvestmentStrategy(buyer);
  assert.ok(strategy.priorities.includes("handover_supply"));
  assert.ok(strategy.priorities.includes("liquidity"));
  assert.equal(strategy.weights.liquidity, 3);
  assert.equal(strategy.nextQuestionField, null);
  assert.equal(update("Handover.", emptyBuyer("new"), "preferredAreas").facts.exitHorizon, undefined);
  assert.equal(update("When is the handover?", buyer, "exitHorizon").facts.exitHorizon, undefined);
});

test("explicit sell around handover and before handover are distinct exit preferences", () => {
  assert.equal(parseInvestmentFacts("Sell around handover.").investmentStrategy, "HANDOVER_EXIT");
  assert.equal(parseInvestmentFacts("Sell before handover.").exitHorizon, "before_handover");
  const rejected = parseInvestmentFacts("I won't sell at handover.", { buyer: { useType: "investment" } });
  assert.equal(rejected.exitHorizon, undefined);
});

test("five year holding period changes priorities and never authorizes reservation", async () => {
  const buyers = service();
  let buyer = await buyers.remember("investor", { useType: "investment", investmentGoal: "total_return", budget: 2_000_000 });
  const answer = update("I'll hold 5 years.", buyer, "exitHorizon");
  buyer = await buyers.remember("investor", answer.facts);
  assert.equal(buyer.holdingPeriod, 5);
  assert.equal(buyer.exitHorizon, "long_term");
  assert.equal(buyer.investmentStrategy, "LONG_TERM_HOLD");
  assert.equal(answer.intents.includes("reserve"), false);
  assert.equal(answer.signals.includes("reserve_interest"), false);
  const strategy = buildInvestmentStrategy(buyer);
  for (const priority of ["area_maturation", "product_quality", "long_term_supply", "rental_fallback", "service_costs"]) assert.ok(strategy.priorities.includes(priority));
  assert.equal(strategy.weights.area, 3);
  assert.equal(strategy.nextQuestionField, null);
});

test("short Hold answer after an exit question is a strategy rather than a reservation", () => {
  const buyer = { ...emptyBuyer("investor"), useType: "investment", investmentGoal: "total_return" };
  for (const message of ["Hold.", "Holding", "Hold it."]) {
    const answer = update(message, buyer, "exitHorizon");
    assert.equal(answer.facts.investmentStrategy, "LONG_TERM_HOLD", message);
    assert.equal(answer.facts.handoverStrategy, "hold", message);
    assert.equal(answer.intents.includes("reserve"), false, message);
    assert.equal(answer.intents.includes("high_intent"), false, message);
    assert.equal(answer.signals.includes("reserve_interest"), false, message);
  }
  // A real unit-hold request remains a transaction discussion.
  assert.equal(extractFactsFromMessage("Hold this unit for me.", { buyer, lastAskedField: "exitHorizon" }).intents.includes("reserve"), true);
});

test("long-term hold is recognized with either word order without reservation signals", () => {
  const buyer = { ...emptyBuyer("investor"), useType: "investment" };
  for (const message of ["Long-term hold.", "I want a long term hold.", "I'll hold long term."]) {
    const answer = update(message, buyer);
    assert.equal(answer.facts.investmentStrategy, "LONG_TERM_HOLD", message);
    assert.equal(answer.intents.includes("reserve"), false, message);
    assert.equal(answer.signals.includes("reserve_interest"), false, message);
  }
});

test("changing a long hold to handover exit clears the old years without clearing the buyer", async () => {
  const buyers = service();
  let buyer = await buyers.remember("investor", { useType: "investment", holdingPeriod: 5, noCalls: true, phone: "+971500000000" });
  buyer = await buyers.remember("investor", update("Actually sell around handover.", buyer).facts);
  assert.equal(buyer.holdingPeriod, null);
  assert.equal(buyer.exitHorizon, "handover");
  assert.equal(buyer.investmentStrategy, "HANDOVER_EXIT");
  assert.equal(buyer.noCalls, true);
  assert.equal(buyer.phone, "+971500000000");
});

test("income from day one requires ready income, whereas income after handover stays off plan compatible", () => {
  const immediate = parseInvestmentFacts("I want rental income from day one.");
  assert.equal(immediate.incomeRequirement, "immediate");
  assert.equal(immediate.investmentStrategy, "READY_INCOME");
  assert.equal(buildInvestmentStrategy(immediate).nextQuestionField, null);
  const later = parseInvestmentFacts("I want rental income after handover.");
  assert.equal(later.investmentStrategy, "INCOME_AFTER_HANDOVER");
  assert.equal(later.handoverStrategy, "rent");
  // Income alone does not authorize assuming a ready property or a yield.
  assert.equal(parseInvestmentFacts("Rental income.").investmentStrategy, "UNDECIDED");
});

test("a growth forecast question does not silently change the investment profile", () => {
  for (const message of ["Will this appreciate 20%?", "What is capital growth?", "Can this deliver rental income?"]) {
    const result = parseInvestmentFacts(message, { buyer: { useType: "investment" } });
    assert.equal(result.investmentObjective, undefined, message);
    assert.equal(result.investmentStrategy, undefined, message);
    assert.equal(result.useType, undefined, message);
  }
});

test("negative driver corrections do not retain inherited growth emphasis", async () => {
  const buyers = service();
  let buyer = await buyers.remember("investor", update("Best ROI. Capital growth.").facts);
  buyer = await buyers.remember("investor", update("I do not want growth. I want rental income.", buyer).facts);
  assert.equal(buyer.investmentObjective, "rental_income");
  assert.equal(buyer.growthPriority, null);
  assert.equal(buyer.investmentStrategy, "UNDECIDED");
  assert.equal(buyer.investmentGoal, "total_return");
});

test("driver both answer requires objective question context", () => {
  assert.equal(parseInvestmentFacts("Both.", { buyer: { useType: "investment" }, lastAskedField: "investmentObjective" }).investmentStrategy, "BALANCED");
  assert.equal(parseInvestmentFacts("Both.", { buyer: { useType: "investment" }, lastAskedField: "bedrooms" }).investmentObjective, undefined);
});

test("abandoning Yas removes the old area rather than selecting it again", async () => {
  const buyers = service();
  let buyer = await buyers.remember("investor", { budget: 2_000_000, area: "Yas", areaFlexibility: "fixed", noCalls: true });
  const answer = update("I don't care about Yas anymore.", buyer);
  assert.equal(answer.facts.area, undefined);
  buyer = await buyers.remember("investor", answer.facts);
  assert.deepEqual(buyer.preferredAreas, []);
  assert.equal(buyer.areaFlexibility, "open");
  assert.equal(buyer.openToOtherAreas, true);
  assert.equal(buyer.noCalls, true);
  assert.equal(buyer.budgetAed, 2_000_000);
  assert.equal(buyer.removedAreas, undefined);
});

test("switching area after abandonment retains the explicit new choice and only Yas stays fixed", async () => {
  const buyers = service();
  let buyer = await buyers.remember("investor", { area: "Yas" });
  buyer = await buyers.remember("investor", update("Forget Yas, try Reem instead.", buyer).facts);
  assert.deepEqual(buyer.preferredAreas, ["Al Reem Island"]);
  buyer = await buyers.remember("investor", update("I only want Yas.", buyer).facts);
  assert.deepEqual(buyer.preferredAreas, ["Yas Island"]);
  assert.equal(buyer.areaFlexibility, "fixed");
  assert.equal(buyer.openToOtherAreas, false);
});

test("hard constraints require explicit input and a model cannot grant them", () => {
  assert.equal(parseAdvisoryFacts("Must have 2 bedrooms").bedroomsRequired, true);
  assert.equal(parseAdvisoryFacts("Initial cash max 150k").initialCashHardCap, true);
  assert.equal(parseAdvisoryFacts("I must use a mortgage").financingRequired, true);
  assert.equal(parseAdvisoryFacts("I don't need a mortgage").financingRequired, undefined);
  const model = normalizeUnderstanding({ facts: { bedroomsRequired: true, initialCashHardCap: true, financingRequired: true, removedAreas: ["Yas Island"], budgetFlexible: true } }, "claude");
  for (const field of ["bedroomsRequired", "initialCashHardCap", "financingRequired", "removedAreas", "budgetFlexible"]) assert.equal(model.facts[field], undefined);
});

test("empty profile keeps absent strategy evidence unknown and does not invent investment permission", () => {
  assert.deepEqual(normalizeInvestmentProfile({ holdingPeriod: 0, investmentStrategy: "HUGE_RETURN", growthPriority: "unknown" }), {});
  const strategy = buildInvestmentStrategy(emptyBuyer("new"));
  assert.equal(strategy.strategy, "UNDECIDED");
  assert.equal(strategy.nextQuestionField, null);
  assert.ok(strategy.unknowns.includes("incomeRequirement"));
  assert.ok(strategy.unknowns.includes("exitHorizon"));
  assert.equal(strategy.forecastAllowed, false);
});

test("old buyer cards receive additive defaults and retain identity, calls and stops", async () => {
  const old = { instagramUserId: "legacy", name: "Buyer", phone: "+971500000000", noCalls: true, contactDeclined: true, salesPathStopped: true, investmentObjective: "growth", useType: "investment" };
  const merged = mergeBuyer(old, { priorities: ["entry_price"] });
  assert.equal(merged.investmentStrategy, "OFF_PLAN_APPRECIATION");
  for (const key of ["name", "phone", "noCalls", "contactDeclined", "salesPathStopped"]) assert.equal(merged[key], old[key]);
  assert.equal(deriveInvestmentStrategy({ useType: "investment", holdingPeriod: 5 }), "LONG_TERM_HOLD");
  assert.equal(deriveInvestmentStrategy({ useType: "end_use", investmentObjective: "growth" }), "UNDECIDED");
});

test("strategy facts persist without a production Airtable schema migration", async () => {
  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "investment-profile-"));
  const buyers = new BuyerService(new LocalStore({ runtimeDir }));
  let buyer = await buyers.remember("investor", update("I have AED 2M. Best ROI.").facts);
  buyer = await buyers.remember("investor", update("Sell around handover.", buyer).facts);
  await buyers.remember("investor", { noCalls: true });
  const saved = JSON.parse(await readFile(path.join(runtimeDir, "buyers.json"), "utf8"))[0];
  assert.equal(saved.investmentGoal, "total_return");
  assert.equal(saved.investmentStrategy, "HANDOVER_EXIT");
  assert.equal(saved.exitHorizon, "handover");
  assert.equal(saved.budgetAed, 2_000_000);
  assert.equal(saved.noCalls, true);
});

test("rejection memory keeps unit and evidence state without creating contact permission", async () => {
  const buyers = service();
  const buyer = await buyers.recordObjection("investor", { category: "initial_payment_too_high", projectId: "p", unitId: "u", factFingerprint: "initial:200000", evidenceState: { initialPaymentAed: 200_000, checkedOn: "2026-10-06" } });
  assert.equal(buyer.rejectionReasons.p.unitId, "u");
  assert.equal(buyer.rejectionReasons.p.factFingerprint, "initial:200000");
  assert.deepEqual(buyer.rejectionReasons.p.evidenceState, { initialPaymentAed: 200_000, checkedOn: "2026-10-06" });
  assert.equal(buyer.preferredContactChannel, null);
  assert.equal(buyer.phone, null);
});

test("explicit end use clears investment strategy while preserving consent and budget", async () => {
  const buyers = service();
  let buyer = await buyers.remember("investor", { budget: 2_000_000, useType: "investment", exitHorizon: "handover", handoverStrategy: "sell", incomeRequirement: "none", noCalls: true });
  buyer = await buyers.remember("investor", update("Actually this is for my own home, not an investment.", buyer).facts);
  assert.equal(buyer.investmentStrategy, "UNDECIDED");
  assert.equal(buyer.exitHorizon, null);
  assert.equal(buyer.incomeRequirement, null);
  assert.equal(buyer.noCalls, true);
  assert.equal(buyer.budgetAed, 2_000_000);
});
