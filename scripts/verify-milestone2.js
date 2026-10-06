import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { createLocalStore } from "../src/store/local-store.js";
import { BuyerService } from "../src/services/buyer-service.js";
import { PropertyService } from "../src/services/property-service.js";
import { ConversationEngine } from "../src/conversation/engine.js";
import { ConversationMemory } from "../src/conversation/memory.js";
import { extractFactsFromMessage } from "../src/conversation/extract.js";
import { validateMessage } from "../src/facts/checker.js";

const steps = [];
let failed = 0;

function step(name, fn) {
  steps.push({ name, fn });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

step("1. Extract budget, Yas, 3BR, payment plan from natural text", async () => {
  const { facts } = extractFactsFromMessage(
    "Hi, budget AED 3M for Yas, 3 bedroom, payment plan, 500k cash ready"
  );
  assert(facts.budget === 3000000, "budget not extracted");
  assert(facts.area === "Yas Island", "area not extracted");
  assert(facts.bedrooms === 3, "bedrooms not extracted");
  assert(facts.financing === "payment_plan", "financing not extracted");
  assert(facts.cash === 500000, "cash not extracted");
});

step("2. Progressive chat qualifies then matches Yas Park Views", async (ctx) => {
  await ctx.engine.handleMessage("ig_v2_1", "Hello");
  await ctx.engine.handleMessage("ig_v2_1", "Budget is 3M");
  await ctx.engine.handleMessage("ig_v2_1", "Yas Island");
  const result = await ctx.engine.handleMessage(
    "ig_v2_1",
    "3 bedroom apartment with payment plan and 500k cash"
  );
  ctx.result = result;
  assert(result.matchCount === 1, `expected 1 match, got ${result.matchCount}`);
  assert(result.matches[0].project.name === "Yas Park Views", "wrong project");
  assert(result.check.ok, "fact check failed on matched reply");
});

step("3. Buyer memory keeps earlier budget on later turns", async (ctx) => {
  const buyer = ctx.result.buyer;
  assert(buyer.budgetAed === 3000000, "budget wiped");
  assert(buyer.preferredAreas[0] === "Yas Island", "area wiped");
  assert(buyer.bedrooms[0] === 3, "bedrooms wiped");
  assert(buyer.conversationSummary, "conversation summary missing");
});

step("4. Returning visitor skips re-asking budget", async (ctx) => {
  const again = await ctx.engine.handleMessage("ig_v2_1", "Any update on those options?");
  assert(again.buyer.budgetAed === 3000000, "returning budget lost");
  assert(!/What budget are you working with/i.test(again.reply), "re-asked budget");
  assert(again.matchCount === 1, "returning match lost");
});

step("5. Hallucinated price is blocked", async (ctx) => {
  const bad = "Yas Park Views starts from AED 2,100,000 and is sold out now.";
  const check = validateMessage(bad, ctx.result.packs);
  assert(check.ok === false, "hallucinated claim was allowed");
});

step("6. Reservation interest asks permission-aware channel choice without a call", async (ctx) => {
  const result = await ctx.engine.handleMessage("ig_v2_1", "I want to reserve");
  assert(result.buyer.leadStatus === "engaged", "high intent must stay engaged, not a handoff lead");
  assert(result.alertRecommended === false, "high intent must not alert before phone submit");
  assert(result.callRequest === null, "reserve interest must not invent call consent");
  assert(result.nextQuestion?.field === "preferredContactChannel", "reserve interest should ask a follow-up channel");
  assert(result.check.ok, "high intent reply failed fact check");
  assert(result.handoffRequired === false, "missing data must not force CRM handoff");
});

step("7. Missing listing fields stay unanswered", async (ctx) => {
  const missing = ctx.result.missingData;
  assert(missing.handoffRequired === false, "missing fields triggered handoff");
});

const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "m2-verify-"));
const store = await createLocalStore({ runtimeDir });
// Offline synthetic fixtures are checked today; production seed dates are untouched.
store.projects = store.projects.map(project => ({ ...project, lastVerified: new Date().toISOString() }));
const buyers = new BuyerService(store);
const properties = new PropertyService(store);
const engine = new ConversationEngine({
  buyers,
  properties,
  memory: new ConversationMemory()
});

const ctx = { store, buyers, properties, engine };

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

if (failed) {
  console.log(`\nMilestone 2 verify failed: ${failed} step(s)`);
  process.exit(1);
}

console.log("\nMilestone 2 verify passed");
