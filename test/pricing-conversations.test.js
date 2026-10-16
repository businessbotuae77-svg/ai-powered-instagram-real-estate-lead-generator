import assert from "node:assert/strict";
import test from "node:test";
import { setupOrchestrator, talk } from "./helpers.js";
import { createPriceLedger, emptyPriceLedger } from "../src/pricing/ledger.js";
import { dayLabel } from "../src/pricing/offer-pack.js";

// Whole conversations over the real engine. Offers are injected with dates
// relative to today; without injection the repository ledger is used, where the
// Vista 3 developer message is still unresolved.

const daysAgo = days => new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
const UNRESOLVED_MESSAGE = /1,5\b|1\.5M|1,500,000|2\.44|2,440,000|835|penthouse|stock|sold out/i;

/** An approved developer quote received two days ago, unless overridden. */
function quote({ id, project, district, bedrooms, amount, ...extra }) {
  return {
    id, evidenceType: "developer_offer", status: "approved", project: { name: project, district },
    home: { scope: "home_type", type: "apartment", bedrooms },
    price: { raw: `AED ${amount.toLocaleString("en-US")}`, amountAed: amount, kind: "exact_quote", discount: "not_stated", currency: "AED", ...extra.price },
    discountTerms: extra.discountTerms || { description: null, eligibility: null },
    payment: extra.payment || { kind: "unknown", summary: null }, availability: { status: "unknown" },
    source: extra.source || { kind: "developer_message", reference: "Developer message (test)" },
    issuedOn: extra.issuedOn ?? null, receivedOn: extra.receivedOn ?? daysAgo(2), supersedes: [], unresolved: []
  };
}

const VISTA_3_ONE_BED = quote({ id: "T-V3-1BR", project: "Vista 3", district: "Al Reem Island", bedrooms: 1, amount: 1500000, price: { discount: "before_discount" } });
const ledger = (...records) => createPriceLedger({ offers: records });
const assertChecked = turns => { for (const turn of turns) assert.equal(turn.check.ok, true, `${turn.reply}\n${JSON.stringify(turn.check.violations)}`); };

test("a current quote above the budget takes a home off the shortlist that its past sales would have put it on", async () => {
  const before = await talk(["I want a 1 bedroom in Reem, budget 1.2M"], "no-quote", { priceLedger: emptyPriceLedger() });
  assert.match(before.last.reply, /1️⃣ Vista 3 · Al Reem Island\n1-bed apartment · recent sales around AED 716K/u, "past sales alone shortlist it");

  const { turns } = await talk(["I want a 1 bedroom in Reem, budget 1.2M", "Vista 3", "And the 1 BR price?"], "quote", { priceLedger: ledger(VISTA_3_ONE_BED) });
  assertChecked(turns);
  assert.doesNotMatch(turns[0].reply, /Vista 3/);
  assert.match(turns[0].reply, /^Recent sales at these projects in Al Reem Island came in under your budget\. Today's prices still need checking/);
  const date = dayLabel(daysAgo(2));
  assert.match(turns[1].reply, new RegExp(`💰 Current price: 1-bed apartment · AED 1,500,000 · before discount · developer message, ${date}\\n🏠 `, "u"));
  assert.doesNotMatch(turns[1].reply, /✨/, "no budget highlight for a home whose current price is above the budget");
  assert.equal(turns[2].reply, `Vista 3 · 1-bed apartment\n💰 Current price: AED 1,500,000 · before discount · developer message, ${date}\n` +
    "Recent developer sales were around AED 716K (last 12 months).\nThat's above your budget.\n\nWould you like more options of the same size?");
  assert.equal(turns[2].followUpSubmitted, false);
});

test("a current quote that fits is shown with its terms and date, and only the units are left to check", async () => {
  const fitting = quote({ id: "T-V3-1BR-PLAN", project: "Vista 3", district: "Al Reem Island", bedrooms: 1, amount: 1100000,
    payment: { kind: "developer_plan", summary: "60/40 payment plan" }, source: { kind: "developer_price_list", reference: "Reportage price list (test)" },
    issuedOn: daysAgo(3), receivedOn: null });
  const { turns } = await talk(["Vista 3", "And the 1 BR price?", "Check availability for Vista 3 here on Instagram"], "fits", { priceLedger: ledger(fitting) });
  assertChecked(turns.slice(0, 2));
  assert.equal(turns[1].reply, `Vista 3 · 1-bed apartment\n💰 Current price: AED 1,100,000 · 60/40 payment plan · developer price list, ${dayLabel(daysAgo(3))}\n` +
    "Recent developer sales were around AED 716K (last 12 months).\n\nWant me to check which units are available at this price, here on Instagram?");
  assert.equal(turns[2].stage, "follow_up_requested");
  assert.equal(turns[2].reply, "Your price and availability request for the 1-bed apartment at Vista 3 is saved 👍 We'll reply here on Instagram once the details are checked.");
  const arabic = await talk(["حدثني عن Vista 3", "وكم سعر غرفة وصالة؟"], "fits-ar", { priceLedger: ledger(fitting) });
  assertChecked(arabic.turns);
  assert.match(arabic.last.reply, /^Vista 3 · شقة غرفة نوم\n💰 السعر الحالي: 1,100,000 درهم · 60\/40 payment plan · قائمة أسعار المطور، /u);
  assert.match(arabic.last.reply, /تبي أتأكد لك من الوحدات المتوفرة بهذا السعر هنا في إنستغرام؟$/);
});

test("the unresolved developer message never reaches a buyer, and one contact's lack of 2-bed stock removes nothing", async () => {
  const { turns } = await talk(["Tell me about Vista 3", "And the 1 BR price?", "And the 2 BR price?"], "real-ledger");
  assertChecked(turns);
  for (const turn of turns) assert.doesNotMatch(turn.reply, UNRESOLVED_MESSAGE);
  assert.match(turns[1].reply, /^Vista 3: 1-bed apartment — recent developer sales around AED 716K \(last 12 months\)\./);
  assert.match(turns[2].reply, /latest price and available units confirmed here on Instagram\?$/);
  // The written "1,5" is still on file: its likely reading keeps Vista 3 off a 1.2M 1-bed shortlist, but not a 2M one.
  assert.doesNotMatch((await talk(["1 bedroom in Reem, budget 1.2M"], "careful")).last.reply, /Vista 3/);
  assert.match((await talk(["1 bedroom in Reem, budget 2M"], "roomy")).last.reply, /1️⃣ Vista 3 · Al Reem Island\n1-bed apartment · recent sales around AED 716K/u);
  // Even once approved, "no 2-bed stock through that contact" is about one contact, not the market.
  const noStock = { ...quote({ id: "T-AVAIL", project: "Vista 3", district: "Al Reem Island", bedrooms: 2, amount: 1 }),
    price: { raw: null, amountAed: null, kind: "none", discount: "not_stated", currency: "AED" },
    availability: { status: "not_available", scope: "contact_inventory", statement: "no two-bedroom stock through that contact" } };
  for (const priceLedger of [undefined, ledger(noStock)]) {
    const { last } = await talk(["2 bedroom in Reem under 1M"], "two-bed", { priceLedger });
    assert.match(last.reply, /1️⃣ Vista 3 · Al Reem Island\n2-bed apartment · recent sales around AED 948K/u);
    assert.doesNotMatch(last.reply, UNRESOLVED_MESSAGE);
  }
});

test("a full-payment discount is never presented as what a payment-plan buyer can afford", async () => {
  const cash = quote({ id: "T-PUD-CASH", project: "PUD Residence 1", district: "Al Shamkhah", bedrooms: 2, amount: 900000,
    price: { discount: "after_discount" }, discountTerms: { description: "8% discount", eligibility: "Cash buyers only" },
    source: { kind: "developer_price_list", reference: "Price list (test)" }, issuedOn: daysAgo(3), receivedOn: null });
  const line = "2-bed apartment · AED 900,000 · after full-payment discount · developer price list";
  const plan = await talk(["2 bedroom in Shamkha under 1.5M with a payment plan"], "plan", { priceLedger: ledger(cash) });
  assertChecked(plan.turns);
  assert.equal(plan.last.buyer.financing, "payment_plan");
  assert.match(plan.last.reply, new RegExp(`${line}, [^\\n]+ · payment-plan price to confirm`));
  assert.doesNotMatch(plan.last.reply, /within your budget/);
  const unknown = await talk(["2 bedroom in Shamkha under 1.5M"], "unknown", { priceLedger: ledger(cash) });
  assert.match(unknown.last.reply, new RegExp(`${line}, [^\\n·]+\\n`), "shown with its condition");
  assert.doesNotMatch(unknown.last.reply, /within your budget|payment-plan price/);
  // Above the budget, a full-payment price is not listed at all, and its past sales do not stand in for it.
  const above = await talk(["2 bedroom in Shamkha under 850K with a payment plan"], "above", { priceLedger: ledger(cash) });
  assert.doesNotMatch(above.last.reply, /PUD Residence 1/);
});

test("budget changes and More options keep each kind of price apart without repeating a project", async () => {
  const { turns } = await talk(["1 bedroom in Reem, budget 2M", "More options", "Change my budget", "1.2M"], "pages");
  assertChecked(turns);
  const names = reply => [...reply.matchAll(/^[1-3]️⃣ (.+?) · /gmu)].map(match => match[1]);
  const first = names(turns[0].reply), second = names(turns[1].reply), third = names(turns[3].reply);
  assert.equal(first[0], "Vista 3");
  assert.ok(second.length && second.every(name => !first.includes(name)), "More options never repeats a project");
  assert.match(turns[1].reply, /^More options in Al Reem Island 👇/u);
  assert.ok(!third.includes("Vista 3"), "a lower budget re-applies the careful rule");
  assert.equal(turns[3].buyer.budgetAed, 1200000);
  for (const turn of [turns[0], turns[1], turns[3]]) assert.match(turn.reply, /Recent sales show what homes sold for, not today's prices\. I can check today's price/);
});

test("declining the price check is respected in English and Gulf Arabic, and accepting it names the home", async () => {
  for (const [id, messages, declined, card] of [
    ["decline-en", ["Tell me about Merito", "No thanks", "Tell me about Merito"], "No problem, I won't check it.\nWhat would you like to do next?", /latest price and available units/],
    ["decline-ar", ["حدثني عن Merito", "لا شكراً", "حدثني عن Merito"], "تمام، ما راح أتأكد منه.\nكيف تحب نكمل؟", /السعر الحالي والوحدات المتوفرة/]]) {
    const { turns } = await talk(messages, id);
    assertChecked(turns);
    assert.equal(turns[1].stage, "price_check_declined");
    assert.equal(turns[1].reply, declined);
    assert.doesNotMatch(turns[2].reply, card, "the same check is not offered again");
    assert.ok(turns.every(turn => !turn.followUpSubmitted));
  }
  for (const message of ["مو الحين", "لا، شكرا", "No thank you"]) {
    assert.equal((await talk(["Tell me about Merito", message], "decline-more")).last.stage, "price_check_declined", message);
  }
  const accepted = await talk(["وسعر الغرفتين في Merito؟", "ايه"], "accept-ar");
  assert.equal(accepted.last.stage, "follow_up_requested");
  assert.equal(accepted.last.reply, "تم، حفظت طلبك للسعر الحالي والتوفر في Merito (شقة غرفتين) 👍 الرد بيكون هنا في إنستغرام بعد التأكد.");
});

test("the owner's alert shows every figure the buyer saw, by kind, with its source", async () => {
  const fitting = quote({ id: "T-V3-1BR-OWNER", project: "Vista 3", district: "Al Reem Island", bedrooms: 1, amount: 1100000 });
  const { send, sent, alertText } = await setupOrchestrator({ priceLedger: ledger(fitting) });
  await send("owner", "Vista 3");
  await send("owner", "And the 1 BR price?");
  const result = await send("owner", "Check availability for Vista 3 here on Instagram");
  assert.equal(result.result.instagramPriceRequest.topic, "Confirm current price and availability for Vista 3 (1-bed apartment); reply here on Instagram");
  const alert = alertText(sent("whatsapp").at(-1));
  assert.match(alert, new RegExp(`- Vista 3 · 1-bed apartment: AED 1,100,000, current offer \\(developer message, receivedOn ${daysAgo(2)}; Developer message \\(test\\)\\)`));
  assert.match(alert, /- Vista 3 · 1-bed apartment: recorded median AED 715,735, past sales, not a current price \(7 Primary off-plan sales, 2025-10-24 to 2026-10-02; ADREC a00fa4473c2d\)/);
  assert.doesNotMatch(alert, UNRESOLVED_MESSAGE);
});

test("a buyer who asks where the prices come from gets a plain answer, without internal references", async () => {
  const { turns } = await talk(["Tell me about Vista 3", "Where do these prices come from?"], "source-en");
  assert.equal(turns[1].reply, "The recent-sales figures are developer sales recorded by the Abu Dhabi Real Estate Centre over the last 12 months, up to 14 Oct 2026. " +
    "They show what homes sold for, not today's price.\n\nWant the latest price and available units confirmed here on Instagram?");
  const offer = await talk(["Vista 3", "And the 1 BR price?", "What is the source of these prices?"], "source-offer", { priceLedger: ledger(VISTA_3_ONE_BED) });
  assert.match(offer.last.reply, new RegExp(`The current price comes from a developer message dated ${dayLabel(daysAgo(2))}\\.`));
  assert.doesNotMatch(offer.last.reply, /\(test\)|DEV-MSG|owner|Airtable|ledger|ADREC/i);
  const arabic = await talk(["ابي شقة غرفتين في الشامخة ميزانيتي 1.5 مليون", "ما مصدر السعر؟"], "source-ar");
  assert.match(arabic.last.reply, /^أرقام المبيعات الحديثة هي مبيعات المطور المسجلة لدى مركز أبوظبي العقاري/);
  assert.deepEqual(arabic.last.buyer.preferredAreas, ["Al Shamkhah"], "مصدر is not Masdar here");
  assertChecked([...turns, ...offer.turns, ...arabic.turns]);
});
