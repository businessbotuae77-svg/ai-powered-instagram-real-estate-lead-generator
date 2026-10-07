import assert from "node:assert/strict";
import test from "node:test";
import { advisoryReady, determineAdvisorStrategy } from "../src/conversation/advisor-strategy.js";
import { buildAdvisorOpportunities } from "../src/conversation/advisor-opportunities.js";
import { advisorLedDiscoveryGuidance, exitQuestion, investmentGuidance } from "../src/conversation/investment-guidance.js";
import { buildInvestmentStrategy, DEFAULT_INVESTMENT_ANALYSIS } from "../src/conversation/investment-strategy.js";
import { canPitchBuyer, resolveMatches } from "../src/conversation/match-resolve.js";
import { isCoreQualified, nextQualificationQuestion, qualificationGaps } from "../src/conversation/qualify.js";

const NOW = Date.UTC(2026, 9, 6, 12);
const checked = new Date(NOW - 60_000).toISOString();
const options = { now: NOW };
const buyer = patch => ({ budgetAed: 3_000_000, useType: "investment", investmentStrategy: "UNDECIDED",
  investmentPreferenceState: "flexible", advisorLed: true, preferredAreas: [], bedrooms: [], propertyTypes: [],
  preferenceStates: { investmentObjective: "flexible" }, objections: [], priorities: [], ...patch });

// Synthetic test inventory is deliberately isolated from Airtable and live offers.
function catalog(rows, intelligence = {}) {
  return {
    developers: [{ id: "dev", active: true }],
    projects: rows.map(row => ({ id: row.id, name: `Discovery Fixture ${row.id}`, developerId: "dev",
      developerName: "Fixture Developer", developerActive: true, active: true, approved: true,
      source: "Synthetic commercial evidence", lastVerified: checked, emirate: "Abu Dhabi", area: "Yas Island",
      status: "Off-plan", handover: "Q4 2028", paymentPlanAvailable: true, paymentPlanSummary: "80/20",
      ...row.project })),
    units: rows.map(row => ({ id: `unit_${row.id}`, projectId: row.id, active: true, propertyType: "apartment",
      bedrooms: row.bedrooms ?? 1, startingPriceAed: row.price, initialPaymentAed: row.cash ?? 200_000,
      availability: "Available", sizeSqftFrom: 750, sizeSqftTo: 820, planId: `plan_${row.id}`, ...row.unit })),
    intelligence
  };
}

test("delegated investment and AED 3M qualify without area, bedrooms, objective, risk or exit", () => {
  const open = buyer();
  assert.equal(advisoryReady(open), true);
  assert.equal(canPitchBuyer(open), true);
  assert.equal(isCoreQualified(open), true);
  assert.deepEqual(qualificationGaps(open), []);
  assert.equal(nextQualificationQuestion(open), null);
  assert.equal(open.budgetAed, 3_000_000);
});

test("specific cash and exit-liquidity choices also unlock discovery without a forced interview", () => {
  for (const preference of [{ cashDeploymentPreference: "lower_initial" }, { liquidityPriority: "high" }]) {
    const selected = buyer({ advisorLed: false, investmentPreferenceState: null, preferenceStates: {}, ...preference });
    assert.equal(advisoryReady(selected), true);
    assert.equal(canPitchBuyer(selected), true);
    assert.deepEqual(qualificationGaps(selected), []);
  }
});

test("flexibility does not replace an unknown budget with a fabricated ceiling", () => {
  const open = buyer({ budgetAed: null, preferenceStates: { budgetAed: "flexible", investmentObjective: "flexible",
    preferredAreas: "flexible", bedrooms: "flexible" } });
  assert.equal(isCoreQualified(open), false);
  assert.equal(canPitchBuyer(open), false);
  assert.equal(advisoryReady(open), false);
  assert.equal(buildAdvisorOpportunities(catalog([{ id: "a", price: 2_000_000 }]), open, options).primary, null);
  assert.equal(qualificationGaps(open).includes("budgetAed"), false);
});

test("uncertain area and bedroom preferences remain usable answers", () => {
  const open = buyer({ advisorLed: false, investmentPreferenceState: null,
    preferenceStates: { preferredAreas: "flexible", bedrooms: "flexible" } });
  assert.deepEqual(qualificationGaps(open), []);
  assert.equal(nextQualificationQuestion(open), null);
});

test("optional cash and financing questions cannot repeat flexible slots", () => {
  const open = buyer({ financing: "unknown", preferenceStates: {
    investmentObjective: "flexible", cashAvailableAed: "flexible", financing: "flexible" } });
  assert.deepEqual(qualificationGaps(open, { includeCash: true, includeFinancing: true }), []);
  assert.equal(nextQualificationQuestion(open, { includeCash: true, includeFinancing: true }), null);
});

test("UNDECIDED keeps existing dimensions and uses all twelve evidence checks without exit interview", () => {
  const strategy = buildInvestmentStrategy(buyer());
  assert.equal(strategy.strategy, "UNDECIDED");
  assert.equal(strategy.advisorLedDiscovery, true);
  assert.deepEqual(strategy.priorities, ["entry_price", "project_stage", "area_maturation", "cash_deployed", "future_supply", "resale_competition"]);
  assert.deepEqual(strategy.analysisDimensions, DEFAULT_INVESTMENT_ANALYSIS);
  assert.equal(strategy.analysisDimensions.length, 12);
  assert.equal(strategy.nextQuestionField, null);
  assert.equal(strategy.forecastAllowed, false);
  assert.equal(exitQuestion(buyer()), null);
});

test("an exit uncertainty stops the same conceptual question even outside delegated discovery", () => {
  const undecidedExit = buyer({ advisorLed: false, investmentPreferenceState: null,
    preferenceStates: { exitHorizon: "flexible" } });
  assert.equal(exitQuestion(undecidedExit), null);
  assert.equal(buildInvestmentStrategy(undecidedExit).nextQuestionField, null);
});

test("discovery provides primary and a genuinely different lower-cash challenger across open products", () => {
  const data = catalog([{ id: "entry", price: 2_000_000, cash: 400_000 },
    { id: "cash", price: 2_700_000, cash: 100_000, bedrooms: 2, project: { area: "Al Reem Island" } }]);
  const result = buildAdvisorOpportunities(data, buyer(), options);
  assert.equal(result.primary.projectId, "entry");
  assert.equal(result.primary.role, "PRIMARY");
  assert.equal(result.challenger.projectId, "cash");
  assert.equal(result.challenger.role, "CHALLENGER");
  assert.ok(result.challenger.buyerBenefit.some(row => row.code === "lower_initial_commitment"));
  assert.equal(result.challenger.priceDifferenceAed, 700_000);
  assert.equal(result.primary.selectionBasis.method, "documented_non_dominated_tradeoffs");
  assert.ok(result.comparison.upgradeAssessment.supportedBenefits.some(row => row.code === "lower_initial_commitment"));
  assert.equal(result.comparison.upgradeAssessment.worthPaying, null);
  assert.equal(result.comparison.buyerPreference, null);
  assert.ok(resolveMatches(data, buyer()).matchCount > 0);
});

test("comparison dimensions carry source scope and leave unsupported outcomes unknown", () => {
  const result = buildAdvisorOpportunities(catalog([{ id: "a", price: 2_000_000 }]), buyer(), options);
  const analysis = result.discoveryAnalysis.candidates[0];
  assert.deepEqual(analysis.comparison.map(row => row.dimension), DEFAULT_INVESTMENT_ANALYSIS);
  assert.equal(analysis.role, "PRIMARY");
  const dimension = name => analysis.comparison.find(row => row.dimension === name);
  assert.equal(dimension("entry_position").currentEntryPriceAed, 2_000_000);
  assert.equal(dimension("project_release_stage").releaseStage, null);
  assert.equal(dimension("product_differentiation").qualityConclusion, "UNKNOWN");
  assert.equal(dimension("competing_exit_supply").exitTimingConclusion, "UNKNOWN");
  assert.equal(dimension("transaction_resale_evidence").futureResaleConclusion, "UNKNOWN");
  assert.equal(dimension("rental_fallback").netRentalIncomeAed, null);
  assert.equal(dimension("factual_risks").absenceOfEvidenceDoesNotEstablishLowRisk, true);
  for (const row of analysis.comparison) for (const evidence of row.evidence) {
    assert.ok(evidence.source);
    assert.ok(evidence.sourceRecordId);
    assert.ok(evidence.scope);
    assert.ok(Number.isFinite(Date.parse(evidence.verifiedOn)));
  }
  const thesis = result.investmentTheses[0];
  assert.deepEqual(thesis.forecasts, []);
  assert.equal(thesis.forecastAllowed, false);
  assert.equal(result.discoveryAnalysis.forecastAllowed, false);
  assert.equal(result.primary.reasonCodes.includes("lower_initial_commitment_priority"), false);
});

test("complete payment schedule supports cash deployment while a plan split alone cannot", () => {
  const schedule = { id: "schedule_a", projectId: "a", planId: "plan_a", approved: true,
    botEnabled: true, usable: true, source: "Synthetic signed schedule", checkedOn: checked, scope: "payment_plan_version",
    milestones: [{ id: "booking", kind: "booking", percent: 10, daysFromBooking: 0 },
      { id: "construction", kind: "construction", percent: 70, monthsFromBooking: 12 },
      { id: "handover", kind: "handover", percent: 20, monthsFromBooking: 24 }] };
  const complete = buildAdvisorOpportunities(catalog([{ id: "a", price: 2_000_000 }], { paymentSchedules: [schedule] }), buyer(), options);
  const incomplete = buildAdvisorOpportunities(catalog([{ id: "a", price: 2_000_000 }]), buyer(), options);
  const cash = result => result.discoveryAnalysis.candidates[0].comparison.find(row => row.dimension === "cash_deployment");
  assert.equal(cash(complete).status, "SUPPORTED");
  assert.equal(cash(complete).cashBeforeHandoverAed, 1_600_000);
  assert.equal(cash(complete).cashAtHandoverAed, 400_000);
  assert.equal(cash(incomplete).status, "PARTIAL");
  assert.equal(cash(incomplete).cashBeforeHandoverAed, null);
  assert.equal(cash(incomplete).cashAtHandoverAed, null);
});

test("advisor-led discovery never activates unapproved, disabled or research-only offers", () => {
  for (const patch of [{ approval: "Pending" }, { botEnabled: false }, { researchOnly: true }]) {
    const data = catalog([{ id: "a", price: 2_000_000 }]);
    data.units[0].commercialOffer = { id: "offer_a", sourceRecordId: "offer_a", projectId: "a", unitId: "unit_a",
      price: 1_900_000, priceBasis: "unit_price", commercialSource: "Synthetic commercial sheet", approval: "Approved",
      botEnabled: true, availability: "Available", checkedOn: checked, ...patch };
    const result = buildAdvisorOpportunities(data, buyer(), options);
    assert.equal(result.primary, null, JSON.stringify(patch));
    assert.equal(result.matches.length, 0);
    assert.equal(result.discoveryAnalysis.candidates.length, 0);
  }
});

test("flexible investment preferences retain hard budgets, cash and financing constraints", () => {
  const data = catalog([{ id: "over", price: 3_050_000, cash: 50_000 },
    { id: "cash", price: 2_000_000, cash: 500_000 },
    { id: "no_plan", price: 2_000_000, cash: 50_000, project: { paymentPlanAvailable: false, paymentPlanSummary: null } }]);
  const result = buildAdvisorOpportunities(data, buyer({ cashAvailableAed: 100_000, financing: "payment_plan" }), options);
  assert.equal(result.primary, null);
  assert.equal(result.budgetPolicy.ceilingAed, 3_000_000);
  assert.ok(result.assessments.find(row => row.candidate.project.id === "over").hardConstraintFailures.includes("over_budget_ceiling"));
  assert.ok(result.assessments.find(row => row.candidate.project.id === "cash").hardConstraintFailures.includes("initial_payment_over_cash"));
  assert.ok(result.assessments.find(row => row.candidate.project.id === "no_plan").hardConstraintFailures.includes("payment_plan_unconfirmed"));
});

test("stale commercial facts are excluded from delegated discovery", () => {
  const result = buildAdvisorOpportunities(catalog([{ id: "a", price: 2_000_000,
    project: { lastVerified: "2025-01-01" } }]), buyer(), options);
  assert.equal(result.primary, null);
  assert.deepEqual(result.matches, []);
});

test("insufficient evidence offers value and only one different useful question", () => {
  const result = advisorLedDiscoveryGuidance({ buyer: buyer() });
  assert.equal(result.stage, "advisor_discovery");
  assert.match(result.text, /open.*filter/);
  assert.match(result.text, /AED 3,000,000/);
  assert.match(result.text, /approved, current commercial evidence/);
  assert.equal(result.nextQuestion.field, "cashAvailableAed");
  assert.equal((result.text.match(/\?/g) || []).length, 1);
  assert.doesNotMatch(result.text, /what matters|what.*priority|which area|what size|exit.*holding/i);
  assert.equal(investmentGuidance({ buyer: buyer(), hasCommercialOptions: true }), null);
});

test("no-offer fallback skips cash uncertainty then financing uncertainty without looping", () => {
  const open = buyer({ preferenceStates: { investmentObjective: "flexible", cashAvailableAed: "flexible" } });
  const first = advisorLedDiscoveryGuidance({ buyer: open });
  assert.equal(first.nextQuestion.field, "financing");
  const next = advisorLedDiscoveryGuidance({ buyer: { ...open,
    preferenceStates: { ...open.preferenceStates, financing: "flexible" } } });
  assert.equal(next.nextQuestion, null);
  assert.equal((next.text.match(/\?/g) || []).length, 0);
});

test("a documented over-budget advantage never triggers an automatic budget-increase question", () => {
  const data = catalog([{ id: "a", price: 2_950_000, cash: 400_000 }, { id: "b", price: 3_100_000, cash: 50_000 }]);
  const open = buyer({ budgetHardCap: false, budgetFlexible: false });
  const advisor = buildAdvisorOpportunities(data, open, options);
  assert.equal(advisor.primary.projectId, "a");
  assert.equal(advisor.challenger, null);
  assert.equal(determineAdvisorStrategy({ buyer: open, advisor }).type, "recommend");
  assert.equal(determineAdvisorStrategy({ buyer: open, advisor }).questionField, "advisoryNextAction");
  assert.deepEqual(advisor.matches.map(row => row.project.id), ["a"]);
});
