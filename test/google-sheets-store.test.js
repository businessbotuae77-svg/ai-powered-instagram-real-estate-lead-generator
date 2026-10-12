import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createGoogleTokenProvider, SHEETS_READONLY_SCOPE } from "../src/store/google-auth.js";
import { GoogleSheetsStore, normalizeGoogleSheetsCatalogue, CATALOGUE_HEADERS, APPROVAL_HEADERS } from "../src/store/google-sheets-store.js";
import { createCatalogStore } from "../src/store/create-store.js";
import { BuyerService } from "../src/services/buyer-service.js";
import { PropertyService } from "../src/services/property-service.js";
import { ConversationEngine } from "../src/conversation/engine.js";
import { buildFactPack } from "../src/facts/retrieval.js";

const developers = [{ id: "dev_aldar", name: "Aldar", active: true }];
const verified = new Date().toISOString().slice(0, 10);
const extras = ["Priced area sqft", "Area basis", "Price-area match", "AED per sqft", "AED per sqm", "Price basis", "Size sqft from", "Size sqft to", "Project source fields JSON", "Unit source fields JSON"];
const cell = value => blank(value) ? {} : { userEnteredValue: { [typeof value === "number" ? "numberValue" : typeof value === "boolean" ? "boolValue" : "stringValue"]: value },
  effectiveValue: { [typeof value === "number" ? "numberValue" : typeof value === "boolean" ? "boolValue" : "stringValue"]: value } };
const blank = value => value === null || value === undefined || value === "";

function fixture({ approval = "Approved", reviewed = "Reviewed", phase = "Phase 2", reordered = false } = {}) {
  const headers = [...CATALOGUE_HEADERS, ...extras];
  if (reordered) headers.reverse();
  const approvalHeaders = [...APPROVAL_HEADERS];
  if (reordered) approvalHeaders.reverse();
  const project = { Developer: "Aldar", Project: "Example project", "Row type": "Project", "Row review": reviewed,
    "Project ID": "project_stable", "Current starting price AED": 900000, "Initial payment AED": 90000,
    "Payment plan available": "Yes", "Payment plan summary": "80/20", Handover: "Q4 2027", Source: "https://example.com/project", "Last verified": verified,
    Area: "Yas Island", Emirate: "Abu Dhabi", "Project status": "Off-plan", "Project property types": '["apartment"]',
    Description: "Example description", Features: "Example features", Active: true, "Linked unit IDs": '["unit_stable"]' };
  const unit = { Developer: "Aldar", Project: "Example project", "Row type": "Home type", "Row review": reviewed,
    "Project ID": "project_stable", "Unit ID": "unit_stable", "Home type": "Example 2BR", "Property type": "apartment", Bedrooms: 2, Phase: phase,
    "Current starting price AED": 1900000, "Initial payment AED": 95000, "Payment plan available": "Yes", "Payment plan summary": "60/40",
    Handover: "Q1 2029", Source: "https://example.com/phase-two", "Last verified": verified, "Launch price AED (historical)": 1000000,
    Availability: "Unknown", Active: true, "Size sqft from": 950, "Size sqft to": 1050,
    "Priced area sqft": 1000, "Area basis": "Saleable", "Price-area match": "Confirmed", "AED per sqft": 999999, "AED per sqm": 999999,
    "Unit source fields JSON": '{"Starting price AED":99999999,"Phase":"wrong"}' };
  const queue = { "Review date": verified, Developer: "Aldar", Projects: 1, "Home types": 1, "Rows to review": 2, "Rows reviewed": 2, "Developer approval": approval,
    "Approved on": verified, "Approved by": "Broker" };
  const sheet = (title, fields, data) => ({ properties: { title }, data: [{ startRow: 6, startColumn: 0, rowData: [{ values: fields.map(cell) }, ...data.map(row => ({ values: fields.map(header => cell(row[header])) }))] }] });
  return { projects: project, unit, queue, headers, approvalHeaders,
    snapshot: () => ({ sheets: [sheet("Catalogue review", headers, [project, unit]), sheet("Daily approval", approvalHeaders, [queue])] }) };
}

async function storeFixture(options = {}) {
  const data = fixture(options);
  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "sheets-store-"));
  let now = Date.now(), reads = 0, failure = null;
  const store = new GoogleSheetsStore({ GOOGLE_SHEETS_ID: "private_example", runtimeDir, developers,
    tokenProvider: async () => "synthetic_token", now: () => now, fetch: async (url, args) => {
      reads += 1;
      assert.match(String(url), /^https:\/\/sheets.googleapis.com\/v4\/spreadsheets\/private_example\?/);
      assert.equal(args.method, "GET");
      assert.equal(args.headers.Authorization, "Bearer synthetic_token");
      assert.equal(new URL(url).searchParams.getAll("ranges").length, 2);
      assert.deepEqual(new URL(url).searchParams.getAll("ranges"), ["'Daily approval'", "'Catalogue review'"]);
      assert.doesNotMatch(new URL(url).searchParams.get("fields"), /notes/);
      if (failure) throw failure;
      return { ok: true, json: async () => data.snapshot() };
    } });
  await store.load();
  return { store, data, runtimeDir, reads: () => reads, advance: ms => { now += ms; }, fail: error => { failure = error; } };
}

test("private Sheets uses header names and stable IDs; archives and calculated metrics are ignored", () => {
  const f = fixture({ reordered: true });
  const result = normalizeGoogleSheetsCatalogue(f.snapshot(), developers);
  assert.equal(result.projects[0].id, "project_stable");
  assert.equal(result.units[0].id, "unit_stable");
  assert.equal(result.units[0].startingPriceAed, 1900000);
  assert.equal(result.units[0].launchPriceAed, 1000000);
  assert.equal(result.units[0].phase, "Phase 2");
  assert.equal(result.units[0].pricedAreaSqft, 1000);
  assert.equal(result.units[0].areaBasis, "Saleable");
  assert.equal(result.units[0].priceAreaMatched, true);
  assert.equal(result.units[0].aedPerSqft, undefined);
  assert.equal(result.units[0].active, true);
});

test("manual developer approval requires all associated rows complete, while exclusions never quote", () => {
  for (const status of ["Pending", "Needs updates"]) {
    const f = fixture(); f.unit["Row review"] = status;
    const result = normalizeGoogleSheetsCatalogue(f.snapshot(), developers);
    assert.equal(result.projects[0].active, false);
    assert.equal(result.units[0].active, false);
  }
  const excluded = fixture(); excluded.unit["Row review"] = "Excluded";
  const result = normalizeGoogleSheetsCatalogue(excluded.snapshot(), developers);
  assert.equal(result.projects[0].active, true);
  assert.equal(result.units[0].active, false);
  assert.equal(result.units[0].approved, true);
  const pending = fixture({ approval: "Pending" });
  assert.equal(normalizeGoogleSheetsCatalogue(pending.snapshot(), developers).projects[0].active, false);
});

test("formula approvals and note-only status or identity never grant approval", () => {
  const f = fixture(); const body = f.snapshot();
  const approval = body.sheets[1].data[0].rowData[1].values[f.approvalHeaders.indexOf("Developer approval")];
  approval.userEnteredValue = { formulaValue: '=IF(TRUE,"Approved","Pending")' };
  assert.equal(normalizeGoogleSheetsCatalogue(body, developers).projects[0].active, false);
  const noteBody = f.snapshot();
  const id = noteBody.sheets[0].data[0].rowData[2].values[f.headers.indexOf("Unit ID")];
  id.note = "unit_stable"; delete id.userEnteredValue; delete id.effectiveValue;
  assert.throws(() => normalizeGoogleSheetsCatalogue(noteBody, developers), /invalid_schema/);
});

test("missing current facts stay unknown and named phases never inherit project price, plan or handover", () => {
  const f = fixture();
  for (const header of ["Current starting price AED", "Initial payment AED", "Payment plan available", "Payment plan summary", "Handover", "Source", "Last verified"]) f.unit[header] = null;
  const result = normalizeGoogleSheetsCatalogue(f.snapshot(), developers);
  const pack = buildFactPack({ project: result.projects[0], unit: result.units[0], downPaymentAed: result.projects[0].initialPaymentAed });
  for (const field of ["startingPriceAed", "downPaymentAed", "paymentPlanSummary", "handover"]) assert.equal(pack[field].value, null, field);
  assert.equal(result.units[0].launchPriceAed, 1000000);
});

test("duplicate IDs, incomplete schema and conflicting project context fail the whole snapshot", () => {
  for (const mutate of [f => { f.headers.splice(f.headers.indexOf("Source"), 1); }, f => { f.unit.Project = "Different project"; },
    f => { f.unit.Area = "Different area"; }, f => { f.projects["Linked unit IDs"] = '[]'; }, f => { f.queue["Rows to review"] = 3; },
    f => { f.unit["Current starting price AED"] = "AED 1,900,000"; }, f => { f.unit["Current starting price AED"] = 0; }]) {
    const f = fixture(); mutate(f);
    assert.throws(() => normalizeGoogleSheetsCatalogue(f.snapshot(), developers), /invalid_schema/);
  }
  const f = fixture(); const body = f.snapshot(); body.sheets[0].data[0].rowData.push(structuredClone(body.sheets[0].data[0].rowData[2]));
  assert.throws(() => normalizeGoogleSheetsCatalogue(body, developers), /invalid_schema/);
  const split = f.snapshot(); split.sheets[0].data.push(structuredClone(split.sheets[0].data[0]));
  assert.throws(() => normalizeGoogleSheetsCatalogue(split, developers), /invalid_schema/);
  const shifted = f.snapshot(); shifted.sheets[0].data[0].startColumn = 2;
  assert.throws(() => normalizeGoogleSheetsCatalogue(shifted, developers), /invalid_schema/);
  const apartmentStudio = fixture(); apartmentStudio.unit.Bedrooms = 0;
  assert.equal(normalizeGoogleSheetsCatalogue(apartmentStudio.snapshot(), developers).units[0].bedrooms, 0);
});

test("typed Sheets dates map to verification dates without implying approval", () => {
  const f = fixture({ approval: "Pending" });
  f.projects["Last verified"] = 46307; f.unit["Last verified"] = 46307;
  const result = normalizeGoogleSheetsCatalogue(f.snapshot(), developers);
  assert.equal(result.projects[0].lastVerified, new Date(Date.UTC(1899, 11, 30) + 46307 * 86400000).toISOString());
  assert.equal(result.projects[0].approved, false);
});

test("cache expiry refreshes one private snapshot; simultaneous requests collapse", async () => {
  const f = await storeFixture();
  await Promise.all([f.store.refreshCatalog(), f.store.refreshCatalog()]);
  assert.equal(f.reads(), 1);
  f.advance(60000);
  await Promise.all([f.store.refreshCatalog(), f.store.refreshCatalog(), f.store.refreshCatalog()]);
  assert.equal(f.reads(), 2);
  assert.equal(f.store.listUnits()[0].id, "unit_stable");
});

test("cache settings are bounded and an expired read failure cannot quote previous facts", async () => {
  const f = await storeFixture();
  f.advance(60000); f.fail(new Error("private upstream body synthetic_token"));
  await assert.rejects(f.store.refreshCatalog(), error => error.code === "read_failed" && !/synthetic_token|upstream body/.test(error.message));
  assert.throws(() => f.store.listUnits(), /cache_expired/);
  assert.equal(f.store.units.length, 0);
  const common = { GOOGLE_SHEETS_ID: "private_example", tokenProvider: async () => "test" };
  assert.equal(new GoogleSheetsStore({ ...common, GOOGLE_SHEETS_CACHE_SECONDS: 1 }).cacheMs, 5000);
  assert.equal(new GoogleSheetsStore({ ...common, GOOGLE_SHEETS_CACHE_SECONDS: 999 }).cacheMs, 300000);
});

test("read timeouts and client failures are redacted and fail closed", async () => {
  const f = fixture();
  const store = new GoogleSheetsStore({ GOOGLE_SHEETS_ID: "private_example", developers, timeoutMs: 5, tokenProvider: async () => "secret", fetch: async (_, args) =>
    new Promise((resolve, reject) => args.signal.addEventListener("abort", () => reject(args.signal.reason), { once: true })) });
  const keepAlive = setTimeout(() => {}, 100);
  try { await assert.rejects(store.refreshCatalog(), /read_timeout/); } finally { clearTimeout(keepAlive); }
  assert.equal(store.projects.length, 0);
  const invalid = new GoogleSheetsStore({ GOOGLE_SHEETS_ID: "private_example", developers, tokenProvider: async () => "secret", fetch: async () => ({ ok: true, json: async () => ({ private: "secret" }) }) });
  await assert.rejects(invalid.refreshCatalog(), error => error.code === "invalid_schema" && !error.message.includes("secret"));
});

test("the engine reports an expired private catalogue failure instead of replaying a cached quote", async () => {
  const f = await storeFixture();
  const engine = new ConversationEngine({ buyers: new BuyerService(f.store), properties: new PropertyService(f.store) });
  const first = await engine.handleMessage("synthetic", "Budget 2M, 2 bedroom in Yas");
  assert.match(first.reply, /1,900,000/);
  f.advance(60000); f.fail(new Error("credentials must not be logged"));
  const failed = await engine.handleMessage("synthetic", "What is the price?");
  assert.match(failed.catalogError, /Google Sheets catalogue unavailable/);
  assert.doesNotMatch(failed.reply, /1,900,000|credentials/);
});

test("Sheets reuses existing buyer persistence and repository intelligence without calling Airtable", async () => {
  const f = await storeFixture();
  await f.store.saveBuyer({ instagramUserId: "synthetic", budgetAed: 2000000 });
  const other = new GoogleSheetsStore({ GOOGLE_SHEETS_ID: "private_example", runtimeDir: f.runtimeDir, developers,
    tokenProvider: async () => "test", fetch: async url => {
      assert.ok(!String(url).includes("airtable")); return { ok: true, json: async () => f.data.snapshot() };
    } });
  await other.load();
  assert.equal(other.getBuyer("synthetic").budgetAed, 2000000);
  assert.ok(other.listIntelligence().areas.length > 0);
});

test("explicit provider selection is required and production never falls back on missing Sheets credentials", async () => {
  await assert.rejects(createCatalogStore({ env: { NODE_ENV: "production", CATALOG_PROVIDER: "google_sheets", GOOGLE_SHEETS_ID: "private_example" } }), /invalid_credentials/);
  await assert.rejects(createCatalogStore({ env: { NODE_ENV: "production" } }), /Airtable is not configured/);
  const f = fixture(); const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "sheets-provider-"));
  const store = await createCatalogStore({ env: { NODE_ENV: "production", CATALOG_PROVIDER: "google_sheets", GOOGLE_SHEETS_ID: "private_example" },
    runtimeDir, tokenProvider: async () => "test", fetch: async url => { assert.match(String(url), /sheets.googleapis.com/); return { ok: true, json: async () => f.snapshot() }; } });
  assert.equal(store.source, "google_sheets");
});

test("service-account OAuth signs RS256 with read-only Sheets scope and caches concurrent token requests", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  let calls = 0;
  const now = () => Date.UTC(2026, 9, 12);
  const provider = createGoogleTokenProvider(JSON.stringify({ type: "service_account", client_email: "test@private.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }), token_uri: "https://untrusted.example/token" }), { now, fetchImpl: async (url, options) => {
    calls += 1; assert.equal(url, "https://oauth2.googleapis.com/token");
    const form = new URLSearchParams(options.body); const jwt = form.get("assertion"); const [header, body, signature] = jwt.split(".");
    assert.equal(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
    assert.equal(JSON.parse(Buffer.from(header, "base64url")).alg, "RS256");
    const claims = JSON.parse(Buffer.from(body, "base64url"));
    assert.equal(claims.scope, SHEETS_READONLY_SCOPE); assert.equal(claims.sub, undefined);
    assert.equal(claims.aud, url); assert.equal(claims.exp - claims.iat, 3600);
    assert.equal(verify("RSA-SHA256", Buffer.from(`${header}.${body}`), publicKey, Buffer.from(signature, "base64url")), true);
    return { ok: true, json: async () => ({ access_token: "safe_test_token", token_type: "Bearer", expires_in: 3600, scope: SHEETS_READONLY_SCOPE }) };
  } });
  assert.deepEqual(await Promise.all([provider(), provider(), provider()]), ["safe_test_token", "safe_test_token", "safe_test_token"]);
  await provider(); assert.equal(calls, 1);
  assert.throws(() => createGoogleTokenProvider('{"private_key":"must stay private"}'), error => error.code === "invalid_credentials" && !/must stay/.test(error.message));
});
