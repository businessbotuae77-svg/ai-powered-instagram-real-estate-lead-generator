import assert from "node:assert/strict";
import test from "node:test";
import { setupConversation } from "./helpers.js";
import { lookupProjectSales } from "../src/facts/project-knowledge.js";

// When no listed home fits, the bot shows projects whose recorded developer
// sales (last 12 months) fit the budget, labelled as sale prices, never quotes.

function listedProjects(reply) {
  return [...reply.matchAll(/^[1-3]️⃣ (.+?) · /gmu)].map(match => match[1]);
}

function typicalWithinBudget(engine, name, budget) {
  const rows = lookupProjectSales(engine.projectKnowledge, { project: name, period: "Last 12 months", saleSequence: "Primary", saleType: "Off-plan" });
  return rows.some(row => row.bedrooms !== "All" && row.medianPriceAed <= budget);
}

test("a search no listed home fits shows recorded developer sales within the budget, not a dead end", async () => {
  const { engine } = await setupConversation();
  const first = await engine.handleMessage("sold", "2 bedroom in Shamkha under 1.5M");
  assert.equal(first.stage, "project_knowledge", first.reply);
  assert.equal(first.check.ok, true, JSON.stringify(first.check.violations));
  assert.match(first.reply, /these projects sold 2-bed apartments within your budget in the last 12 months/);
  assert.match(first.reply, /recorded developer sales \(ADREC\) over the last 12 months to 2026-10-14, not today's asking price/);
  const names = listedProjects(first.reply);
  assert.equal(names.length, 3);
  for (const name of names) assert.ok(typicalWithinBudget(engine, name, 1500000), name);
  assert.match(first.reply, /· Al Shamkhah —/);
  assert.doesNotMatch(first.reply, /Khalifa City|Al Reem Island/);
  assert.deepEqual(first.buyer.preferredAreas, ["Al Shamkhah"]);
  assert.deepEqual(first.nextQuestion.choices.slice(0, 3).map(choice => choice.value), names);
  assert.equal(first.followUpSubmitted, false);

  const more = await engine.handleMessage("sold", "Hmm. Whats other projects");
  assert.equal(more.check.ok, true, JSON.stringify(more.check.violations));
  const next = listedProjects(more.reply);
  assert.ok(next.length > 0, more.reply);
  assert.ok(next.every(name => !names.includes(name)), "no project is repeated");
  assert.match(more.reply, /more projects where 2-bed apartments sold within your budget/);
});

test("a tapped project gets its recorded sales answer and a next step with buttons", async () => {
  const { engine } = await setupConversation();
  const list = await engine.handleMessage("tap", "I want a 1 bedroom in Reem, budget 1.2M");
  const name = list.nextQuestion.choices[0].value;
  const answer = await engine.handleMessage("tap", name);
  assert.equal(answer.stage, "project_knowledge", answer.reply);
  assert.equal(answer.check.ok, true, JSON.stringify(answer.check.violations));
  assert.match(answer.reply, new RegExp(`${name} is in Al Reem Island`));
  assert.match(answer.reply, /What would you like to do next\?$/);
  assert.deepEqual(answer.nextQuestion.choices.map(choice => choice.label), ["More options", "Talk to an agent"]);
  assert.equal(answer.pendingOffer, null);
});

test("Arabic buyers get the recorded sales list in Arabic", async () => {
  const { engine } = await setupConversation();
  const result = await engine.handleMessage("sold-ar", "ابي شقة غرفتين في الشامخة ميزانيتي 1.5 مليون");
  assert.equal(result.stage, "project_knowledge", result.reply);
  assert.equal(result.check.ok, true, JSON.stringify(result.check.violations));
  assert.match(result.reply, /انباعت فيها/);
  assert.match(result.reply, /مبيعات المطور المسجلة \(ADREC\)/);
  assert.doesNotMatch(result.reply, /typically|developer sales|Which one/);
});

test("other-project wording is recognised however it is typed", async () => {
  const { wantsMoreOptions } = await import("../src/conversation/concierge.js");
  for (const message of ["Hmm. Whats other projects", "what other projects do you have?", "ok what else?", "any other options", "في مشاريع ثانية؟"]) {
    assert.equal(wantsMoreOptions(message), true, message);
  }
  for (const message of ["Whats the price", "Tell me about Yas", "other fees?"]) assert.equal(wantsMoreOptions(message), false, message);
});
