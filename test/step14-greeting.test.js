import assert from "node:assert/strict";
import test from "node:test";
import { setupConversation } from "./helpers.js";

test("step 14a Hi alone does not soft-pitch leftover buyer criteria", async () => {
  const { engine } = await setupConversation();
  await engine.handleMessage("ig_m2_hi1", "Budget AED 2M and Yas Island");
  const hi = await engine.handleMessage("ig_m2_hi1", "Hi");
  assert.equal(hi.stage, "welcome_back");
  assert.match(hi.reply, /Hi\. Happy to help/i);
  assert.match(hi.reply, /continue|start fresh/i);
  assert.doesNotMatch(hi.reply, /exact match for everything you asked for/i);
  assert.doesNotMatch(hi.reply, /Yas Park Views by Aldar/i);
  assert.ok(hi.nextQuestion?.choices?.some((c) => /fresh/i.test(c.label)));
});

test("step 14b Start fresh clears criteria then opens purpose and exploration", async () => {
  const { engine, buyers } = await setupConversation();
  await engine.handleMessage("ig_m2_hi2", "Budget AED 2M and Yas Island");
  const fresh = await engine.handleMessage("ig_m2_hi2", "Start fresh");
  assert.equal(fresh.stage, "exploring");
  assert.match(fresh.reply, /The Sustainable Bot, your AI guide to UAE property\. What would you like to explore\?/);
  assert.equal(fresh.nextQuestion.field, "explorationTopic");
  const buyer = await buyers.getOrCreate("ig_m2_hi2");
  assert.equal(buyer.budgetAed, null);
  assert.deepEqual(buyer.preferredAreas, []);
});

test("a first hello introduces the bot as the guide describes and offers three choices", async () => {
  const { engine } = await setupConversation();
  const hi = await engine.handleMessage("opening-hook", "Hi");
  assert.equal(hi.stage, "exploring");
  assert.equal(hi.nextQuestion?.field, "explorationTopic");
  assert.equal(hi.reply, "Hi 👋 I'm The Sustainable Bot, your AI guide to UAE property. What would you like to explore?");
  assert.deepEqual(hi.nextQuestion.choices.map(choice => choice.label), ["Find a property", "Payment plans", "Ask a question"]);
  assert.doesNotMatch(hi.reply, /budget/i, "the welcome invites a conversation, not a budget");
  assert.doesNotMatch(hi.reply, /are you buying a home, investing, or just exploring/i);
});

test("the areas hook answers with Abu Dhabi area guidance before asking for a preference", async () => {
  const { engine } = await setupConversation();
  await engine.handleMessage("area-hook", "Hi");
  const areas = await engine.handleMessage("area-hook", "Areas");
  assert.equal(areas.stage, "area_guide");
  assert.equal(areas.check.ok, true, JSON.stringify(areas.check.violations));
  assert.match(areas.reply, /Hudayriyat[\s\S]*family-friendly[\s\S]*Yas[\s\S]*entertainment[\s\S]*Masdar City/i);
  assert.equal(areas.nextQuestion?.field, "areaInterest");
});

test("step 14c Continue after Hi resumes with confirmed options", async () => {
  const { engine } = await setupConversation();
  await engine.handleMessage("ig_m2_hi3", "Budget AED 2M and Yas Island");
  await engine.handleMessage("ig_m2_hi3", "Hi");
  const cont = await engine.handleMessage("ig_m2_hi3", "Continue");
  assert.ok(cont.matchCount >= 1);
  assert.match(cont.reply, /Yas Park Views|Yas Studio/i);
  assert.doesNotMatch(cont.reply, /Want to continue with your last search/i);
});

test("each welcome choice gets its own useful reply, in English and Arabic", async () => {
  const { engine } = await setupConversation();
  const find = await engine.handleMessage("choice-find", "Find a property");
  assert.equal(find.nextQuestion.field, "useType");
  assert.match(find.reply, /buying a home to live in, investing, or not sure yet\?/);
  const plans = await engine.handleMessage("choice-plans", "Payment plans");
  assert.equal(plans.stage, "education");
  assert.match(plans.reply, /booking payment, instalments during construction, and a balance at handover/);
  assert.equal(plans.check.ok, true);
  const ask = await engine.handleMessage("choice-ask", "Ask a question");
  assert.match(ask.reply, /Ask me anything about Abu Dhabi property/);
  const arHi = await engine.handleMessage("choice-ar", "مرحبا");
  assert.match(arHi.reply, /أنا The Sustainable Bot، دليلك الذكي لعقارات الإمارات/);
  assert.deepEqual(arHi.nextQuestion.choices.map(choice => choice.label), ["ابحث عن عقار", "خطط السداد", "اسأل سؤالاً"]);
  const arPlans = await engine.handleMessage("choice-ar", "خطط السداد");
  assert.match(arPlans.reply, /دفعة الحجز/);
});
