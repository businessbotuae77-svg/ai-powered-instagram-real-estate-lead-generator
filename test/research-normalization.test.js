import assert from "node:assert/strict";
import test from "node:test";
import { AirtableStore } from "../src/store/airtable-store.js";
import { emptyIntelligence, normalizeAreaIntelligence, normalizeInvestmentEvidence, normalizeMarketSnapshot, normalizePriceHistory, normalizeProjectRelationship } from "../src/facts/intelligence.js";

const NOW = Date.parse("2026-10-06T12:00:00Z");
const SOURCE = "https://adrec.gov.ae/research";
const price = fields => ({ id: "rec-price", fields: {
  Project: ["rec-nawayef"], "Observation date": "2026-10-05", "Price type": "Developer price",
  "Price AED": 2000000, "Source URL": SOURCE, "Source type": "ADREC", Confidence: "Official", Verified: true, ...fields
} });
const snapshot = fields => ({ id: "rec-market", fields: {
  Project: ["rec-nawayef"], "Snapshot date": "2026-10-05", "Source note": SOURCE, Confidence: "High",
  "Transactions 12M": 12, "Asking sample size": 10, "Transaction median AED": 2200000,
  "Asking median AED": 2300000, "Trend 3M %": 3, "Trend 6M %": 4, "Trend 12M %": 5, "Since launch %": 6, ...fields
} });
const endpoint = overrides => ({ projectLabel: "Nawayef Park Views", area: "Hudayriyat Island", propertyType: "apartment",
  bedrooms: 1, saleType: "off-plan", metric: "transaction median AED/sqft", sampleSize: 6, ...overrides });
const basis = overrides => ({ start: endpoint(), end: endpoint(overrides) });
const relation = fields => ({ id: "rec-relation", fields: {
  "Project A": [{ id: "rec-nawayef", name: "Nawayef Park Views" }], "Project B": ["rec-alternative"],
  "Relationship type": "SAME_AREA", Reason: "Both projects are documented on Hudayriyat Island.",
  "Source / evidence": `${SOURCE}\nhttps://developer.example/masterplan`, "Checked on": "2026-10-05", Confidence: "High", ...fields
} });
const investment = fields => ({ id: "rec-evidence", fields: {
  "Evidence ID": "AD-004-ENTRY-01", Project: ["rec-nawayef"], "Project Sheet ID": "AD-004", Dimension: "ENTRY",
  "Evidence fact": "Project launch prices started at AED 2M.", "Evidence class": "FACT", Scope: "Project-level launch starting price, not a bedroom price",
  "Source URL": SOURCE, "Source type": "Official developer", "Published date": "10 Dec 2024", "Checked date": "2026-10-05",
  Confidence: "Official", Caveat: "Bedrooms are not specified in the launch starting price.", Orientation: "Neutral", ...fields
} });

test("verified Official ADREC/developer observations normalize to usable High confidence without altering source metadata", () => {
  for (const sourceType of ["ADREC", "Developer"]) {
    const row = normalizePriceHistory(price({ "Source type": sourceType }), { now: NOW });
    assert.equal(row.usable, true);
    assert.equal(row.confidence, "High");
    assert.equal(row.sourceConfidence, "Official");
    assert.equal(row.evidenceClass, "FACT");
    assert.equal(row.sourceRecordId, "rec-price");
  }
  const secondary = normalizePriceHistory(price({ Confidence: "Strong secondary" }), { now: NOW });
  assert.equal(secondary.confidence, "Medium");
  assert.equal(secondary.usable, true);
});

test("Indicative, Unverified, absent and unfamiliar confidence never become strong historical evidence", () => {
  for (const confidence of ["Indicative", "Unverified", null, "Unclear"]) {
    const row = normalizePriceHistory(price({ Confidence: confidence }), { now: NOW });
    assert.equal(row.usable, false, String(confidence));
    assert.equal(row.sourceConfidence, confidence);
    assert.notEqual(row.confidence, "High");
  }
  assert.equal(normalizePriceHistory(price({ Confidence: "Official", Verified: false }), { now: NOW }).usable, false);
});

test("Nawayef project launch keeps its missing bedroom and size scope when current 1BR price is the same", () => {
  const launch = normalizePriceHistory(price({ "Observation date": "2024-12-10", "Price type": "Original launch price" }), { now: NOW });
  const current = normalizePriceHistory(price({ Bedrooms: 1, "Property type": "apartment", "Size sqft": 800 }), { now: NOW });
  assert.equal(launch.priceAed, current.priceAed);
  assert.equal(launch.bedrooms, null);
  assert.equal(launch.scope.bedrooms, null);
  assert.equal(launch.sizeSqft, null);
  assert.equal(current.bedrooms, 1);
  assert.equal(launch.appreciation, undefined);
});

test("price history preserves sale, release, phase, size and price bases as observed", () => {
  const row = normalizePriceHistory(price({ "Sale type": "Off-plan", Release: "Release 2", Phase: "East",
    "Price basis": "Starting price", "Comparable size basis": "Same published 800 sqft layout" }), { now: NOW });
  for (const [key, expected] of Object.entries({ saleType: "Off-plan", release: "Release 2", phase: "East", priceBasis: "Starting price", comparableSizeBasis: "Same published 800 sqft layout" })) {
    assert.equal(row[key], expected);
    assert.equal(row.scope[key], expected);
  }
});

test("live Price History scope, checked date and stated aggregate samples remain distinct from transaction sale scope", () => {
  const normalized = normalizePriceHistory(price({ "Observation date": "2025-09-26", "Checked date": "2026-10-06",
    "Price type": "Registered transaction", "Price scope": "median of registered transactions", "Size sqft": 1986, Bedrooms: 2,
    "Property type": "Apartment", Notes: "ADREC median of 15 registration(s), primary, off-plan, 2025-Q3." }), { now: NOW });
  assert.equal(normalized.priceBasis, "median of registered transactions");
  assert.equal(normalized.checkedOn, "2026-10-06");
  assert.equal(normalized.verifiedOn, "2026-10-06");
  assert.equal(normalized.observationDate, "2025-09-26");
  assert.equal(normalized.sampleSize, 15);
  assert.equal(normalized.sampleBasis, "documented_registration_count_in_notes");
  assert.equal(normalized.saleType, null, "Sales scope is not inferred from unstructured Notes");
  assert.equal(normalized.usable, true);
  for (const note of ["ADREC median of 1 registration(s)", "ADREC median of 2 registration(s)", "ADREC aggregate; sample unknown"]) {
    const row = normalizePriceHistory(price({ "Price type": "Registered transaction", "Price scope": "median of registered transactions", Notes: note }), { now: NOW });
    assert.equal(row.usable, false);
    assert.ok(row.rejectionReasons.includes("aggregate_sample_insufficient"));
  }
});

test("n=1/n=2 market samples cannot expose medians or trends even with a documented basis", () => {
  for (const sampleSize of [1, 2]) {
    const row = normalizeMarketSnapshot(snapshot({ "Transactions 12M": sampleSize, "Asking sample size": sampleSize, "Comparable basis": JSON.stringify(basis()) }), { now: NOW });
    assert.equal(row.transactionMedianAed, null);
    assert.equal(row.askingMedianAed, null);
    assert.equal(row.trend12m, null);
    assert.equal(row.sampleUsable, false);
  }
});

test("all market trend windows require a meaningful comparable basis with adequate endpoint samples", () => {
  for (const comparable of [null, "", "   ", "ADREC", JSON.stringify(basis({ sampleSize: 2 })), JSON.stringify(basis({ bedrooms: 2 }))]) {
    const row = normalizeMarketSnapshot(snapshot({ "Comparable basis": comparable }), { now: NOW });
    for (const key of ["trend3m", "trend6m", "trend12m", "sinceLaunch"]) assert.equal(row[key], null, `${key}: ${comparable}`);
    assert.equal(row.comparableBasisUsable, false);
  }
  const row = normalizeMarketSnapshot(snapshot({ "Comparable basis": JSON.stringify(basis()) }), { now: NOW });
  assert.equal(row.trend12m, 5);
  assert.equal(row.sinceLaunch, 6);
  assert.equal(row.comparableBasisUsable, true);
  const text = "Same mapped project label; same area; same property type; same bedroom count; same sale type; same metric transaction median AED/sqft. Start n=6; end n=8.";
  assert.equal(normalizeMarketSnapshot(snapshot({ "Comparable basis": text }), { now: NOW }).trend12m, 5);
});

test("developer starting prices and transaction medians never form an appreciation basis", () => {
  const mixed = { start: endpoint({ metric: "developer starting price AED" }), end: endpoint({ metric: "transaction median AED" }) };
  const row = normalizeMarketSnapshot(snapshot({ "Comparable basis": JSON.stringify(mixed) }), { now: NOW });
  assert.equal(row.sinceLaunch, null);
  assert.ok(row.comparableBasisRejectionReasons.includes("incompatible_metric_basis"));
});

test("comparable endpoints cannot borrow another project or bedroom scope for a snapshot trend", () => {
  const other = endpoint({ projectId: 'rec-bashayer', projectLabel: 'Bashayer', bedrooms: 3, propertyType: 'villa', saleType: 'secondary' });
  const row = normalizeMarketSnapshot(snapshot({ Bedrooms: 1, 'Property type': 'apartment', 'Sale type': 'primary off-plan',
    'ADREC project label': 'Nawayef Park Views', 'Comparable basis': JSON.stringify({ start: other, end: other }) }), { now: NOW });
  assert.equal(row.comparableBasisUsable, false);
  for (const key of ['trend3m', 'trend6m', 'trend12m', 'sinceLaunch']) assert.equal(row[key], null);
});

test("investment evidence rejects an explicit scope contradicting its linked Project", () => {
  const row = normalizeInvestmentEvidence(investment({ Scope: JSON.stringify({ projectId: 'rec-bashayer', bedrooms: 1 }) }), { now: NOW });
  assert.equal(row.usable, false);
  assert.ok(row.rejectionReasons.includes('investment_project_scope_mismatch'));
});

test("live Comparable basis can use documented Counts basis with a separate sample gate for every window", () => {
  const comparable = "Same ADREC-mapped project label + area + property type + bedroom + sale type at both endpoints; same quarterly median AED/sqft metric; endpoint sample sizes are documented in Counts basis; exact-duplicate feed rows excluded.";
  const row = normalizeMarketSnapshot(snapshot({ "ADREC project label": "Nawayef Park Views", "Comparable basis": comparable,
    "Counts basis": "Median n=9 (2026-Q3). Trend endpoint n: 3M 126→9; 6M 0→9 (blank); 12M 2→9 (blank)." }), { now: NOW });
  assert.equal(row.mappedProjectLabel, "Nawayef Park Views");
  assert.equal(row.scope.mappedProjectLabel, "Nawayef Park Views");
  assert.equal(row.trend3m, 3);
  assert.equal(row.trend6m, null);
  assert.equal(row.trend12m, null);
  assert.equal(row.sinceLaunch, null, "A usable 3M pair never proves a since-launch pair");
});

test("area facts require their own source/date/approval and retain factual provenance", () => {
  const approved = { description: "Announced cultural destination", Source: SOURCE, "Verified date": "2026-10-05", usable: true };
  const area = normalizeAreaIntelligence({ id: "rec-area", fields: {
    Name: "Hudayriyat Island", "Source URL": SOURCE, "Checked on": "2026-10-05", Verified: true,
    Notes: "Guaranteed appreciation", Catalysts: JSON.stringify([approved, { description: "Free text promise" }, { ...approved, usable: false }]),
    Risks: JSON.stringify([{ ...approved, description: "Competing supply" }, { ...approved, Source: null }]),
    "Competing supply": JSON.stringify([{ projectId: "rec-alternative", Source: SOURCE, "Verified date": "2026-10-05", Approval: "Approved" }])
  } }, { now: NOW });
  assert.equal(area.catalysts.length, 1);
  assert.equal(area.risks.length, 1);
  assert.equal(area.supply.length, 1);
  for (const item of [...area.catalysts, ...area.risks, ...area.supply]) {
    assert.equal(item.source, SOURCE);
    assert.equal(item.sourceRecordId, "rec-area");
    assert.equal(item.verifiedOn, "2026-10-05");
    assert.equal(item.evidenceClass, "FACT");
    assert.equal(item.usable, true);
  }
  assert.equal(area.appreciation, undefined);
  assert.equal(area.catalysts[0].forecast, undefined);
});

test("relationship normalization uses linked record identity, source aliases and explicit vocabulary", () => {
  for (const relationship of ["SAME_MASTERPLAN", "SAME_AREA", "NEARBY", "DIRECT_COMPETITOR", "EARLIER_PHASE", "LATER_PHASE", "SIMILAR_PRICE_BAND", "SIMILAR_PRODUCT", "READY_ALTERNATIVE", "OFF_PLAN_ALTERNATIVE"]) {
    const row = normalizeProjectRelationship(relation({ "Relationship type": relationship }), { now: NOW });
    assert.equal(row.from, "rec-nawayef");
    assert.equal(row.to, "rec-alternative");
    assert.equal(row.relationship, relationship.toLowerCase());
    assert.equal(row.usable, true);
    assert.equal(row.source, SOURCE);
    assert.equal(row.sourceRecordId, "rec-relation");
    assert.deepEqual(row.sources, [SOURCE, "https://developer.example/masterplan"]);
  }
  assert.equal(normalizeProjectRelationship(relation(), { now: NOW }).relationship, "same_area");
  assert.equal(normalizeProjectRelationship(relation(), { now: NOW }).nearby, undefined);
});

test("geographic and competitive relationships require an explicit documented basis and research authority", () => {
  for (const relationship of ["NEARBY", "DIRECT_COMPETITOR"]) {
    for (const fields of [{ Reason: null }, { "Source / evidence": null }, { Confidence: "Low" }, { "Checked on": "2027-01-01" }, { Approval: "Draft" }]) {
      assert.equal(normalizeProjectRelationship(relation({ "Relationship type": relationship, ...fields }), { now: NOW }).usable, false);
    }
  }
  assert.equal(normalizeProjectRelationship(relation({ "Project B": [] }), { now: NOW }).usable, false);
  assert.equal(normalizeProjectRelationship(relation({ "Relationship type": "GUARANTEED_WINNER" }), { now: NOW }).usable, false);
});

test("investment FACT and CALCULATION retain record/source/class/scope/confidence without becoming forecasts", () => {
  for (const evidenceClass of ["FACT", "CALCULATION"]) {
    const row = normalizeInvestmentEvidence(investment({ "Evidence class": evidenceClass }), { now: NOW });
    assert.equal(row.usable, true);
    assert.equal(row.projectId, "rec-nawayef");
    assert.equal(row.projectSheetId, "AD-004");
    assert.equal(row.dimension, "ENTRY");
    assert.equal(row.evidenceFact, row.fact);
    assert.equal(row.evidenceClass, evidenceClass);
    assert.equal(row.source, SOURCE);
    assert.equal(row.sourceRecordId, "rec-evidence");
    assert.equal(row.verifiedOn, "2026-10-05");
    assert.equal(row.confidence, "High");
    assert.equal(row.sourceConfidence, "Official");
    assert.equal(row.publishedOn, "10 Dec 2024");
    assert.equal(row.expectedAppreciation, undefined);
  }
});

test("speculative and incomplete investment evidence cannot masquerade as usable confirmed claims", () => {
  for (const fields of [
    { "Evidence class": "FORECAST" }, { "Evidence class": "SCENARIO" }, { "Evidence class": null },
    { Scope: null }, { Scope: "  " }, { Scope: JSON.stringify({ projectId: null }) }, { Confidence: "Indicative" },
    { Confidence: null }, { "Source URL": null }, { "Checked date": "2027-01-01" }, { Project: [] }, { Approval: "Draft" }
  ]) assert.equal(normalizeInvestmentEvidence(investment(fields), { now: NOW }).usable, false, JSON.stringify(fields));
  const forecast = normalizeInvestmentEvidence(investment({ "Evidence class": "FORECAST" }), { now: NOW });
  assert.equal(forecast.evidenceClass, "FORECAST");
  assert.ok(forecast.rejectionReasons.includes("speculative_evidence_disabled"));
});

test("optional research tables load independently and payment schedules remain an explicit configuration", async () => {
  const tables = [];
  const store = new AirtableStore({ AIRTABLE_API_KEY: "test-only", AIRTABLE_BASE_ID: "test-base", fetch: async url => {
    const table = decodeURIComponent(new URL(url).pathname.split("/")[3]);
    tables.push(table);
    return { ok: true, json: async () => ({ records: [] }) };
  } });
  // Research tables were removed from the base; they are read only when configured.
  assert.equal(store.optionalTables.projectRelations, null);
  assert.equal(store.optionalTables.investmentEvidence, null);
  assert.equal(store.optionalTables.paymentSchedules, null);
  await store.refreshIntelligence(true);
  assert.ok(!tables.includes("Project Relationships (research)"));
  assert.ok(!tables.includes("Investment Evidence (research)"));
  assert.ok(!tables.includes("Payment Schedules (research)"));
  assert.deepEqual(store.listIntelligence().projectRelations, []);
  assert.deepEqual(store.listIntelligence().investmentEvidence, []);
  assert.deepEqual(emptyIntelligence().projectRelations, []);
  assert.deepEqual(emptyIntelligence().investmentEvidence, []);
  const configured = new AirtableStore({ AIRTABLE_PROJECT_RELATIONSHIPS_TABLE: "Custom relations", AIRTABLE_INVESTMENT_EVIDENCE_TABLE: "Custom evidence", AIRTABLE_PAYMENT_SCHEDULES_TABLE: "Payment Schedules (research)" });
  assert.equal(configured.optionalTables.projectRelations, "Custom relations");
  assert.equal(configured.optionalTables.investmentEvidence, "Custom evidence");
  assert.equal(configured.optionalTables.paymentSchedules, "Payment Schedules (research)");
});
