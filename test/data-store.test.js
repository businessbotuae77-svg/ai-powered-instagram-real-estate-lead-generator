import assert from "node:assert/strict";
import test from "node:test";
import { PropertyService } from "../src/services/property-service.js";
import { AirtableStore } from "../src/store/airtable-store.js";
import { createSeededAirtableStore, loadSeed } from "../src/store/create-store.js";
import { projectListings } from "../src/facts/project-listings.js";

// Airtable holds Projects, Units, Price History and Market Snapshot; developers
// and areas come from the repo.

async function seeded() {
  const seed = await loadSeed();
  seed.projects.forEach(p => { p.lastVerified = new Date().toISOString(); });
  return createSeededAirtableStore({ seed });
}

test("the Airtable store reads projects and their units; developers come from the repo", async () => {
  const { store, seed, api } = await seeded();
  assert.equal(store.projects.length, seed.projects.length);
  assert.equal(store.units.length, seed.units.length);
  assert.equal(api.tables.has("Developers"), false);
  assert.ok(store.listProjects().every(p => p.developerName && p.developerActive));
});

test("unit prices drive matching, and a price change in Airtable changes the match", async () => {
  const { store } = await seeded();
  const properties = new PropertyService(store);
  const criteria = { emirate: "Abu Dhabi", budgetAed: 3_000_000, area: "Yas Island", bedrooms: 3, paymentPlanRequired: true };
  const names = () => properties.answer(criteria).matches.map(m => `${m.project.name} ${m.unit.bedrooms}BR ${m.unit.startingPriceAed}`);
  assert.ok(names().includes("Yas Park Views 3BR 2600000"));
  await store.updateUnitPrice("Yas Park Views", 3, 3_500_000);
  assert.ok(!names().some(name => name.startsWith("Yas Park Views 3BR")));
});

test("an inactive project or an unpriced unit is never recommended on budget", async () => {
  const { store } = await seeded();
  const result = new PropertyService(store).match({ emirate: "Abu Dhabi", area: "Yas Island", bedrooms: 3, budgetAed: 3_000_000 });
  assert.ok(!result.matches.some(m => m.project.name === "Old Yas Towers"));
  assert.ok(!result.matches.some(m => m.project.name === "Yas Waterfront Residences"));
});

test("a project's developer resolves by dropdown name, plain text or an old link", async () => {
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
  const store = new AirtableStore({ AIRTABLE_API_KEY: "test", AIRTABLE_BASE_ID: "app-test", developers,
    fetch: async url => {
      const rows = records[decodeURIComponent(new URL(url).pathname.split("/")[3])];
      return { ok: Boolean(rows), status: rows ? 200 : 404, json: async () => (rows ? { records: rows } : {}) };
    } });
  await store.refreshCatalog(true);
  const by = Object.fromEntries(store.listProjects().map(p => [p.name, p]));
  assert.equal(by.Select.developerName, "Modon");
  assert.equal(by.Link.developerName, "Modon");
  assert.equal(by.Inactive.developerActive, false);
  assert.equal(by.Unknown.developerActive, false);
});

test("area guides and research load from the repo files, with no Airtable table", async () => {
  const store = new AirtableStore({ AIRTABLE_API_KEY: "test", AIRTABLE_BASE_ID: "app-test", developers: [],
    fetch: async () => ({ ok: true, json: async () => ({ records: [] }) }) });
  await store.refreshCatalog(true);
  assert.equal(store.optionalTables.areas, null);
  const intelligence = store.listIntelligence();
  assert.equal(intelligence.areas.length, 12);
  assert.ok(intelligence.areaGuide.length > 0);
  assert.ok(intelligence.areas.every(area => !area.usable), "unapproved research is never quoted as current");
});

test("a priced project without unit rows is still recommendable at its starting price", () => {
  const project = { id: "p1", startingPriceAed: 2_000_000, bedroomRange: "1–3BR apartments", propertyTypes: ["apartment"] };
  const [listing] = projectListings([project], []);
  assert.equal(listing.startingPriceAed, 2_000_000);
  assert.deepEqual([listing.bedrooms, listing.bedroomsMax], [1, 3]);
  assert.equal(projectListings([project], [{ projectId: "p1" }]).length, 0, "unit rows take over once they exist");
});
