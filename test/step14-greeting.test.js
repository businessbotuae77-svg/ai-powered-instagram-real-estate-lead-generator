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
  assert.match(fresh.reply, /buying.*home.*investing.*exploring/i);
  assert.equal(fresh.nextQuestion.field, "useType");
  const buyer = await buyers.getOrCreate("ig_m2_hi2");
  assert.equal(buyer.budgetAed, null);
  assert.deepEqual(buyer.preferredAreas, []);
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
