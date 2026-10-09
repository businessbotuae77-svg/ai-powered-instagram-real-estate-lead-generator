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
  assert.match(fresh.reply, /area.*project.*budget/i);
  assert.equal(fresh.nextQuestion.field, "explorationTopic");
  const buyer = await buyers.getOrCreate("ig_m2_hi2");
  assert.equal(buyer.budgetAed, null);
  assert.deepEqual(buyer.preferredAreas, []);
});

test("a first hello offers useful property hooks instead of a buyer-type form", async () => {
  const { engine } = await setupConversation();
  const hi = await engine.handleMessage("opening-hook", "Hi");
  assert.equal(hi.stage, "exploring");
  assert.equal(hi.nextQuestion?.field, "explorationTopic");
  assert.match(hi.reply, /explore Abu Dhabi areas.*compare current projects.*payment plans/i);
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
