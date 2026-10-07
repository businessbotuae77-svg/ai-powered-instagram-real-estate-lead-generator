import assert from "node:assert/strict";
import test from "node:test";
import { setupConversation } from "./helpers.js";

const PRIORITIES = /What matters most to you in the property\?|What should I optimise for/;

async function chat(engine, userId, messages) {
  const replies = [];
  for (const message of messages) replies.push(await engine.handleMessage(userId, message, { useLlm: false }));
  return replies;
}

test("step 31a an unsure investor is advised instead of being asked the same question", async () => {
  const { engine } = await setupConversation();
  const [, , budget, unsure] = await chat(engine, "unsure_investor", ["Start fresh.", "Exploring investment opportunities", "3 million", "Idk"]);
  assert.match(budget.reply, PRIORITIES);
  assert.doesNotMatch(unsure.reply, PRIORITIES);
  assert.match(unsure.reply, /you're open, so I'll do the filtering/);
  assert.equal(unsure.buyer.budgetAed, 3_000_000);
});

test("step 31b repeated I don't know never repeats the priorities question or the same reply", async () => {
  const { engine } = await setupConversation();
  const replies = await chat(engine, "repeat_unsure", ["Start fresh.", "Exploring investment opportunities", "3 million", "Idk", "I don’t know", "I don't know", "not sure"]);
  assert.equal(replies.filter(r => PRIORITIES.test(r.reply)).length, 1);
  for (let i = 1; i < replies.length; i++) assert.notEqual(replies[i].reply, replies[i - 1].reply);
});

test("step 31c a concrete goal after an unsure answer is understood", async () => {
  const { engine } = await setupConversation();
  const replies = await chat(engine, "unsure_then_goal", ["Start fresh.", "Exploring investment opportunities", "3 million", "Idk", "Rental income"]);
  assert.equal(replies.at(-1).buyer.investmentObjective, "rental_income");
});

test("step 31d an unsure explorer gets a concrete next step, not a dead end", async () => {
  const { engine } = await setupConversation();
  const replies = await chat(engine, "unsure_explorer", ["Start fresh.", "Just exploring", "3 million", "not sure", "not sure"]);
  assert.match(replies[3].reply, /With around AED 3,000,000, I can show you what that buys/);
  assert.notEqual(replies[4].reply, replies[3].reply);
  for (const reply of replies) assert.notEqual(reply.stage, "fact_check_fallback");
});
