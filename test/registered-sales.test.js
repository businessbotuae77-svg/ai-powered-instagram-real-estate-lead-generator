import test from "node:test";
import assert from "node:assert/strict";
import { buildRegisteredSales, parseCsv, layoutBedrooms } from "../scripts/import-registered-sales.js";
import { registeredSalesFromRecords, registeredProjectsInMessage } from "../src/facts/registered-sales.js";
import { AirtableStore } from "../src/store/airtable-store.js";
import { registeredSalesAnswer } from "../src/conversation/registered-sales-answer.js";
import { thesisClaims } from "../src/facts/advisor-claims.js";
import { validateMessage } from "../src/facts/checker.js";
import { setupConversation } from "./helpers.js";

const headers = ["Asset Class", "Property Type", "Sale Application Date", "Property Layout", "District", "Community", "Project Name", "Property Sale Price (AED)", "Property Sold Share", "Property Sold Area (SQM)", "Sale Sequence", "Sale Application Type"];
const line = (price, extra = {}) => ({ "Asset Class": "residential", "Property Type": "apartment", "Sale Application Date": "2026-10-10", "Property Layout": "2 beds", District: "Al Reem Island", Community: "RS2", "Project Name": "Cove Test", "Property Sale Price (AED)": price, "Property Sold Share": 1, "Property Sold Area (SQM)": 100, "Sale Sequence": "Primary", "Sale Application Type": "off-plan", ...extra });
const csv = rows => [headers.join(","), ...rows.map(row => headers.map(h => `"${String(row[h] ?? "").replace(/"/g, '""')}"`).join(","))].join("\r\n");
function fixture(rows = [line(100000), line(300000), line(900000)]) {
  return buildRegisteredSales(csv(rows), { checkedOn: "2026-10-15", government: { checkedOn: "2026-10-15", districts: ["Al Reem Island"], projects: ["Cove Test"] } });
}
function privateRecord(data, extra = {}) {
  return { id: "rec-private", fields: { Name: "Cove Test", Active: false,
    "Registry source": data.source.url, "Registry checked on": data.source.checkedOn,
    "Recorded home types and prices": JSON.stringify({ commercialUse: false, sourceSha256: data.source.sha256, registryScopes: data.projects }), ...extra } };
}

test("sales CSV parsing preserves quoted commas, quotes, embedded newlines and BOM", () => {
  const name = 'Cove, "Phase A"\nTower';
  assert.equal(parseCsv(`\uFEFF${csv([line(100, { "Project Name": name })])}`)[0]["Project Name"], name);
  assert.throws(() => parseCsv('"unclosed'), /Unclosed/);
  assert.throws(() => parseCsv("a,b\nx,y"), /Missing CSV column/);
});

test("home evidence excludes land and private identities and cannot turn partial or court sales into prices", () => {
  const d = fixture([line(100000), line(300000), line(900000),
    line(1, { "Property Sold Share": 0.5 }), line(1, { "Sale Application Type": "court-mandated" }),
    line(1, { "Property Type": "plot for villa" }), line(1, { "Project Name": "Private" })]);
  assert.equal(d.projects.length, 1);
  assert.equal(d.projects[0].homeTypes[0].mixedSales.medianPriceAed, 300000);
  assert.equal(d.projects[0].homeTypes[0].mixedSales.rows, 3);
  assert.equal(d.audit.excludedPriceRows, 2);
});

test("identical rows remain explicitly counted without claiming transaction deduplication", () => {
  const d = fixture([line(100000), line(100000), line(300000)]);
  assert.equal(d.audit.repeatedRows, 1);
  assert.equal(d.projects[0].homeTypes[0].mixedSales.rows, 3);
  assert.equal(d.projects[0].homeTypes[0].mixedSales.distinctRows, 2);
});

test("five-plus, six-plus and unclassified layouts never become exact bedroom counts", () => {
  assert.deepEqual(layoutBedrooms("6+ beds"), { bedrooms: null, minimumBedrooms: 6 });
  assert.equal(layoutBedrooms("5+ beds").bedrooms, null);
  assert.equal(layoutBedrooms("unclassified").bedrooms, null);
  assert.equal(layoutBedrooms("studio").bedrooms, 0);
  const data = fixture([line(1000000, { "Property Type": "villa", "Property Layout": "6+ beds" })]);
  const reply = registeredSalesAnswer({ message: "6 bedroom villa price in Cove Test", catalog: { registeredSales: data } });
  assert.equal(reply.recordedSales.missingScope, true);
  assert.doesNotMatch(reply.text, /AED/);
});

test("price answers preserve primary versus resale and ready versus off-plan scope", () => {
  const data = fixture([line(100000), line(900000, { "Sale Sequence": "Secondary", "Sale Application Type": "ready" })]);
  const reply = registeredSalesAnswer({ message: "Cove Test secondary ready 2 bedroom price", catalog: { registeredSales: data } });
  assert.match(reply.text, /AED 900,000/);
  assert.match(reply.text, /Secondary, ready/);
  assert.doesNotMatch(reply.text, /AED 100,000/);
  assert.equal(reply.suppressCommercial, true);
  assert.equal(reply.factPacks.length, 0);
});

test("historical answers retain the existing checker and reject changed prices", () => {
  const reply = registeredSalesAnswer({ message: "Cove Test price", catalog: { registeredSales: fixture() } });
  const allowedClaims = thesisClaims(reply.investmentTheses);
  assert.equal(validateMessage(reply.text, [], { allowedClaims }).ok, true);
  assert.equal(validateMessage(reply.text.replace("AED 300,000", "AED 999,999"), [], { allowedClaims }).ok, false);
  assert.equal(validateMessage("Cove Test is available now for AED 300,000", [], { allowedClaims }).ok, false);
});

test("current quotes keep priority and sales exports do not answer availability or payment plans", () => {
  const catalog = { registeredSales: fixture(), projects: [{ id: "current", name: "Cove Test" }], units: [{ projectId: "current", startingPriceAed: 1234567 }] };
  assert.equal(registeredSalesAnswer({ message: "Cove Test price", catalog }), null);
  assert.ok(registeredSalesAnswer({ message: "Cove Test historical price", catalog }));
  assert.equal(registeredSalesAnswer({ message: "Cove Test payment plan", catalog }), null);
  assert.equal(registeredSalesAnswer({ message: "Cove Test available?", catalog }), null);
});

test("official-name confirmation is required and phases do not inherit shorter-name prices", () => {
  const d = fixture(); d.projects[0].governmentNameConfirmed = false;
  assert.equal(registeredSalesAnswer({ message: "Cove Test price", catalog: { registeredSales: d } }), null);
  const names = ["Manchester City Yas Residences", "Manchester City Yas Residences - Phase A"];
  const data = buildRegisteredSales(csv(names.map((name, i) => line(100000 + i * 100000, { "Project Name": name, District: "Al Rahah" }))), {
    checkedOn: "2026-10-15", government: { checkedOn: "2026-10-15", districts: ["Al Rahah"], projects: names },
    aliases: { "Manchester City Yas Residences by Ohana": names } });
  const selected = registeredProjectsInMessage("Manchester City Yas Residences - Phase A prices", data);
  assert.ok(selected.length);
  assert.ok(selected.every(p => p.name === "Manchester City Yas Residences - Phase A"));
  assert.ok(selected.every(p => p.district === "Al Rahah"));
  assert.equal(registeredSalesAnswer({ message: "Compare Manchester City Yas Residences versus Manchester City Yas Residences - Phase A historical prices", catalog: { registeredSales: data } }), null);
});

test("real English and Arabic turns answer a newly discovered project and remember it for follow-ups", async () => {
  for (const [id, message] of [["sales-en", "What home types and prices are recorded at Cove Test?"], ["sales-ar", "كم سعر شقة غرفتين في Cove Test؟"]]) {
    const { engine, store } = await setupConversation(); store.registeredSales = fixture();
    const answer = await engine.handleMessage(id, message);
    assert.equal(answer.stage, "recorded_sales");
    assert.equal(answer.check.ok, true);
    assert.match(answer.reply, /AED 300,000/);
    assert.equal(answer.matchCount, 0);
    assert.equal(answer.buyer.projectInterest, "Cove Test");
    const next = await engine.handleMessage(id, id.endsWith("ar") ? "سعر غرفتين؟" : "What about the 2 bedroom price?");
    assert.equal(next.stage, "recorded_sales");
    assert.equal(next.check.ok, true);
    const stop = await engine.handleMessage(id, "Stop messaging me");
    assert.notEqual(stop.stage, "recorded_sales");
  }
});

test("private import fields are parsed without a public dataset or commercial activation", () => {
  const data = fixture(), record = privateRecord(data);
  const result = registeredSalesFromRecords([record]);
  assert.equal(result.source.commercialUse, false);
  assert.equal(result.projects.length, 1);
  assert.equal(record.fields.Active, false);
  assert.equal(registeredSalesFromRecords([privateRecord(data, { "Registry source": "https://example.com" })]).projects.length, 0);
  assert.equal(registeredSalesFromRecords([privateRecord(data, { "Registry checked on": "2099-01-01" })]).projects.length, 0);
  assert.equal(registeredSalesFromRecords([privateRecord(data, { "Recorded home types and prices": "malformed" })]).projects.length, 0);
});

test("the production Airtable store exposes inactive research through the private path only", async () => {
  const record = privateRecord(fixture());
  const store = new AirtableStore({ AIRTABLE_API_KEY: "test", AIRTABLE_BASE_ID: "test", developers: [],
    fetch: async url => ({ ok: true, json: async () => ({ records: String(url).split("?")[0].endsWith("/Projects") ? [record] : [] }) }) });
  await store.refreshCatalog(true);
  assert.equal(store.listProjects().length, 0);
  assert.equal(store.listUnits().length, 0);
  assert.equal(store.listRegisteredSales().projects.length, 1);
  assert.equal(store.listRegisteredSales().projects[0].name, "Cove Test");
});
