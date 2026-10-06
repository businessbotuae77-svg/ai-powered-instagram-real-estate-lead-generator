import assert from "node:assert/strict";
import test from "node:test";
import { advisorBudgetPolicy, buildAdvisorOpportunities } from "../src/conversation/advisor-opportunities.js";

const NOW = Date.UTC(2026, 9, 5, 12);
const options = { now: NOW };

// All inventory in this file is isolated test data, never production inventory.
function catalogue(rows) {
  return {
    developers: [{ id: "dev_test", name: "Fixture Developer", active: true }],
    projects: rows.map(row => ({
      id: row.id,
      name: `Fixture ${row.id}`,
      developerId: "dev_test",
      developerName: "Fixture Developer",
      developerActive: true,
      emirate: "Abu Dhabi",
      area: "Yas Island",
      active: true,
      source: "Synthetic unit-test price sheet",
      lastVerified: new Date(NOW - 60_000).toISOString(),
      status: "Off-plan",
      handover: "Q4 2027",
      paymentPlanAvailable: true,
      paymentPlanSummary: "80/20. 10 percent booking.",
      ...row.project
    })),
    units: rows.map(row => ({
      id: `unit_${row.id}`,
      projectId: row.id,
      active: true,
      propertyType: "apartment",
      bedrooms: 1,
      startingPriceAed: row.price,
      initialPaymentAed: row.cash ?? 190_000,
      sizeSqftFrom: 750,
      sizeSqftTo: 820,
      availability: "Available",
      ...row.unit
    }))
  };
}

function buyer(patch = {}) {
  return {
    budgetAed: 2_000_000,
    budgetHardCap: true,
    budgetFirm: false,
    budgetFlexible: false,
    preferredEmirate: "Abu Dhabi",
    preferredAreas: ["Yas Island"],
    areaFlexibility: "preferred",
    bedrooms: [1],
    propertyTypes: ["apartment"],
    useType: "unknown",
    priorities: [],
    objections: [],
    ...patch
  };
}

test("advisor defaults to a hard budget; absent price cannot be a recommendation", () => {
  const result = buildAdvisorOpportunities(catalogue([{ id: "a", price: 1_900_000 }, { id: "over", price: 2_010_000 }, { id: "missing", price: null }]), buyer(), options);
  assert.deepEqual(result.matches.map(row => row.project.id), ["a"]);
  assert.equal(result.budgetPolicy.flexible, false);
  assert.equal(result.budgetPolicy.ceilingAed, 2_000_000);
  assert.ok(result.assessments.find(row => row.candidate.project.id === "over").hardConstraintFailures.includes("over_budget_ceiling"));
  assert.ok(result.assessments.find(row => row.candidate.project.id === "missing").hardConstraintFailures.includes("price_unknown"));
});

test("only explicit flexibility permits a conservative configured stretch", () => {
  assert.equal(advisorBudgetPolicy(buyer({ budgetFlexible: true })).ceilingAed, 2_000_000);
  const flexible = buyer({ budgetHardCap: false, budgetFlexible: true });
  assert.equal(advisorBudgetPolicy(flexible, { defaultBudgetStretchPct: 5 }).ceilingAed, 2_100_000);
  assert.equal(advisorBudgetPolicy({ ...flexible, budgetFlexibilityPct: 50 }).ceilingAed, 2_200_000);
  assert.equal(advisorBudgetPolicy({ ...flexible, budgetFirm: true }).ceilingAed, 2_000_000);
  assert.equal(advisorBudgetPolicy({ ...flexible, budgetStretchAed: 0 }).ceilingAed, 2_100_000);
  assert.equal(advisorBudgetPolicy({ ...flexible, budgetFlexibilityPct: 0, budgetStretchAed: 0 }).ceilingAed, 2_000_000);
  assert.equal(advisorBudgetPolicy({ ...flexible, budgetFlexibilityPct: 0, budgetStretchAed: 150_000 }).ceilingAed, 2_150_000);
  assert.equal(advisorBudgetPolicy({ ...flexible, budgetFlexibilityPct: 0, budgetStretchAed: 300_000 }).ceilingAed, 2_200_000);
  assert.equal(advisorBudgetPolicy({ ...flexible, budgetFlexibilityPct: 3, budgetStretchAed: 100_000 }).ceilingAed, 2_060_000);
});

test("an explicitly zero or named hard ceiling never widens to the default stretch", () => {
  const data = catalogue([{ id: "a", price: 1_960_000 }, { id: "b", price: 2_100_000, unit: { bedrooms: 2 } }]);
  for (const cap of [{ budgetFlexible: true, budgetHardCap: false, budgetFlexibilityPct: 0, budgetStretchAed: 0 }, { budgetFlexible: false, budgetHardCap: true, budgetFirm: true }]) {
    const result = buildAdvisorOpportunities(data, buyer({ useType: "end_use", priorities: ["more_space"], ...cap }), options);
    assert.equal(result.budgetPolicy.ceilingAed, 2_000_000);
    assert.deepEqual(result.matches.map(row => row.project.id), ["a"]);
    assert.equal(result.upgradeAssessment.permissionCandidate, null);
  }
});

test("flexible budget gives one upgrade with exact price, bedroom and cash evidence", () => {
  const data = catalogue([
    { id: "a", price: 1_960_000, cash: 196_000 },
    { id: "b", price: 2_100_000, cash: 199_000, unit: { bedrooms: 2, sizeSqftFrom: 1100, sizeSqftTo: 1200 } },
    { id: "c", price: 2_110_000, cash: 190_000, unit: { bedrooms: 2 } }
  ]);
  const result = buildAdvisorOpportunities(data, buyer({ budgetFlexible: true, budgetHardCap: false, useType: "end_use", priorities: ["more_space"] }), options);
  assert.equal(result.matches.length, 2);
  assert.equal(result.primary.projectId, "a");
  assert.equal(result.challenger.projectId, "b");
  assert.equal(result.challenger.type, "smart_upgrade");
  assert.equal(result.challenger.priceDifferenceAed, 140_000);
  assert.equal(result.challenger.cashDifferenceAed, 3_000);
  assert.equal(result.challenger.budgetStatus, "above_original_with_permission");
  assert.deepEqual(result.challenger.buyerBenefit.find(row => row.code === "additional_bedroom"), { code: "additional_bedroom", field: "bedrooms", from: 1, to: 2, delta: 1, unit: "bedrooms" });
  assert.ok(result.challenger.tradeoffs.some(row => row.code === "higher_starting_price" && row.delta === 140_000));
  assert.ok(result.challenger.supportedFacts.some(row => row.projectId === "b" && row.field === "bedrooms" && row.value === 2));
  assert.deepEqual(result.challenger.comparedTo, { projectId: "a", unitId: "unit_a" });
  assert.equal(result.challenger.amountBasis, "confirmed_starting_prices");
});

test("hard budget hides an upgrade and asks permission internally only when material", () => {
  const data = catalogue([{ id: "a", price: 1_960_000 }, { id: "b", price: 2_100_000, unit: { bedrooms: 2 } }]);
  const result = buildAdvisorOpportunities(data, buyer({ useType: "end_use", priorities: ["more_space"] }), options);
  assert.deepEqual(result.matches.map(row => row.project.id), ["a"]);
  assert.deepEqual(result.packs.map(row => row.projectId), ["a"]);
  assert.equal(result.upgradeAssessment.permissionCandidate.projectId, "b");
  assert.equal(result.upgradeAssessment.permissionCandidate.budgetStatus, "requires_budget_permission");
  assert.equal(result.upgradeAssessment.decision, "ask_budget_permission_once");
  assert.equal(result.challenger, null);
});

test("firm budget, prior permission question and declined upgrade suppress stretch", () => {
  const data = catalogue([{ id: "a", price: 1_960_000 }, { id: "b", price: 2_100_000, unit: { bedrooms: 2 } }]);
  for (const restriction of [{ budgetFirm: true }, { budgetFlexibilityAsked: true }, { upgradeDeclined: true }]) {
    const result = buildAdvisorOpportunities(data, buyer({ useType: "end_use", priorities: ["more_space"], ...restriction }), options);
    assert.equal(result.upgradeAssessment.permissionCandidate, null);
    assert.deepEqual(result.matches.map(row => row.project.id), ["a"]);
  }
});

test("flexibility does not promote an over-original primary merely by an objective bonus", () => {
  const data = catalogue([{ id: "inside", price: 1_960_000 }, { id: "ready", price: 2_100_000, project: { status: "Ready", handover: "Ready" } }]);
  const result = buildAdvisorOpportunities(data, buyer({ budgetFlexible: true, budgetHardCap: false, useType: "investment", investmentObjective: "rental_income" }), options);
  assert.equal(result.primary.projectId, "inside");
  assert.equal(result.challenger.projectId, "ready");
  assert.equal(result.challenger.type, "smart_upgrade");
  assert.equal(result.challenger.priceDifferenceAed, 140_000);
  assert.ok(result.challenger.reasonCodes.includes("ready_income_route"));
  assert.ok(result.challenger.tradeoffs.some(item => item.code === "higher_starting_price"));
});

test("an over-original option without a comparison baseline never becomes an upsell", () => {
  const result = buildAdvisorOpportunities(catalogue([{ id: "over", price: 2_050_000 }]), buyer({ budgetFlexible: true, budgetHardCap: false }), options);
  assert.equal(result.primary, null);
  assert.equal(result.matches.length, 0);
  assert.equal(result.opportunities[0].type, "no_push");
});

test("explicit flexibility can resolve a rejected in-budget size objection with exact benefit", () => {
  const data = catalogue([{ id: "old", price: 1_960_000 }, { id: "larger", price: 2_100_000, unit: { bedrooms: 2 } }]);
  const result = buildAdvisorOpportunities(data, buyer({ budgetFlexible: true, budgetHardCap: false, rejectedProjects: ["old"], objections: [{ category: "too_small", projectId: "old", unitId: "unit_old" }] }), options);
  assert.equal(result.primary.projectId, "larger");
  assert.equal(result.primary.type, "smart_upgrade");
  assert.equal(result.primary.priceDifferenceAed, 140_000);
  assert.ok(result.primary.buyerBenefit.some(item => item.code === "additional_bedroom" && item.from === 1 && item.to === 2));
});

test("more expensive does not win and no material benefit produces do-not-pay-extra evidence", () => {
  const result = buildAdvisorOpportunities(catalogue([{ id: "cheap", price: 1_800_000 }, { id: "costly", price: 1_980_000 }]), buyer(), options);
  assert.equal(result.primary.projectId, "cheap");
  assert.equal(result.challenger, null);
  assert.equal(result.upgradeAssessment.decision, "no_push");
  const negative = result.upgradeAssessment.opportunities[0];
  assert.equal(negative.type, "no_push");
  assert.equal(negative.priceDifferenceAed, 180_000);
  assert.deepEqual(negative.reasonCodes, ["no_material_buyer_benefit_for_extra_price"]);
});

test("investment growth does not justify bedrooms as an automatic upgrade", () => {
  const result = buildAdvisorOpportunities(catalogue([{ id: "a", price: 1_900_000 }, { id: "b", price: 1_980_000, unit: { bedrooms: 2, sizeSqftFrom: 1200, sizeSqftTo: 1350 } }]), buyer({ useType: "investment", investmentObjective: "growth" }), options);
  assert.equal(result.challenger, null);
  assert.equal(result.primary.projectId, "a");
});

test("end-user space priority and rental-income route rank different supported choices", () => {
  const data = catalogue([
    { id: "ready", price: 1_890_000, project: { status: "Ready", handover: "Ready" }, unit: { sizeSqftFrom: 650, sizeSqftTo: 720 } },
    { id: "offplan", price: 1_980_000, unit: { sizeSqftFrom: 1000, sizeSqftTo: 1100 } }
  ]);
  const income = buildAdvisorOpportunities(data, buyer({ useType: "investment", investmentObjective: "rental_income" }), options);
  const endUse = buildAdvisorOpportunities(data, buyer({ useType: "end_use", priorities: ["more_space"] }), options);
  assert.equal(income.primary.projectId, "ready");
  assert.ok(income.primary.reasonCodes.includes("ready_income_route"));
  assert.equal(endUse.primary.projectId, "offplan");
  assert.ok(endUse.primary.reasonCodes.includes("more_space_priority"));
  assert.doesNotMatch(JSON.stringify(income.opportunities.map(row => ({ buyerBenefit: row.buyerBenefit, supportedFacts: row.supportedFacts, reasonCodes: row.reasonCodes }))), /rentalYield|expectedROI|appreciation|guaranteed/i);
  for (const thesis of income.investmentTheses) {
    assert.deepEqual(thesis.forecasts, []);
    assert.equal(thesis.forecastAllowed, false);
    assert.ok(thesis.unknowns.includes("future_appreciation"));
  }
});

test("growth recommendation can keep area and bedrooms open while retaining budget", () => {
  const state = buyer({ preferredAreas: [], areaFlexibility: "open", bedrooms: [], propertyTypes: [], useType: "investment", investmentObjective: "growth" });
  const result = buildAdvisorOpportunities(catalogue([{ id: "a", price: 1_980_000 }]), state, options);
  assert.equal(result.primary.projectId, "a");
  assert.equal(result.budgetPolicy.originalBudgetAed, 2_000_000);
  assert.deepEqual(state.preferredAreas, []);
});

test("one area challenger must solve a need without overwriting Yas preference", () => {
  const data = catalogue([{ id: "yas", price: 1_950_000, cash: 390_000 }, { id: "reem", price: 1_950_000, cash: 120_000, project: { area: "Al Reem Island" } }, { id: "random", price: 1_950_000, cash: 390_000, project: { area: "Masdar City" } }]);
  const state = buyer({ financing: "payment_plan" });
  const before = structuredClone(state);
  const result = buildAdvisorOpportunities(data, state, options);
  assert.equal(result.primary.projectId, "yas");
  assert.equal(result.challenger.projectId, "reem");
  assert.equal(result.challenger.type, "easier_payment_alternative");
  assert.ok(result.challenger.reasonCodes.includes("lower_initial_commitment"));
  assert.equal(result.challenger.cashDifferenceAed, -270_000);
  assert.ok(result.challenger.tradeoffs.some(row => row.code === "outside_preferred_area"));
  assert.deepEqual(state, before);
});

test("fixed area prevents a challenger even when cheaper cash exists", () => {
  const result = buildAdvisorOpportunities(catalogue([{ id: "yas", price: 1_950_000, cash: 390_000 }, { id: "reem", price: 1_950_000, cash: 120_000, project: { area: "Al Reem Island" } }]), buyer({ financing: "payment_plan", areaFlexibility: "fixed" }), options);
  assert.equal(result.challenger, null);
  assert.deepEqual(result.matches.map(row => row.project.id), ["yas"]);
});

test("chosen area does not trigger random cheaper cross-selling without a cost need", () => {
  const result = buildAdvisorOpportunities(catalogue([{ id: "yas", price: 1_950_000 }, { id: "reem", price: 1_650_000, project: { area: "Al Reem Island" } }]), buyer(), options);
  assert.equal(result.primary.projectId, "yas");
  assert.equal(result.challenger, null);
});

test("initial-payment objection changes recommendation and binds rejected reference arithmetic", () => {
  const data = catalogue([{ id: "a", price: 1_950_000, cash: 390_000 }, { id: "b", price: 1_950_000, cash: 120_000 }, { id: "c", price: 1_900_000, cash: 380_000 }]);
  const result = buildAdvisorOpportunities(data, buyer({ activeRecommendationProjectId: "a", activeRecommendationUnitId: "unit_a", rejectedProjects: ["a"], rejectionReasons: { a: { categories: ["initial_payment_too_high"], unitId: "unit_a", resolved: false } }, objections: [{ category: "initial_payment_too_high", projectId: "a", unitId: "unit_a", resolved: false }] }), options);
  assert.equal(result.primary.projectId, "b");
  assert.deepEqual(result.matches.map(row => row.project.id), ["b"]);
  assert.equal(result.primary.cashDifferenceAed, -270_000);
  assert.ok(result.primary.reasonCodes.includes("lower_initial_commitment"));
  assert.deepEqual(result.primary.comparedTo, { projectId: "a", unitId: "unit_a" });
  assert.ok(result.packs.some(pack => pack.projectId === "a"));
  assert.equal(result.primary.initialCashBasis, "documented_initial_payment_only_fees_and_schedule_not_inferred");
});

test("persistent objection remains bound to rejected property across later turns", () => {
  const data = catalogue([{ id: "a", price: 1_950_000, cash: 390_000 }, { id: "b", price: 1_950_000, cash: 120_000 }, { id: "c", price: 1_900_000, cash: 380_000 }]);
  const state = buyer({ activeRecommendationProjectId: "b", activeRecommendationUnitId: "unit_b", rejectedProjects: ["a"], objections: [{ category: "initial_payment_too_high", projectId: "a", unitId: "unit_a", resolved: false }] });
  const first = buildAdvisorOpportunities(data, state, options);
  const next = buildAdvisorOpportunities(data, { ...state, activeRecommendationProjectId: first.primary.projectId, activeRecommendationUnitId: first.primary.unitId }, options);
  assert.equal(first.primary.projectId, "b");
  assert.equal(next.primary.projectId, "b");
  assert.equal(next.primary.comparedTo.projectId, "a");
  assert.equal(next.primary.cashDifferenceAed, -270_000);
});

test("wrong-area objection requires a different area and preserves the original preference", () => {
  const data = catalogue([{ id: "old", price: 1_950_000 }, { id: "samearea", price: 1_850_000 }, { id: "different", price: 1_950_000, project: { area: "Al Reem Island" } }]);
  const state = buyer({ rejectedProjects: ["old"], activeRecommendationProjectId: "old", activeRecommendationUnitId: "unit_old", objections: [{ category: "wrong_area", projectId: "old", unitId: "unit_old" }] });
  const result = buildAdvisorOpportunities(data, state, options);
  assert.equal(result.primary.projectId, "different");
  assert.ok(result.primary.reasonCodes.includes("different_area_as_requested"));
  assert.equal(result.primary.buyerBenefit.find(row => row.code === "different_area_as_requested").to, "Al Reem Island");
  assert.deepEqual(state.preferredAreas, ["Yas Island"]);
  const firm = buildAdvisorOpportunities(data, { ...state, areaFlexibility: "fixed" }, options);
  assert.equal(firm.primary, null);
});

test("wrong-type objection needs explicit type flexibility and does not change buyer type", () => {
  const data = catalogue([{ id: "old", price: 1_950_000 }, { id: "same", price: 1_850_000 }, { id: "townhouse", price: 1_950_000, unit: { propertyType: "townhouse" } }]);
  const state = buyer({ rejectedProjects: ["old"], activeRecommendationProjectId: "old", activeRecommendationUnitId: "unit_old", objections: [{ category: "wrong_property_type", projectId: "old", unitId: "unit_old" }], propertyTypeFlexibility: true });
  const result = buildAdvisorOpportunities(data, state, options);
  assert.equal(result.primary.projectId, "townhouse");
  assert.ok(result.primary.reasonCodes.includes("property_type_as_requested"));
  assert.deepEqual(state.propertyTypes, ["apartment"]);
  assert.equal(buildAdvisorOpportunities(data, { ...state, propertyTypeFlexibility: false }, options).primary, null);
});

test("too-large objection finds a supported smaller alternative without ignoring size", () => {
  const data = catalogue([{ id: "old", price: 1_950_000, unit: { bedrooms: 2, sizeSqftFrom: 1500, sizeSqftTo: 1600 } }, { id: "same", price: 1_850_000, unit: { bedrooms: 2, sizeSqftFrom: 1550, sizeSqftTo: 1650 } }, { id: "smaller", price: 1_800_000, unit: { bedrooms: 1, sizeSqftFrom: 750, sizeSqftTo: 850 } }]);
  const state = buyer({ bedrooms: [2], rejectedProjects: ["old"], objections: [{ category: "too_large", projectId: "old", unitId: "unit_old" }] });
  const result = buildAdvisorOpportunities(data, state, options);
  assert.equal(result.primary.projectId, "smaller");
  assert.ok(result.primary.reasonCodes.includes("smaller_supported_size_range"));
  assert.ok(result.primary.reasonCodes.includes("fewer_bedrooms_as_requested"));
  assert.equal(result.primary.priceDifferenceAed, -150_000);
  assert.deepEqual(state.bedrooms, [2]);
});

test("developer concern changes developer without unsupported quality rankings", () => {
  const data = catalogue([{ id: "old", price: 1_950_000 }, { id: "same", price: 1_850_000 }, { id: "other", price: 1_950_000, project: { developerName: "Other Fixture Developer" } }]);
  const result = buildAdvisorOpportunities(data, buyer({ developerInterest: "Fixture Developer", rejectedProjects: ["old"], objections: [{ category: "developer_concern", projectId: "old", unitId: "unit_old" }] }), options);
  assert.equal(result.primary.projectId, "other");
  assert.ok(result.primary.reasonCodes.includes("different_developer_as_requested"));
  assert.doesNotMatch(JSON.stringify(result.primary), /superior|better_developer|trusted_developer/);
});

test("rejected projects and declined upgrades are not immediately repeated", () => {
  const data = catalogue([{ id: "a", price: 1_900_000 }, { id: "b", price: 1_980_000, unit: { bedrooms: 2 } }]);
  const state = buyer({ useType: "end_use", priorities: ["more_space"], rejectedProjects: ["b"], lastUpgradeProjectId: "b", upgradeDeclined: true });
  const result = buildAdvisorOpportunities(data, state, options);
  assert.deepEqual(result.matches.map(row => row.project.id), ["a"]);
  assert.equal(result.challenger, null);
});

test("explicit re-request or resolved objection permits a rejected direct option", () => {
  const data = catalogue([{ id: "a", price: 1_900_000 }]);
  const state = buyer({ rejectedProjects: ["a"] });
  assert.equal(buildAdvisorOpportunities(data, state, options).matches.length, 0);
  assert.equal(buildAdvisorOpportunities(data, state, { ...options, explicitRequestedProjectIds: ["a"] }).matches.length, 1);
  assert.equal(buildAdvisorOpportunities(data, { ...state, rejectionReasons: { a: { resolved: true } } }, options).matches.length, 1);
});

test("no stale, inactive, unapproved, unsupported, unavailable or non-UAE option is selected", () => {
  const data = catalogue([
    { id: "good", price: 1_900_000 },
    { id: "stale", price: 1_000_000, project: { lastVerified: "2020-01-01" } },
    { id: "inactive", price: 1_000_000, project: { active: false } },
    { id: "unapproved", price: 1_000_000, project: { approved: false } },
    { id: "nosource", price: 1_000_000, project: { source: "" } },
    { id: "future", price: 1_000_000, project: { lastVerified: "2030-01-01" } },
    { id: "sold", price: 1_000_000, unit: { availability: "Sold out" } },
    { id: "dubai", price: 1_000_000, project: { emirate: "Dubai" } },
    { id: "badprice", price: Number.POSITIVE_INFINITY }
  ]);
  const result = buildAdvisorOpportunities(data, buyer(), options);
  assert.deepEqual(result.matches.map(row => row.project.id), ["good"]);
  const stale = result.candidates.find(row => row.project.id === "stale");
  assert.equal(stale.unit.startingPriceAed, null);
  assert.equal(stale.factPack.startingPriceAed.confirmed, false);
});

test("unknown availability is not invented; project launch is no availability evidence", () => {
  const result = buildAdvisorOpportunities(catalogue([{ id: "a", price: 1_900_000, project: { lastVerified: new Date(NOW - 2 * 86400000).toISOString(), availabilityNotes: "launching now" } }]), buyer(), options);
  assert.equal(result.primary.confidence, "medium");
  assert.equal(result.packs[0].availability.confirmed, false);
  assert.ok(result.primary.tradeoffs.every(row => row.code !== "available_now"));
  assert.ok(result.primary.supportedFacts.every(row => row.field !== "availability"));
});

test("cash and financing are suitability constraints; missing plan is never inferred", () => {
  const data = catalogue([{ id: "highcash", price: 1_900_000, cash: 390_000 }, { id: "missingplan", price: 1_800_000, cash: 100_000, project: { paymentPlanSummary: null } }, { id: "good", price: 1_950_000, cash: 120_000 }]);
  const result = buildAdvisorOpportunities(data, buyer({ cashAvailableAed: 150_000, financing: "payment_plan" }), options);
  assert.deepEqual(result.matches.map(row => row.project.id), ["good"]);
  assert.ok(result.assessments.find(row => row.candidate.project.id === "highcash").hardConstraintFailures.includes("initial_payment_over_cash"));
  assert.ok(result.assessments.find(row => row.candidate.project.id === "missingplan").hardConstraintFailures.includes("payment_plan_unconfirmed"));
});

test("Hudayriyat studio exclusion survives flexible area and unset bedroom preferences", () => {
  const data = catalogue([{ id: "studio", price: 800_000, project: { area: "Hudayriyat Island" }, unit: { bedrooms: 0, propertyType: "studio" } }, { id: "a", price: 1_900_000 }]);
  const result = buildAdvisorOpportunities(data, buyer({ preferredAreas: [], bedrooms: [], propertyTypes: [], areaFlexibility: "open" }), options);
  assert.deepEqual(result.candidates.map(row => row.project.id), ["a"]);
});

test("one primary plus one challenger obeys lower configured limit and never dumps inventory", () => {
  const data = catalogue([{ id: "a", price: 1_890_000, cash: 189_000 }, { id: "b", price: 1_950_000, cash: 120_000 }, { id: "c", price: 1_980_000, cash: 130_000 }]);
  const state = buyer({ financing: "payment_plan" });
  const one = buildAdvisorOpportunities(data, state, { ...options, maxRecommendations: 1 });
  const many = buildAdvisorOpportunities(data, state, { ...options, maxRecommendations: 99 });
  assert.equal(one.matches.length, 1);
  assert.ok(many.matches.length <= 2);
  for (const opportunity of many.opportunities) assert.ok(opportunity.reasonCodes.length > 0);
});

test("no-calls survives advisory work and stopped sales paths produce no-push only", () => {
  const data = catalogue([{ id: "a", price: 1_900_000 }]);
  const state = buyer({ noCalls: true, preferredContactChannel: "instagram" });
  assert.equal(buildAdvisorOpportunities(data, state, options).matches.length, 1);
  assert.equal(state.noCalls, true);
  const stopped = buildAdvisorOpportunities(data, { ...state, salesPathStopped: true }, options);
  assert.equal(stopped.matches.length, 0);
  assert.equal(stopped.opportunities[0].type, "no_push");
});

test("no-calls does not reject a recommended property or change the comparison reference", () => {
  const data = catalogue([{ id: "a", price: 1_890_000 }, { id: "b", price: 1_980_000 }]);
  const state = buyer({ noCalls: true, activeRecommendationProjectId: "a", activeRecommendationUnitId: "unit_a", objections: [{ category: "no_calls", projectId: "a", unitId: "unit_a" }] });
  const result = buildAdvisorOpportunities(data, state, options);
  assert.equal(result.primary.projectId, "a");
  assert.equal(result.primary.comparedTo, null);
  assert.equal(state.noCalls, true);
});

test("trust concern is answered before recommending rather than switching randomly", () => {
  const data = catalogue([{ id: "a", price: 1_890_000 }, { id: "b", price: 1_980_000 }]);
  const state = buyer({ activeRecommendationProjectId: "a", activeRecommendationUnitId: "unit_a", objections: [{ category: "trust_concern", projectId: "a", unitId: "unit_a" }] });
  const result = buildAdvisorOpportunities(data, state, options);
  assert.equal(result.primary, null);
  assert.equal(result.opportunities[0].type, "no_push");
  assert.deepEqual(result.opportunities[0].reasonCodes, ["resolve_trust_before_recommending"]);
  const requested = buildAdvisorOpportunities(data, state, { ...options, requestedRecommendation: true });
  assert.equal(requested.primary.projectId, "a");
});

test("overlapping unit-size ranges cannot justify paying extra for a larger minimum", () => {
  const data = catalogue([{ id: "a", price: 1_890_000, unit: { sizeSqftFrom: 750, sizeSqftTo: 1200 } }, { id: "b", price: 1_980_000, unit: { sizeSqftFrom: 900, sizeSqftTo: 1100 } }]);
  const result = buildAdvisorOpportunities(data, buyer({ useType: "end_use", priorities: ["more_space"] }), options);
  assert.equal(result.primary.projectId, "a");
  assert.equal(result.challenger?.reasonCodes.includes("larger_supported_size_range") || false, false);
  assert.equal(result.upgradeAssessment.opportunities[0].type, "no_push");
});

test("handover alternatives require non-overlapping supported date ranges", () => {
  const data = catalogue([{ id: "a", price: 1_890_000, project: { handover: "2028" } }, { id: "b", price: 1_980_000, project: { handover: "Q4 2027" } }]);
  const result = buildAdvisorOpportunities(data, buyer({ priorities: ["earlier_handover"] }), options);
  assert.equal(result.challenger.type, "smart_upgrade");
  assert.ok(result.challenger.reasonCodes.includes("earlier_handover"));
  const overlapping = buildAdvisorOpportunities(catalogue([{ id: "a", price: 1_890_000, project: { handover: "2028" } }, { id: "b", price: 1_980_000, project: { handover: "Q4 2028" } }]), buyer({ priorities: ["move_in_soon"] }), options);
  assert.equal(overlapping.challenger, null);
});
