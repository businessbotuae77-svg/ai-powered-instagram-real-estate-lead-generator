import assert from "node:assert/strict";
import test from "node:test";
import { PropertyService } from "../src/services/property-service.js";
import { YAS_MATCH_CRITERIA } from "../src/store/airtable-schema.js";
import { createSeededAirtableStore as seededStore, loadSeed } from "../src/store/create-store.js";
async function createSeededAirtableStore() {
  const seed = await loadSeed();
  seed.projects.forEach(p => p.lastVerified = new Date().toISOString());
  return seededStore({ seed });
}
import { AirtableStore } from "../src/store/airtable-store.js";
import { runAirtableMilestoneChecks } from "../scripts/airtable-demo.js";

test("step 7a matching reads Airtable records not seed JSON ids", async () => {
  const { store, seed, api } = await createSeededAirtableStore();
  assert.equal(store.source, "airtable");
  assert.equal(store.developers.length, seed.developers.length);
  assert.equal(store.projects.length, seed.projects.length);
  // Projects only: units and availability stay with the broker and are never read.
  assert.equal(store.units.length, 0);
  assert.deepEqual(store.listUnits(), []);
  assert.equal(api.tables.has("Units"), false);
  assert.ok(store.developers.every((row) => row.id.startsWith("rec")));
  assert.equal(store.developers.some((row) => row.id === "dev_aldar"), false);
});

test("step 7g Airtable buyer memory honors Railway runtime volume", () => {
  const store = new AirtableStore({
    AIRTABLE_API_KEY: "test",
    AIRTABLE_BASE_ID: "app-test",
    RUNTIME_DATA_DIR: "/data/runtime",
    fetch: async () => ({ ok: true, json: async () => ({ records: [] }) })
  });
  assert.equal(store.runtimeDir, "/data/runtime");
});

test("step 7b Yas 3M query matches projects on their published starting price and bedroom range", async () => {
  const { store } = await createSeededAirtableStore();
  const result = new PropertyService(store).answer(YAS_MATCH_CRITERIA);
  assert.deepEqual(result.matches.map(row => row.project.name), ["Yas Park Views", "Yas Grove Residences"]);
  const [first] = result.matches;
  assert.equal(first.unit.projectLevel, true);
  assert.equal(first.unit.startingPriceAed, 1400000);
  assert.equal(first.unit.id.startsWith("rec"), true);
  const pack = result.packs[0];
  assert.equal(pack.startingPriceBasis.value, "Starting price - 1BR");
  assert.equal(pack.bedroomLabel.value, "1-3BR apartments");
  assert.equal(pack.availability.confirmed, false);
  assert.equal(pack.availabilityNotes.confirmed, false);
});

test("step 7c changing a project's Starting price AED in Airtable changes the match", async () => {
  const { store } = await createSeededAirtableStore();
  const properties = new PropertyService(store);
  const named = () => properties.answer(YAS_MATCH_CRITERIA).matches.map(row => row.project.name);
  assert.ok(named().includes("Yas Park Views"));

  await store.updateProjectPrice("Yas Park Views", 3_500_000);
  assert.equal(store.findProject("Yas Park Views").startingPriceAed, 3_500_000);
  assert.equal(named().includes("Yas Park Views"), false);

  await store.updateProjectPrice("Yas Park Views", 1_400_000);
  assert.ok(named().includes("Yas Park Views"));
});

test("step 7d inactive Airtable project stays out of matches", async () => {
  const { store } = await createSeededAirtableStore();
  const live = store.listProjects().map((row) => row.name);
  const hidden = store.listProjects({ includeInactive: true }).find((row) => row.name === "Old Yas Towers");
  const result = new PropertyService(store).match({
    emirate: "Abu Dhabi",
    area: "Yas Island",
    bedrooms: 3,
    budgetAed: 3_000_000
  });
  assert.ok(hidden);
  assert.equal(hidden.active, false);
  assert.equal(live.includes("Old Yas Towers"), false);
  assert.equal(result.matches.some((row) => row.project.name === "Old Yas Towers"), false);
});

test("step 7e a project without a published price is never priced", async () => {
  const { store } = await createSeededAirtableStore();
  const properties = new PropertyService(store);
  const result = properties.match({
    emirate: "Abu Dhabi",
    area: "Yas Island",
    bedrooms: 3,
    developer: "Aldar"
  });
  assert.equal(result.matches.some((row) => row.project.name === "Yas Waterfront Residences"), false);
  assert.equal(properties.catalog().units.some((unit) => unit.projectId === store.findProject("Yas Waterfront Residences").id), false);
});

test("step 7h project listings fit bedroom ranges and property types", async () => {
  const { store } = await createSeededAirtableStore();
  const properties = new PropertyService(store);
  const names = criteria => properties.match({ emirate: "Abu Dhabi", ...criteria }).matches.map(row => row.project.name);
  assert.ok(names({ area: "Yas Island", bedrooms: 2 }).includes("Yas Park Views"));
  assert.equal(names({ area: "Yas Island", bedrooms: 4 }).includes("Yas Park Views"), false);
  assert.ok(names({ propertyType: "studio" }).includes("Yas Studio One"));
  assert.deepEqual(names({ area: "Hudayriyat Island", propertyType: "villa", bedrooms: 4 }), ["Hudayriyat Villas"]);
});

test("step 7f client Airtable checklist all passes", async () => {
  const { store } = await createSeededAirtableStore();
  const results = await runAirtableMilestoneChecks(store);
  const failed = results.filter((row) => !row.ok).map((row) => row.check);
  assert.deepEqual(failed, []);
});
