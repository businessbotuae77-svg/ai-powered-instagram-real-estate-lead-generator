import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createCatalogStore } from "../src/store/create-store.js";
import { approvedFresh, factPolicy } from "../src/facts/freshness.js";
import { buildFactPack } from "../src/facts/retrieval.js";
import { packPaymentStages } from "../src/facts/payment-stages.js";

const MANIFEST_URL = new URL("../data/buyer-decisions-pilot.json", import.meta.url);
const present = value => value !== null && value !== undefined && value !== "";
const positive = value => Number.isFinite(value) && value > 0;

export async function loadPilotManifest() {
  return JSON.parse(await readFile(MANIFEST_URL, "utf8"));
}

/** A current readiness report, never an approval or a persisted price snapshot. */
export function inspectPilot(catalog, manifest, { now = Date.now(), policy = factPolicy({}) } = {}) {
  const rows = manifest?.units || [];
  const manifestErrors = [];
  if (rows.length !== 12) manifestErrors.push("pilot_requires_12_home_types");
  if (new Set(rows.map(row => row.unitId)).size !== rows.length) manifestErrors.push("duplicate_unit_id");
  if (rows.filter(row => row.segment === "apartments").length !== 6 ||
      rows.filter(row => row.segment === "family").length !== 6) manifestErrors.push("pilot_requires_six_per_segment");
  if (rows.some(row => row.segment === "apartments" ? row.propertyType !== "apartment" || row.bedrooms >= 3 :
    row.segment !== "family" || row.bedrooms < 3 || !["apartment", "townhouse", "villa"].includes(row.propertyType))) {
    manifestErrors.push("invalid_segment_home_type");
  }

  const units = rows.map(row => {
    const unit = (catalog.units || []).find(candidate => candidate.id === row.unitId);
    const project = (catalog.projects || []).find(candidate => candidate.id === unit?.projectId);
    const missingFields = [];
    if (!unit) missingFields.push("unit_record");
    if (!project) missingFields.push("project_record");
    if (unit && unit.active !== true) missingFields.push("unit_active");
    if (project && project.active !== true) missingFields.push("project_active");
    if (project && project.developerActive !== true) missingFields.push("developer_active");
    if (unit && (unit.projectId !== row.projectId || unit.propertyType !== row.propertyType ||
      unit.bedrooms !== row.bedrooms || (unit.name && unit.name !== row.name))) missingFields.push("home_type_identity");
    if (project && !present(project.source)) missingFields.push("source");
    if (project && !present(project.lastVerified)) missingFields.push("last_verified");
    if (project?.approved === false) missingFields.push("approval");
    const fresh = Boolean(project && approvedFresh(project, { now, maxAgeDays: policy.commercialDays }));
    if (project && !fresh) missingFields.push("fresh_commercial_verification");

    const pack = project && unit ? buildFactPack({ project, unit,
      downPaymentAed: unit.initialPaymentAed ?? project.initialPaymentAed ?? null }, { now, policy }) : null;
    const priceConfirmed = Boolean(pack?.startingPriceAed?.confirmed && positive(pack.startingPriceAed.value));
    if (!priceConfirmed) missingFields.push("starting_price");
    const readyForPriceComparison = missingFields.length === 0;
    const planConfirmed = Boolean(pack?.paymentPlanSummary?.confirmed && String(pack.paymentPlanSummary.value).trim());
    if (!planConfirmed) missingFields.push("payment_plan_summary");
    const stages = priceConfirmed && planConfirmed ? packPaymentStages(pack) : [];
    const completeStages = ["booking", "construction", "beforeHandover", "handover"].every(key =>
      stages.some(stage => stage.key === key));
    if (!stages.some(stage => stage.key === "booking")) missingFields.push("booking_payment");
    if (!completeStages) missingFields.push("complete_payment_stages");
    if (!pack?.handover?.confirmed) missingFields.push("handover");
    const completeCashPicture = missingFields.length === 0;

    const availabilityFresh = Boolean(project && approvedFresh(project, { now, maxAgeDays: policy.availabilityDays }));
    const availabilityKnown = availabilityFresh && /^(available|limited)$/i.test(unit?.availability || "");
    const availabilityStatus = availabilityKnown ? "verified" : availabilityFresh && /^sold out$/i.test(unit?.availability || "") ?
      "unavailable" : "needs_verification";
    return { unitId: row.unitId, name: row.name, projectId: row.projectId, segment: row.segment,
      readyForPriceComparison, completeCashPicture, readyForRollout: completeCashPicture && availabilityKnown,
      missingFields: [...new Set(missingFields)], availabilityStatus,
      needsAvailabilityVerification: availabilityStatus === "needs_verification",
      derivedPaymentStages: readyForPriceComparison ? stages : [] };
  });
  return { inspectedAt: new Date(now).toISOString(), source: catalog.source || "unknown", manifestErrors,
    ready: manifestErrors.length === 0 && units.length === 12 && units.every(row => row.readyForRollout),
    summary: { selected: units.length, readyForPriceComparison: units.filter(row => row.readyForPriceComparison).length,
      completeCashPicture: units.filter(row => row.completeCashPicture).length,
      readyForRollout: units.filter(row => row.readyForRollout).length,
      needsAvailabilityVerification: units.filter(row => row.needsAvailabilityVerification).length }, units };
}

export async function runPilotCheck({ args = process.argv.slice(2), env = process.env,
  createStore = createCatalogStore, write = text => console.log(text), writeError = text => console.error(text) } = {}) {
  const airtable = args.includes("--airtable");
  if (args.some(arg => arg !== "--airtable")) {
    writeError("Usage: npm run pilot:check [-- --airtable]");
    return 2;
  }
  if (!airtable && env.NODE_ENV === "production") {
    writeError("Production pilot checks require --airtable and configured catalogue access.");
    return 1;
  }
  if (airtable && (!env.AIRTABLE_API_KEY || !env.AIRTABLE_BASE_ID)) {
    writeError("Airtable pilot check requires configured AIRTABLE_API_KEY and AIRTABLE_BASE_ID.");
    return 1;
  }
  try {
    const manifest = await loadPilotManifest();
    const store = await createStore(airtable ? { env, requireAirtable: true } : { env, store: "local" });
    const catalog = { source: store.source || (airtable ? "airtable" : "local"),
      projects: store.listProjects({ includeInactive: true }), units: store.listUnits({ includeInactive: true }) };
    const report = inspectPilot(catalog, manifest, { policy: factPolicy(env) });
    // Categories and catalogue names only: no buyer state, keys, raw errors or quote amounts.
    const safeReport = { ...report, units: report.units.map(({ derivedPaymentStages, ...row }) =>
      ({ ...row, supportedPaymentStages: derivedPaymentStages.map(stage => stage.key) })) };
    write(JSON.stringify(safeReport, null, 2));
    return report.ready ? 0 : 1;
  } catch {
    writeError("Pilot check failed: catalogue_unavailable_or_invalid. Review configuration and approved catalogue data.");
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runPilotCheck();
}
