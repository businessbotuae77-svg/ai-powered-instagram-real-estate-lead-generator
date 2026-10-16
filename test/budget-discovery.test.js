import assert from "node:assert/strict";
import test from "node:test";
import { talk, setupConversation } from "./helpers.js";
import { BUDGET_CHOICES, parseBudgetRange } from "../src/conversation/budget.js";
import { searchProperties } from "../src/conversation/property-search.js";
import { loadProjectKnowledge } from "../src/facts/project-knowledge.js";

const data = loadProjectKnowledge();
const inBand = (turn, min, max = Infinity) => {
  assert.equal(turn.check.ok, true);
  assert.equal(turn.stage, "soft_match");
  assert.ok(turn.buyer.discoverySearch.lastPrices.length);
  assert.ok(turn.buyer.discoverySearch.lastPrices.every(price => price >= min && price <= max));
  assert.equal(turn.followUpSubmitted, false);
};

test("budget buttons preserve both bounds in payloads and English/Arabic labels", () => {
  for (const choice of BUDGET_CHOICES.slice(1)) {
    const expected = parseBudgetRange(choice.value);
    assert.ok(expected);
    assert.deepEqual(parseBudgetRange(choice.label), expected);
    assert.deepEqual(parseBudgetRange(choice.labelAr), expected);
  }
  assert.deepEqual(parseBudgetRange("between 1.5 and 2 million"), { min: 1500000, max: 2000000 });
  assert.deepEqual(parseBudgetRange("من ١٫٥ إلى ٢ مليون"), { min: 1500000, max: 2000000 });
  for (const text of ["1-2 bedrooms", "prices 1.5M–2M", "deposit 1M–2M", "1.5M", "under 2M", "2M–1M"])
    assert.equal(parseBudgetRange(text), null);
});

test("Explore by budget asks for a range before showing projects, in both languages", async () => {
  for (const greeting of ["Hi", "مرحبا"]) {
    const { engine } = await setupConversation();
    const welcome = await engine.handleMessage("budget", greeting);
    const choice = welcome.nextQuestion.choices.find(row => row.id === "explore_budget");
    const turn = await engine.handleMessage("budget", choice.value);
    assert.equal(turn.check.ok, true);
    assert.equal(turn.nextQuestion.field, "budgetAed");
    assert.doesNotMatch(turn.reply, /Harmony Residence|Plaza 1|Vista 2|AED \d/);
    assert.ok(turn.nextQuestion.choices.some(row => row.value === "Budget AED 1.5M–2M"));
    const result = await engine.handleMessage("budget", greeting === "Hi" ? "Budget AED 1.5M–2M" : "ميزانيتي من ١٫٥ إلى ٢ مليون");
    inBand(result, 1500000, 2000000);
  }
});

test("the screenshot's budget change reruns the search and pagination in the selected band", async () => {
  const { turns } = await talk(["Hi", "Cheapest", "Different budget", "AED 1.5M–2M", "More options"]);
  assert.equal(turns[2].nextQuestion.field, "budgetAed");
  assert.equal(turns[2].check.ok, true);
  inBand(turns[3], 1500000, 2000000);
  inBand(turns[4], 1500000, 2000000);
  assert.deepEqual(turns[3].buyer.budgetRange, { min: 1500000, max: 2000000 });
  assert.equal(turns[3].buyer.budgetAed, 2000000);
  assert.doesNotMatch(turns[3].reply, /Harmony Residence|Plaza 1|Vista 2|533K|539K|550K/);
  const first = turns[3].buyer.discoverySearch.shownIds;
  assert.ok(turns[4].buyer.discoverySearch.shownIds.length > first.length);
});

test("a ceiling replaces an old band and fresh start clears both bounds", async () => {
  const { turns } = await talk(["AED 1.5M–2M", "Different budget", "Under AED 1M", "Start fresh"]);
  assert.equal(turns[2].buyer.budgetRange, null);
  assert.equal(turns[2].buyer.budgetAed, 1000000);
  inBand(turns[2], 0, 1000000);
  assert.equal(turns[3].buyer.budgetRange, null);
  assert.equal(turns[3].buyer.budgetAed, null);
});

test("AED 5M+ is a lower bound and more options can exceed AED 5M", async () => {
  const { turns } = await talk(["AED 5M+", "More options"]);
  inBand(turns[0], 5000000);
  inBand(turns[1], 5000000);
  assert.ok(turns[1].buyer.discoverySearch.lastPrices.some(price => price > 5000000));
});

test("a band preserves area and bedroom requirements and never fills an empty band below its floor", async () => {
  const { turns } = await talk(["2 bedroom in Shamkha under 1M", "Different budget", "AED 1.5M–2M", "More options"]);
  for (const turn of turns.slice(2)) {
    inBand(turn, 1500000, 2000000);
    assert.deepEqual(turn.buyer.bedrooms, [2]);
    assert.deepEqual(turn.buyer.preferredAreas, ["Al Shamkhah"]);
    assert.doesNotMatch(turn.reply, /Studio|1-bed|Masdar/);
  }
  const none = searchProperties({ data, buyer: { preferredAreas: ["Masdar City"], bedrooms: [0],
    budgetAed: 2000000, budgetRange: { min: 1900000, max: 2000000 } } });
  assert.equal(none.picks.length, 0);
});

test("explicitly revising a budget is allowed without repeating it on unrelated turns", async () => {
  const { turns } = await talk(["Budget 2M", "Change my budget", "1.5M", "More options"]);
  assert.equal(turns[1].nextQuestion.field, "budgetAed");
  assert.equal(turns[1].check.ok, true);
  assert.equal(turns[2].buyer.budgetAed, 1500000);
  assert.notEqual(turns[3].nextQuestion?.field, "budgetAed");
});

test("the range floor applies to fresh quotes as well as recorded-sale guide prices", async () => {
  const { store, properties } = await setupConversation();
  store.projects = [{ id: "band", developerId: "dev_aldar", name: "Budget Band Fixture", area: "Yas Island", active: true, approved: true,
    source: "Synthetic quote fixture", lastVerified: new Date().toISOString() }];
  store.units = [900000, 1700000, 2300000].map((price, bedrooms) => ({ id: `band-${bedrooms}`,
    projectId: "band", active: true, approved: true, propertyType: "apartment", bedrooms, startingPriceAed: price }));
  const result = searchProperties({ catalog: properties.catalog(), buyer: { budgetAed: 2000000,
    budgetRange: { min: 1500000, max: 2000000 } } });
  assert.equal(result.picks.length, 1);
  assert.equal(result.picks[0].kind, "listing");
  assert.equal(result.picks[0].price, 1700000);
});

test("an empty band asks to adjust the search without advertising below-range studios", async () => {
  const { last } = await talk(["Studio in Masdar", "Different budget", "AED 1.5M–2M"]);
  assert.equal(last.check.ok, true);
  assert.equal(last.stage, "no_match");
  assert.doesNotMatch(last.reply, /Harmony Residence|Plaza 1|Vista 2|533K|539K|550K/);
});

test("opening a recommended project keeps its relevant home type inside the selected band", async () => {
  const { engine } = await setupConversation();
  const search = await engine.handleMessage("band-card", "AED 1.5M–2M");
  const card = await engine.handleMessage("band-card", search.nextQuestion.choices[0].value);
  assert.equal(card.check.ok, true);
  assert.deepEqual(card.buyer.budgetRange, { min: 1500000, max: 2000000 });
  assert.match(card.reply, /2-bed apartment/);
  assert.doesNotMatch(card.reply, /Studio|533K|579K|guide price around AED 9/);
});
