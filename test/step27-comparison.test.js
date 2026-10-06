import assert from "node:assert/strict";
import test from "node:test";
import { compareProperties, UNKNOWN } from "../src/conversation/comparison.js";
import { buildFactPack } from "../src/facts/retrieval.js";

const NOW = Date.UTC(2026, 9, 5, 12);
function candidate(id, { price = 1_900_000, cash = 190_000, area = "Yas Island", beds = 1, min = 750, max = 820, handover = "Q4 2027", status = "Off-plan", ...patch } = {}) {
  const project = { id, name: `Fixture ${id}`, developerId: "fixture-developer", developerName: "Fixture Developer", emirate: "Abu Dhabi", area, areaId: "fixture-area", masterplanId: "fixture-masterplan", source: "Synthetic unit-test developer sheet", lastVerified: new Date(NOW).toISOString(), active: true, status, handover, paymentPlanAvailable: true, paymentPlanSummary: "60/40. 10 percent booking.", ...patch };
  const unit = { id: `unit-${id}`, projectId: id, propertyType: "apartment", bedrooms: beds, startingPriceAed: price, initialPaymentAed: cash, sizeSqftFrom: min, sizeSqftTo: max, availability: "Available", active: true };
  const result = { project, unit, downPaymentAed: cash };
  result.factPack = buildFactPack(result, { now: NOW });
  return result;
}

test("comparison records exact extra cost, supported benefit, relevance and traceability", () => {
  const result = compareProperties(candidate("a"), candidate("b", { price: 2_100_000, beds: 2, min: 1100, max: 1200 }), { priorities: ["more_space"] });
  assert.equal(result.differences.find(row => row.dimension === "price").delta, 200_000);
  assert.equal(result.upgradeAssessment.extraCostAed, 200_000);
  assert.ok(result.upgradeAssessment.supportedBenefits.some(row => row.code === "additional_bedroom"));
  assert.equal(result.buyerPreference.projectId, "b");
  assert.equal(result.upgradeAssessment.worthPaying, true);
  for (const row of result.differences) for (const evidence of row.evidence) {
    assert.ok(evidence.source && evidence.recordId && evidence.scope && evidence.verificationDate);
  }
});

test("the cheaper equally suitable home wins and a higher price is never a benefit", () => {
  const result = compareProperties(candidate("a", { price: 1_700_000 }), candidate("b", { price: 1_950_000 }));
  assert.equal(result.buyerPreference.projectId, "a");
  assert.equal(result.upgradeAssessment.worthPaying, false);
  assert.ok(result.upgradeAssessment.reasonCodes.includes("no_supported_buyer_benefit_for_extra_price"));
  assert.deepEqual(result.bAdvantages, []);
});

test("a hard budget beats a supported space improvement without inventing stretch permission", () => {
  const result = compareProperties(candidate("a"), candidate("b", { price: 2_100_000, beds: 2 }), { budgetAed: 2_000_000, budgetHardCap: true, priorities: ["more_space"] });
  assert.equal(result.buyerPreference.projectId, "a");
  assert.ok(result.hardConstraintFailures.b.includes("over_budget_ceiling"));
  assert.equal(result.upgradeAssessment.worthPaying, false);
});

test("comparison honors the existing deterministic budget policy after explicit flexibility", () => {
  const buyer = { budgetAed: 2_000_000, budgetFlexible: true, budgetHardCap: false, priorities: ["more_space"] };
  const a = candidate("a"), b = candidate("b", { price: 2_100_000, beds: 2 });
  const permitted = compareProperties(a, b, buyer, { budgetPolicy: { originalBudgetAed: 2_000_000, ceilingAed: 2_100_000 } });
  assert.equal(permitted.buyerPreference.projectId, "b");
  assert.deepEqual(permitted.hardConstraintFailures.b, []);
  const firm = compareProperties(a, b, { ...buyer, budgetHardCap: true }, { budgetPolicy: { originalBudgetAed: 2_000_000, ceilingAed: 2_100_000 } });
  assert.equal(firm.buyerPreference.projectId, "a");
});

test("an unknown cash requirement cannot beat a documented cash constraint failure", () => {
  const a = candidate("a", { cash: 300_000 }), b = candidate("b");
  b.factPack.downPaymentAed = { value: null, confirmed: false };
  const result = compareProperties(a, b, { cashAvailableAed: 200_000 });
  assert.equal(result.buyerPreference, null);
  assert.ok(result.hardConstraintFailures.b.includes("initial_payment_unknown"));
});

test("initial cash is a difference but only becomes an advantage for this buyer's priority", () => {
  const a = candidate("a", { cash: 300_000 }), b = candidate("b", { price: 1_980_000, cash: 100_000 });
  const ordinary = compareProperties(a, b);
  assert.equal(ordinary.differences.find(row => row.dimension === "initial_cash").delta, -200_000);
  assert.ok(!ordinary.bAdvantages.some(row => row.code === "lower_initial_commitment"));
  const objecting = compareProperties(a, b, { objections: [{ category: "initial_payment_too_high" }] });
  assert.equal(objecting.buyerPreference.projectId, "b");
  assert.ok(objecting.bAdvantages.some(row => row.code === "lower_initial_commitment"));
});

test("overlapping size ranges and handover date ranges prove no directional advantage", () => {
  const result = compareProperties(candidate("a", { min: 750, max: 1000, handover: "2027" }), candidate("b", { min: 900, max: 1100, handover: "Q4 2027" }), { priorities: ["more_space", "earlier_handover"] });
  assert.ok(result.differences.some(row => row.dimension === "size_range"));
  assert.ok(![...result.aAdvantages, ...result.bAdvantages].some(row => ["larger_supported_size_range", "earlier_handover"].includes(row.code)));
});

test("a supported earlier handover addresses a timing objection", () => {
  const result = compareProperties(candidate("a", { handover: "2029" }), candidate("b", { handover: "Q4 2027" }), { objections: [{ category: "handover_too_late" }] });
  assert.equal(result.buyerPreference.projectId, "b");
  assert.ok(result.bAdvantages.some(row => row.code === "earlier_handover"));
});

test("ready income selects a supported ready alternative without promising rent", () => {
  const result = compareProperties(candidate("a"), candidate("b", { status: "Ready", handover: "Ready" }), { investmentStrategy: "READY_INCOME" });
  assert.equal(result.buyerPreference.projectId, "b");
  assert.ok(result.bAdvantages.some(row => row.code === "ready_income_route"));
  assert.equal(result.unsupportedClaims.find(row => row.dimension === "rental_yield").value, UNKNOWN);
});

test("a fixed area remains a hard constraint despite better cash terms elsewhere", () => {
  const result = compareProperties(candidate("a", { cash: 300_000 }), candidate("b", { area: "Al Reem Island", cash: 100_000 }), { preferredAreas: ["Yas Island"], areaFlexibility: "fixed", priorities: ["lower_initial_cash"] });
  assert.equal(result.buyerPreference.projectId, "a");
  assert.ok(result.hardConstraintFailures.b.includes("wrong_fixed_area"));
});

test("raw prices cannot bypass a missing, stale or untraceable confirmed fact", () => {
  const a = candidate("a"), b = candidate("b");
  b.factPack.startingPriceAed = { value: null, confirmed: false };
  const absent = compareProperties(a, b);
  assert.ok(!absent.differences.some(row => row.dimension === "price"));
  assert.equal(absent.unknowns.find(row => row.dimension === "price").b, UNKNOWN);
  assert.equal(absent.upgradeAssessment, null);
  b.factPack.startingPriceAed = { value: 1_800_000, confirmed: true };
  b.factPack.source = { value: null, confirmed: false };
  assert.ok(!compareProperties(a, b).differences.some(row => row.dimension === "price"));
  b.factPack.source = a.factPack.source;
  b.factPack.lastVerified = { value: null, confirmed: false };
  assert.ok(!compareProperties(a, b).differences.some(row => row.dimension === "price"));
});

test("unknown investment evidence never becomes a return, liquidity or demand score", () => {
  const a = candidate("a"), b = candidate("b");
  a.investmentThesis = { liquidityCase: { confidence: null }, riskCase: [] };
  const result = compareProperties(a, b, { investmentStrategy: "HANDOVER_EXIT" });
  assert.equal(result.buyerPreference, null);
  assert.ok(result.unsupportedClaims.every(row => row.value === UNKNOWN));
  assert.ok(!result.differences.some(row => ["appreciation", "resale_demand", "liquidity"].includes(row.dimension)));
});

test("unknown product differences do not manufacture an equally suitable cheaper recommendation", () => {
  const a = candidate("a", { price: 1_700_000 }), b = candidate("b");
  a.factPack.propertyType = { value: null, confirmed: false };
  assert.equal(compareProperties(a, b).buyerPreference, null);
});

function withSchedule(row, construction, handover, status = "COMPLETE") {
  row.investmentThesis = { projectId: row.project.id, unitId: row.unit.id, paymentCase: {
    scheduleStatus: status, cashBeforeHandoverAed: construction, cashAtHandoverAed: handover,
    amountBasis: "purchase_price_milestones_excluding_fees",
    evidence: [{ source: "Synthetic reconciled plan", sourceRecordId: `plan-${row.project.id}`, planId: `plan-${row.project.id}`, field: "milestones", scope: "payment_plan_version", verifiedOn: new Date(NOW).toISOString() }]
  } };
  return row;
}

test("handover-exit comparison uses reconciled construction cash and shows shifted balloon exposure", () => {
  const a = withSchedule(candidate("a"), 1_140_000, 760_000);
  const b = withSchedule(candidate("b"), 760_000, 1_140_000);
  const result = compareProperties(a, b, { investmentStrategy: "HANDOVER_EXIT" });
  assert.equal(result.differences.find(row => row.dimension === "construction_cash").delta, -380_000);
  assert.equal(result.buyerPreference.projectId, "b");
  const tradeoff = result.tradeoffs.find(row => row.code === "lower_construction_cash_higher_handover_exposure");
  assert.equal(tradeoff.borneBy, "b");
  assert.equal(tradeoff.constructionSavingsAed, 380_000);
  assert.equal(tradeoff.handoverExtraAed, 380_000);
  assert.equal(tradeoff.amountBasis, "purchase_price_milestones_excluding_fees");
});

test("incomplete, mismatched or untraceable schedules cannot become cash comparisons", () => {
  const a = withSchedule(candidate("a"), 1_140_000, 760_000);
  const b = withSchedule(candidate("b"), 760_000, 1_140_000, "UNKNOWN");
  for (const alter of [() => {}, () => { b.investmentThesis.paymentCase.scheduleStatus = "COMPLETE"; b.investmentThesis.projectId = "unrelated"; }, () => { b.investmentThesis.projectId = "b"; b.investmentThesis.paymentCase.evidence = []; }]) {
    alter();
    const result = compareProperties(a, b, { investmentStrategy: "HANDOVER_EXIT" });
    assert.ok(!result.differences.some(row => row.dimension === "construction_cash"));
    assert.ok(!result.bAdvantages.some(row => row.code === "lower_construction_cash"));
  }
});

test("handover cash becomes a benefit only for a relevant buyer preference", () => {
  const a = withSchedule(candidate("a"), 1_140_000, 760_000), b = withSchedule(candidate("b"), 760_000, 1_140_000);
  const ordinary = compareProperties(a, b);
  assert.ok(!ordinary.aAdvantages.some(row => row.code === "lower_handover_cash"));
  const avoidingBalloon = compareProperties(a, b, { priorities: ["avoid_handover_balloon"] });
  assert.equal(avoidingBalloon.buyerPreference.projectId, "a");
  assert.ok(avoidingBalloon.aAdvantages.some(row => row.code === "lower_handover_cash"));
});
