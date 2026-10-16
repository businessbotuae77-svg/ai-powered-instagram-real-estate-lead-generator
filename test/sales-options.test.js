import assert from "node:assert/strict";
import test from "node:test";
import { setupConversation, talk } from "./helpers.js";
import { lookupProjectSales } from "../src/facts/project-knowledge.js";

// When no listed home fits, the bot shows projects whose recorded developer
// sales (last 12 months) fit the budget, labelled as sale prices, never quotes.
// A project the bot knows from those sales is shown as a card, like a listing.

const SOURCES = /ADREC|adrec\.gov\.ae|Source:|المصدر/;

/** Project names in a reply: the card's 🏙️ line, then the numbered lines. */
function listedProjects(reply) {
  return [...reply.matchAll(/^(?:🏙️|[1-3]️⃣) (.+?)(?= · |$)/gmu)].map(match => match[1]);
}

function typicalWithinBudget(engine, name, budget) {
  const rows = lookupProjectSales(engine.projectKnowledge, { project: name, period: "Last 12 months", saleSequence: "Primary", saleType: "Off-plan" });
  return rows.some(row => row.bedrooms !== "All" && row.medianPriceAed <= budget);
}

test("a budget search shows the lowest-priced matching projects from recorded developer sales", async () => {
  const { engine } = await setupConversation();
  const first = await engine.handleMessage("sold", "2 bedroom in Shamkha under 1.5M");
  assert.equal(first.stage, "soft_match", first.reply);
  assert.equal(first.check.ok, true, JSON.stringify(first.check.violations));
  assert.match(first.reply, /projects within your budget in Al Shamkhah/);
  assert.match(first.reply, /1️⃣ PUD Residence 1 · Al Shamkhah\n2-bed apartment · Guide price around AED [\d.]+[MK]/u);
  assert.doesNotMatch(first.reply, /not today's asking price|payment plan|handover/i);
  assert.doesNotMatch(first.reply, SOURCES);
  const names = listedProjects(first.reply);
  assert.equal(names.length, 3);
  for (const name of names) assert.ok(typicalWithinBudget(engine, name, 1500000), name);
  assert.match(first.reply, /· Al Shamkhah/);
  assert.doesNotMatch(first.reply, /Khalifa City|Al Reem Island/);
  assert.deepEqual(first.buyer.preferredAreas, ["Al Shamkhah"]);
  assert.deepEqual(first.nextQuestion.choices.slice(0, 3).map(choice => choice.value), names);
  assert.equal(first.followUpSubmitted, false);

  const more = await engine.handleMessage("sold", "Hmm. Whats other projects");
  assert.equal(more.check.ok, true, JSON.stringify(more.check.violations));
  const next = listedProjects(more.reply);
  assert.ok(next.length > 0, more.reply);
  assert.ok(next.every(name => !names.includes(name)), "no project is repeated");
  assert.match(more.reply, /More options in Al Shamkhah/);
});

test("a budget search includes cheaper recorded matches even when listings also fit", async () => {
  const { last } = await talk(["Hi", "budget 2M"]);
  assert.equal(last.stage, "soft_match", last.reply);
  assert.equal(last.check.ok, true, JSON.stringify(last.check.violations));
  assert.match(last.reply, /^I found these projects within your budget/);
  assert.doesNotMatch(last.reply, /I don't have a listed price|Recorded sale prices/);
  assert.ok(last.projectKnowledge.projectNames.includes("Plaza 1"));
});

test("a project known from recorded sales is shown as a card with buttons, not as statistics", async () => {
  const { engine } = await setupConversation();
  const list = await engine.handleMessage("tap", "I want a 1 bedroom in Reem, budget 1.2M");
  const name = list.nextQuestion.choices[0].value;
  const card = await engine.handleMessage("tap", name);
  assert.equal(card.stage, "project_knowledge", card.reply);
  assert.equal(card.check.ok, true, JSON.stringify(card.check.violations));
  assert.match(card.reply, new RegExp(`^🏙️ ${name}\\n📍 Al Reem Island`, "u"));
  assert.match(card.reply, /🏠 1-bed apartment · about [\d,]+ sq ft · guide price around AED [\d.]+[MK]/);
  assert.doesNotMatch(card.reply, /📊|developer sales in the last 12 months/);
  assert.match(card.reply, /For your budget.*1-bed apartment/);
  assert.match(card.reply, /confirmed here on Instagram\?$/);
  assert.doesNotMatch(card.reply, /average AED|\/sqft|Primary off-plan|year to date|Data through/);
  assert.doesNotMatch(card.reply, SOURCES);
  assert.deepEqual(card.nextQuestion.choices.map(choice => choice.label), ["Check price & units", "More options", "About the area"]);
  assert.deepEqual(card.pendingOffer, { type: "instagram_price_offer", projectName: name, channel: "instagram" });

  const area = await engine.handleMessage("tap", "About the area");
  assert.equal(area.stage, "area_guide", area.reply);
  assert.match(area.reply, /^📍 Al Reem Island/);

  const price = await engine.handleMessage("tap", card.nextQuestion.choices[0].value);
  assert.equal(price.stage, "follow_up_requested", price.reply);
  assert.equal(price.followUpSubmitted, true);
  assert.match(price.reply, /reply here on Instagram/);
});

test("a project gets a card, its price follow-up is brief, and yes explores the offered home size", async () => {
  const { engine } = await setupConversation();
  const card = await engine.handleMessage("about", "Tell me about Merito");
  assert.equal(card.check.ok, true, JSON.stringify(card.check.violations));
  assert.match(card.reply, /^🏙️ Merito\n📍 Al Shamkhah\n/u);
  assert.equal((card.reply.match(/^🏠 /gmu) || []).length, 3);
  const focused = await engine.handleMessage("about", "And the 2 BR price?");
  assert.equal(focused.check.ok, true, JSON.stringify(focused.check.violations));
  assert.match(focused.reply, /2-bed apartment.*AED 1\.36M/);
  assert.doesNotMatch(focused.reply, /1-bed|3-bed/);
  const yes = await engine.handleMessage("about", "yes");
  assert.equal(yes.stage, "soft_match", yes.reply);
  assert.deepEqual(yes.buyer.bedrooms, [2]);
  assert.equal(yes.followUpSubmitted, false);
});

test("an area project search uses the same price-ranked discovery as budget searches", async () => {
  const { engine } = await setupConversation();
  for (const [id, message, area] of [["yas", "What projects do you have in Yas?", "Yas Island"], ["shamkha", "Which projects are in Al Shamkhah?", "Al Shamkhah"]]) {
    const found = await engine.handleMessage(id, message);
    assert.equal(found.check.ok, true, JSON.stringify(found.check.violations));
    assert.equal(found.stage, "soft_match");
    assert.equal(listedProjects(found.reply).length, 3);
    assert.match(found.reply, new RegExp(`lower-priced options in ${area}`));
    assert.doesNotMatch(found.reply, SOURCES);
    assert.doesNotMatch(found.reply, /today's prices|busiest/);
  }
});

test("asking about a listed project shows its listing card, flagged when it starts above the budget", async () => {
  for (const message of ["Tell me about Yas Park Views", "Yas Park Views", "How much is Yas Park Views?", "حدثني عن Yas Park Views"]) {
    const { last } = await talk([message]);
    assert.equal(last.stage, "matched", `${message}: ${last.reply}`);
    assert.equal(last.check.ok, true, JSON.stringify(last.check.violations));
    assert.match(last.reply, /🏙️ Yas Park Views · (?:by|من) Aldar\n📍 /u, message);
  }
  const over = (await talk(["budget 1M", "How much is Reem Gate?"])).last;
  assert.match(over.reply, /^Here's Reem Gate 👇 Heads up: it starts above your budget\./);
  const plan = (await talk(["Yas Park Views payment plan?"])).last;
  assert.equal(plan.stage, "fact_answer", plan.reply);
});

test("a named statistic keeps the detailed figures, without a source link", async () => {
  const { engine } = await setupConversation();
  const stat = await engine.handleMessage("stat", "What is the average price per sqft in Merito over the last 12 months?");
  assert.equal(stat.check.ok, true, JSON.stringify(stat.check.violations));
  assert.match(stat.reply, /^📊 Merito · Al Shamkhah\nDeveloper sales, off-plan · last 12 months\n🏠 Apartments: average AED [\d,]+\/sq ft · [\d,]+ developer sales\n/u);
  assert.match(stat.reply, /data through 14 Oct 2026/);
  assert.doesNotMatch(stat.reply, SOURCES);
});

test("Arabic buyers get the recorded sales list and cards in Arabic", async () => {
  const { engine } = await setupConversation();
  const result = await engine.handleMessage("sold-ar", "ابي شقة غرفتين في الشامخة ميزانيتي 1.5 مليون");
  assert.equal(result.stage, "soft_match", result.reply);
  assert.equal(result.check.ok, true, JSON.stringify(result.check.violations));
  assert.match(result.reply, /ضمن ميزانيتك/);
  assert.match(result.reply, /شقة غرفتين · سعر استرشادي/);
  assert.match(result.reply, /مبيعات حديثة/);
  assert.doesNotMatch(result.reply, /typically|developer sales|Which one/);
  assert.doesNotMatch(result.reply, SOURCES);

  const card = await engine.handleMessage("sold-ar-2", "حدثني عن Merito");
  assert.equal(card.check.ok, true, JSON.stringify(card.check.violations));
  assert.match(card.reply, /^🏙️ Merito\n📍 الشامخة\n/u);
  assert.doesNotMatch(card.reply, /عملية بيع من المطور خلال آخر 12 شهراً/);
  assert.deepEqual(card.nextQuestion.choices.map(choice => choice.label), ["السعر والتوفر", "خيارات أكثر"]);
});

test("other-project wording is recognised however it is typed", async () => {
  const { wantsMoreOptions } = await import("../src/conversation/concierge.js");
  for (const message of ["Hmm. Whats other projects", "what other projects do you have?", "ok what else?", "any other options", "في مشاريع ثانية؟"]) {
    assert.equal(wantsMoreOptions(message), true, message);
  }
  for (const message of ["Whats the price", "Tell me about Yas", "other fees?"]) assert.equal(wantsMoreOptions(message), false, message);
});
