import test from "node:test";
import assert from "node:assert/strict";
import { researchReply } from "../src/conversation/research-reply.js";
import { knowledgeAdvice } from "../src/conversation/knowledge-advice.js";
import { emptyIntelligence, normalizeInvestmentEvidence, normalizePriceHistory } from "../src/facts/intelligence.js";

const NOW = Date.parse("2026-10-06T12:00:00Z");
const SOURCE = "https://developer.example.test/research";
const project = { id: "project-a", name: "Synthetic Park Views", sheetProjectId: "AD-004", area: "Hudayriyat Island", emirate: "Abu Dhabi", source: SOURCE, lastVerified: "2026-10-06", active: true, developerActive: true, developerName: "Synthetic Developer", status: "Off-plan" };
const buyer = { projectInterest: project.name, bedrooms: [1], propertyTypes: ["apartment"], language: "en", budgetAed: 2_000_000 };
function evidence(id, dimension, value, overrides = {}) {
  return normalizeInvestmentEvidence({ id, fields: { Project: [project.id], "Evidence ID": id, Dimension: dimension,
    "Evidence fact": value, "Evidence class": "FACT", Scope: "Project-level documented research", "Source URL": SOURCE,
    "Checked date": "2026-10-06", Confidence: "Official", ...overrides } }, { now: NOW });
}
function catalog(extra = {}) {
  return { projects: [project], units: [], intelligence: { ...emptyIntelligence(), investmentEvidence: [
    evidence("entry", "ENTRY", "The documented current 1BR starting observation is AED 2M."),
    evidence("catalyst", "AREA_CATALYST", "The official announcement records a planned cultural destination."),
    evidence("risk", "RISK", "Construction instalment timing is not documented."),
    evidence("resale", "RESALE_LIQUIDITY", "The documented secondary observation sample contains two transactions."),
    evidence("payment", "PAYMENT", "The researched plan records 10% booking, 50% construction and 40% handover."),
    ...extra.investmentEvidence || [] ], ...extra } };
}

test("research answers cite exact FACT observations without commercial units", () => {
  const reply = researchReply({ buyer, catalog: catalog(), message: "What supports the appreciation case?", now: NOW });
  assert.equal(reply.stage, "research_answer");
  assert.match(reply.text, /FACT: The official announcement records a planned cultural destination/);
  assert.match(reply.text, /Future appreciation remains UNKNOWN/);
  assert.match(reply.text, /record catalyst; checked 2026-10-06; confidence High; scope documented project research/);
  assert.equal(reply.commercialQuote, false);
  assert.equal(reply.pendingOffer, null);
  assert.ok(reply.factPacks.every(pack => pack.knowledgeOnly && !pack.startingPriceAed.confirmed && !pack.availability.confirmed));
  assert.ok(reply.researchClaims.every(row => row.source && row.sourceRecordId && row.verifiedOn && row.scope && row.confidence && row.evidenceClass === "FACT"));
  assert.equal(reply.researchClaims.find(row => row.sourceRecordId === "catalyst").scope, "Project-level documented research");
});

test("FORECAST/SCENARIO and forecast-like words mislabelled FACT are never promoted", () => {
  const extra = [
    evidence("forecast", "AREA_CATALYST", "Annual capital appreciation reaches 25%.", { "Evidence class": "FORECAST" }),
    evidence("scenario", "ENTRY", "Scenario value AED 5M.", { "Evidence class": "SCENARIO" }),
    evidence("badfact", "AREA_CATALYST", "This catalyst will deliver capital growth."),
    evidence("badresale", "RESALE_LIQUIDITY", "The property is easy to resell.")
  ];
  const reply = researchReply({ buyer, catalog: catalog({ investmentEvidence: extra }), message: "What supports the appreciation case and resale liquidity?", now: NOW });
  assert.doesNotMatch(reply.text, /25%|AED 5M|will deliver|easy to resell/);
  assert.ok(reply.researchClaims.every(row => !["forecast", "scenario", "badfact", "badresale"].includes(row.sourceRecordId)));
});

test("project launch scope and thin resale samples keep movement and ease UNKNOWN", () => {
  const observations = [{ id: "launch", fields: { Project: [project.id], "Observation date": "2024-12-10", "Price AED": 2_000_000, "Price type": "Developer launch starting price", "Price basis": "Developer starting price", "Source URL": SOURCE, Verified: true, Confidence: "Official" } },
    { id: "current", fields: { Project: [project.id], "Observation date": "2026-10-06", "Price AED": 2_000_000, "Price type": "Developer starting price", "Price basis": "Developer starting price", Bedrooms: 1, "Property type": "apartment", "Size sqft": 800, "Source URL": SOURCE, Verified: true, Confidence: "Official" } }].map(row => normalizePriceHistory(row, { now: NOW }));
  const launchReply = researchReply({ buyer, catalog: catalog({ priceHistory: observations }), message: "What changed from the previous release?", now: NOW });
  assert.match(launchReply.text, /Comparable historical price movement is UNKNOWN/);
  assert.doesNotMatch(launchReply.text, /0%|1BR appreciation/);
  const resaleReply = researchReply({ buyer, catalog: catalog(), message: "What evidence supports resale liquidity?", now: NOW });
  assert.match(resaleReply.text, /secondary observation sample contains two transactions/);
  assert.match(resaleReply.text, /Resale liquidity conclusion: UNKNOWN/);
  assert.doesNotMatch(resaleReply.text, /resale is easy|easy to resell/);
});

test("sourced booking example provides booking calculation while all deployment windows stay unknown", () => {
  const history = normalizePriceHistory({ id: "current", fields: { Project: [project.id], "Observation date": "2026-10-06", "Price AED": 2_000_000, "Price type": "Developer starting price", Bedrooms: 1, "Property type": "apartment", "Source URL": SOURCE, Verified: true, Confidence: "Official" } }, { now: NOW });
  const reply = researchReply({ buyer, catalog: catalog({ priceHistory: [history] }), message: "How much cash will I have deployed by handover?", now: NOW });
  assert.match(reply.text, /CALCULATION: research purchase-price example booking cash = AED 200,000/);
  assert.match(reply.text, /Cash within 30 days, within 6 months, within 12 months and by handover: UNKNOWN/);
  assert.equal(reply.investmentTheses[0].paymentCase.scheduleStatus, "UNKNOWN");
  const calculated = reply.researchClaims.find(row => row.field === "bookingAed");
  assert.equal(calculated.evidenceClass, "CALCULATION");
  assert.equal(calculated.inputEvidence.length, 2);
  assert.equal(calculated.commercialQuote, false);
});

test("questions about facts versus calculations explain classes without enabling speculation", () => {
  const reply = researchReply({ buyer, catalog: catalog(), message: "What is fact versus calculation versus speculation?", now: NOW });
  assert.match(reply.text, /FACT records state sourced observations/);
  assert.match(reply.text, /CALCULATION records derive values from cited inputs/);
  assert.match(reply.text, /forecasts and speculation are disabled/);
  assert.doesNotMatch(reply.text, /grade\s*[ABCD]|investment score/i);
});

test("a bedroom-specific research request cannot reuse another unit's cached booking calculation", () => {
  const wrongThesis = { projectId: project.id, unitId: "one-bedroom", researchEvidence: [], evidenceRegistry: [],
    researchBookingExample: { status: "PARTIAL_RESEARCH_EXAMPLE", evidence: [{ field: "bookingAed", value: 200_000,
      source: SOURCE, sourceRecordId: "wrong-unit-booking", verifiedOn: "2026-10-06", scope: "1BR", confidence: "High", evidenceClass: "CALCULATION" }] } };
  const reply = researchReply({ buyer, catalog: catalog(), message: "How much cash deployed for 3BR by handover?", advisor: { investmentTheses: [wrongThesis] }, now: NOW });
  assert.doesNotMatch(reply.text, /wrong-unit-booking|booking cash = AED 200,000/);
  assert.equal(reply.investmentTheses[0].researchBookingExample, null);
});

test("research is routed only for an identified project and preserves commercial comparison routing", () => {
  assert.equal(researchReply({ buyer: {}, catalog: catalog(), message: "What weakens it?", now: NOW }), null);
  assert.equal(researchReply({ buyer, catalog: catalog(), message: "Hello", now: NOW }), null);
  assert.equal(researchReply({ buyer, catalog: catalog(), message: "What does paying AED 200k more buy me?", advisor: { primary: { projectId: project.id } }, now: NOW }), null);
  const reply = researchReply({ buyer, catalog: catalog(), message: "What does paying AED 200k more buy me?", now: NOW });
  assert.match(reply.text, /Paying more requires a documented improvement/);
  assert.match(reply.text, /benefit of spending more remains UNKNOWN/);
});

test("same-area candidates cite the relationship record and do not imply next-door proximity", () => {
  const other = { ...project, id: "project-b", name: "Synthetic Island Apartments" };
  const related = catalog({ projectRelations: [{ id: "relation", from: project.id, to: other.id, relationship: "same_area", source: SOURCE,
    sourceRecordId: "relation", verifiedOn: "2026-10-06", confidence: "High", usable: true }] });
  related.projects.push(other);
  const reply = researchReply({ buyer, catalog: related, message: "Why this rather than the project next door?", now: NOW });
  assert.match(reply.text, /Comparison candidate: Synthetic Island Apartments; documented relationship: same area/);
  assert.match(reply.text, /record relation; checked 2026-10-06; confidence High/);
  assert.doesNotMatch(reply.text, /documented relationship: nearby|direct competitor/);
  assert.equal(reply.researchClaims.find(row => row.field === "relationship").sourceRecordId, "relation");
});

test("knowledge-only selection remains an identity pack rather than a price quote", () => {
  const reply = knowledgeAdvice({ buyer, catalog: catalog(), message: project.name });
  assert.equal(reply.stage, "knowledge_answer");
  assert.equal(reply.factPacks[0].startingPriceAed.confirmed, false);
  assert.equal(reply.factPacks[0].availability.confirmed, false);
  assert.equal(knowledgeAdvice({ buyer: { activeRecommendationProjectId: project.id, preferredAreas: ["Masdar City"] }, catalog: catalog(), message: "What about Masdar?" }), null);
  assert.equal(knowledgeAdvice({ buyer: { activeRecommendationProjectId: project.id }, catalog: catalog(), message: "I only have 50k cash available and need a payment plan" }), null);
});
