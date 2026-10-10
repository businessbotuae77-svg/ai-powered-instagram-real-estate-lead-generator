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

test("step 7a matching reads Airtable projects and units; developers come from the repo", async () => {
  const { store, seed, api } = await createSeededAirtableStore();
  assert.equal(store.source, "airtable");
  assert.equal(store.developers.length, seed.developers.length);
  assert.equal(store.projects.length, seed.projects.length);
  assert.equal(store.units.length, seed.units.length);
  assert.ok(store.units.every((row) => row.id.startsWith("rec") && row.projectId.startsWith("rec")));
  assert.equal(api.tables.has("Developers"), false);
  assert.ok(store.listProjects().every((row) => row.developerActive && row.developerName));
});

test("step 7i a project's developer resolves by select name, text or a legacy link", async () => {
  const developers = [{ id: "dev_modon", name: "Modon", active: true }, { id: "dev_old", name: "Old Dev", active: false }];
  const records = {
    Developers: [{ id: "recDevModon", fields: { Name: "Modon" } }],
    Projects: [
      { id: "recA", fields: { Name: "Select", Developer: "Modon", Active: true } },
      { id: "recB", fields: { Name: "Link", Developer: ["recDevModon"], Active: true } },
      { id: "recC", fields: { Name: "Inactive", Developer: { name: "Old Dev" }, Active: true } },
      { id: "recD", fields: { Name: "Unknown", Developer: "Nobody", Active: true } }
    ],
    Units: []
  };
  const store = new AirtableStore({
    AIRTABLE_API_KEY: "test", AIRTABLE_BASE_ID: "app-test", developers,
    fetch: async (url) => {
      const rows = records[decodeURIComponent(new URL(url).pathname.split("/")[3])];
      return { ok: Boolean(rows), status: rows ? 200 : 404, json: async () => (rows ? { records: rows } : {}) };
    }
  });
  await store.refreshCatalog(true);
  const byName = Object.fromEntries(store.listProjects().map((row) => [row.name, row]));
  assert.equal(byName.Select.developerName, "Modon");
  assert.equal(byName.Link.developerName, "Modon");
  assert.equal(byName.Link.developerActive, true);
  assert.equal(byName.Inactive.developerActive, false);
  assert.equal(byName.Unknown.developerActive, false);
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
