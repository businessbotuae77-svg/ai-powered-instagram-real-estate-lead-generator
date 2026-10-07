import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { emptyBuyer } from "../src/schema/fields.js";
import { BuyerService, buyerFromKnownFacts, mergeBuyer } from "../src/services/buyer-service.js";
import { extractFactsFromMessage } from "../src/conversation/extract.js";
import { mergeUnderstanding, understandMessageLocally } from "../src/conversation/understand.js";
import { canonicalQuestionField, isFlexiblePreference, parseFlexiblePreferences } from "../src/conversation/preference-state.js";
import { DurableConversationMemory } from "../src/integrations/durable-memory.js";
import { parseAdvisoryFacts } from "../src/conversation/advisory-memory.js";

const investor = { ...emptyBuyer("flexible-investor"), useType: "investment", budgetAed: 3_000_000 };

test("explicit uncertainty and delegation become remembered advisor-led answers", () => {
  for (const message of ["idk", "I don't know", "not sure", "you choose", "whatever you think", "best option", "I'm open", "no preference", "I don't know what I want", "Whatever you think is best", "I don't have any preference"]) {
    const local = understandMessageLocally(message, { buyer: investor, lastAskedField: "advisoryPriority" });
    const base = extractFactsFromMessage(message, { buyer: investor, lastAskedField: "advisoryPriority" });
    const understood = mergeUnderstanding(base, local);
    const buyer = mergeBuyer(investor, buyerFromKnownFacts(investor.instagramUserId, understood.facts));
    assert.equal(buyer.investmentPreferenceState, "flexible", message);
    assert.equal(buyer.advisorLed, true, message);
    assert.equal(buyer.investmentStrategy, "UNDECIDED", message);
    assert.equal(buyer.budgetAed, 3_000_000, message);
    assert.equal(buyer.budgetHardCap, true, message);
    assert.equal(buyer.budgetFlexible, false, message);
    assert.equal(buyer.budgetStretchAed, 0, message);
    assert.equal(isFlexiblePreference(buyer, "investmentGoal"), true, message);
  }
  for (const message of ["not sure if my budget is flexible", "not sure if I can stretch"]) {
    const facts = parseAdvisoryFacts(message, { buyer: investor, lastAskedField: "budgetFlexibility" });
    assert.notEqual(facts.budgetFlexible, true, message);
    assert.notEqual(facts.budgetHardCap, false, message);
    assert.equal(facts.budgetFlexibilityPct, undefined, message);
  }
});

test("all qualification uncertainty slots persist instead of remaining missing", () => {
  for (const field of ["budgetAed", "preferredAreas", "bedrooms", "propertyTypes", "investmentObjective", "exitHorizon", "riskTolerance", "cashDeploymentPreference", "cashAvailableAed", "financing", "advisoryPriority", "advisoryNextAction"]) {
    const parsed = parseFlexiblePreferences("idk", { buyer: investor, lastAskedField: field });
    const buyer = mergeBuyer(investor, buyerFromKnownFacts(investor.instagramUserId, parsed.facts));
    assert.equal(buyer.preferenceStates[canonicalQuestionField(field)], "flexible", field);
    assert.equal(buyer.budgetAed, 3_000_000, field);
  }
  assert.equal(isFlexiblePreference(emptyBuyer("unknown"), "investmentObjective"), false);
});

test("quick reply IDs preserve structured advisor-led choices through understanding", () => {
  for (const message of ["you_choose", "best_overall"]) {
    const extracted = extractFactsFromMessage(message, { buyer: investor, lastAskedField: "investmentObjective" });
    const merged = mergeUnderstanding(extracted, understandMessageLocally(message, { buyer: investor, lastAskedField: "investmentObjective" }));
    const buyer = mergeBuyer(investor, buyerFromKnownFacts(investor.instagramUserId, merged.facts));
    assert.equal(buyer.advisorLed, true, message);
    assert.equal(buyer.investmentPreferenceState, "flexible", message);
    assert.equal(buyer.budgetAed, 3_000_000, message);
  }
});

test("generic delegation preserves a known end-use enquiry", () => {
  const homeBuyer = { ...investor, useType: "end_use" };
  const message = "best option";
  const merged = mergeUnderstanding(extractFactsFromMessage(message, { buyer: homeBuyer, lastAskedField: "propertyTypes" }), understandMessageLocally(message, { buyer: homeBuyer, lastAskedField: "propertyTypes" }));
  const buyer = mergeBuyer(homeBuyer, buyerFromKnownFacts(homeBuyer.instagramUserId, merged.facts));
  assert.equal(buyer.useType, "end_use");
  assert.equal(buyer.advisorLed, false);
  assert.equal(buyer.budgetAed, 3_000_000);
});

test("unknown area and bedroom answers enable flexibility and preserve other constraints", () => {
  const buyer = { ...investor, preferredAreas: ["Yas Island"], areaFlexibility: "fixed", bedrooms: [2], bedroomsRequired: true };
  const area = parseFlexiblePreferences("no preference", { buyer, lastAskedField: "preferredAreas" }).facts;
  assert.equal(area.openToOtherAreas, true);
  const size = parseFlexiblePreferences("you choose", { buyer, lastAskedField: "bedrooms" }).facts;
  assert.equal(size.propertyTypeFlexibility, true);
  assert.equal(size.bedroomsRequired, false);
  const objective = parseFlexiblePreferences("you choose", { buyer, lastAskedField: "investmentObjective" }).facts;
  assert.equal(objective.openToOtherAreas, undefined);
  const extracted = extractFactsFromMessage("you choose", { buyer, lastAskedField: "investmentObjective" });
  assert.equal(extracted.facts.openToOtherAreas, undefined);
  const exit = parseFlexiblePreferences("I don't know whether to hold or sell", { buyer, lastAskedField: "exitHorizon" }).facts;
  assert.equal(exit.preferenceStates.exitHorizon, "flexible");
  assert.equal(exit.advisorLed, true);
});

test("later concrete answers override only the corresponding flexible semantic slot", () => {
  const flexible = mergeBuyer(investor, { preferenceStates: { preferredAreas: "flexible", bedrooms: "flexible", investmentObjective: "flexible" }, advisorLed: true, investmentPreferenceState: "flexible" });
  const next = mergeBuyer(flexible, buyerFromKnownFacts(investor.instagramUserId, { area: "Yas", bedrooms: 2 }));
  assert.equal(isFlexiblePreference(next, "area"), false);
  assert.equal(isFlexiblePreference(next, "bedrooms"), false);
  assert.equal(isFlexiblePreference(next, "advisoryPriority"), true);
  const growth = mergeBuyer(next, buyerFromKnownFacts(investor.instagramUserId, { investmentObjective: "growth" }));
  assert.equal(growth.investmentPreferenceState, "specified");
  assert.equal(growth.advisorLed, false);
  const typed = mergeBuyer({ ...flexible, propertyTypeFlexibility: true }, buyerFromKnownFacts(investor.instagramUserId, { propertyType: "apartment" }));
  assert.equal(typed.propertyTypeFlexibility, false);
  assert.equal(typed.preferenceStates.propertyTypes, "specified");
});

test("uncertainty mentioning growth and income does not manufacture a balanced preference", () => {
  for (const existing of [investor, { ...investor, investmentObjective: "growth", investmentStrategy: "OFF_PLAN_APPRECIATION" }]) {
    const message = "I don't know whether growth or income matters most";
    const merged = mergeUnderstanding(extractFactsFromMessage(message, { buyer: existing, lastAskedField: "investmentObjective" }), understandMessageLocally(message, { buyer: existing, lastAskedField: "investmentObjective" }));
    assert.equal(merged.facts.investmentObjective, undefined);
    assert.equal((merged.facts.priorities || []).includes("balanced_returns"), false);
    const buyer = mergeBuyer(existing, buyerFromKnownFacts(existing.instagramUserId, merged.facts));
    assert.equal(buyer.advisorLed, true);
    assert.equal(buyer.investmentPreferenceState, "flexible");
    assert.notEqual(buyer.investmentStrategy, "BALANCED");
    assert.equal(buyer.budgetAed, 3_000_000);
  }
});

test("fact questions and objection uncertainty do not delegate investment decisions", () => {
  for (const message of ["I'm not sure if this project has a payment plan", "not sure about this developer", "What is the best option for payment plan on Yas?", "I'm not sure about this project's risk", "I don't know which area Yas Studio One is located in", "I don't know the initial payment for this project", "not sure how many bedrooms this project offers", "I'm not sure whether this project offers low risk growth"] ) {
    const result = parseFlexiblePreferences(message, { buyer: investor, lastAskedField: "investmentObjective" });
    assert.deepEqual(result.facts, {}, message);
    assert.deepEqual(result.unsure, [], message);
    const merged = mergeUnderstanding(extractFactsFromMessage(message, { buyer: investor, lastAskedField: "investmentObjective" }), understandMessageLocally(message, { buyer: investor, lastAskedField: "investmentObjective" }));
    assert.equal(merged.facts.advisorLed, undefined, message);
    assert.deepEqual(merged.facts.preferenceStates || {}, {}, message);
    if (/whether/.test(message)) {
      assert.equal(merged.facts.investmentObjective, undefined, message);
      assert.equal(merged.facts.riskTolerance, undefined, message);
    }
  }
});

test("starting a new search clears flexible criteria and retains contact preferences", async () => {
  let saved = { ...investor, preferredContactChannel: "instagram", noCalls: true, phone: "0501234567", advisorLed: true, investmentPreferenceState: "flexible", preferenceStates: { investmentObjective: "flexible", preferredAreas: "flexible" } };
  const buyers = new BuyerService({ getBuyer: () => saved, saveBuyer: async buyer => { saved = buyer; return buyer; } });
  const reset = await buyers.resetCriteria(investor.instagramUserId);
  assert.deepEqual(reset.preferenceStates, {});
  assert.equal(reset.investmentPreferenceState, null);
  assert.equal(reset.advisorLed, false);
  assert.equal(reset.budgetAed, null);
  assert.equal(reset.noCalls, true);
  assert.equal(reset.phone, "0501234567");
});

test("semantic question history and flexible answers survive memory restart and reset", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "advisor-question-memory-"));
  try {
    const first = new DurableConversationMemory({ rootDir });
    await first.ensureReady();
    first.setLastAskedField("buyer", "advisoryPriority");
    assert.equal(first.getQuestionState("buyer", "investmentGoal"), "asked");
    first.recordFlexibleFields("buyer", ["investmentObjective", "area"]);
    await first.flush();
    const restarted = new DurableConversationMemory({ rootDir });
    await restarted.ensureReady();
    assert.equal(restarted.getQuestionState("buyer", "priorities"), "flexible");
    assert.equal(restarted.getQuestionState("buyer", "preferredAreas"), "flexible");
    assert.equal(restarted.getSemanticQuestionHistory("buyer").investmentObjective.asks, 1);
    restarted.recordPreferenceStates("buyer", { investmentGoal: "specified" });
    assert.equal(restarted.getQuestionState("buyer", "advisoryPriority"), "specified");
    await restarted.flush();
    const corrected = new DurableConversationMemory({ rootDir });
    await corrected.ensureReady();
    assert.equal(corrected.getQuestionState("buyer", "investmentObjective"), "specified");
    restarted.clear("buyer");
    assert.equal(restarted.getQuestionState("buyer", "investmentObjective"), null);
    await restarted.flush();
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
