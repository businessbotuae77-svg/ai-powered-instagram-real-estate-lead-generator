import assert from "node:assert/strict";
import test from "node:test";
import { setupConversation } from "./helpers.js";
import { paymentStages, planPercentages } from "../src/facts/payment-stages.js";

async function chat(messages) {
  const { engine } = await setupConversation();
  const replies = [];
  for (const message of messages) replies.push(await engine.handleMessage("fallback_buyer", message));
  return replies;
}

test("payment stages are worked out only when the plan reconciles", () => {
  const nawayef = "60/40 plan: 10% down payment on booking, 50% in instalments during construction, 40% on handover (Modon official page, checked 2026-10-06).";
  assert.deepEqual(paymentStages(2_000_000, nawayef).map(s => [s.key, s.percent, s.amountAed]),
    [["booking", 10, 200_000], ["construction", 50, 1_000_000], ["beforeHandover", 60, 1_200_000], ["handover", 40, 800_000]]);
  assert.deepEqual(paymentStages(850_000, "70/30. 10 percent booking.").map(s => s.amountAed), [85_000, 510_000, 595_000, 255_000]);
  assert.deepEqual(paymentStages(1_000_000, "Payment plan available"), []);
  assert.equal(planPercentages("60/40 with 30% on booking and 50% during construction"), null, "percentages that do not add up are never used");
});

test("follow-up fact questions answer about the project just discussed", async () => {
  const [, plan, handover, initial] = await chat(["Tell me about Yas Park Views", "What's the payment plan?", "When is handover?", "Initial payment?"]);
  assert.match(plan.reply, /payment plan for Yas Park Views/);
  assert.match(plan.reply, /AED 1,120,000/);
  assert.match(handover.reply, /Yas Park Views hands over in Q4 2027/);
  assert.match(initial.reply, /AED 140,000/);
  for (const reply of [plan, handover, initial]) assert.doesNotMatch(reply.reply, /Which project/);
});

test("a named project with priced units leads with prices, plan and the area", async () => {
  const [overview, breakdown, availability] = await chat(["Tell me about Yas Park Views", "Sure", "Yes"]);
  assert.match(overview.reply, /1 bedroom apartment from AED 1,400,000/);
  assert.match(overview.reply, /entertainment island/);
  assert.doesNotMatch(overview.reply, /don't have a current commercial unit/);
  assert.match(breakdown.reply, /before handover 80% is AED 1,120,000/);
  assert.match(availability.reply, /Availability at Yas Park Views/);
  assert.doesNotMatch(availability.reply, /availability Available/);
});

test("a family is never offered a studio, and a large budget gets more than the cheapest ticket", async () => {
  const [, family] = await chat(["Hi, I want a home for my family near the beach, we have two kids", "Budget around 4 million"]);
  assert.doesNotMatch(family.reply.split("\n").slice(0, 2).join(" "), /studio/i);
  assert.match(family.reply, /[2-9] bedroom/);
  const [, , best] = await chat(["Invest", "5M", "Best overall"]);
  assert.doesNotMatch(best.reply.split("\n").slice(0, 2).join(" "), /\bstudio\b/i);
  assert.doesNotMatch(best.reply, /well under your budget/);
});

test("delegation phrases get a pick, not the same question again", async () => {
  for (const phrase of ["Go with your pick", "What do you recommend?", "Show me what I can get", "Up to you"]) {
    const replies = await chat(["Invest", "2M", phrase]);
    const last = replies.at(-1);
    assert.match(last.reply, /pick|prefer/i, `${phrase}: ${last.reply}`);
    assert.doesNotMatch(last.reply, /What should I optimise for|No problem, take your time/);
  }
});

test("a search constraint mentioning a payment plan is not mistaken for a fact question", async () => {
  const [, constraint] = await chat(["Budget AED 3M, Yas, 3 bedroom", "I only have 50k cash available now and need a payment plan"]);
  assert.notEqual(constraint.stage, "fact_answer");
});
