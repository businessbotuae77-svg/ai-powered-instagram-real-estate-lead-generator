import assert from "node:assert/strict";
import test from "node:test";
import { buildProjectRelations, relationsBetween, crossSellCandidateIds, RESEARCH_RELATIONSHIPS } from "../src/conversation/project-relations.js";
import { compareProperties, compareTransactionDepth } from "../src/conversation/comparison.js";
import { buildBuyerBudgetComparisons, sourcedCandidatePrice } from "../src/conversation/comparison-evidence.js";
import { buildAdvisorOpportunities } from "../src/conversation/advisor-opportunities.js";
import { buildFactPack } from "../src/facts/retrieval.js";
import { normalizePriceHistory } from "../src/facts/intelligence.js";

const NOW = Date.parse("2026-10-06T12:00:00Z");
const VERIFIED = "2026-10-06T08:00:00Z";
const SOURCE = "https://synthetic.example.test/developer";
function candidate(id, { price = 2_000_000, bedrooms = 1, area = "Hudayriyat Island", size = 800, ...overrides } = {}) {
  const project = { id, name: `Synthetic ${id}`, active: true, approved: true, source: SOURCE, lastVerified: VERIFIED,
    emirate: "Abu Dhabi", area, developerName: "Synthetic Developer", status: "Off-plan", handover: "Q1 2028",
    paymentPlanAvailable: true, paymentPlanSummary: "10% booking, 50% construction, 40% handover" };
  const unit = { id: `unit-${id}`, projectId: id, active: true, propertyType: "apartment", bedrooms,
    startingPriceAed: price, initialPaymentAed: price * 0.1, sizeSqftFrom: size, sizeSqftTo: size, availability: "Unknown", ...overrides };
  return { project, unit, factPack: buildFactPack({ project, unit, downPaymentAed: unit.initialPaymentAed }, { now: NOW }) };
}
function relation(from, to, relationship, overrides = {}) {
  return { id: `rel-${relationship}`, from, to, relationship, usable: true, source: SOURCE,
    sourceRecordId: `rel-${relationship}`, verifiedOn: VERIFIED, confidence: "High", reason: "Documented positioning",
    scope: { from, to }, evidenceClass: "FACT", ...overrides };
}
function currentPrice(id, overrides = {}) {
  return normalizePriceHistory({ id, fields: { Project: ["npv"], "Observation date": "2026-10-05", "Checked on": "2026-10-06",
    "Price type": "Developer current", "Price AED": 2_000_000, "Property type": "Apartment", Bedrooms: 1,
    "Price scope": "1BR starting price", Verified: true, Confidence: "Official", "Source URL": SOURCE, ...overrides } }, { now: NOW });
}
function evidence(id, value, overrides = {}) {
  return { sourceRecordId: id, projectId: "b", field: "evidenceFact", value, source: SOURCE,
    verifiedOn: VERIFIED, scope: { projectId: "b" }, confidence: "High", evidenceClass: "FACT", ...overrides };
}

test("all documented relationship types become candidates with source records; phase direction is preserved", () => {
  const a = candidate("a"), b = candidate("b", { area: "Different island" });
  const graph = buildProjectRelations([a.project, b.project], { now: NOW, intelligence: {
    projectRelations: [...RESEARCH_RELATIONSHIPS].map(type => relation("a", "b", type)) } });
  for (const type of RESEARCH_RELATIONSHIPS) {
    const edge = relationsBetween(graph, "a", "b").find(row => row.relationship === type);
    assert.ok(edge, type);
    assert.equal(edge.evidence[0].sourceRecordId, `rel-${type}`);
    assert.equal(edge.evidence[0].evidenceClass, "FACT");
  }
  assert.ok(relationsBetween(graph, "b", "a").some(row => row.relationship === "later_phase"));
  assert.ok(crossSellCandidateIds(graph, "a").has("b"));
  assert.ok(graph.edges.every(row => !Object.hasOwn(row, "winner") && !Object.hasOwn(row, "score")));
});

test("same area creates no nearby/competitor claim and geographic claims reject weak or unsourced records", () => {
  const a = candidate("a"), b = candidate("b");
  const graph = buildProjectRelations([a.project, b.project], { now: NOW, intelligence: { projectRelations: [
    relation("a", "b", "nearby", { source: null }), relation("a", "b", "direct_competitor", { confidence: "Low" }),
    relation("a", "b", "direct_competitor", { usable: false })
  ] } });
  assert.ok(graph.edges.some(row => row.relationship === "same_area"));
  assert.ok(!graph.edges.some(row => ["nearby", "direct_competitor"].includes(row.relationship)));
  const explicit = buildProjectRelations([a.project, b.project], { now: NOW, intelligence: {
    projectRelations: [relation("a", "b", "direct_competitor")] } });
  assert.equal(relationsBetween(explicit, "a", "b").find(row => row.relationship === "direct_competitor").evidence[0].sourceRecordId, "rel-direct_competitor");
});

test("project launch price cannot support a bedroom entry price, upsell delta or current budget set", () => {
  const a = candidate("npv"), b = candidate("b", { price: 2_200_000 });
  a.factPack.startingPriceAed.scope = { projectId: "npv", priceBasis: "project_launch_starting_price" };
  assert.equal(sourcedCandidatePrice(a, { now: NOW }), null);
  const comparison = compareProperties(a, b, { priorities: ["more_space"] }, { now: NOW });
  assert.equal(comparison.upgradeAssessment, null);
  assert.equal(comparison.unknowns.find(row => row.dimension === "price").a, "UNKNOWN");
  assert.ok(!buildBuyerBudgetComparisons([a], { now: NOW }).some(band => band.candidates.length));
});

test("current sourced research budget sets work without commercial units and retain research scope", () => {
  const project = candidate("npv").project;
  const intelligence = { priceHistory: [currentPrice("current-1br"), currentPrice("launch", {
    "Price type": "Launch starting price", "Observation date": "2024-12-10", Bedrooms: undefined,
    "Property type": undefined, "Price scope": "Project prices starting from AED 2M" })] };
  const sets = buildBuyerBudgetComparisons([], { now: NOW, intelligence, projects: [project], buyer: { bedrooms: [1], propertyTypes: ["apartment"] } });
  const rows = sets.flatMap(band => band.candidates);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].priceAed, 2_000_000);
  assert.equal(rows[0].priceScope, "unit_type");
  assert.equal(rows[0].researchOnly, true);
  assert.equal(rows[0].availability, "UNKNOWN");
  assert.equal(rows[0].evidence[0].sourceRecordId, "current-1br");
  assert.equal(rows[0].evidence[0].confidence, "High");
  const projectOnly = { priceHistory: [currentPrice("project-current", { Bedrooms: undefined, "Property type": undefined })] };
  assert.equal(buildBuyerBudgetComparisons([], { now: NOW, intelligence: projectOnly, projects: [project], buyer: { bedrooms: [1] } }).flatMap(band => band.candidates).length, 0);
  assert.equal(buildBuyerBudgetComparisons([], { now: NOW, intelligence: projectOnly, projects: [project] }).flatMap(band => band.candidates)[0].priceScope, "project");
});

test("budget sets apply freshness, confidence, graph and buyer constraints and update from current observations", () => {
  const project = candidate("npv").project;
  const rows = [currentPrice("old", { "Observation date": "2026-07-01" }), currentPrice("indicative", { Confidence: "Indicative" }),
    currentPrice("previous", { "Price AED": 1_900_000, "Observation date": "2026-10-03" }), currentPrice("latest")];
  const options = { now: NOW, projects: [project], intelligence: { priceHistory: rows }, buyer: { bedrooms: [1] } };
  assert.equal(buildBuyerBudgetComparisons([], options).flatMap(band => band.candidates).length, 1);
  assert.equal(buildBuyerBudgetComparisons([], options).flatMap(band => band.candidates)[0].evidence[0].sourceRecordId, "latest");
  assert.equal(buildBuyerBudgetComparisons([], { ...options, candidateProjectIds: new Set(["elsewhere"]) }).flatMap(band => band.candidates).length, 0);
  assert.equal(buildBuyerBudgetComparisons([], { ...options, buyer: { budgetAed: 1_900_000, budgetHardCap: true } }).flatMap(band => band.candidates).length, 0);
  assert.equal(buildBuyerBudgetComparisons([], { ...options, buyer: { preferredAreas: ["Yas Island"], areaFlexibility: "fixed" } }).flatMap(band => band.candidates).length, 0);
});

test("additional positive facts enrich the comparison without declaring a winner or enabling a forecast", () => {
  const a = candidate("a"), b = candidate("b", { price: 2_200_000 });
  b.investmentThesis = { projectId: "b", areaCase: { evidence: Array.from({ length: 12 }, (_, index) => evidence(`catalyst-${index}`, `Documented catalyst ${index}`)) },
    projectCase: { evidence: [evidence("forecast", "Guaranteed growth", { evidenceClass: "FORECAST" })] } };
  const compared = compareProperties(a, b, { useType: "investment" }, { now: NOW });
  assert.equal(compared.buyerPreference.projectId, "a");
  assert.equal(compared.upgradeAssessment.worthPaying, false);
  assert.deepEqual(compared.upgradeAssessment.supportedBenefits, []);
  const area = compared.researchDimensions.find(row => row.dimension === "area_maturity_catalysts");
  assert.equal(area.bEvidence.length, 12);
  assert.equal(area.preferred, null);
  assert.ok(compared.researchDimensions.every(row => row.evidence.every(source => source.evidenceClass !== "FORECAST")));
});

test("AED 200k more requires a sourced material benefit that fits buyer constraints", () => {
  const a = candidate("a"), b = candidate("b", { price: 2_200_000, bedrooms: 2, size: 1_150 });
  const compared = compareProperties(a, b, { priorities: ["more_space"] }, { now: NOW });
  assert.equal(compared.upgradeAssessment.extraCostAed, 200_000);
  assert.equal(compared.upgradeAssessment.worthPaying, true);
  assert.ok(compared.upgradeAssessment.supportedBenefits.some(row => row.code === "additional_bedroom" && row.evidence.every(e => e.source && e.sourceRecordId && e.scope && e.verifiedOn)));
  const capped = compareProperties(a, b, { budgetAed: 2_000_000, budgetHardCap: true, priorities: ["more_space"] }, { now: NOW });
  assert.equal(capped.upgradeAssessment.worthPaying, false);
});

test("documented resale depth requires secondary sample, matching scope and adequate samples", () => {
  const withTransactions = (row, count, saleType = "Secondary", metric = "registered_transaction_count_12m") => {
    const source = evidence(`transactions-${row.project.id}`, count, { projectId: row.project.id });
    row.investmentThesis = { projectId: row.project.id, liquidityCase: { evidence: [source], transactionSamples: [{
      sourceRecordId: source.sourceRecordId, transactions12m: count, latestTransactionDate: "2026-10-01", scope: { projectId: row.project.id },
      area: row.project.area, propertyType: "Apartment", bedrooms: 1, saleType, metric, reportingPeriod: "12M" }] } };
    return row;
  };
  const a = withTransactions(candidate("a"), 5), b = withTransactions(candidate("b"), 25);
  assert.equal(compareTransactionDepth(a, b, { now: NOW }).delta, 20);
  assert.ok(compareProperties(a, b, { useType: "investment" }, { now: NOW }).bAdvantages.some(row => row.code === "better_documented_transaction_depth"));
  for (const [count, saleType, metric] of [[2, "Secondary", "registered_transaction_count_12m"], [25, "Primary", "registered_transaction_count_12m"], [25, "Secondary", "asking_count"]]) {
    assert.equal(compareTransactionDepth(a, withTransactions(candidate("b"), count, saleType, metric), { now: NOW }), null);
  }
});

test("advisor applies the graph before cross-selling and does not select an unrelated higher-priced option", () => {
  const a = candidate("a", { price: 1_900_000 }), b = candidate("b", { price: 2_200_000, bedrooms: 2, area: "Yas Island", size: 1_100 });
  const catalog = { projects: [a.project, b.project], units: [a.unit, b.unit] };
  const buyer = { budgetAed: 2_300_000, budgetHardCap: true, useType: "end_use", preferredAreas: ["Hudayriyat Island"], areaFlexibility: "preferred",
    bedrooms: [1], propertyTypes: ["apartment"], priorities: ["more_space"] };
  const unrelated = buildAdvisorOpportunities(catalog, buyer, { now: NOW });
  assert.equal(unrelated.challenger, null);
  catalog.intelligence = { projectRelations: [relation("a", "b", "similar_product")] };
  const related = buildAdvisorOpportunities(catalog, buyer, { now: NOW });
  assert.equal(related.challenger.projectId, "b");
  assert.ok(related.challenger.buyerBenefit.some(row => row.code === "additional_bedroom"));
  assert.equal(buildAdvisorOpportunities(catalog, { ...buyer, areaFlexibility: "fixed" }, { now: NOW }).challenger, null);
});
