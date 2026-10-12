import assert from "node:assert/strict";
import test from "node:test";
import { inspectPilot, loadPilotManifest, runPilotCheck } from "../scripts/buyer-decisions-pilot.js";
import { loadBuyerDecisionsConfig } from "../src/conversation/buyer-decisions-config.js";

const manifest = await loadPilotManifest();
const NOW = Date.parse("2026-10-11T14:10:47.000Z");
const policy = { commercialDays: 30, availabilityDays: 1 };

function fixture(verified = new Date(NOW).toISOString()) {
  return { source: "test", projects: [...new Map(manifest.units.map(row => [row.projectId, {
    id: row.projectId, name: row.projectName, active: true, approved: true, developerActive: true,
    source: "https://developer.example/test-plan", lastVerified: verified, handover: "Q1 2028",
    paymentPlanAvailable: true, paymentPlanSummary: "60/40; 10% on booking; 50% during construction; 40% on handover"
  }])).values()], units: manifest.units.map(row => ({ id: row.unitId, name: row.name,
    projectId: row.projectId, propertyType: row.propertyType, bedrooms: row.bedrooms,
    active: true, startingPriceAed: 1000000, initialPaymentAed: null, availability: "Available" })) };
}

const inspect = (catalog, selected = manifest) => inspectPilot(catalog, selected, { now: NOW, policy });

test("buyer decisions default off and expose only the curated actual record IDs", () => {
  for (const env of [{}, { BUYER_DECISIONS_ENABLED: "false" }, { BUYER_DECISIONS_ENABLED: "TRUE" }]) {
    assert.equal(loadBuyerDecisionsConfig(env).enabled, false);
  }
  const config = loadBuyerDecisionsConfig({ BUYER_DECISIONS_ENABLED: "true" });
  assert.equal(config.enabled, true);
  assert.equal(config.pilotUnitIds.length, 12);
  assert.equal(new Set(config.pilotUnitIds).size, 12);
  assert.ok(config.pilotUnitIds.every(id => /^rec[A-Za-z0-9]{14}$/.test(id)));
  config.pilotUnitIds.pop();
  assert.equal(loadBuyerDecisionsConfig({}).pilotUnitIds.length, 12);
});

test("pilot selection has six apartments and six family homes, without storing quotes", () => {
  assert.equal(manifest.units.filter(row => row.segment === "apartments").length, 6);
  assert.equal(manifest.units.filter(row => row.segment === "family").length, 6);
  assert.equal(manifest.inspection.confirmedAvailabilityRows, 0);
  assert.ok(manifest.units.every(row => !Object.hasOwn(row, "startingPriceAed")));
  assert.ok(manifest.units.filter(row => row.projectName === "Nawayef East").every(row => /Homes/.test(row.name)));
});

test("fresh supported pilot calculates booking from the approved plan without duplicate cash data", () => {
  const catalog = fixture();
  const original = structuredClone(catalog);
  const report = inspect(catalog);
  assert.equal(report.ready, true);
  assert.equal(report.summary.completeCashPicture, 12);
  assert.equal(report.units[0].derivedPaymentStages.find(stage => stage.key === "booking").amountAed, 100000);
  assert.deepEqual(catalog, original);
});

test("missing price or plan never creates derived payment amounts", () => {
  const catalog = fixture();
  catalog.units[0].startingPriceAed = null;
  catalog.projects.find(row => row.id === catalog.units[2].projectId).paymentPlanSummary = null;
  const report = inspect(catalog);
  assert.equal(report.ready, false);
  assert.ok(report.units[0].missingFields.includes("starting_price"));
  assert.deepEqual(report.units[0].derivedPaymentStages, []);
  assert.equal(report.units[2].readyForPriceComparison, true);
  assert.ok(report.units[2].missingFields.includes("payment_plan_summary"));
  assert.deepEqual(report.units[2].derivedPaymentStages, []);
});

test("a partial plan and conflicting booking amount remain incomplete", () => {
  const catalog = fixture();
  catalog.projects.find(row => row.id === catalog.units[0].projectId).paymentPlanSummary = "40/60";
  catalog.units[2].initialPaymentAed = 123456;
  const report = inspect(catalog);
  assert.equal(report.units[0].readyForPriceComparison, true);
  assert.equal(report.units[0].completeCashPicture, false);
  assert.ok(report.units[0].missingFields.includes("booking_payment"));
  assert.equal(report.units[2].completeCashPicture, false);
  assert.ok(report.units[2].missingFields.includes("booking_payment"));
});

test("availability verification is separate from price and payment readiness", () => {
  const catalog = fixture();
  catalog.units.forEach(row => { row.availability = null; });
  const report = inspect(catalog);
  assert.equal(report.summary.readyForPriceComparison, 12);
  assert.equal(report.summary.completeCashPicture, 12);
  assert.equal(report.summary.needsAvailabilityVerification, 12);
  assert.equal(report.ready, false);
  catalog.units[0].availability = "Sold out";
  assert.equal(inspect(catalog).units[0].availabilityStatus, "unavailable");
});

test("stale, future, inactive and changed-identity rows cannot pass the pilot", () => {
  for (const verified of ["2026-08-01", "2026-10-12"]) {
    const report = inspect(fixture(verified));
    assert.equal(report.summary.readyForPriceComparison, 0);
    assert.ok(report.units[0].missingFields.includes("fresh_commercial_verification"));
    assert.deepEqual(report.units[0].derivedPaymentStages, []);
  }
  const catalog = fixture();
  catalog.units[0].active = false;
  catalog.units[1].bedrooms = 3;
  catalog.units.splice(2, 1);
  const report = inspect(catalog);
  assert.ok(report.units[0].missingFields.includes("unit_active"));
  assert.ok(report.units[1].missingFields.includes("home_type_identity"));
  assert.ok(report.units[2].missingFields.includes("unit_record"));
});

test("duplicate and unbalanced manifests fail instead of broadening pilot scope", () => {
  const selected = structuredClone(manifest);
  selected.units[1] = selected.units[0];
  selected.units[6].segment = "apartments";
  const report = inspect(fixture(), selected);
  assert.equal(report.ready, false);
  assert.ok(report.manifestErrors.includes("duplicate_unit_id"));
  assert.ok(report.manifestErrors.includes("pilot_requires_six_per_segment"));
  assert.ok(report.manifestErrors.includes("invalid_segment_home_type"));
});

test("CLI defaults to local even when Airtable keys exist and prints no quote amounts", async () => {
  const lines = [];
  let options;
  const catalog = fixture(new Date().toISOString());
  const code = await runPilotCheck({ args: [], env: { AIRTABLE_API_KEY: "not-used", AIRTABLE_BASE_ID: "not-used" },
    createStore: async selected => {
      options = selected;
      return { source: "local", listProjects: () => catalog.projects, listUnits: () => catalog.units };
    }, write: line => lines.push(line), writeError: line => lines.push(line) });
  assert.equal(code, 0);
  assert.equal(options.store, "local");
  assert.equal(options.requireAirtable, undefined);
  const output = lines.join("\n");
  assert.doesNotMatch(output, /not-used|amountAed|1000000|buyers|phone/i);
  assert.ok(JSON.parse(output).units[0].supportedPaymentStages.includes("booking"));
});

test("CLI requires explicit production/Airtable configuration and redacts raw failure details", async () => {
  for (const [args, env] of [[[], { NODE_ENV: "production" }], [["--airtable"], {}], [["--unknown"], {}]]) {
    let touched = false;
    const code = await runPilotCheck({ args, env, createStore: async () => { touched = true; }, writeError: () => {} });
    assert.notEqual(code, 0);
    assert.equal(touched, false);
  }
  const errors = [];
  const code = await runPilotCheck({ args: ["--airtable"], env: { AIRTABLE_API_KEY: "private-key", AIRTABLE_BASE_ID: "base" },
    createStore: async () => { throw new Error("private-key private-buyer 971555555555"); }, writeError: line => errors.push(line) });
  assert.equal(code, 1);
  assert.deepEqual(errors, ["Pilot check failed: catalogue_unavailable_or_invalid. Review configuration and approved catalogue data."]);
});


test("named phases require their own terms and verification rather than fresh project data", () => {
  const catalog = fixture();
  catalog.units[0].phase = "Phase 2";
  catalog.units[0].launchPriceAed = 800000;
  let report = inspect(catalog);
  assert.equal(report.units[0].readyForRollout, false);
  for (const key of ["source", "last_verified", "starting_price", "payment_plan_summary", "handover"]) {
    assert.ok(report.units[0].missingFields.includes(key), key);
  }
  assert.deepEqual(report.units[0].derivedPaymentStages, []);
  assert.equal(report.units[1].readyForRollout, true);
  Object.assign(catalog.units[0], { source: "https://developer.example/phase-2", lastVerified: new Date(NOW).toISOString(),
    paymentPlanAvailable: "Yes", paymentPlanSummary: "25/75; 5% on booking; 20% during construction; 75% on handover",
    handover: "Q1 2029" });
  report = inspect(catalog);
  assert.equal(report.units[0].readyForRollout, true);
  assert.equal(report.units[0].phase, "Phase 2");
  assert.equal(report.units[0].derivedPaymentStages.find(stage => stage.key === "booking").amountAed, 50000);
  catalog.units[0].startingPriceAed = null;
  assert.ok(inspect(catalog).units[0].missingFields.includes("starting_price"));
  catalog.units[0].startingPriceAed = 1000000;
  catalog.units[0].lastVerified = "2026-08-01";
  assert.equal(inspect(catalog).units[0].availabilityStatus, "needs_verification");
});

test("a manifest with an explicit phase fails if the home type moves to another phase", () => {
  const catalog = fixture();
  const selected = structuredClone(manifest);
  selected.units[0].phase = "Phase 2";
  assert.ok(inspect(catalog, selected).units[0].missingFields.includes("home_type_identity"));
});
