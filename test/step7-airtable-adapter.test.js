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
  const { store, seed } = await createSeededAirtableStore();
  assert.equal(store.source, "airtable");
  assert.equal(store.developers.length, seed.developers.length);
  assert.equal(store.projects.length, seed.projects.length);
  assert.equal(store.units.length, seed.units.length);
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

test("step 7b Yas 3M query uses Airtable unit prices", async () => {
  const { store } = await createSeededAirtableStore();
  const result = new PropertyService(store).answer(YAS_MATCH_CRITERIA);
  assert.equal(result.matchCount, 1);
  assert.equal(result.matches[0].project.name, "Yas Park Views");
  assert.equal(result.matches[0].unit.startingPriceAed, 2600000);
  assert.equal(result.matches[0].unit.id.startsWith("rec"), true);
});

test("step 7c changing Starting price AED in Airtable changes the match", async () => {
  const { store } = await createSeededAirtableStore();
  const properties = new PropertyService(store);
  assert.equal(properties.answer(YAS_MATCH_CRITERIA).matchCount, 1);

  await store.updateUnitPrice("Yas Park Views", 3, 3_500_000);
  const after = properties.answer(YAS_MATCH_CRITERIA);
  assert.equal(store.findUnit({ projectName: "Yas Park Views", bedrooms: 3 }).startingPriceAed, 3_500_000);
  assert.equal(after.matchCount, 0);

  await store.updateUnitPrice("Yas Park Views", 3, 2_600_000);
  assert.equal(properties.answer(YAS_MATCH_CRITERIA).matchCount, 1);
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

test("step 7e missing Airtable price is null and not filled in", async () => {
  const { store } = await createSeededAirtableStore();
  const properties = new PropertyService(store);
  const result = properties.match({
    emirate: "Abu Dhabi",
    area: "Yas Island",
    bedrooms: 3,
    developer: "Aldar"
  });
  const missing = result.matches.find((row) => row.project.name === "Yas Waterfront Residences");
  const pack = properties.factsFor({ matches: [missing] })[0];
  assert.equal(pack.startingPriceAed.value, null);
  assert.equal(pack.startingPriceAed.confirmed, false);
});

test("step 7f client Airtable checklist all passes", async () => {
  const { store } = await createSeededAirtableStore();
  const results = await runAirtableMilestoneChecks(store);
  const failed = results.filter((row) => !row.ok).map((row) => row.check);
  assert.deepEqual(failed, []);
});
