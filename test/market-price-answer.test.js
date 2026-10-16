import test from "node:test";
import assert from "node:assert/strict";
import { marketPriceAnswer, isMarketPriceQuestion, DEFAULT_MARKET_PRICE_PERIOD } from "../src/conversation/market-price-answer.js";
import { createMarketPrices, loadMarketPrices } from "../src/facts/market-prices.js";
import { thesisClaims } from "../src/facts/advisor-claims.js";
import { validateMessage } from "../src/facts/checker.js";

const data = loadMarketPrices();
const answer = (message, extra = {}) => marketPriceAnswer({ message, data, currentYear: 2026, ...extra });
const row = (extra = {}) => ({ Key: "sample-period", Period: "This year", Level: "District", Area: "Al Reem Island", Project: "All projects", Type: "Apartment", Bedrooms: "All", "Sale Type": "All", Sales: 3,
  "Avg AED per sqft": 987, "Median AED per sqft": 876, "Avg price AED": 1234567, "Median price AED": 1123456, "Avg size sqft": 1000,
  "First sale": "2026-10-01", "Last sale": "2026-10-14", Reliability: "Low sample", "Cheapest rank": null, "Data up to": "2026-10-14", ...extra });

test("market prices default to this year's average price per sqft with exact-source checking", () => {
  const draft = answer("What is the average price of a 2 bedroom apartment in Reem?");
  assert.equal(draft.stage, "market_prices");
  assert.equal(DEFAULT_MARKET_PRICE_PERIOD, "This year");
  assert.deepEqual(draft.marketPrices.filters, { type: "Apartment", bedrooms: "2 BR", saleType: "All", period: "This year" });
  assert.match(draft.text, /2026 year-to-date average — Apartment; 2 BR; All sale types/);
  assert.match(draft.text, /average AED 1,658\/sqft; 2,044 sales/);
  assert.doesNotMatch(draft.text, /median|2,386,525|Last 12 months|historical|past sales|Recorded sales/i);
  assert.match(draft.text, /Data through 2026-10-14/);
  assert.equal(draft.nextQuestion, null);
  assert.equal(draft.suppressCommercial, true);
  assert.deepEqual(draft.factPacks, []);
  const allowedClaims = thesisClaims(draft.investmentTheses);
  assert.equal(validateMessage(draft.text, [], { allowedClaims }).ok, true);
  assert.equal(validateMessage(draft.text.replace("AED 1,658", "AED 9,999"), [], { allowedClaims }).ok, false);
  assert.equal(validateMessage("Al Reem Island is available now for AED 1,658/sqft", [], { allowedClaims }).ok, false);
  assert.equal(allowedClaims[0].field, "marketPriceEvidence");
  assert.equal(allowedClaims[0].scope.basis, "precomputed_market_prices");
});

test("Arabic prices show this year's average per sqft with a plain source", () => {
  const draft = answer("متوسط سعر شقة غرفتين في الريم؟", { buyer: { language: "ar" } });
  assert.match(draft.text, /متوسط الأسعار لعام 2026 منذ بداية السنة/);
  assert.match(draft.text, /المتوسط AED 1,658\/قدم²/);
  assert.match(draft.text, /2,044 مبيعة/);
  assert.match(draft.text, /البيانات حتى 2026-10-14/);
  assert.doesNotMatch(draft.text, /المصدر|adrec\.gov\.ae/);
  assert.doesNotMatch(draft.text, /الوسيط|تاريخية|Recorded sales/);
  assert.equal(validateMessage(draft.text, [], { allowedClaims: thesisClaims(draft.investmentTheses) }).ok, true);
  const comparison = answer("متوسط أسعار الشقق في الريم والسعديات", { buyer: { language: "ar" } });
  assert.equal(comparison.marketPrices.rows.length, 2);
  assert.equal(answer("متوسط الأسعار").marketPrices.rows[0].Level, "Abu Dhabi");
});

test("Arabic square-foot wording cannot be mistaken for a calendar quarter", () => {
  const recent = answer("كم متوسط سعر القدم المربع لشقة غرفتين في الريم خلال آخر3أشهر؟", { buyer: { language: "ar" } });
  assert.equal(recent.marketPrices.mode, "period");
  assert.equal(recent.marketPrices.filters.period, "Last 3 months");
  assert.match(recent.text, /المتوسط AED 1,669\/قدم²; 410 مبيعة/);
  assert.equal(validateMessage(recent.text, [], { allowedClaims: thesisClaims(recent.investmentTheses) }).ok, true);
  const current = answer("كم متوسط سعر القدم المربع لشقة غرفتين في الريم هذا العام؟", { buyer: { language: "ar" } });
  assert.equal(current.marketPrices.mode, "period");
  assert.equal(current.marketPrices.filters.period, "This year");
  assert.match(current.text, /المتوسط AED 1,658\/قدم²; 2,044 مبيعة/);
  const quarter = answer("متوسط سعر شقة غرفتين في الريم في الربع الرابع 2026؟", { buyer: { language: "ar" } });
  assert.equal(quarter.marketPrices.mode, "quarter");
  assert.deepEqual(quarter.marketPrices.quarters, ["2026-Q4"]);
});

test("calendar-year wording reads the real YTD row and does not substitute a rolling year", () => {
  for (const qualifier of ["this year", "year to date", "YTD", "in 2026", "during calendar year 2026"]) {
    const draft = answer(`Average 2 BR apartment price in Reem ${qualifier}`);
    assert.equal(draft.marketPrices.filters.period, "This year", qualifier);
    assert.match(draft.text, /average AED 1,658\/sqft; 2,044 sales/, qualifier);
    assert.doesNotMatch(draft.text, /1,623|2,295,017|Last 12 months/, qualifier);
  }
  for (const qualifier of ["هذا العام", "هذه السنة", "لعام 2026", "السنة 2026"]) {
    const draft = answer(`متوسط سعر شقة غرفتين في الريم ${qualifier}`, { buyer: { language: "ar" } });
    assert.match(draft.text, /المتوسط AED 1,658\/قدم²/, qualifier);
    assert.equal(draft.marketPrices.filters.period, "This year", qualifier);
  }
  const stale = answer("Average 2 BR price in Reem this year", { currentYear: 2027 });
  assert.equal(stale.marketPrices.unavailable, true);
  assert.doesNotMatch(stale.text, /2026|AED|historical/i);
  const explicit = answer("Average 2 BR price in Reem in 2026", { currentYear: 2027 });
  assert.match(explicit.text, /2026 year-to-date average/);
  const recent = answer("Average 2 BR price in Reem", { defaultPeriod: "Last 3 months" });
  assert.match(recent.text, /Last 3 months average.*\n.*average AED 1,669\/sqft; 410 sales/);
});

test("median and total prices appear only when explicitly requested", () => {
  const median = answer("Median 2 BR apartment price in Reem");
  assert.match(median.text, /median AED 1,764\/sqft/);
  assert.doesNotMatch(median.text, /average|2,465,000/);
  const both = answer("Average and median 2 BR apartment price in Reem");
  assert.match(both.text, /average AED 1,658\/sqft; median AED 1,764\/sqft/);
  const total = answer("Average total unit price of 2 BR apartments in Reem");
  assert.match(total.text, /average AED 1,658\/sqft, AED 2,386,525 per unit/);
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

test("cheapest areas use this year's average sqft ranks, with older rank bases explicit", () => {
  const draft = answer("What are the cheapest 3 areas?");
  assert.match(draft.text, /average AED\/sqft rank/);
  assert.deepEqual(draft.marketPrices.rows.map(row => row.Area), ["Al Layyan", "Al Sa`adah", "Al Reef"]);
  assert.deepEqual(draft.marketPrices.rows.map(row => row["Cheapest rank"]), [1, 2, 3]);
  assert.ok(draft.marketPrices.rows.every(row => row.Period === "This year"));
  const twoBedroom = answer("Cheapest 3 areas for 2 BR apartments");
  assert.deepEqual(twoBedroom.marketPrices.rows.map(row => row.Area), ["Al Layyan", "Al Reef", "Al Shamkhah"]);
  assert.deepEqual(twoBedroom.marketPrices.rows.map(row => row["Avg AED per sqft"]), [898, 938, 1153]);
  assert.match(answer("Cheapest 3 areas over the last 3 months").text, /median AED\/sqft rank/);
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

test("everyday area price comparisons ignore a stale catalogue project", () => {
  const buyer = { projectInterest: "Bab Al Qasr Residence", bedrooms: [2], preferredAreas: ["Yas Island"] };
  const catalog = { projects: [{ id: "bab", name: "Bab Al Qasr Residence", area: "Yas Island" }], units: [{ id: "bab-1", projectId: "bab", bedrooms: 1, startingPriceAed: 1000000 }] };
  for (const query of ["Whats average 1 br price in shamkha vs yas", "Whats 1 br price in shamkha vs yas", "What's average 1 br price in shamkha vs yas", "What’s 1 br price in shamkha vs yas", "What is the 1 BR price in Shamkha or Yas?"]) {
    const draft = answer(query, { buyer, catalog });
    assert.equal(isMarketPriceQuestion(query, data), true, query);
    assert.notEqual(draft.marketPrices.missingScope, true, query);
    assert.deepEqual(draft.marketPrices.rows.map(row => row.Area), ["Al Shamkhah", "Yas Island"], query);
    assert.equal(draft.marketPrices.filters.bedrooms, "1 BR", query);
    assert.equal(draft.marketPrices.filters.period, "This year", query);
    assert.match(draft.text, /Al Shamkhah.*average AED 1,131\/sqft; 93 sales/, query);
    assert.match(draft.text, /Yas Island.*average AED 2,211\/sqft; 1,494 sales/, query);
    assert.doesNotMatch(draft.text, /Bab Al Qasr|AED 1,000,000|Whats/, query);
    assert.deepEqual(draft.factPacks, []);
    assert.equal(validateMessage(draft.text, [], { allowedClaims: thesisClaims(draft.investmentTheses) }).ok, true, query);
  }
  const arabic = answer("كم متوسط سعر شقة غرفة نوم واحدة في الشامخة مقابل ياس؟", { buyer: { ...buyer, language: "ar" }, catalog });
  assert.notEqual(arabic.marketPrices.missingScope, true);
  assert.equal(arabic.marketPrices.filters.bedrooms, "1 BR");
  assert.deepEqual(arabic.marketPrices.rows.map(row => row.Area), ["Al Shamkhah", "Yas Island"]);
  assert.match(arabic.text, /المتوسط AED 1,131\/قدم²; 93 مبيعة/);
  assert.match(arabic.text, /المتوسط AED 2,211\/قدم²; 1,494 مبيعة/);
  assert.equal(validateMessage(arabic.text, [], { allowedClaims: thesisClaims(arabic.investmentTheses) }).ok, true);
});

test("bare area comparisons inherit only relevant market filters and preserve explicit changes", () => {
  const comparisonContext = { filters: { type: "Apartment", bedrooms: "1 BR", saleType: "All", period: "This year" } };
  const buyer = { projectInterest: "Bab Al Qasr Residence", bedrooms: [2] };
  const draft = answer("Al shamkha vs yas", { comparisonContext, buyer });
  assert.equal(isMarketPriceQuestion("Al shamkha vs yas", data, comparisonContext), true);
  assert.deepEqual(draft.marketPrices.filters, comparisonContext.filters);
  assert.deepEqual(draft.marketPrices.rows.map(row => row.Area), ["Al Shamkhah", "Yas Island"]);
  assert.doesNotMatch(draft.text, /Bab Al Qasr/);
  const explicit = answer("Al shamkha vs yas 2 BR over the last 3 months", { comparisonContext, buyer });
  assert.equal(explicit.marketPrices.filters.bedrooms, "2 BR");
  assert.equal(explicit.marketPrices.filters.period, "Last 3 months");
  assert.equal(answer("Al shamkha vs yas", { comparisonContext: {}, buyer: { bedrooms: [1] } }).marketPrices.filters.bedrooms, "1 BR");
  assert.equal(answer("Al shamkha vs yas"), null);
  assert.equal(isMarketPriceQuestion("Yas or Saadiyat", data), false);
  assert.equal(answer("Which projects should I buy in Shamkha vs Yas?", { comparisonContext }), null);
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
  assert.match(missing.text, /no sales.*\nThe quarterly project table is available for All sale types/);
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
  for (const query of ["Average Reem prices last 6 months", "Average Reem prices 2024", "Average prices in Reem last year", "Average prices in Reem during 2025 and 2026", "Average prices in Reem during 2025 over last 12 months", "Average prices in Reem this month", "Average 1 or 2 bedroom apartment Reem", "Average 10 BR apartments Reem", "Average five bedroom villa Reem", "Average resale price Reem", "Average primary price Reem"]) {
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
