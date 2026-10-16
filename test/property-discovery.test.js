import assert from "node:assert/strict";
import test from "node:test";
import { setupConversation, talk } from "./helpers.js";
import { loadProjectKnowledge, lookupProjectSales } from "../src/facts/project-knowledge.js";
import { projectCommunity, projectInArea, projectLocation } from "../src/facts/project-geography.js";
import { searchProperties } from "../src/conversation/property-search.js";
import { validateMessage } from "../src/facts/checker.js";
import { thesisClaims } from "../src/facts/advisor-claims.js";
import { propertySearchReply } from "../src/conversation/concierge.js";

const data = loadProjectKnowledge();
const names = result => result.picks.map(row => row.name);

test("affordable discovery scans the complete residential price index rather than the listed shortlist", () => {
  const found = searchProperties({ data });
  assert.deepEqual(names(found), ["Harmony Residence", "Plaza 1", "Vista 2"]);
  const expected = lookupProjectSales(data, { period: "Last 12 months", saleSequence: "Primary", saleType: "Off-plan" })
    .filter(row => row.type === "Apartment" && row.bedrooms === "Studio" && row.reliability === "OK")
    .sort((a, b) => a.medianPriceAed - b.medianPriceAed);
  assert.equal(found.picks[0].price, expected[0].medianPriceAed);
  assert.ok(found.total > 100);
  for (const row of found.picks) assert.equal(row.sale.reliability, "OK");
});

test("Masdar is resolved per project and never aliases the whole Khalifa City district", () => {
  const found = searchProperties({ data, message: "Cheapest in Masdar" });
  assert.deepEqual(names(found), ["Plaza 1", "Royal Park", "Plaza 2"]);
  for (const row of found.picks) {
    assert.equal(row.area, "Masdar City");
    assert.equal(row.sale.area, "Khalifa City", "registry evidence is preserved");
    assert.match(projectLocation(row.name, row.district).source, /^https:\/\/reportagegroup\.com\//);
  }
  assert.equal(projectInArea("Reportage Village", "Khalifa City", "Masdar City"), false);
  assert.equal(projectCommunity("Plaza 1", "Al Reem Island"), "Al Reem Island", "a homonym in another district cannot inherit the mapping");
});

test("area, bedrooms, home type, studio, ceiling and named-project filters are strict", () => {
  for (const buyer of [
    { preferredAreas: ["Hudayriyat Island"], bedrooms: [0] },
    { preferredAreas: ["Masdar City"], bedrooms: [2], propertyTypes: ["villa"] },
    { preferredAreas: ["Nurai Island"], budgetAed: 500000 },
    { preferredAreas: ["Al Shamkha"], bedrooms: [6] }
  ]) assert.equal(searchProperties({ data, buyer }).picks.length, 0, JSON.stringify(buyer));
  const found = searchProperties({ data, buyer: { preferredAreas: ["Al Shamkha"], bedrooms: [2], budgetAed: 1500000 } });
  assert.ok(found.picks.length);
  for (const row of found.picks) {
    assert.equal(row.district, "Al Shamkhah");
    assert.equal(row.bedrooms, 2);
    assert.ok(row.price <= 1500000);
  }
  assert.deepEqual(names(searchProperties({ data, message: "cheapest in Merito" })), ["Merito"]);
});

test("fresh unit quotes supersede only the same home's median, with no copied plan or availability", async () => {
  const { store, properties } = await setupConversation();
  store.projects = [{ id: "harmony", developerId: "dev_aldar", name: "Harmony Residence", area: "Al Shamkhah", emirate: "Abu Dhabi", active: true,
    source: "Synthetic quote fixture", lastVerified: new Date().toISOString(), approved: true }];
  store.units = [{ id: "studio", projectId: "harmony", bedrooms: 0, propertyType: "apartment", startingPriceAed: 900000, active: true }];
  const found = searchProperties({ data, catalog: properties.catalog(), message: "cheapest Harmony Residence" });
  assert.equal(found.picks.length, 1);
  assert.equal(found.picks[0].kind, "listing");
  assert.equal(found.picks[0].price, 900000);
  assert.equal(found.picks[0].pack.paymentPlanSummary.confirmed, false);
  assert.equal(found.picks[0].pack.availability.confirmed, false);
  store.units[0].startingPriceAed = 100;
  store.units[0].approved = false;
  const noUnapprovedQuote = searchProperties({ data, catalog: properties.catalog(), message: "cheapest Harmony Residence" });
  assert.equal(noUnapprovedQuote.picks[0].kind, "recorded_sale");
  assert.notEqual(noUnapprovedQuote.picks[0].price, 100);
});

test("Masdar quotes deduplicate the registry identity and an over-budget quote cannot reappear as a cheaper median", async () => {
  const { store, properties } = await setupConversation();
  store.projects = [{ id: "plaza", developerId: "dev_aldar", name: "Plaza 1", area: "Masdar City", emirate: "Abu Dhabi", active: true,
    source: "Synthetic quote fixture", lastVerified: new Date().toISOString(), approved: true }];
  store.units = [{ id: "studio", projectId: "plaza", bedrooms: 0, propertyType: "apartment", startingPriceAed: 990000, active: true }];
  const found = searchProperties({ data, catalog: properties.catalog(), message: "cheapest studio in Plaza 1", buyer: { bedrooms: [0] } });
  assert.equal(found.picks.length, 1);
  assert.equal(found.picks[0].kind, "listing");
  assert.equal(found.picks[0].price, 990000);
  const capped = searchProperties({ data, catalog: properties.catalog(), message: "cheapest in Plaza 1", buyer: { bedrooms: [0], budgetAed: 600000 } });
  assert.equal(capped.picks.length, 0);
});

test("English and Gulf Arabic cheapest turns show Shamkha and Masdar, with working project choices", async () => {
  for (const messages of [["Hi", "Cheapest"], ["مرحبا", "ارخص"]]) {
    const { last } = await talk(messages);
    assert.equal(last.check.ok, true);
    assert.match(last.reply, /Harmony Residence/);
    assert.match(last.reply, /Plaza 1/);
    assert.match(last.reply, /Al Shamkhah|الشامخة/);
    assert.match(last.reply, /Masdar City|مدينة مصدر/);
    assert.equal(last.nextQuestion.choices[0].value, "Harmony Residence");
    assert.doesNotMatch(last.reply, /lowest-priced home I have right now|Nawayef|not today's asking price/);
    assert.equal(last.followUpSubmitted, false);
    assert.equal(last.intentAlert, null);
  }
});

test("pagination preserves search filters through a project card and never repeats a page", async () => {
  const { engine } = await setupConversation();
  const first = await engine.handleMessage("pages", "2 bedroom in Shamkha under 1.5M");
  const selected = first.nextQuestion.choices[0].value;
  await engine.handleMessage("pages", selected);
  const more = await engine.handleMessage("pages", "More options");
  assert.equal(more.check.ok, true);
  const oldNames = first.projectKnowledge.projectNames;
  assert.ok(more.projectKnowledge.projectNames.every(name => !oldNames.includes(name)));
  assert.deepEqual(more.buyer.bedrooms, [2]);
  assert.equal(more.buyer.budgetAed, 1500000);
  assert.deepEqual(more.buyer.preferredAreas, ["Al Shamkhah"]);
  assert.doesNotMatch(more.reply, /1-bed|Studio|Khalifa City|Masdar|Reem/);
});

test("too expensive cannot switch back to a more expensive legacy recommendation", async () => {
  const { turns, last } = await talk(["Budget 2M, 2 bedroom in Yas", "That is too expensive", "Keep area flexible"]);
  assert.equal(turns[1].stage, "no_match");
  assert.match(turns[1].reply, /lower-priced project/);
  assert.doesNotMatch(turns[1].reply, /Yas Park Views|From AED 1,900,000/);
  assert.equal(last.check.ok, true);
  assert.match(last.reply, /PUD Residence 1/);
  assert.deepEqual(last.buyer.bedrooms, [2]);
  assert.equal(last.buyer.budgetAed, 2000000);
  assert.equal(last.buyer.areaFlexibility, "open");
});

test("ambiguous interest in a shortlist asks which project without starting contact capture", async () => {
  const { last } = await talk(["Cheapest", "yes"]);
  assert.match(last.reply, /Which project do you mean/);
  assert.ok(last.nextQuestion.choices.some(choice => choice.value === "Plaza 1"));
  assert.equal(last.followUpSubmitted, false);
  assert.equal(last.intentAlert, null);
  assert.doesNotMatch(last.reply, /number|reach you|WhatsApp/);
});

test("a selected recorded-sales project retains its subject for missing commercial facts", async () => {
  for (const messages of [["Cheapest", "Plaza 1", "What's the payment plan?"], ["ارخص", "Plaza 1", "شو خطة السداد؟"]]) {
    const { turns, last } = await talk(messages);
    assert.match(turns[1].reply, /📍 (?:Masdar City|مدينة مصدر)/u);
    assert.equal(last.stage, "fact_answer");
    assert.equal(last.check.ok, true);
    assert.match(last.reply, /Plaza 1/);
    assert.match(last.reply, /needs a fresh check|تحتاج تأكيد حديث/);
    assert.doesNotMatch(last.reply, /Which project|أي مشروع|60\/40|80\/20|AED \d/);
    assert.equal(last.followUpSubmitted, false);
  }
});

test("a bedroom-price follow-up answers directly, yes requests that home's check here, and More options keeps the size", async () => {
  const { turns, last } = await talk(["Merito", "And the 2 BR price?", "Yes"]);
  assert.ok(turns[1].reply.length < 200);
  assert.match(turns[1].reply, /^Merito: 2-bed apartment — recent developer sales around AED 1\.36M \(last 12 months\)\./);
  assert.doesNotMatch(turns[1].reply, /1-bed|3-bed|guide price/);
  assert.equal(last.stage, "follow_up_requested");
  assert.equal(last.reply, "Your price and availability request for the 2-bed apartment at Merito is saved 👍 We'll reply here on Instagram once the details are checked.");
  assert.equal(last.instagramPriceRequest.topic, "Confirm current price and availability for Merito (2-bed apartment); reply here on Instagram");
  const more = await talk(["Merito", "And the 2 BR price?", "More options"], "buyer-more");
  assert.deepEqual(more.last.buyer.bedrooms, [2]);
  assert.equal(more.last.stage, "soft_match");
  assert.equal(more.last.followUpSubmitted, false);
  assert.doesNotMatch(more.last.reply, /Merito|1-bed|3-bed/);
});

test("a bare amount after discovery updates the budget, and a fresh start clears the search cursor", async () => {
  const { turns, last } = await talk(["Cheapest", "1M", "Start fresh"]);
  assert.equal(turns[1].buyer.budgetAed, 1000000);
  assert.match(turns[1].reply, /^Recent sales at these projects in Abu Dhabi came in under your budget\. Today's prices still need checking/);
  assert.equal(last.buyer.discoverySearch, undefined);
  assert.equal(last.buyer.budgetAed, null);
});

test("yes after an empty search adjusts scope, while a source question cannot move the buyer to Masdar", async () => {
  const { turns } = await talk(["Studio in Hudayriyat", "yes", "Change my budget", "1M"]);
  assert.match(turns[1].reply, /change the area or the budget/);
  assert.equal(turns[2].nextQuestion.field, "budgetAed");
  assert.equal(turns[3].buyer.budgetAed, 1000000);
  assert.deepEqual(turns[3].buyer.bedrooms, [0]);
  const { last } = await talk(["شقة غرفتين في الشامخة ميزانيتي 1.5 مليون", "ما مصدر السعر؟"]);
  assert.deepEqual(last.buyer.preferredAreas, ["Al Shamkhah"]);
});

test("recorded search prices pass with their own provenance and fail when tampered with", () => {
  const result = propertySearchReply({ data });
  const allowedClaims = thesisClaims(result.investmentTheses);
  assert.equal(validateMessage(result.text, [], { allowedClaims }).ok, true);
  assert.equal(validateMessage(result.text.replace("533K", "999K"), [], { allowedClaims }).ok, false);
  assert.equal(validateMessage("Harmony Residence is available now for AED 532,552.", [], { allowedClaims }).ok, false);
});
