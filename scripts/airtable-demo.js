import { loadEnv } from "./load-env.js";
import { PropertyService } from "../src/services/property-service.js";
import { YAS_MATCH_CRITERIA } from "../src/store/airtable-schema.js";
import { airtableConfigured } from "../src/store/airtable-store.js";
import { createCatalogStore, createSeededAirtableStore } from "../src/store/create-store.js";

loadEnv();

function names(result) {
  return result.matches.map((row) => row.project.name);
}

export async function runAirtableMilestoneChecks(store) {
  const properties = new PropertyService(store);
  const log = [];

  const tables = {
    developers: store.developers.map((row) => row.name),
    projects: store.projects.map((row) => `${row.name} (active=${row.active})`),
    units: store.units.map((row) => row.name || `${row.projectId} ${row.bedrooms}BR`)
  };
  log.push({
    check: "tables and sample records",
    ok: store.developers.length >= 2 && store.projects.length >= 8 && store.units.length >= 13,
    source: store.source,
    tables
  });

  const first = properties.answer(YAS_MATCH_CRITERIA);
  log.push({
    check: "AED 3M / 500k / Yas / 3BR / payment plan",
    ok: first.matchCount === 1 && first.matches[0].project.name === "Yas Park Views" && first.matches[0].unit.startingPriceAed === 2600000,
    matchCount: first.matchCount,
    matches: first.matches.map((row) => ({
      project: row.project.name,
      price: row.unit.startingPriceAed,
      down: row.downPaymentAed
    })),
    reply: first.reply.text
  });

  const originalPrice = 2600000;
  await store.updateUnitPrice("Yas Park Views", 3, 3_500_000);
  const afterRaise = properties.answer(YAS_MATCH_CRITERIA);
  const raisedUnit = store.findUnit({ projectName: "Yas Park Views", bedrooms: 3 });
  log.push({
    check: "price change in Airtable changes matching",
    ok: raisedUnit.startingPriceAed === 3_500_000 && afterRaise.matchCount === 0 && !names(afterRaise).includes("Yas Park Views"),
    priceInAirtable: raisedUnit.startingPriceAed,
    matchCount: afterRaise.matchCount,
    matches: names(afterRaise)
  });

  await store.updateUnitPrice("Yas Park Views", 3, originalPrice);
  const restored = properties.answer(YAS_MATCH_CRITERIA);
  log.push({
    check: "restored price returns Yas Park Views",
    ok: restored.matchCount === 1 && restored.matches[0].unit.startingPriceAed === originalPrice,
    priceInAirtable: store.findUnit({ projectName: "Yas Park Views", bedrooms: 3 }).startingPriceAed,
    matchCount: restored.matchCount
  });

  const liveNames = store.listProjects().map((row) => row.name);
  const hidden = store.listProjects({ includeInactive: true }).find((row) => row.name === "Old Yas Towers");
  log.push({
    check: "inactive project does not appear",
    ok: hidden && hidden.active === false && !liveNames.includes("Old Yas Towers") && !names(first).includes("Old Yas Towers"),
    liveProjects: liveNames,
    inactiveRow: hidden ? { name: hidden.name, active: hidden.active } : null
  });

  const missingMatch = properties.match({
    emirate: "Abu Dhabi",
    area: "Yas Island",
    bedrooms: 3,
    developer: "Aldar"
  });
  const missing = missingMatch.matches.find((row) => row.project.name === "Yas Waterfront Residences");
  const packs = missing ? properties.factsFor({ matches: [missing] }) : [];
  const { renderSafeReply } = await import("../src/facts/safe-reply.js");
  const reply = missing ? renderSafeReply(packs) : { text: "" };
  log.push({
    check: "missing price is not invented",
    ok: Boolean(missing) && packs[0]?.startingPriceAed.confirmed === false && packs[0]?.startingPriceAed.value === null && reply.text.includes("not confirmed yet") && !reply.text.includes("AED 2,600,000"),
    startingPrice: packs[0]?.startingPriceAed || null,
    reply: reply.text
  });

  return log;
}

async function main() {
  let store;
  let mode;
  if (airtableConfigured()) {
    store = await createCatalogStore({ requireAirtable: true });
    mode = "live Airtable";
  } else {
    ({ store } = await createSeededAirtableStore());
    mode = "Airtable record adapter";
  }

  const results = await runAirtableMilestoneChecks(store);
  const failed = results.filter((row) => !row.ok);
  console.log(JSON.stringify({ mode, source: store.source, failed: failed.length, results }, null, 2));
  if (failed.length) process.exit(1);
}

const isMain = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("airtable-demo.js");
if (isMain) {
  await main();
}
