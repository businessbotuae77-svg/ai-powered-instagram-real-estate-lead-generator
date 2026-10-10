import assert from "node:assert/strict";
import test from "node:test";
import { bedroomBounds, projectListing, projectListings } from "../src/facts/project-listings.js";
import { PropertyService } from "../src/services/property-service.js";
import { buildBrokerContext } from "../src/conversation/broker-mode.js";
import { createSeededAirtableStore } from "../src/store/create-store.js";

const today = new Date().toISOString().slice(0, 10);
const project = (overrides = {}) => ({
  id: "ad4", name: "Nawayef Park Views", developerId: "modon", emirate: "Abu Dhabi", area: "Hudayriyat Island",
  propertyTypes: ["apartment"], status: "Off-plan", handover: "Q1 2028", paymentPlanAvailable: true,
  paymentPlanSummary: "60/40: 10% booking + 50% construction + 40% handover.", initialPaymentAed: null,
  startingPriceAed: 2000000, startingPriceBasis: "Starting price - 1BR", bedroomRange: "1–4BR apartments",
  description: "Apartments beside a park.", features: null, availabilityNotes: "Only 3 units left",
  source: "Official developer page", lastVerified: today, active: true, ...overrides
});

async function projectsOnly(projects) {
  const { store } = await createSeededAirtableStore({
    seed: { developers: [{ id: "modon", name: "Modon", active: true }], projects, units: [] }
  });
  return { store, properties: new PropertyService(store) };
}

test("bedroom ranges are read from published wording", () => {
  assert.deepEqual(bedroomBounds("1–4BR apartments"), { min: 1, max: 4 });
  assert.deepEqual(bedroomBounds("3-4BR townhouses; 4–6BR villas; 6BR mansions"), { min: 3, max: 6 });
  assert.deepEqual(bedroomBounds("Studio and 1BR apartments"), { min: 0, max: 1 });
  assert.equal(bedroomBounds("Residences; bedroom mix to verify"), null);
});

test("only priced projects without unit rows become listings, and never carry availability", () => {
  assert.equal(projectListing(project({ startingPriceAed: null })), null);
  const [listing] = projectListings([project()]);
  assert.equal(listing.projectLevel, true);
  assert.equal(listing.availability, null);
  assert.equal(projectListings([project()], [{ projectId: "ad4" }]).length, 0);
});

test("projects-only catalogue: availability notes are ignored and stale prices are withheld", async () => {
  const { properties } = await projectsOnly([project(), project({ id: "ad13", name: "Tara Park", lastVerified: "2020-01-01" })]);
  const result = properties.match({ emirate: "Abu Dhabi", bedrooms: 2, budgetAed: 2_500_000 });
  assert.deepEqual(result.matches.map(row => row.project.name), ["Nawayef Park Views"]);
  const pack = properties.factsFor(result)[0];
  assert.equal(pack.startingPriceText.value, "AED 2,000,000");
  assert.equal(pack.bedroomLabel.value, "1–4BR apartments");
  assert.equal(pack.availability.confirmed, false);
  assert.equal(pack.availabilityNotes.confirmed, false);
});

test("a buyer's cash figure does not exclude a project whose booking amount the broker confirms", async () => {
  const { properties } = await projectsOnly([project()]);
  const result = properties.match({ emirate: "Abu Dhabi", bedrooms: 2, budgetAed: 2_500_000, cashAvailableAed: 100_000 });
  assert.equal(result.matchCount, 1);
});

test("broker mode shows a from-price with its basis and sends unit and availability questions to the team", async () => {
  const { properties } = await projectsOnly([project()]);
  const context = buildBrokerContext({ catalog: properties.catalog(), buyer: { budgetAed: 2_500_000 }, message: "Tell me about Nawayef Park Views" });
  const [listing] = context.listings;
  assert.equal(listing.unit, "1–4BR apartments");
  assert.equal(listing.priceBasis, "Starting price - 1BR");
  assert.equal(listing.availability, undefined);
  assert.match(listing.quote, /not a unit quote/);
  assert.match(listing.quote, /availability come from the team/);
});
