import assert from "node:assert/strict";
import test from "node:test";
import { talk } from "./helpers.js";

// The opening from the brand guide: who the bot is, what to explore, three choices.
const EN = "Hi 👋 I'm The Sustainable Bot, your AI guide to UAE property. What would you like to explore?";

test("a first hello introduces the bot and offers three choices, without asking for a budget", async () => {
  const { last } = await talk(["Hi"]);
  assert.equal(last.reply, EN);
  assert.deepEqual(last.nextQuestion.choices.map(c => c.label), ["Find a property", "Payment plans", "Ask a question"]);
  assert.equal(last.outcome, "browsing");
});

test("Arabic hello gets the Arabic welcome and Arabic buttons", async () => {
  const { last } = await talk(["مرحبا"]);
  assert.match(last.reply, /أنا The Sustainable Bot، دليلك الذكي لعقارات الإمارات/);
  assert.deepEqual(last.nextQuestion.choices.map(c => c.label), ["ابحث عن عقار", "خطط السداد", "اسأل سؤالاً"]);
});

test("Start fresh clears the search and shows the welcome again", async () => {
  const { last } = await talk(["Budget 2M in Yas", "Start fresh"]);
  assert.match(last.reply, /^Fresh start 👋 I'm The Sustainable Bot/);
  assert.equal(last.buyer.budgetAed, null);
  assert.deepEqual(last.buyer.preferredAreas, []);
});

test("each button has its own useful reply", async () => {
  const find = (await talk(["Hi", "Find a property"])).last;
  assert.equal(find.nextQuestion.field, "useType");
  assert.match(find.reply, /buying a home to live in, investing, or not sure yet\?/);

  const plans = (await talk(["Hi", "Payment plans"])).last;
  assert.equal(plans.stage, "education");
  assert.match(plans.reply, /booking payment, instalments during construction, and a balance at handover/);

  const ask = (await talk(["Hi", "Ask a question"])).last;
  assert.match(ask.reply, /Ask me anything about Abu Dhabi property/);

  const arPlans = (await talk(["مرحبا", "خطط السداد"])).last;
  assert.match(arPlans.reply, /دفعة الحجز/);
});

test("a returning buyer is offered to continue or start fresh, not re-qualified", async () => {
  const { engine } = await talk([]);
  await engine.handleMessage("returning", "Budget 2M in Yas", { useLlm: false });
  const back = await engine.handleMessage("returning", "Hi", { useLlm: false });
  assert.equal(back.stage, "welcome_back");
  assert.doesNotMatch(back.reply, /What budget/);
});
