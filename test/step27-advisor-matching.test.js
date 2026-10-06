import assert from "node:assert/strict";
import test from "node:test";
import { buildAdvisorOpportunities, commercialEvidenceState, commercialEvidenceFingerprint } from "../src/conversation/advisor-opportunities.js";
import { assessCandidate } from "../src/conversation/fit-assess.js";
import { resolveMatches } from "../src/conversation/match-resolve.js";

const NOW = Date.UTC(2026, 9, 6, 12);
const checked = new Date(NOW - 60_000).toISOString();
const options = { now: NOW };
const buyer = patch => ({ budgetAed: 2_000_000, budgetHardCap: true, preferredEmirate: "Abu Dhabi", preferredAreas: [], bedrooms: [1], propertyTypes: ["apartment"], useType: "investment", investmentGoal: "total_return", objections: [], priorities: [], ...patch });
function catalog(rows, intelligence = {}) {
  return {
    developers: [{ id: "dev", active: true }],
    projects: rows.map(row => ({ id: row.id, name: `Synthetic ${row.id}`, developerId: "dev", developerName: "Synthetic Developer", developerActive: true, active: true, approved: true, source: "Synthetic contract only", lastVerified: checked, emirate: "Abu Dhabi", area: "Yas Island", status: "Off-plan", handover: "Q4 2027", paymentPlanAvailable: true, paymentPlanSummary: "80/20", ...row.project })),
    units: rows.map(row => ({ id: `unit_${row.id}`, projectId: row.id, active: true, propertyType: "apartment", bedrooms: 1, startingPriceAed: row.price, initialPaymentAed: row.cash ?? 100_000, availability: "Available", sizeSqftFrom: 750, sizeSqftTo: 820, planId: `plan_${row.id}`, ...row.unit })), intelligence
  };
}
function schedule(id, constructionPercent) {
  return { id: `schedule_${id}`, projectId: id, planId: `plan_${id}`, approved: true, botEnabled: true, usable: true, source: "Synthetic contract only", checkedOn: checked, scope: "payment_plan_version", milestones: [{ id: "booking", kind: "booking", percent: 10, daysFromBooking: 0 }, { id: "construction", kind: "construction", percent: constructionPercent - 10, monthsFromBooking: 12 }, { id: "handover", kind: "handover", percent: 100 - constructionPercent, monthsFromBooking: 24 }] };
}

test("ROI umbrella accepts open area and carries explainable component reasoning", () => {
  const result = buildAdvisorOpportunities(catalog([{ id: "a", price: 1_900_000 }]), buyer(), options);
  assert.equal(result.investmentStrategy.investmentGoal, "total_return");
  assert.equal(result.primary.projectId, "a");
  assert.equal(result.rationale.areaFit.status, "NOT_REQUESTED");
  assert.equal(result.rationale.priceFit.status, "MATCH");
  assert.equal(result.rationale.liquidityFit.status, "UNKNOWN");
  assert.equal(result.rationale.riskFit.status, "UNKNOWN");
});

test("handover exit ranks sourced cash deployment; longer hold retains lower entry when maturation evidence is absent", () => {
  const data = catalog([{ id: "a", price: 1_850_000 }, { id: "b", price: 1_950_000 }], { paymentSchedules: [schedule("a", 80), schedule("b", 20)] });
  const exit = buildAdvisorOpportunities(data, buyer({ exitHorizon: "handover", handoverStrategy: "sell" }), options);
  const hold = buildAdvisorOpportunities(data, buyer({ exitHorizon: "long_term", handoverStrategy: "hold", holdingPeriod: 5 }), options);
  assert.equal(exit.primary.projectId, "b");
  assert.ok(exit.primary.reasonCodes.includes("construction_cash_for_exit_strategy"));
  assert.equal(exit.investmentTheses[0].paymentCase.constructionCashAed, 390_000);
  assert.equal(hold.primary.projectId, "a");
  assert.ok(hold.investmentTheses[0].exitCase.considerations.includes("area_maturation"));
  assert.equal(hold.investmentTheses[0].areaCase.status, "UNKNOWN");
});

test("immediate income excludes off-plan in both advisory and legacy matching", () => {
  const data = catalog([{ id: "off", price: 1_800_000 }, { id: "ready", price: 1_950_000, project: { status: "Ready", handover: "Ready" } }]);
  const state = buyer({ incomeRequirement: "immediate", investmentStrategy: "READY_INCOME" });
  const result = buildAdvisorOpportunities(data, state, options);
  assert.deepEqual(result.matches.map(row => row.project.id), ["ready"]);
  assert.ok(result.assessments.find(row => row.candidate.project.id === "off").hardConstraintFailures.includes("ready_income_required"));
  assert.deepEqual(resolveMatches(data, state).matches.map(row => row.project.id), ["ready"]);
});

test("fixed preferences are constraints while preferred area remains a documented tradeoff", () => {
  const data = catalog([{ id: "yas", price: 1_950_000, cash: 350_000 }, { id: "reem", price: 1_950_000, cash: 100_000, project: { area: "Al Reem Island" } }]);
  const state = buyer({ preferredAreas: ["Yas Island"], areaFlexibility: "preferred", priorities: ["lower_initial_cash"] });
  const soft = buildAdvisorOpportunities(data, state, options);
  assert.equal(soft.primary.projectId, "yas");
  assert.equal(soft.challenger.projectId, "reem");
  assert.ok(soft.challenger.tradeoffs.some(row => row.code === "outside_preferred_area"));
  const fixed = buildAdvisorOpportunities(data, { ...state, areaFlexibility: "fixed" }, options);
  assert.equal(fixed.challenger, null);
  assert.ok(fixed.assessments.find(row => row.candidate.project.id === "reem").hardConstraintFailures.includes("fixed_area"));
});

test("required bedrooms block an otherwise tempting larger upgrade", () => {
  const data = catalog([{ id: "a", price: 1_850_000 }, { id: "b", price: 1_950_000, unit: { bedrooms: 2, sizeSqftFrom: 1100, sizeSqftTo: 1200 } }]);
  const result = buildAdvisorOpportunities(data, buyer({ bedroomsRequired: true, priorities: ["more_space"] }), options);
  assert.equal(result.challenger, null);
  assert.ok(result.assessments.find(row => row.candidate.project.id === "b").hardConstraintFailures.includes("required_bedrooms"));
});

test("cash ceiling and financing cannot reenter through legacy financial compromises", () => {
  const data = catalog([{ id: "highcash", price: 1_800_000, cash: 350_000 }, { id: "no_plan", price: 1_900_000, project: { paymentPlanAvailable: false, paymentPlanSummary: null } }]);
  const state = buyer({ preferredAreas: ["Yas Island"], cashAvailableAed: 150_000, financing: "payment_plan" });
  assert.equal(resolveMatches(data, state).matchCount, 0);
  assert.equal(buildAdvisorOpportunities(data, state, options).primary, null);
});

test("matching recognizes all acceptable areas and types rather than only the first", () => {
  const data = catalog([{ id: "a", price: 1_900_000, project: { area: "Al Reem Island" }, unit: { propertyType: "townhouse" } }]);
  const row = { project: data.projects[0], unit: data.units[0], downPaymentAed: 100_000 };
  const fit = assessCandidate(row, buyer({ preferredAreas: ["Yas Island", "Al Reem Island"], propertyTypes: ["apartment", "townhouse"] })).fit;
  assert.equal(fit.components.areaFit.status, "MATCH");
  assert.equal(fit.components.typeFit.status, "MATCH");
});

test("rejection evidence persists across check-date refresh and unrelated commercial change", () => {
  const data = catalog([{ id: "a", price: 1_950_000, cash: 350_000 }]);
  const candidate = buildAdvisorOpportunities(data, buyer(), options).matches[0];
  const state = buyer({ rejectedProjects: ["a"], activeRecommendationProjectId: "a", activeRecommendationUnitId: "unit_a", rejectionReasons: { a: { categories: ["initial_payment_too_high"], unitId: "unit_a", evidenceState: commercialEvidenceState(candidate), factFingerprint: commercialEvidenceFingerprint(candidate), resolved: false } }, objections: [{ category: "initial_payment_too_high", projectId: "a", unitId: "unit_a" }] });
  data.projects[0].lastVerified = new Date(NOW).toISOString();
  data.units[0].startingPriceAed = 1_900_000;
  assert.equal(buildAdvisorOpportunities(data, state, options).primary, null);
  data.units[0].initialPaymentAed = 100_000;
  assert.equal(buildAdvisorOpportunities(data, state, options).primary.projectId, "a");
});

test("bad payment-plan objection changes documented structure rather than repeating shortlist", () => {
  const data = catalog([{ id: "a", price: 1_900_000 }, { id: "same", price: 1_850_000 }, { id: "different", price: 1_950_000, project: { paymentPlanSummary: "40/60" } }]);
  const result = buildAdvisorOpportunities(data, buyer({ rejectedProjects: ["a"], activeRecommendationProjectId: "a", activeRecommendationUnitId: "unit_a", objections: [{ category: "payment_plan_bad", projectId: "a", unitId: "unit_a" }] }), options);
  assert.equal(result.primary.projectId, "different");
  assert.ok(result.primary.reasonCodes.includes("different_documented_payment_structure"));
  assert.equal(result.investmentTheses[0].paymentCase.constructionCashAed, null);
});

test("price alone supplies no upgrade benefit; cheaper supported option wins with an opinion", () => {
  const result = buildAdvisorOpportunities(catalog([{ id: "a", price: 1_800_000 }, { id: "b", price: 2_000_000 }]), buyer(), options);
  assert.equal(result.primary.projectId, "a");
  assert.equal(result.challenger, null);
  assert.equal(result.upgradeAssessment.opportunities[0].priceDifferenceAed, 200_000);
  assert.equal(result.upgradeAssessment.opportunities[0].opinion, "would_not_pay_extra");
  assert.equal(result.comparison.upgradeAssessment.worthPaying, false);
  assert.equal(result.comparison.buyerPreference.opinion, "prefer_lower_cost_option");
});

test("at most one reasoned challenger and claim traces remain sourced to record scope and date", () => {
  const result = buildAdvisorOpportunities(catalog([{ id: "a", price: 1_850_000, cash: 350_000 }, { id: "b", price: 1_900_000, cash: 100_000 }, { id: "c", price: 1_950_000, cash: 120_000 }]), buyer({ preferredAreas: ["Yas Island"], priorities: ["lower_initial_cash"] }), options);
  assert.ok(result.matches.length <= 2);
  for (const opportunity of result.opportunities) for (const claim of opportunity.supportedFacts) {
    assert.ok(claim.source);
    assert.ok(claim.sourceRecordId);
    assert.ok(claim.scope);
    assert.ok(Number.isFinite(Date.parse(claim.lastVerified || claim.verifiedOn)));
  }
});

test("handover strategy compares documented transaction depth without claiming future liquidity", () => {
  const marketSnapshots = [5, 25].map((transactions12m, index) => ({ id: `market_${index}`, sourceRecordId: `market_${index}`, projectId: index ? "b" : "a", usable: true, source: "Synthetic executed secondary transaction records", verifiedOn: checked, latestTransactionDate: "2026-10-01", confidence: "high",
    area: "Yas Island", propertyType: "Apartment", bedrooms: 1, saleType: "Secondary", metric: "registered_transaction_count_12m", reportingPeriod: "12M",
    scope: { projectId: index ? "b" : "a", area: "Yas Island", propertyType: "Apartment", bedrooms: 1, saleType: "Secondary", metric: "registered_transaction_count_12m" }, transactions12m }));
  const data = catalog([{ id: "a", price: 1_850_000 }, { id: "b", price: 1_900_000 }], { marketSnapshots });
  const result = buildAdvisorOpportunities(data, buyer({ exitHorizon: "handover", handoverStrategy: "sell" }), options);
  assert.equal(result.primary.projectId, "b");
  assert.ok(result.primary.reasonCodes.includes("documented_transaction_depth_for_strategy"));
  assert.equal(result.rationale.liquidityFit.status, "SUPPORTED");
  assert.equal(result.rationale.liquidityFit.conclusion, "UNKNOWN");
  assert.deepEqual(result.investmentTheses[0].forecasts, []);
  assert.ok(result.rationale.liquidityFit.evidence[0].sourceRecordId);
});
