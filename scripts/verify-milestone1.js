import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { createLocalStore } from "../src/store/local-store.js";
import { BuyerService } from "../src/services/buyer-service.js";
import { PropertyService } from "../src/services/property-service.js";
import { validateCatalog } from "../src/schema/validate.js";
import { validateMessage, missingDataHandoff } from "../src/facts/checker.js";
import { renderSafeReply } from "../src/facts/safe-reply.js";

const steps = [];
let failed = 0;

function step(name, fn) {
  steps.push({ name, fn });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

step("1. Load seed catalog and validate schema", async (ctx) => {
  const catalog = ctx.store.snapshot();
  const errors = validateCatalog(catalog);
  assert(errors.length === 0, errors.join("\n"));
  assert(catalog.developers.length === 2, "expected 2 developers");
  assert(catalog.projects.length === 8, "expected 8 projects");
  assert(catalog.units.length === 13, "expected 13 units");
});

step("2. Inactive projects are hidden from matching", async (ctx) => {
  const names = ctx.store.listProjects().map((row) => row.name);
  assert(names.includes("Yas Park Views"), "live project missing");
  assert(!names.includes("Old Yas Towers"), "disabled project leaked");
});

step("3. Buyer card stores Yas 3M / 500k / 3BR / payment plan", async (ctx) => {
  const buyer = await ctx.buyers.remember("ig_verify_1", {
    budget: "AED 3M",
    cash: "500k",
    area: "Yas",
    bedrooms: "3BR",
    financing: "payment_plan"
  });
  ctx.buyer = buyer;
  assert(buyer.budgetAed === 3000000, "budget not parsed");
  assert(buyer.cashAvailableAed === 500000, "cash not parsed");
  assert(buyer.preferredAreas[0] === "Yas Island", "area alias failed");
  assert(buyer.bedrooms[0] === 3, "bedrooms not parsed");
});

step("4. Returning Instagram user keeps budget", async (ctx) => {
  const again = await ctx.buyers.remember("ig_verify_1", { name: "Omar" });
  assert(again.budgetAed === 3000000, "budget was wiped");
  assert(again.name === "Omar", "name not saved");
  assert(!ctx.buyers.missingQualificationFields(again).includes("budgetAed"), "system would re-ask budget");
});

step("5. Match Yas 3M 500k 3BR payment plan", async (ctx) => {
  const result = ctx.properties.matchBuyer(ctx.buyer);
  ctx.yasResult = result;
  assert(result.matchCount === 1, `expected 1 match, got ${result.matchCount}`);
  assert(result.matches[0].project.name === "Yas Park Views", "wrong project");
  assert(result.matches[0].unit.bedrooms === 3, "wrong bedrooms");
  assert(result.matches[0].unit.startingPriceAed === 2600000, "wrong price");
});

step("6. Reject studio, missing price, high down, and disabled rows", async (ctx) => {
  const names = ctx.yasResult.matches.map((row) => row.project.name);
  assert(!names.includes("Yas Studio One"), "studio project leaked into 3BR match");
  assert(!names.includes("Yas Waterfront Residences"), "unconfirmed price was recommended");
  assert(!names.includes("Yas Grove Residences"), "800k down passed 500k cash");
  assert(!names.includes("Old Yas Towers"), "disabled project matched");
});

step("7. Retrieve facts only from approved rows", async (ctx) => {
  const packs = ctx.properties.factsFor(ctx.yasResult);
  ctx.packs = packs;
  assert(packs[0].startingPriceAed.value === 2600000, "price was not taken from unit");
  assert(packs[0].startingPriceAed.confirmed === true, "confirmed price marked missing");
});

step("8. Hallucinated AED 2,100,000 is blocked", async (ctx) => {
  const bad = validateMessage("Starts from AED 2,100,000.", ctx.packs);
  assert(bad.ok === false, "invented price passed");
  const good = validateMessage("Starts from AED 2,600,000.", ctx.packs);
  assert(good.ok === true, "real price was blocked");
});

step("9. Safe reply passes checker and does not handoff", async (ctx) => {
  const reply = renderSafeReply(ctx.packs);
  const check = validateMessage(reply.text, ctx.packs);
  assert(check.ok === true, `safe reply failed: ${JSON.stringify(check.violations)}`);
  assert(reply.handoffRequired === false, "safe reply asked for a human");
});

step("10. Missing commercial data stays unconfirmed and does not handoff", async (ctx) => {
  const result = ctx.properties.match({
    emirate: "Abu Dhabi",
    area: "Yas Island",
    bedrooms: 3,
    developer: "Aldar"
  });
  const missing = result.matches.find((row) => row.project.name === "Yas Waterfront Residences");
  assert(missing, "missing-price project should still be retrievable without a budget filter");
  const packs = ctx.properties.factsFor({ matches: [missing] });
  assert(packs[0].startingPriceAed.confirmed === false, "null price was invented");
  const reply = renderSafeReply(packs);
  assert(reply.text.includes("not confirmed yet"), "missing price was not disclosed");
  assert(missingDataHandoff(packs).handoffRequired === false, "missing data triggered handoff");
});

step("11. Studio and villa filters respect unit rows", async (ctx) => {
  const studios = ctx.properties.match({ emirate: "Abu Dhabi", propertyType: "studio" });
  assert(studios.matches.every((row) => row.unit.bedrooms === 0), "non-studio recommended as studio");
  assert(!studios.matches.some((row) => row.project.name === "Yas Park Views"), "Yas Park Views has no studio");
  const villas = ctx.properties.match({ emirate: "Abu Dhabi", propertyType: "villa" });
  assert(villas.matches.every((row) => row.unit.propertyType === "villa"), "non-villa recommended as villa");
});

step("12. End-to-end answer for the locked Yas query", async (ctx) => {
  const answer = ctx.properties.answer({
    emirate: "Abu Dhabi",
    budgetAed: 3000000,
    cashAvailableAed: 500000,
    area: "Yas Island",
    bedrooms: 3,
    paymentPlanRequired: true
  });
  assert(answer.matchCount === 1, "end-to-end match count");
  assert(answer.check.ok === true, "end-to-end fact check");
  assert(answer.reply.handoffRequired === false, "end-to-end handoff");
  assert(answer.reply.text.includes("Yas Park Views"), "end-to-end reply");
});

const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "m1-verify-"));
const store = await createLocalStore({ runtimeDir });
// Offline synthetic fixtures are checked today; production seed dates are untouched.
store.projects = store.projects.map(project => ({ ...project, lastVerified: new Date().toISOString() }));
const ctx = {
  store,
  buyers: new BuyerService(store),
  properties: new PropertyService(store)
};

for (const item of steps) {
  try {
    await item.fn(ctx);
    console.log(`PASS  ${item.name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL  ${item.name}`);
    console.log(`      ${error.message}`);
  }
}

console.log("");
console.log(failed === 0 ? "Milestone 1 verification passed." : `Milestone 1 verification failed (${failed} step(s)).`);
process.exit(failed === 0 ? 0 : 1);
