import test from "node:test";
import assert from "node:assert/strict";
import { marketPriceAnswer, isMarketPriceQuestion } from "../src/conversation/market-price-answer.js";
import { createMarketPrices, loadMarketPrices } from "../src/facts/market-prices.js";
import { thesisClaims } from "../src/facts/advisor-claims.js";
import { validateMessage } from "../src/facts/checker.js";

const data = loadMarketPrices();
const answer = (message, extra = {}) => marketPriceAnswer({ message, data, ...extra });
const row = (extra = {}) => ({ Key: "sample-period", Period: "Last 12 months", Level: "District", Area: "Al Reem Island", Project: "All projects", Type: "Apartment", Bedrooms: "All", "Sale Type": "All", Sales: 3,
  "Avg AED per sqft": 987, "Median AED per sqft": 876, "Avg price AED": 1234567, "Median price AED": 1123456, "Avg size sqft": 1000,
  "First sale": "2026-10-01", "Last sale": "2026-10-14", Reliability: "Low sample", "Cheapest rank": null, "Data up to": "2026-10-14", ...extra });

test("market prices label the exact scope, lead with median and retain exact-source checking", () => {
  const draft = answer("What is the average price of a 2 bedroom apartment in Reem?");
  assert.equal(draft.stage, "market_prices");
  assert.deepEqual(draft.marketPrices.filters, { type: "Apartment", bedrooms: "2 BR", saleType: "All", period: "Last 12 months" });
  assert.match(draft.text, /Last 12 months; Apartment; 2 BR; All sale types/);
  assert.match(draft.text, /median AED 2,410,000.*average AED 2,295,017.*2,579 sales/);
  assert.match(draft.text, /Data up to 2026-10-14/);
  assert.equal(draft.nextQuestion, null);
  assert.equal(draft.suppressCommercial, true);
  assert.deepEqual(draft.factPacks, []);
  const allowedClaims = thesisClaims(draft.investmentTheses);
  assert.equal(validateMessage(draft.text, [], { allowedClaims }).ok, true);
  assert.equal(validateMessage(draft.text.replace("AED 2,410,000", "AED 9,999,999"), [], { allowedClaims }).ok, false);
  assert.equal(validateMessage("Al Reem Island is available now for AED 2,410,000", [], { allowedClaims }).ok, false);
});

test("Arabic historical prices use the requested scope and the same checked source", () => {
  const draft = answer("متوسط سعر شقة غرفتين في الريم؟", { buyer: { language: "ar" } });
  assert.match(draft.text, /الوسيط.*المتوسط/);
  assert.match(draft.text, /آخر 12/);
  assert.match(draft.text, /2,579 مبيعة/);
  assert.match(draft.text, /Recorded sales source: ADREC/);
  assert.equal(validateMessage(draft.text, [], { allowedClaims: thesisClaims(draft.investmentTheses) }).ok, true);
  const comparison = answer("متوسط أسعار الشقق في الريم والسعديات", { buyer: { language: "ar" } });
  assert.equal(comparison.marketPrices.rows.length, 2);
  assert.equal(answer("متوسط الأسعار").marketPrices.rows[0].Level, "Abu Dhabi");
});

test("low samples show the count without a price or a rank", () => {
  const fixture = createMarketPrices({ periodRows: [row()] });
  const draft = answer("Average prices in Reem", { data: fixture });
  assert.match(draft.text, /too few sales.*Low sample.*3 sales/);
  assert.doesNotMatch(draft.text, /AED [\d,]+/);
  const cheapest = answer("Cheapest areas", { data: fixture });
  assert.match(cheapest.text, /sufficient samples/);
  assert.equal(cheapest.marketPrices.rows.length, 0);
});

test("cheapest areas use the source's median sqft ranks in one scope", () => {
  const draft = answer("What are the cheapest 3 areas?");
  assert.match(draft.text, /median AED\/sqft rank/);
  assert.deepEqual(draft.marketPrices.rows.map(row => row.Area), ["Al Layyan", "Al Sa`adah", "Al Reef"]);
  assert.deepEqual(draft.marketPrices.rows.map(row => row["Cheapest rank"]), [1, 2, 3]);
  assert.equal(answer("Cheapest areas in Yas Island for 2 BR apartments?").marketPrices.missingScope, true);
  assert.equal(answer("Cheapest areas Q1 2025").marketPrices.missingScope, true);
});

test("comparisons preserve one filter scope and disclose different geographic levels", () => {
  const draft = answer("Compare average 2 BR off-plan apartment prices in Reem and Yas over the last 3 months");
  assert.equal(draft.marketPrices.rows.length, 2);
  for (const row of draft.marketPrices.rows) {
    assert.equal(row.Period, "Last 3 months");
    assert.equal(row.Type, "Apartment");
    assert.equal(row.Bedrooms, "2 BR");
    assert.equal(row["Sale Type"], "Off-plan");
  }
  const mixed = answer("Compare recorded prices in Reem and Masdar");
  assert.match(mixed.text, /mixes District and Project scopes/);
  assert.equal(mixed.marketPrices.rows[1].Project, "The Gate, Masdar City");
  assert.equal(mixed.marketPrices.rows[1].Area, "Khalifa City");
});

test("quarter comparisons read exact quarters, label partial quarters and never widen project sale type", () => {
  const draft = answer("Compare apartment prices in Reem and Yas in Q1 2026 and Q3 2026");
  assert.equal(draft.marketPrices.rows.length, 4);
  assert.deepEqual(draft.marketPrices.quarters, ["2026-Q1", "2026-Q3"]);
  assert.match(answer("Price trends in Yas").text, /2026-Q4.*quarter is not finished \(Partial\)/);
  const last = answer("Average prices in Reem last quarter");
  assert.deepEqual(last.marketPrices.quarters, ["2026-Q3"]);
  const missing = answer("Quarterly recorded sales for Ready apartments in Masdar");
  assert.equal(missing.marketPrices.rows.length, 0);
  assert.match(missing.text, /no recorded sales.*\nThe quarterly project table is available for All sale types/);
});

test("unknown and partial place names ask for an exact identity without emirate fallback", () => {
  for (const query of ["Average price at Foobar", "Average price for Dubai apartments?", "Average price of Dubai apartments?", "Average apartment prices in Reem Hills?", "Average in Saadiyat Lagoons Q1 vs Q3 2025", "Average apartment prices Yas Bay?"]) {
    const draft = answer(query);
    assert.equal(draft.marketPrices.missingScope, true, query);
    assert.equal(draft.marketPrices.rows.length, 0, query);
    assert.doesNotMatch(draft.text, /median AED/, query);
  }
  assert.match(answer("Average price in Reeem").text, /Close matches: Al Reem Island/);
  assert.match(answer("Average in Saadiyat Lagoons").text, /Saadiyat Lagoons - Phase/);
});

test("unsupported periods and bedroom/sale-sequence scopes never widen silently", () => {
  for (const query of ["Average Reem prices last 6 months", "Average Reem prices 2024", "Average prices in Reem this year", "Average prices in Reem this month", "Average 1 or 2 bedroom apartment Reem", "Average 10 BR apartments Reem", "Average five bedroom villa Reem", "Average resale price Reem", "Average primary price Reem"]) {
    const draft = answer(query);
    assert.equal(draft.marketPrices.missingScope, true, query);
    assert.doesNotMatch(draft.text, /median AED/, query);
  }
  assert.equal(answer("Average price 0 bedroom apartments Reem").marketPrices.filters.bedrooms, "Studio");
  assert.equal(answer("Average price 2 BHK apartments Reem").marketPrices.filters.bedrooms, "2 BR");
  assert.equal(answer("Average price 5+ BR villas Reem").marketPrices.filters.bedrooms, "5+ BR");
  assert.equal(answer("Average villa land price in Reem").marketPrices.filters.type, "Villa plot");
});

test("every canonical project identity survives punctuation, digits and words that resemble filters", () => {
  for (const place of data.places.filter(place => place.level === "Project")) {
    const draft = answer(`Average price in ${place.name}?`);
    assert.ok(draft, place.name);
    assert.notEqual(draft.marketPrices.missingScope, true, place.name);
    assert.equal(draft.marketPrices.places[0].project, place.project, place.name);
  }
});

test("normal listings, recommendations, unrelated averages and permissions keep their existing route", () => {
  for (const query of ["What is the price in Reem?", "Show me the cheapest apartment in Reem", "Recommend villas in Yas", "Average age of a buyer in Reem?", "Average size of an apartment in Reem?", "Call me about average prices in Reem", "Delete my data and tell me average prices", "Stop messaging me", "Average price and payment plan in Reem", "What does EOI mean?", "What does 20/80 mean?", "هل أحتاج وسيط؟"]) {
    assert.equal(isMarketPriceQuestion(query, data), false, query);
    assert.equal(answer(query), null, query);
  }
  assert.equal(answer("Average Reem price", { data: null }).marketPrices.unavailable, true);
  assert.equal(answer("Average Reem price", { buyer: { salesPathStopped: true } }), null);
});
