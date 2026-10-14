import assert from "node:assert/strict";
import test from "node:test";
import { setupConversation, talk } from "./helpers.js";
import { fallbackSafeText } from "../src/conversation/replies.js";

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

test("bare and explained payment splits explain percentages without inventing payment dates", async () => {
  for (const message of ["20/80", "What does 20/80 mean?", "اشرح ٢٠/٨٠", "٢٠/٨٠ يعني شو؟"]) {
    const { last } = await talk([message]);
    assert.equal(last.stage, "education", message);
    assert.match(last.reply, /20\/80/);
    assert.match(last.reply, /20%.*80%/);
    assert.doesNotMatch(last.reply, /20%[^.!؟]*construction|80%[^.!؟]*handover|20%[^.!؟]*البناء|80%[^.!؟]*التسليم|Q[1-4]|\b20\d{2}\b|AED/);
    assert.doesNotMatch(last.reply, /budget|ميزاني/i);
    assert.equal(last.check.ok, true);
    assert.equal(last.nextQuestion.field, "factProject");
  }
});

test("Arabic and English investment replies offer a useful route without personal questions", async () => {
  for (const message of ["Investment", "استثمار"]) {
    const { last } = await talk([message]);
    assert.equal(last.nextQuestion.field, "investmentRoute");
    assert.match(last.reply, /ready.*off-plan|جاهز.*على الخارطة/i);
    assert.doesNotMatch(last.reply, /nationality|جنسي|phone|رقم|budget|ميزاني/i);
    assert.equal(last.check.ok, true);
  }
  for (const [message, choice] of [["Investment", "Ready"], ["استثمار", "جاهز"]]) {
    const { last } = await talk([message, choice]);
    assert.equal(last.buyer.investmentStrategy, "READY_INCOME");
    assert.match(last.reply, /completed homes|العقارات الجاهزة/);
    assert.equal(last.nextQuestion.field, "budgetAed");
    assert.equal(last.check.ok, true);
  }
});

test("a nationality objection acknowledges the boundary and continues the investment discussion", async () => {
  for (const message of ["شدخلك؟", "Why do you need my nationality?"]) {
    const { engine } = await setupConversation();
    engine.memory.setLastAskedField("privacy", "nationality");
    await engine.buyers.remember("privacy", { useType: "investment" });
    const last = await engine.handleMessage("privacy", message);
    assert.equal(last.stage, "conversation_repair");
    assert.match(last.reply, /Fair point|معك حق/);
    assert.match(last.reply, /ready.*off-plan|جاهز.*على الخارطة/);
    assert.equal(last.nextQuestion.field, "investmentRoute");
    assert.equal(last.followUpSubmitted, false);
    assert.equal(last.check.ok, true);
  }
});

test("personal-information refusals are acknowledged and never repeated during property advice", async () => {
  for (const refusal of ["I don't want to share personal information", "لا أبغي أشارك معلوماتي", "ما أبي أعطيك رقمي", "No WhatsApp", "ما أبي واتساب"]) {
    const { engine, turns } = await talk(["Can I talk to someone?", refusal]);
    const declined = turns.at(-1);
    assert.equal(declined.buyer.contactDeclined, true, refusal);
    assert.equal(declined.nextQuestion, null, refusal);
    assert.equal(engine.memory.getPendingOffer("buyer"), null);
    const last = await engine.handleMessage("buyer", "What is the price of Yas Studio One?");
    assert.match(last.reply, /AED 850,000/);
    assert.doesNotMatch(last.reply, /phone|nationality|number|connect you|رقم|جنسي/i);
    assert.equal(last.buyer.contactDeclined, true);
    assert.equal(last.check.ok, true);
  }
});

test("a checked fallback names the missing fact in the buyer's language without budget capture", () => {
  for (const language of ["en", "ar"]) {
    const text = fallbackSafeText([], { language, topic: "availability" });
    assert.match(text, /availability.*current check|التوفر الحالي.*تحقق/);
    assert.doesNotMatch(text, /budget|ميزاني|AED|phone|رقم/i);
    assert.equal((text.match(/[?؟]/g) || []).length, 1);
  }
});

test("investment answers do not echo unsupported numeric ROI or appreciation promises", async () => {
  for (const message of ["10% ROI for 10 years?", "Will it appreciate 20%?", "هل العائد ١٠٪ مضمون لعشر سنوات؟", "Can you guarantee a 10% return?"]) {
    const { last } = await talk([message]);
    assert.doesNotMatch(last.reply, /\d+(?:\.\d+)?\s*(?:%|٪|percent)|\bwill appreciate\b/i);
    assert.equal(last.check.ok, true, message);
    assert.doesNotMatch(last.reply, /budget|ميزاني/i);
  }
});

test("accepting an availability check preserves the discussed unit in English and Arabic", async () => {
  for (const [question, acceptance] of [["What is the payment plan?", "Yes"], ["ما خطة السداد؟", "نعم"]]) {
    const { turns, last } = await talk(["Budget 2M, 2 bedroom in Yas", question, acceptance]);
    assert.equal(turns[1].stage, "fact_answer");
    assert.equal((turns[1].reply.match(/[?؟]/g) || []).length, 1);
    assert.equal(last.stage, "fact_answer");
    assert.equal(last.packs[0].unitId, "unt_ypv_2");
    assert.match(last.reply, /limited|محدود/i);
    assert.equal(last.check.ok, true);
  }
});
