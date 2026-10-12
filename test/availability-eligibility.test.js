import assert from "node:assert/strict";
import test from "node:test";
import { safeCatalog } from "../src/facts/freshness.js";
import { buildFactPack } from "../src/facts/retrieval.js";
import { matchInventory } from "../src/matching/matcher.js";
import { ConversationEngine } from "../src/conversation/engine.js";
import { setupServices } from "./helpers.js";

function fixture() {
  const now = Date.now();
  const project = { id: "project", name: "Example", active: true, approved: true, developerActive: true,
    source: "Verified project sheet", lastVerified: new Date(now).toISOString() };
  const unit = { id: "home", projectId: project.id, active: true, bedrooms: 2, propertyType: "apartment",
    startingPriceAed: 1_500_000, availability: "Sold out" };
  return { now, project, unit, catalog: { projects: [project], units: [unit] } };
}

test("suppressed availability preserves a fresh sold-out exclusion through repeated catalogue reads", () => {
  const { now, catalog } = fixture();
  for (const suppressAvailability of [true, false]) {
    const first = safeCatalog(catalog, { now, suppressAvailability });
    const second = safeCatalog(first, { now, suppressAvailability: true });
    const third = safeCatalog(second, { now, suppressAvailability: false });
    assert.equal(second.units[0].startingPriceAed, 1_500_000);
    assert.equal(second.units[0].availability, null);
    assert.equal(third.units[0].availability, null, "suppressed copy never restores a public availability claim");
    assert.equal(third.units[0].availabilityBlocked, true);
    assert.equal(matchInventory(third).matchCount, 0);
    assert.equal(matchInventory(third).rejected[0].reason, "sold_out");
    assert.equal(buildFactPack({ project: third.projects[0], unit: third.units[0] }, { now }).availability.confirmed, false);
  }
});

test("a retained sold-out exclusion expires and cannot survive changed source or verification scope", () => {
  const { now, catalog } = fixture();
  const first = safeCatalog(catalog, { now, suppressAvailability: true });
  assert.equal(safeCatalog(first, { now: now + 2 * 86400000 }).units[0].availabilityBlocked, false);
  for (const patch of [{ source: "New source" }, { lastVerified: new Date(now - 1000).toISOString() }]) {
    const changed = { ...first, projects: first.projects.map(p => ({ ...p, ...patch })) };
    assert.equal(safeCatalog(changed, { now }).units[0].availabilityBlocked, false);
  }
  const available = { ...first, units: first.units.map(u => ({ ...u, availability: "Available" })) };
  assert.equal(safeCatalog(available, { now, suppressAvailability: true }).units[0].availabilityBlocked, false);
});

test("suppressed offer availability cannot reappear from the retained private offer", () => {
  const { now, project, unit } = fixture();
  const commercialOffer = { id: "offer", projectId: project.id, unitId: unit.id, price: 1_500_000,
    priceBasis: "unit_type_starting_price", commercialSource: "Approved offer sheet",
    checkedOn: new Date(now).toISOString(), approval: "Approved", botEnabled: true, availability: "Available" };
  const catalog = { projects: [project], units: [{ ...unit, commercialOffer }] };
  const visible = safeCatalog(catalog, { now });
  assert.equal(visible.units[0].commercialGate.ok, true);
  assert.equal(visible.units[0].availability, "Available");
  const hidden = safeCatalog(visible, { now, suppressAvailability: true });
  const repeated = safeCatalog(hidden, { now, suppressAvailability: false });
  assert.equal(repeated.units[0].startingPriceAed, 1_500_000);
  assert.equal(repeated.units[0].availability, null);
  assert.equal(buildFactPack({ project: repeated.projects[0], unit: repeated.units[0] }, { now }).availability.confirmed, false);
});

test("named phases use their own availability freshness instead of the parent date", () => {
  const { now, project, unit } = fixture();
  const phase = { ...unit, phase: "Phase 2", source: "Phase 2 sheet", lastVerified: new Date(now).toISOString() };
  const staleParent = { ...project, lastVerified: new Date(now - 40 * 86400000).toISOString() };
  const freshPhase = safeCatalog({ projects: [staleParent], units: [phase] }, { now, suppressAvailability: true });
  assert.equal(freshPhase.units[0].availabilityBlocked, true);
  const stalePhase = safeCatalog({ projects: [project], units: [{ ...phase, lastVerified: new Date(now - 2 * 86400000).toISOString() }] }, { now });
  assert.equal(stalePhase.units[0].availabilityBlocked, false);
  assert.equal(stalePhase.units[0].availability, null);
});

test("normal chat recommends the available home rather than a cheaper sold-out sibling", async () => {
  const services = await setupServices();
  services.store.projects = services.store.projects.filter(p => p.id === "prj_yas_park_views");
  const available = services.store.units.find(u => u.id === "unt_ypv_2");
  services.store.units = [available, { ...available, id: "cheaper_sold_out", startingPriceAed: 1_500_000, availability: "Sold out" }];
  const engine = new ConversationEngine({ buyers: services.buyers, properties: services.properties });
  const result = await engine.handleMessage("availability", "Budget 2M, 2 bedroom in Yas", { useLlm: false });
  assert.equal(result.advisor.primary.unitId, available.id);
  assert.match(result.reply, /1,900,000/);
  assert.doesNotMatch(result.reply, /1,500,000|sold out|available now/i);
  assert.equal(result.check.ok, true);
});

test("a home that becomes sold out cannot be selected from an earlier comparison", async () => {
  const services = await setupServices();
  services.store.projects = services.store.projects.filter(p => p.id === "prj_yas_park_views");
  services.store.units = services.store.units.filter(u => u.projectId === "prj_yas_park_views")
    .map(u => u.bedrooms === 3 ? { ...u, startingPriceAed: 2_000_000, initialPaymentAed: 200_000 } : u);
  const engine = new ConversationEngine({ buyers: services.buyers, properties: services.properties, buyerDecisions: { enabled: true, pilotUnitIds: [] } });
  const first = await engine.handleMessage("comparison", "Budget 2.1M, 2 bedroom in Yas, more space", { useLlm: false });
  assert.equal(first.buyer.decisionComparison.pair.length, 2);
  services.store.units = services.store.units.map(u => u.id === "unt_ypv_3" ? { ...u, availability: "Sold out" } : u);
  const selected = await engine.handleMessage("comparison", "Choose second", { useLlm: false });
  assert.equal(selected.buyer.selectedListing, null);
  assert.equal(selected.buyer.decisionComparison, null);
  assert.equal(selected.commercialDecision, null);
  assert.equal(selected.check.ok, true);
});
