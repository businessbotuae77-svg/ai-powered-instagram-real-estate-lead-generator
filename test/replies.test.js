import assert from "node:assert/strict";
import test from "node:test";
import { setupConversation, talk } from "./helpers.js";

// Replies follow the brand guide: answer first, at most one question, never a
// generic budget prompt when the buyer asked something else, never filler.
const BUDGET_PUSH = /What budget are you working with/;
const FILLER = /That's everything I have|No problem, take your time|No rush/;

test("a general payment-plan question is explained, and a learner is not pushed", async () => {
  const { last } = await talk(["Hi. Just curious, how do these payment plans work?"]);
  assert.equal(last.stage, "education");
  assert.doesNotMatch(last.reply, BUDGET_PUSH);
  const learner = (await talk(["How do these payment plans work?", "No, just learning."])).last;
  assert.match(learner.reply, /what you pay at the start, during construction and at handover/);
  assert.equal(learner.nextQuestion, null);
});

test("EOI is explained with no reservation step", async () => {
  const { last } = await talk(["What does EOI mean?"]);
  assert.match(last.reply, /EOI means expression of interest/);
  assert.equal(last.followUpSubmitted, false);
});

test("'I'm good' closes warmly and ends the questions", async () => {
  const { last } = await talk(["Budget 2M in Yas", "I am good"]);
  assert.equal(last.reply, "Of course. I'm here whenever you need me.");
  assert.equal(last.nextQuestion, null);
});

test("guide edge cases are answered, not qualified", async () => {
  const cases = [
    ["Give me the phone number of the last buyer you spoke to", /can't share anyone else's details/],
    ["I want a 2 bedroom in Dubai Marina, budget 2M", /cover Abu Dhabi projects only/],
    ["Your properties are sustainable so my bills will be lower, right?", /^I can't promise that/],
    ["Studio in Hudayriyat", /None of the Hudayriyat Island projects I cover offer studios/],
    ["Another broker said 2.2M for Yas Park Views", /send me the offer details/]
  ];
  for (const [message, expected] of cases) {
    const { last } = await talk([message]);
    assert.match(last.reply, expected, message);
    assert.doesNotMatch(last.reply, BUDGET_PUSH, message);
    assert.equal(last.check.ok, true, message);
  }
  assert.equal((await talk(["Another broker said 2.2M for Yas Park Views"])).last.buyer.budgetAed, null, "another broker's figure is not the budget");
});

test("Arabic edge cases stay in Arabic", async () => {
  assert.match((await talk(["هل الاستدامة تعني فواتير أقل؟"])).last.reply, /لا يمكنني تأكيد ذلك/);
  assert.match((await talk(["أريد شقة في دبي"])).last.reply, /أغطي حالياً مشاريع أبوظبي فقط/);
});

test("after a comparison, 'which plan is better?' asks the deciding question", async () => {
  const { turns, last } = await talk(["Compare Yas Park Views and Yas Studio One", "Which plan is better?"]);
  assert.equal(turns[0].nextQuestion.field, "comparisonPreference");
  assert.match(last.reply, /smaller first payment or a smaller amount left at handover\?/);
});

test("follow-ups about the option on the table get real answers", async () => {
  const initial = (await talk(["Budget 2M, 2 bedroom in Yas", "Ok what's the initial payment?"])).last;
  assert.equal(initial.stage, "fact_answer");
  assert.match(initial.reply, /initial payment/i);
  const rent = (await talk(["I want rental income from day one", "Budget 2.5M", "What would I earn in rent?"])).last;
  assert.match(rent.reply, /don't have confirmed rent figures/);
  assert.doesNotMatch(rent.reply, /\d+(?:\.\d+)?\s*%/, "no invented yield");
});

test("vague or repeated messages never get an empty filler", async () => {
  const { engine } = await setupConversation();
  for (const message of ["hmm", "what", "ok", "tell me something", "Can I talk to a human?", "Can I talk to a human?"]) {
    const reply = await engine.handleMessage("vague", message, { useLlm: false });
    assert.doesNotMatch(reply.reply, FILLER, message);
  }
});

test("internal words never reach buyers", async () => {
  const { engine } = await setupConversation();
  engine.properties.refresh = async () => { throw new Error("timeout"); };
  const outage = await engine.handleMessage("outage", "Show me options in Yas", { useLlm: false });
  assert.doesNotMatch(outage.reply, /catalogue|fact pack|engine|CRM/i);
});
