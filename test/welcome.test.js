import assert from "node:assert/strict";
import test from "node:test";
import { talk, setupConversation } from "./helpers.js";

// The opening: who the bot is and what it does in one line, then four buttons.
const EN = "Hi 👋 Welcome to The Sustainable Bot.\nI help you find the right off-plan home in Abu Dhabi, with real prices, payment plans and handover dates in seconds.\nWhat can I help you with?";

test("a first hello introduces the bot and offers four choices, without asking for a budget", async () => {
  const { last } = await talk(["Hi"]);
  assert.equal(last.reply, EN);
  assert.deepEqual(last.nextQuestion.choices.map(c => c.label), ["Find a property", "Explore by budget", "Payment plans", "Talk to an agent"]);
  assert.equal(last.outcome, "browsing");
});

test("the welcome greets the buyer by first name when Instagram shares it", async () => {
  const { engine } = await setupConversation();
  await engine.buyers.patchBuyer("named", { firstName: "Sara" });
  const last = await engine.handleMessage("named", "Hello");
  assert.match(last.reply, /^Hi Sara 👋 Welcome to The Sustainable Bot\./);
});

test("Arabic and Gulf greetings get the Arabic welcome and Arabic buttons", async () => {
  for (const hello of ["مرحبا", "هلا", "السلام عليكم"]) {
    const { last } = await talk([hello]);
    assert.match(last.reply, /حياك في The Sustainable Bot/);
    assert.doesNotMatch(last.reply, /Welcome|Find a property|What can I/);
    assert.deepEqual(last.nextQuestion.choices.map(c => c.label), ["ابحث عن عقار", "خيارات حسب ميزانيتك", "خطط السداد", "كلّم موظف"]);
  }
});

test("Start fresh clears the search and shows the welcome again", async () => {
  const { last } = await talk(["Budget 2M in Yas", "Start fresh"]);
  assert.match(last.reply, /^Fresh start 👋/);
  assert.equal(last.buyer.budgetAed, null);
  assert.deepEqual(last.buyer.preferredAreas, []);
});

test("each button has its own useful reply, with buttons for the next step", async () => {
  const find = (await talk(["Hi", "Find a property"])).last;
  assert.equal(find.nextQuestion.field, "useType");
  assert.match(find.reply, /Is it a home to live in, or an investment\?/);
  assert.deepEqual(find.nextQuestion.choices.map(c => c.label), ["To live in", "Investment", "Not sure yet"]);

  const invest = (await talk(["Hi", "Find a property", "Investment"])).last;
  assert.equal(invest.nextQuestion.field, "budgetAed");
  assert.match(invest.reply, /^Investment, got it 👍/);
  assert.equal(invest.nextQuestion.choices.length, 6);

  const live = (await talk(["Hi", "Find a property", "To live in"])).last;
  assert.equal(live.nextQuestion.field, "bedrooms");

  const plans = (await talk(["Hi", "Payment plans"])).last;
  assert.equal(plans.stage, "education");
  assert.match(plans.reply, /On booking[\s\S]*During construction[\s\S]*On handover/);
  assert.ok(plans.nextQuestion.choices.length >= 2);

  const cheapest = (await talk(["Hi", "Show the cheapest"])).last;
  assert.match(cheapest.reply, /lower-priced options in Abu Dhabi/);
  assert.equal(cheapest.check.ok, true);

  const agent = (await talk(["Hi", "Talk to an agent"])).last;
  assert.equal(agent.stage, "follow_up_channel");
  assert.deepEqual(agent.nextQuestion.choices.map(c => c.label), ["WhatsApp", "Phone call", "Here on Instagram"]);

  const ask = (await talk(["Hi", "Ask a question"])).last;
  assert.match(ask.reply, /Ask me anything about Abu Dhabi property/);

  const arPlans = (await talk(["مرحبا", "خطط السداد"])).last;
  assert.match(arPlans.reply, /دفعة الحجز/);
  const arFind = (await talk(["مرحبا", "ابحث عن عقار"])).last;
  assert.deepEqual(arFind.nextQuestion.choices.map(c => c.label), ["للسكن", "للاستثمار", "ما قررت بعد"]);
});

test("a returning buyer is offered to continue or start fresh, not re-qualified", async () => {
  const { engine } = await talk([]);
  await engine.handleMessage("returning", "Budget 2M in Yas", { useLlm: false });
  const back = await engine.handleMessage("returning", "Hi", { useLlm: false });
  assert.equal(back.stage, "welcome_back");
  assert.match(back.reply, /^Welcome back 👋/);
  assert.doesNotMatch(back.reply, /What budget/);
});
