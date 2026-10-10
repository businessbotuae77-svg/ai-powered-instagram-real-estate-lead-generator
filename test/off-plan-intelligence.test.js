import assert from "node:assert/strict";
import test from "node:test";
import { AirtableStore } from "../src/store/airtable-store.js";
import { emptyIntelligence, normalizeAreaIntelligence, normalizeMarketSnapshot, normalizePaymentSchedule, normalizePriceHistory } from "../src/facts/intelligence.js";
import { approvedCommercialOffers, commercialOfferGate, normalizeCommercialOffer, offerUnits } from "../src/facts/commercial-offers.js";
import { PropertyService } from "../src/services/property-service.js";

const NOW = Date.parse("2026-10-06T12:00:00Z");
const source = "https://developer.example/observations";
const observation = fields => ({ id: "rec-observation", fields: {
  Project: ["project-a"], Unit: ["unit-a"], "Observation date": "2026-10-05", "Price type": "Original launch price",
  "Price AED": 1900000, "Size sqft": 1000, Bedrooms: 1, "Property type": "apartment",
  "Source URL": source, "Source type": "Developer", Verified: true, Confidence: "High", ...fields
} });
const approvedOffer = overrides => ({
  id: "offer-a", offerId: "offer-a", projectId: "project-a", unitId: "unit-a", unitType: "apartment", bedrooms: 1,
  price: 2000000, priceBasis: "Exact unit", availability: "Available", checkedOn: "2026-10-06", validUntil: "2026-10-07",
  approval: "Approved", botEnabled: true, commercialSource: source, researchOnly: false, ...overrides
});

test("Price History keeps exact observed scope and source without inventing a future return", () => {
  const row = normalizePriceHistory(observation(), { now: NOW });
  assert.equal(row.usable, true);
  assert.equal(row.priceAed, 1900000);
  assert.equal(row.aedPerSqft, 1900);
  assert.equal(row.sourceRecordId, "rec-observation");
  assert.equal(row.verifiedOn, "2026-10-05");
  assert.equal(row.scope.unitId, "unit-a");
  assert.equal(row.expectedAppreciation, undefined);
  for (const fields of [{ Verified: false }, { "Source URL": null }, { "Observation date": "2027-01-01" }, { Confidence: "Low" }, { "Price AED": null }]) {
    assert.equal(normalizePriceHistory(observation(fields), { now: NOW }).usable, false);
  }
});

test("Market Snapshot weak sample leaves medians, trend and liquidity evidence unknown", () => {
  const record = { id: "snapshot", fields: {
    Project: ["project-a"], "Snapshot date": "2026-10-05", Confidence: "High", "Source note": `Official statistics: ${source}`,
    "Original price AED": 1800000, "Current developer price AED": 2000000,
    "Transactions 12M": 2, "Transaction median AED": 2100000, "Asking median AED": 2300000,
    "Trend 12M %": 0.2, "Since launch %": 0.3
  } };
  const weak = normalizeMarketSnapshot(record, { now: NOW });
  assert.equal(weak.originalPriceAed, 1800000);
  assert.equal(weak.transactionMedianAed, null);
  assert.equal(weak.askingMedianAed, null);
  assert.equal(weak.trend12m, null);
  assert.equal(weak.sinceLaunch, null);
  assert.equal(weak.sampleUsable, false);
  const enough = normalizeMarketSnapshot({ ...record, fields: { ...record.fields, "Transactions 12M": 12 } }, { now: NOW });
  assert.equal(enough.transactionMedianAed, 2100000);
  assert.equal(enough.sampleUsable, true);
  assert.equal(enough.trend12m, null, "Count does not establish a comparable trend basis");
  const unknown = normalizeMarketSnapshot({ ...record, fields: { ...record.fields, "Source note": null, "Transactions 12M": "" } }, { now: NOW });
  assert.equal(unknown.usable, false);
  assert.equal(unknown.transactions12m, null);
  assert.equal(unknown.currentDeveloperPriceAed, null);
});

test("Area research notes are not catalysts, and future sourced catalysts remain scoped evidence", () => {
  const record = { id: "area", fields: { Name: "Yas Island", Emirate: "Abu Dhabi", Notes: "Guaranteed growth due to future metro", Summary: "A leisure area" } };
  const research = normalizeAreaIntelligence(record, { now: NOW });
  assert.equal(research.name, "Yas Island");
  assert.equal(research.usable, false);
  assert.equal(research.summary, null);
  assert.deepEqual(research.catalysts, []);
  const evidenced = normalizeAreaIntelligence({ ...record, fields: {
    ...record.fields, Source: source, "Last verified": "2026-10-05", Approval: "Approved",
    Catalysts: JSON.stringify([
      { description: "Announced cultural destination", source, verifiedOn: "2026-10-05", approved: true },
      { description: "Unsourced transport line", approved: true }
    ])
  } }, { now: NOW });
  assert.equal(evidenced.usable, true);
  assert.equal(evidenced.catalysts.length, 1);
  assert.deepEqual(evidenced.catalysts[0].scope, { area: "Yas Island" });
  assert.equal(evidenced.guaranteedAppreciation, undefined);
});

test("Offer gate independently enforces approval, enablement, date, source, price and availability", () => {
  assert.equal(commercialOfferGate(approvedOffer(), { now: NOW }).ok, true);
  for (const override of [
    { approval: "Draft" }, { botEnabled: false }, { researchOnly: true }, { commercialSource: null },
    { checkedOn: null }, { checkedOn: "2026-09-01" }, { validUntil: "2026-10-01" },
    { availability: "Unknown" }, { price: null }, { priceBasis: null }, { projectId: null }
  ]) {
    assert.equal(commercialOfferGate(approvedOffer(override), { now: NOW }).ok, false, JSON.stringify(override));
  }
  assert.equal(commercialOfferGate(approvedOffer({ checkedOn: "2026-10-04", validUntil: "2027-01-01" }), { now: NOW }).ok, false);
  assert.deepEqual(approvedCommercialOffers([approvedOffer({ researchOnly: true })], { now: NOW }), []);
});

test("Research offer price never becomes a live unit and project identity is mapped explicitly", () => {
  const projects = [{ id: "project-a", sheetProjectId: "AD-001" }];
  const offer = normalizeCommercialOffer({ id: "rec-offer", fields: {
    "Offer ID": "OFFER-001", "Sheet Project ID": "AD-001", "Price (AED)": 2000000, "Home type": "apartment", Bedrooms: "1",
    "Price basis": "Starting", Approval: "Draft", "Bot enabled": "No", Availability: "Unknown"
  } }, { projects, researchOnly: true });
  assert.equal(offer.projectId, "project-a");
  assert.equal(offer.price, 2000000);
  assert.deepEqual(offerUnits({ projects, units: [], intelligence: { offers: [offer] } }, { now: NOW }), []);
});

test("Fresh offer is an independent unit scope and cannot inherit old project commercial terms", () => {
  const catalog = {
    projects: [{ id: "project-a", initialPaymentAed: 500000, paymentPlanSummary: "60/40", handover: "2030" }],
    units: [{ id: "unit-a", projectId: "project-a", propertyType: "apartment", bedrooms: 1, startingPriceAed: 1900000, initialPaymentAed: 500000 }],
    intelligence: { offers: [approvedOffer()] }
  };
  const [unit] = offerUnits(catalog, { now: NOW });
  assert.equal(unit.startingPriceAed, 2000000);
  assert.equal(unit.initialPaymentAed, null);
  assert.equal(unit.commercialOffer.handover, undefined);
  assert.equal(unit.inventoryUnitId, "unit-a");
  assert.equal(unit.commercialGate.ok, true);
  assert.equal(unit.id, "offer:offer-a");
});

test("Payment adapter does not parse an unstructured 60/40 into fabricated milestones", () => {
  const row = normalizePaymentSchedule({ id: "schedule", fields: {
    Project: ["project-a"], "Plan ID": "plan-a", "Payment plan summary": "60/40", Approval: "Approved",
    "Bot enabled": "Yes", "Commercial source": source, "Checked on": "2026-10-06"
  } });
  assert.equal(row.planId, "plan-a");
  assert.deepEqual(row.milestones, []);
  assert.equal(row.approved, true);
  assert.equal(row.botEnabled, true);
  const complete = normalizePaymentSchedule({ id: "schedule", fields: {
    Milestones: JSON.stringify([{ id: "booking", kind: "booking", percent: 10 }, { id: "handover", kind: "handover", percent: 90 }]),
    Fees: "invalid json"
  } });
  assert.equal(complete.milestones.length, 2);
  assert.deepEqual(complete.fees, []);
});

test("Absent optional tables leave legacy catalog operational and cache research separately", async () => {
  const counts = new Map();
  const store = new AirtableStore({
    AIRTABLE_API_KEY: "test-only", AIRTABLE_BASE_ID: "app-test",
    fetch: async url => {
      const table = decodeURIComponent(new URL(url).pathname.split("/")[3]);
      counts.set(table, (counts.get(table) || 0) + 1);
      const core = ["Projects", "Units"].includes(table);
      return { ok: core, status: core ? 200 : 404, json: async () => core ? { records: [] } : { error: { type: "NOT_FOUND" } } };
    }
  });
  await store.refreshCatalog(true);
  assert.deepEqual(store.listProjects(), []);
  assert.deepEqual(store.listIntelligence().priceHistory, []);
  assert.equal(store.listIntelligence().limitations.find(row => row.category === "areas").status, "not_configured");
  store.catalogLoadedAt = Date.now() - 61000;
  await store.refreshCatalog();
  assert.equal(counts.get("Projects"), 2);
  assert.equal(counts.get("Price History"), 1);
  assert.equal(counts.get("Market Snapshot"), 1);
  assert.equal(counts.get("Offers (research)"), undefined);
  assert.deepEqual(emptyIntelligence().paymentSchedules, []);
});

test("Optional research failures never overwrite buyer permissions or identity", async () => {
  const store = new AirtableStore({ AIRTABLE_API_KEY: "test", AIRTABLE_BASE_ID: "app-test", fetch: async () => { throw new Error("offline"); } });
  const buyer = { instagramUserId: "buyer", phone: "+971500000000", noCalls: true, salesPathStopped: true, preferredContactChannel: "instagram" };
  store.buyers.set("buyer", buyer);
  await store.refreshIntelligence(true);
  assert.deepEqual(store.getBuyer("buyer"), buyer);
  assert.equal(store.listIntelligence().limitations.find(row => row.category === "priceHistory").status, "read_failed");
});

test("PropertyService quotes a fresh scoped offer independently of stale project terms", () => {
  const project = { id: "project-a", name: "Project A", active: true, source, lastVerified: "2025-01-01", developerActive: true, developerName: "Developer A", emirate: "Abu Dhabi", area: "Yas Island", initialPaymentAed: 500000, paymentPlanAvailable: true, paymentPlanSummary: "60/40", handover: "2030" };
  const today = new Date().toISOString();
  const live = approvedOffer({ unitId: null, checkedOn: today, validUntil: new Date(Date.now() + 86400000).toISOString() });
  const properties = new PropertyService({
    listDevelopers: () => [], listProjects: () => [project], listUnits: () => [],
    listIntelligence: () => ({ ...emptyIntelligence(), offers: [live] })
  });
  const result = properties.match({ budgetAed: 2000000 });
  assert.equal(result.matchCount, 1);
  const pack = properties.factsFor(result)[0];
  assert.equal(pack.startingPriceAed.value, 2000000);
  assert.equal(pack.startingPriceAed.recordId, "offer-a");
  assert.equal(pack.downPaymentAed.value, null);
  assert.equal(pack.paymentPlanSummary.value, null);
  assert.equal(pack.handover.value, null);
  assert.equal(pack.name.value, "Project A");
});
