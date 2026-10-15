import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseMarketPriceCsv, createMarketPrices, loadMarketPrices, marketPriceRows, marketQuarterRows,
  marketPriceCoverage, marketPlacesInMessage, exactMarketPlaces, findMarketPlaces, cheapestMarketAreas } from "../src/facts/market-prices.js";

function period(extra = {}) {
  const row = { Period: "Last 12 months", Level: "District", Area: "Al Reem Island", Project: "All projects", Type: "Apartment", Bedrooms: "2 BR", "Sale Type": "All",
    Sales: 11, "Avg AED per sqft": 1501, "Median AED per sqft": 1203, "Avg price AED": 1999009, "Median price AED": 1700017,
    "Avg size sqft": 1234, "First sale": "2025-11-01", "Last sale": "2026-10-14", Reliability: "OK", "Cheapest rank": 7, "Data up to": "2026-10-14", ...extra };
  row.Key ??= [row.Period, row.Level, row.Area, row.Project, row.Type, row.Bedrooms, row["Sale Type"]].join(" | ");
  return row;
}
function quarter(extra = {}) {
  const row = period(extra);
  delete row.Period; delete row["Cheapest rank"]; delete row["Data up to"];
  row.Quarter = extra.Quarter || "2026-Q4";
  row["Quarter status"] = extra["Quarter status"] || "Partial (data to 2026-10-14)";
  row.Key = [row.Level, row.Area, row.Project, row.Type, row.Bedrooms, row["Sale Type"], row.Quarter].join(" | ");
  return row;
}

test("market CSV handles BOM, escaped quotes, commas and multiline names without dropping blank cells", () => {
  const rows = parseMarketPriceCsv('\uFEFFName,Value\r\n"The Gate, Masdar City",1203\r\n"A ""quoted""\nname",9\r\n,\r\n', ["Name", "Value"]);
  assert.deepEqual(rows, [{ Name: "The Gate, Masdar City", Value: "1203" }, { Name: 'A "quoted"\nname', Value: "9" }, { Name: "", Value: "" }]);
  assert.throws(() => parseMarketPriceCsv('Name\n"unclosed'), /Unclosed/);
  assert.throws(() => parseMarketPriceCsv('Name\n"closed"unexpected'), /Malformed/);
  assert.throws(() => parseMarketPriceCsv("Name,Name\nx,y"), /header/);
  assert.throws(() => parseMarketPriceCsv("Name,Value\nx"), /column count/);
  assert.throws(() => parseMarketPriceCsv("Name\nx", ["Missing"]), /Missing/);
});

test("indexed lookup retains exact segment scope and every supplied precomputed figure", () => {
  const original = period(), data = createMarketPrices({ periodRows: [original,
    period({ "Sale Type": "Ready", "Median price AED": 9876543 }), period({ Bedrooms: "All", Sales: 50 })], quarterRows: [quarter({ Level: "Project", Project: "Gardenia Bay", Area: "Yas Island" })] });
  const filters = { period: "Last 12 months", level: "District", area: "Al Reem Island", project: "All projects", type: "Apartment", bedrooms: "2 BR", saleType: "All" };
  assert.deepEqual(marketPriceRows(data, filters), [original]);
  assert.equal(marketPriceRows(data, { ...filters, saleType: "Off-plan" }).length, 0);
  assert.equal(marketPriceRows(data, { ...filters, area: "Reem" }).length, 0);
  assert.equal(marketPriceRows(data, { ...filters, unknown: "unexpected" }).length, 0);
  assert.equal(marketPriceRows(data, { ...filters, bedrooms: "" }).length, 0);
  assert.equal(marketPriceRows(data, { ...filters, Area: "Yas Island" }).length, 0);
  assert.equal(marketQuarterRows(data, { level: "Project", project: "Gardenia Bay", saleType: "Off-plan", quarter: "2026-Q4" }).length, 0);
  assert.equal(marketQuarterRows(data, { level: "Project", project: "Gardenia Bay", saleType: "All", quarter: "2026-Q4" })[0]["Quarter status"], "Partial (data to 2026-10-14)");
});

test("cheapest areas read the existing rank and exclude unreliable or incomparable segments", () => {
  const data = createMarketPrices({ periodRows: [
    period({ Area: "First ranked", "Cheapest rank": 1, "Median AED per sqft": 9999 }),
    period({ Area: "Second ranked", "Cheapest rank": 2, "Median AED per sqft": 100 }),
    period({ Area: "Unranked", "Cheapest rank": null, "Median AED per sqft": 1 }),
    period({ Area: "Low sample", "Cheapest rank": 1, Sales: 2, Reliability: "Low sample" }),
    period({ Area: "Different bedrooms", Bedrooms: "1 BR", "Cheapest rank": 1 })] });
  const filters = { period: "Last 12 months", type: "Apartment", bedrooms: "2 BR", saleType: "All" };
  assert.deepEqual(cheapestMarketAreas(data, filters, { limit: 2 }).map(row => row.Area), ["First ranked", "Second ranked"]);
  assert.deepEqual(cheapestMarketAreas(data, { period: "Last 12 months", type: "Apartment", saleType: "All" }), []);
});

test("name resolution uses declared aliases and the longest mention without guessing typo identities", () => {
  const data = createMarketPrices({ periodRows: [period(), period({ Area: "Al Shamkhah" }), period({ Area: "Al Saadiyat Island" }),
    period({ Level: "Project", Area: "Khalifa City", Project: "The Gate, Masdar City" }),
    period({ Level: "Project", Area: "Yas Island", Project: "Gardenia Bay" }),
    period({ Level: "Project", Project: "Manchester City Yas Residences" }),
    period({ Level: "Project", Project: "Manchester City Yas Residences - Phase A" })] });
  assert.deepEqual(marketPlacesInMessage("Compare Reem, Masdar and Shamkha", data).map(place => place.name), ["Al Reem Island", "The Gate, Masdar City", "Al Shamkhah"]);
  assert.deepEqual(marketPlacesInMessage("الريم والسعديات ومدينة مصدر", data).map(place => place.name), ["Al Reem Island", "Al Saadiyat Island", "The Gate, Masdar City"]);
  assert.deepEqual(marketPlacesInMessage("Manchester City Yas Residences - Phase A prices", data).map(place => place.name), ["Manchester City Yas Residences - Phase A"]);
  assert.deepEqual(marketPlacesInMessage("Compare Manchester City Yas Residences versus Manchester City Yas Residences - Phase A", data).map(place => place.name), ["Manchester City Yas Residences", "Manchester City Yas Residences - Phase A"]);
  assert.deepEqual(marketPlacesInMessage("Gardena Bay", data), []);
  assert.equal(exactMarketPlaces("Reem", data)[0].name, "Al Reem Island");
  assert.equal(exactMarketPlaces("مدينة مصدر", data)[0].name, "The Gate, Masdar City");
  assert.deepEqual(exactMarketPlaces("Reem Hills", data), []);
  assert.deepEqual(exactMarketPlaces("Saadiyat Lagoons", data), []);
  assert.equal(findMarketPlaces("Gardena Bay", data)[0].name, "Gardenia Bay");
  assert.deepEqual(findMarketPlaces("Completely unrelated area name", data), []);
});

test("coverage distinguishes districts and named projects from private and missing identities", () => {
  const data = createMarketPrices({ periodRows: [period(),
    period({ Level: "Project", Project: "Gardenia Bay", Area: "Yas Island" }),
    period({ Level: "Project", Project: "Private" }),
    period({ Level: "Project", Project: "No project name" })],
  quarterRows: [quarter({ Level: "Project", Project: "Gardenia Bay", Area: "Yas Island" })] });
  assert.equal(marketPriceCoverage(data).projectCount, 1);
  assert.equal(data.coverage.districtCount, 1);
  assert.equal(data.coverage.dataUpTo, "2026-10-14");
  assert.equal(data.places.some(place => ["Private", "No project name"].includes(place.name)), false);
});

test("malformed or inconsistent rows fail closed and missing tables never expose partial data", () => {
  assert.throws(() => createMarketPrices({ periodRows: [period({ Sales: "11oops" })] }), /number/);
  assert.throws(() => createMarketPrices({ periodRows: [period(), period()] }), /Duplicate/);
  assert.throws(() => createMarketPrices({ periodRows: [period({ "First sale": "2026-02-31" })] }), /date/);
  assert.throws(() => createMarketPrices({ periodRows: [period({ Period: "This year", "First sale": "2025-12-31" })] }), /current-year/);
  assert.throws(() => createMarketPrices({ periodRows: [period(), period({ Area: "Other", "Data up to": "2026-10-15" })] }), /Mixed/);
  const directory = mkdtempSync(path.join(tmpdir(), "market-data-"));
  try {
    writeFileSync(path.join(directory, "period_prices.csv"), "not,the,expected,schema\n");
    const missing = loadMarketPrices(directory);
    assert.equal(missing.coverage.available, false);
    assert.equal(missing.periods.length, 0);
    assert.equal(missing.quarters.length, 0);
    assert.strictEqual(loadMarketPrices(directory), missing);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("bundled market tables expose all named projects and exact imported scope once loaded", () => {
  const data = loadMarketPrices();
  assert.strictEqual(loadMarketPrices(), data);
  assert.deepEqual(data.coverage, { available: true, projectCount: 348, districtCount: 100, periodRows: 30583, quarterRows: 40959,
    dataUpTo: "2026-10-14", firstSale: "2019-01-02", sourceSales: 124526, salesUsed: 107157,
    currentYear: 2026, currentYearStart: "2026-01-01", currentYearRows: 4508, currentYearSales: 22269, currentYearProjectCount: 328, currentYearDistrictCount: 72 });
  const rows = marketPriceRows(data, { period: "Last 12 months", level: "District", area: "Al Reem Island", type: "Apartment", bedrooms: "2 BR", saleType: "All" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]["Median AED per sqft"], 1697);
  assert.equal(rows[0]["Median price AED"], 2410000);
  assert.equal(rows[0].Sales, 2579);
});

test("this-year averages use calendar-year sales rather than rolling periods or quarter averages", () => {
  const data = loadMarketPrices();
  const yearRows = marketPriceRows(data, { period: "This year" });
  assert.equal(yearRows.length, 4508);
  assert.ok(yearRows.every(row => row["First sale"] >= "2026-01-01" && row["Last sale"] <= "2026-10-14"));
  const filters = { period: "This year", level: "District", area: "Al Reem Island", type: "Apartment", bedrooms: "2 BR", saleType: "All" };
  const [row] = marketPriceRows(data, filters);
  assert.equal(row.Sales, 2044);
  assert.equal(row["Avg price AED"], 2386525);
  assert.equal(row["Median price AED"], 2465000);
  assert.equal(row["Avg AED per sqft"], 1658);
  // Averaging the rounded quarter means (1,583, 1,721, 1,640, 1,701) gives 1,661.
  assert.notEqual(row["Avg AED per sqft"], 1661);
  assert.equal(row["Median AED per sqft"], 1764);
  assert.equal(row["First sale"], "2026-01-02");
  // The unweighted mean of the four quarter means is 2,388,888, not the YTD average.
  assert.notEqual(row["Avg price AED"], 2388888);
  assert.notEqual(row["Avg price AED"], marketPriceRows(data, { ...filters, period: "Last 12 months" })[0]["Avg price AED"]);
  assert.equal(marketPriceRows(data, { ...filters, saleType: "Off-plan" })[0]["Avg price AED"], 2600843);
  assert.equal(marketPriceRows(data, { ...filters, saleType: "Ready" })[0]["Avg price AED"], 1750228);
});

test("this-year cheapest ranks follow average price per sqft while older periods retain median ranks", () => {
  const data = loadMarketPrices();
  for (const [periodName, metric] of [["This year", "Avg AED per sqft"], ["Last 12 months", "Median AED per sqft"]]) {
    const groups = new Map();
    for (const row of marketPriceRows(data, { period: periodName })) {
      if (row.Reliability !== "OK") { assert.equal(row["Cheapest rank"], null); continue; }
      const key = JSON.stringify([row.Level, row.Type, row.Bedrooms, row["Sale Type"]]);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    for (const rows of groups.values()) {
      rows.sort((a, b) => a[metric] - b[metric]);
      for (let index = 0; index < rows.length; index++) {
        const rank = rows.findIndex(row => row[metric] === rows[index][metric]) + 1;
        assert.equal(rows[index]["Cheapest rank"], rank, `${periodName}: ${rows[index].Key}`);
      }
    }
  }
});
