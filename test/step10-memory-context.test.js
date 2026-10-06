import assert from "node:assert/strict";
import test from "node:test";
import { setupConversation } from "./helpers.js";

test("step 10a multi-turn chat keeps buyer memory", async () => {
  const { engine, store } = await setupConversation();
  await engine.handleMessage("ig_m2_mem1", "Budget AED 3M");
  await engine.handleMessage("ig_m2_mem1", "Yas area");
  const third = await engine.handleMessage("ig_m2_mem1", "3BR with 500k cash and payment plan");

  const buyer = store.getBuyer("ig_m2_mem1");
  assert.equal(buyer.budgetAed, 3000000);
  assert.deepEqual(buyer.preferredAreas, ["Yas Island"]);
  assert.deepEqual(buyer.bedrooms, [3]);
  assert.equal(buyer.cashAvailableAed, 500000);
  assert.equal(buyer.financing, "payment_plan");
  assert.ok(third.matchCount >= 1 && third.matchCount <= 2);
  assert.equal(third.matches[0].project.name, "Yas Park Views");
  if (third.advisor.challenger) assert.ok(third.advisor.challenger.reasonCodes.length);
  assert.match(third.reply, /Yas Park Views/);
  assert.ok(third.check.ok);
});

test("step 10b returning user does not re-ask known budget", async () => {
  const { engine, buyers } = await setupConversation();
  await buyers.remember("ig_m2_mem2", {
    budget: "3M",
    area: "Yas",
    bedrooms: 3,
    cash: "500k",
    financing: "payment_plan"
  });
  const result = await engine.handleMessage("ig_m2_mem2", "Show me what still fits");
  assert.equal(result.buyer.budgetAed, 3000000);
  assert.ok(result.matchCount >= 1 && result.matchCount <= 2);
  assert.equal(result.matches[0].project.name, "Yas Park Views");
  if (result.advisor.challenger) assert.ok(result.advisor.challenger.reasonCodes.length);
  assert.doesNotMatch(result.reply, /What budget are you working with/i);
  assert.ok(result.context.length >= 2);
});

test("step 10c conversation summary is stored on the buyer card", async () => {
  const { engine, store } = await setupConversation();
  await engine.handleMessage("ig_m2_mem3", "I have 2M for Saadiyat, 2 bedroom");
  const buyer = store.getBuyer("ig_m2_mem3");
  assert.ok(buyer.conversationSummary);
  assert.match(buyer.conversationSummary, /2000000|2,000,000|Saadiyat|2BR/i);
});
