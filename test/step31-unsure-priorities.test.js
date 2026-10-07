import assert from "node:assert/strict";
import test from "node:test";
import { setupConversation } from "./helpers.js";

const PRIORITIES = /What matters most to you in the property\?/;

async function chat(engine, userId, messages) {
  const replies = [];
  for (const message of messages) replies.push(await engine.handleMessage(userId, message, { useLlm: false }));
  return replies;
}

test("step 31a unsure investor gets goal options instead of the same question", async () => {
  const { engine } = await setupConversation();
  const [, , budget, unsure] = await chat(engine, "unsure_investor", ["Start fresh.", "Exploring investment opportunities", "3 million", "Idk"]);
  assert.match(budget.reply, PRIORITIES);
  assert.doesNotMatch(unsure.reply, PRIORITIES);
  assert.equal(unsure.nextQuestion.field, "investmentObjective");
  assert.deepEqual(unsure.nextQuestion.choices.map(c => c.label), ["Rental income", "Capital growth", "A mix"]);
});

test("step 31b repeated I don't know never repeats the priorities question", async () => {
  const { engine } = await setupConversation();
  const replies = await chat(engine, "repeat_unsure", ["Start fresh.", "Exploring investment opportunities", "3 million", "Idk", "I don’t know", "I don't know", "not sure"]);
  assert.equal(replies.filter(r => PRIORITIES.test(r.reply)).length, 1);
  for (let i = 1; i < replies.length; i++) assert.notEqual(replies[i].reply, replies[i - 1].reply);
});

test("step 31c goal options are understood after an unsure answer", async () => {
  const { engine } = await setupConversation();
  const replies = await chat(engine, "unsure_then_goal", ["Start fresh.", "Exploring investment opportunities", "3 million", "Idk", "Rental income"]);
  assert.equal(replies.at(-1).buyer.investmentObjective, "rental_income");
});

test("step 31d unsure non-investor is asked the purpose with options", async () => {
  const { engine } = await setupConversation();
  const replies = await chat(engine, "unsure_explorer", ["Start fresh.", "Just exploring", "3 million", "not sure"]);
  assert.equal(replies.at(-1).nextQuestion.field, "useType");
  assert.equal(replies.at(-1).nextQuestion.choices.length, 3);
});
