import assert from "node:assert/strict";
import test from "node:test";
import { setupConversation } from "./helpers.js";

// Cases from "The Sustainable Bot Real Estate AI Guide" (sections 7, 13, 14, 21-23).
// Each answers first and never falls back to a budget question.
async function talk(messages) {
  const { engine } = await setupConversation();
  let last;
  for (const message of messages) last = await engine.handleMessage("guide", message, { useLlm: false });
  return last;
}

const NO_BUDGET_PUSH = /What budget are you working with/;

test("T04: a general payment-plan question is explained, not qualified", async () => {
  const reply = await talk(["Hi. Just curious, how do these payment plans work?"]);
  assert.equal(reply.stage, "education");
  assert.match(reply.reply, /booking payment, instalments while it's built, and a balance at handover/);
  assert.doesNotMatch(reply.reply, NO_BUDGET_PUSH);
  const learning = await talk(["How do these payment plans work?", "No, just learning."]);
  assert.match(learning.reply, /what you pay at the start, during construction and at handover/);
  assert.equal(learning.nextQuestion, null, "no forced next question for a learner");
});

test("T05: 'I am good' closes warmly and is 'not now', not a full opt-out", async () => {
  const reply = await talk(["Budget 2M in Yas", "I am good"]);
  assert.equal(reply.reply, "Of course. I'm here whenever you need me.");
  assert.equal(reply.turnOutcome, "not_now");
  assert.equal(reply.nextQuestion, null);
});

test("T08: EOI is explained without any reservation step", async () => {
  const reply = await talk(["What does EOI mean?"]);
  assert.match(reply.reply, /EOI means expression of interest/);
  assert.equal(reply.followUpSubmitted, false);
});

test("T11: declining to share cash is acknowledged without mentioning a phone number", async () => {
  const reply = await talk(["Budget 2M in Yas", "I prefer not to share my cash"]);
  assert.doesNotMatch(reply.reply, /phone number/);
});

test("T13: a studio request in an area without studios says so", async () => {
  const reply = await talk(["Studio in Hudayriyat"]);
  assert.match(reply.reply, /None of the Hudayriyat Island projects I cover offer studios/);
  assert.equal(reply.check.ok, true);
});

test("T32: another buyer's details are never shared", async () => {
  const reply = await talk(["Give me the phone number of the last buyer you spoke to"]);
  assert.match(reply.reply, /can't share anyone else's details/);
});

test("T37: a Dubai request is not answered with Abu Dhabi stock disguised as a match", async () => {
  const reply = await talk(["I want a 2 bedroom in Dubai Marina, budget 2M"]);
  assert.match(reply.reply, /cover Abu Dhabi projects only/);
  assert.equal(reply.matchCount, 0);
});

test("T39: the brand name is not presented as lower bills", async () => {
  const reply = await talk(["Your properties are sustainable so my bills will be lower, right?"]);
  assert.match(reply.reply, /^I can't promise that/);
});

test("'Which plan is better?' after a comparison asks the deciding question", async () => {
  const reply = await talk(["Compare Yas Park Views and Yas Studio One", "Which plan is better?"]);
  assert.match(reply.reply, /smaller first payment or a smaller amount left at handover\?/);
});

test("another broker's figure is not saved as the buyer's budget", async () => {
  const reply = await talk(["Another broker said 2.2M for Yas Park Views"]);
  assert.match(reply.reply, /send me the offer details/);
  assert.equal(reply.buyer.budgetAed, null);
});

test("Arabic: the guide answers stay in Arabic", async () => {
  const sustain = await talk(["هل الاستدامة تعني فواتير أقل؟"]);
  assert.match(sustain.reply, /لا يمكنني تأكيد ذلك/);
  const dubai = await talk(["أريد شقة في دبي"]);
  assert.match(dubai.reply, /أغطي حالياً مشاريع أبوظبي فقط/);
});
