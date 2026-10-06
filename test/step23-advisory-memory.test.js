import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";
import { BuyerService, mergeBuyer } from "../src/services/buyer-service.js";
import { LocalStore } from "../src/store/local-store.js";
import { emptyBuyer } from "../src/schema/fields.js";
import { extractFactsFromMessage } from "../src/conversation/extract.js";
import { mergeUnderstanding, normalizeUnderstanding, understandMessageLocally } from "../src/conversation/understand.js";
import { parseAdvisoryFacts, defaultBudgetStretchPct } from "../src/conversation/advisory-memory.js";
import { qualificationGaps, nextQualificationQuestion } from "../src/conversation/qualify.js";

function parsed(message, buyer = emptyBuyer("test"), lastAskedField = null) {
  return mergeUnderstanding(extractFactsFromMessage(message), understandMessageLocally(message, { buyer, lastAskedField }));
}
function service() {
  const rows = new Map();
  return new BuyerService({ getBuyer: id => rows.get(String(id)), saveBuyer: async row => { rows.set(row.instagramUserId, row); return row; } });
}

test("known budget and area never become missing or unsure after an advisory idk", () => {
  const buyer = { ...emptyBuyer("known"), budgetAed: 2000000, preferredAreas: ["Yas Island"], bedrooms: [1] };
  const update = parsed("Idk. Im looking for the best roi", buyer, "budgetAed");
  assert.equal(update.facts.useType, "investment");
  assert.equal(update.facts.budget, undefined);
  assert.equal(update.unsure.includes("budget"), false);
  assert.deepEqual(qualificationGaps(buyer), []);
  assert.equal(nextQualificationQuestion(buyer), null);
  assert.equal(parsed("I don't know", buyer).unsure.includes("budget"), false);
});

test("open area and property type are valid criteria rather than unanswered form fields", () => {
  const update = parsed("I don't know the area. I can consider anywhere", { ...emptyBuyer("open"), budgetAed: 2000000 });
  assert.equal(update.facts.openToOtherAreas, true);
  assert.equal(update.facts.areaFlexibility, "open");
  assert.equal(qualificationGaps({ ...emptyBuyer("open"), budgetAed: 2000000, ...update.facts, propertyTypeFlexibility: true }).length, 0);
  assert.equal(parseAdvisoryFacts("Only Yas").areaFlexibility, "fixed");
  assert.equal(parseAdvisoryFacts("open to townhouse or apartment").propertyTypeFlexibility, true);
});

test("exploration, ROI objective and holding period survive later messages", async () => {
  const buyers = service();
  let buyer = await buyers.remember("objective", parsed("Exploring").facts);
  assert.equal(buyer.explorationState, true);
  buyer = await buyers.remember("objective", parsed("I have 2M. Best ROI, I don't know the area", buyer).facts);
  assert.equal(buyer.budgetAed, 2000000);
  assert.equal(buyer.useType, "investment");
  buyer = await buyers.remember("objective", parsed("Growth", buyer, "investmentObjective").facts);
  assert.equal(buyer.investmentObjective, "growth");
  buyer = await buyers.remember("objective", parsed("I'll hold it for 7 years", buyer).facts);
  buyer = await buyers.remember("objective", parsed("Thanks", buyer).facts);
  assert.equal(buyer.holdingPeriod, 7);
  assert.equal(buyer.investmentObjective, "growth");
  assert.equal(buyer.budgetAed, 2000000);
  assert.equal(buyer.explorationState, false);
  assert.equal(parsed("A mix", buyer, "investmentObjective").facts.investmentObjective, "balanced");
  assert.equal(parsed("Rental income", buyer, "investmentObjective").facts.investmentObjective, "rental_income");
});

test("explicit end use and negated investment override an old investment objective", async () => {
  const buyers = service();
  let buyer = await buyers.remember("home", { investmentObjective: "growth", useType: "investment", priorities: ["capital_growth"] });
  const facts = parsed("I'd prefer a two bedroom apartment. It's for me to live in, not an investment.", buyer).facts;
  assert.equal(facts.useType, "end_use");
  buyer = await buyers.remember("home", facts);
  assert.equal(buyer.useType, "end_use");
  assert.equal(buyer.investmentObjective, null);
  assert.equal(buyer.priorities.includes("capital_growth"), false);
  assert.equal(parsed("Budget 2M for my home").facts.useType, "end_use");
});

test("explicit objective corrections discard the negated objective and retain firm budget", async () => {
  const buyers = service();
  let buyer = await buyers.remember("correction", { budget: 2000000, budgetFirm: true, useType: "investment", investmentObjective: "growth" });
  buyer = await buyers.remember("correction", parsed("I do not want growth. I want rental income", buyer).facts);
  assert.equal(buyer.investmentObjective, "rental_income");
  assert.equal(buyer.budgetHardCap, true);
  assert.equal(buyer.budgetFirm, true);
  buyer = await buyers.remember("correction", parsed("I don't want rental income, I want growth", buyer).facts);
  assert.equal(buyer.investmentObjective, "growth");
  assert.equal(buyer.budgetFlexible, false);
  assert.equal(parsed("No growth, rental income only", buyer).facts.investmentObjective, "rental_income");
});

test("Arabic objectives, firm ceiling and first-payment objections use the same buyer state", () => {
  const buyer = { ...emptyBuyer("arabic"), budgetAed: 2000000, useType: "investment" };
  assert.equal(parsed("النمو", buyer, "investmentObjective").facts.investmentObjective, "growth");
  assert.equal(parsed("دخل الإيجار", buyer, "investmentObjective").facts.investmentObjective, "rental_income");
  assert.equal(parsed("كلاهما", buyer, "investmentObjective").facts.investmentObjective, "balanced");
  assert.equal(parsed("لا أريد النمو، أريد دخل الإيجار", buyer).facts.investmentObjective, "rental_income");
  assert.equal(parsed("ميزانيتي ثابتة", buyer).facts.budgetFirm, true);
  assert.equal(parsed("قليلا", buyer, "budgetFlexibility").facts.budgetFlexible, true);
  assert.equal(parsed("الدفعة الأولى مرتفعة", buyer).facts.objections[0].category, "initial_payment_too_high");
});

test("budget is a hard ceiling until explicit deterministic flexibility and a firm reply persists", async () => {
  const buyers = service();
  let buyer = await buyers.remember("budget", { budget: 2000000 });
  assert.equal(buyer.budgetHardCap, true);
  assert.equal(buyer.budgetFlexible, false);
  buyer = await buyers.remember("budget", parsed("a little", buyer, "budgetFlexibility").facts);
  assert.equal(buyer.budgetAed, 2000000);
  assert.equal(buyer.budgetHardCap, false);
  assert.equal(buyer.budgetFlexible, true);
  assert.equal(buyer.budgetFlexibilityPct, defaultBudgetStretchPct());
  buyer = await buyers.remember("budget", parsed("My budget is firm", buyer).facts);
  buyer = await buyers.remember("budget", parsed("Growth", buyer).facts);
  assert.equal(buyer.budgetFirm, true);
  assert.equal(buyer.budgetHardCap, true);
  assert.equal(buyer.budgetFlexible, false);
  assert.equal(buyer.budgetStretchAed, 0);
  assert.equal(buyer.budgetFlexibilityPct, 0);
});

test("additional stretch and target stretch ceiling never replace the original budget", async () => {
  const buyers = service();
  let buyer = await buyers.remember("stretch", { budget: 2000000 });
  buyer = await buyers.remember("stretch", parsed("I can stretch another 100k", buyer).facts);
  assert.equal(buyer.budgetAed, 2000000);
  assert.equal(buyer.budgetStretchAed, 100000);
  buyer = await buyers.remember("stretch", parsed("I can stretch to 2.1M", buyer).facts);
  assert.equal(buyer.budgetAed, 2000000);
  assert.equal(buyer.budgetStretchAed, 100000);
  assert.equal(defaultBudgetStretchPct({ ADVISOR_DEFAULT_BUDGET_STRETCH_PCT: "99" }), 10);
  assert.equal(defaultBudgetStretchPct({ ADVISOR_DEFAULT_BUDGET_STRETCH_PCT: "invalid" }), 5);
  assert.equal(parsed("I can stretch 7%", buyer).facts.budgetFlexibilityPct, 7);
  assert.equal(parsed("I can stretch 7%", buyer).facts.budgetStretchAed, 0);
  assert.equal(parsed("Budget 2M, flexible", buyer).facts.budgetFlexible, true);
  assert.equal(parsed("My budget is not flexible", buyer).facts.budgetFirm, true);
});

test("a fresh explicit budget defaults to a new hard ceiling with no inherited stretch", () => {
  const existing = { ...emptyBuyer("newbudget"), budgetAed: 2000000, budgetHardCap: false, budgetFlexible: true, budgetFlexibilityPct: 5, budgetFlexibilityAsked: true };
  const changed = mergeBuyer(existing, { budgetAed: 1800000 });
  assert.equal(changed.budgetAed, 1800000);
  assert.equal(changed.budgetHardCap, true);
  assert.equal(changed.budgetFlexible, false);
  assert.equal(changed.budgetFlexibilityPct, 0);
  assert.equal(changed.budgetFlexibilityAsked, false);
});

test("a model cannot grant budget flexibility or inject inventory IDs into extracted state", () => {
  const model = normalizeUnderstanding({ facts: { budgetFlexible: true, budgetHardCap: false, budgetFirm: false, budgetStretchAed: 300000, activeRecommendationProjectId: "invented", shownProjects: ["invented"], investmentObjective: "growth" } }, "claude");
  assert.equal(model.facts.budgetFlexible, undefined);
  assert.equal(model.facts.budgetHardCap, undefined);
  assert.equal(model.facts.budgetStretchAed, undefined);
  assert.equal(model.facts.activeRecommendationProjectId, undefined);
  assert.equal(model.facts.shownProjects, undefined);
  assert.equal(model.facts.investmentObjective, "growth");
});

test("initial payment concern becomes a bound rejection and one resolved objection restores eligibility", async () => {
  const buyers = service();
  await buyers.remember("reject", { budget: 2000000, area: "Yas" });
  await buyers.recordAdvisoryExposure("reject", { projectIds: ["primary", "challenger"], primaryProjectId: "primary", primaryUnitId: "unit-primary", upgradeProjectId: "challenger" });
  const facts = parsed("The first payment is too high").facts;
  assert.deepEqual(facts.objections, [{ category: "initial_payment_too_high" }]);
  assert.equal(facts.budget, undefined);
  assert.equal(facts.cash, undefined);
  assert.equal(facts.financing, undefined);
  await buyers.remember("reject", facts);
  let buyer = await buyers.recordObjection("reject", { projectId: "primary", unitId: "unit-primary", category: facts.objections[0].category, factFingerprint: "initial=200000" });
  assert.deepEqual(buyer.rejectedProjects, ["primary"]);
  assert.equal(buyer.objections.length, 1);
  assert.equal(buyer.objections[0].projectId, "primary");
  assert.deepEqual(buyer.rejectionReasons.primary.categories, ["initial_payment_too_high"]);
  assert.equal(buyer.rejectionReasons.primary.factFingerprint, "initial=200000");
  assert.equal(buyer.priorities.includes("lower_initial_cash"), true);
  buyer = await buyers.resolveProjectObjection("reject", "primary", "initial_payment_too_high");
  assert.equal(buyer.rejectionReasons.primary.resolved, true);
  assert.equal(buyer.objections[0].resolved, true);
});

test("primary and challenger exposure preserves preferred area and rejected upgrade memory", async () => {
  const buyers = service();
  await buyers.remember("exposure", { budget: 2000000, area: "Yas", noCalls: true });
  let buyer = await buyers.recordAdvisoryExposure("exposure", { projectIds: ["yas", "reem"], primaryProjectId: "yas", primaryUnitId: "u-yas", upgradeProjectId: "reem" });
  assert.deepEqual(buyer.preferredAreas, ["Yas Island"]);
  assert.equal(buyer.activeRecommendationProjectId, "yas");
  assert.equal(buyer.activeRecommendationUnitId, "u-yas");
  buyer = await buyers.recordObjection("exposure", { projectId: "reem", category: "too_expensive" });
  assert.equal(buyer.upgradeDeclined, true);
  assert.deepEqual(buyer.rejectedProjects, ["reem"]);
  buyer = await buyers.recordAdvisoryExposure("exposure", { projectIds: ["new-primary"], primaryProjectId: "new-primary" });
  assert.equal(buyer.activeRecommendationUnitId, null);
  assert.equal(buyer.noCalls, true);
  assert.deepEqual(buyer.preferredAreas, ["Yas Island"]);
});

test("generic no-calls and needs-time objections do not reject an otherwise suitable property", async () => {
  const buyers = service();
  let buyer = await buyers.recordObjection("permission", { projectId: "p", category: "no_calls" });
  buyer = await buyers.recordObjection("permission", { projectId: "p", category: "needs_time" });
  assert.deepEqual(buyer.rejectedProjects, []);
  assert.equal(extractFactsFromMessage("I already have an agent").intents.includes("agent"), false);
  assert.equal(parsed("I don't want the upgrade").facts.upgradeDeclined, true);
  assert.equal(parsed("I can stretch a little for an extra bedroom").facts.priorities.includes("more_space"), true);
});

test("stop/no-call preferences survive advisory updates and new search resets preserve no-call", async () => {
  const buyers = service();
  let buyer = await buyers.remember("stop", parsed("No calls. I'm good.").facts);
  buyer = await buyers.remember("stop", { priorities: ["lower_initial_cash"], investmentObjective: "growth" });
  assert.equal(buyer.noCalls, true);
  // The production engine owns deciding when a new enquiry resumes a stop.
  await buyers.remember("stop", parsed("I'm good.").facts);
  buyer = await buyers.remember("stop", parsed("Thanks").facts);
  assert.equal(buyer.salesPathStopped, true);
  buyer = await buyers.resetCriteria("stop");
  assert.equal(buyer.noCalls, true);
  assert.equal(buyer.investmentObjective, null);
  assert.deepEqual(buyer.rejectedProjects, []);
});

test("advisory state persists in existing buyer JSON without an Airtable schema", async () => {
  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "advisory-buyers-"));
  const store = new LocalStore({ runtimeDir });
  const buyers = new BuyerService(store);
  await buyers.remember("durable", { budget: 2000000, investmentObjective: "growth", holdingPeriod: 7, noCalls: true });
  await buyers.recordAdvisoryExposure("durable", { projectIds: ["p"], primaryProjectId: "p", primaryUnitId: "u" });
  await buyers.recordObjection("durable", { projectId: "p", unitId: "u", category: "initial_payment_too_high" });
  const saved = JSON.parse(await readFile(path.join(runtimeDir, "buyers.json"), "utf8"))[0];
  assert.equal(saved.investmentObjective, "growth");
  assert.equal(saved.holdingPeriod, 7);
  assert.equal(saved.activeRecommendationUnitId, "u");
  assert.equal(saved.rejectionReasons.p.resolved, false);
  assert.equal(saved.noCalls, true);
});
