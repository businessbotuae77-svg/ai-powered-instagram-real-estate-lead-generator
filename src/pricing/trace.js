// The owner's view behind one figure: the recorded-sales row the bot quotes,
// the export rows that make it up (and those left out, with the rule that left
// them out), every developer offer and asking price on file for the project,
// and what the bot decides for a given budget and payment method.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadProjectKnowledge, lookupProjectSales } from "../facts/project-knowledge.js";
import { areaKey } from "../matching/area-names.js";
import { assessHome, offerReasons, projectPriceEvidence } from "./assess.js";
import { loadPriceLedger, pricingKey, recordState, recordsForProject } from "./ledger.js";
import { currency } from "./policy.js";

const folder = name => fileURLToPath(new URL(`../../data/market-prices/${name}`, import.meta.url));
export const ARCHIVE_PATHS = Object.freeze({ sales: folder("recent_sales.csv"), exclusions: folder("transaction_exclusions.csv"),
  flags: folder("transaction_flags.csv"), audit: folder("transaction_audit.json") });

// The same maps as build_project_knowledge.py and build_transaction_audit.py.
const TYPE_MAP = { apartment: "Apartment", villa: "Villa", "townhouse / attached villa": "Townhouse", duplex: "Duplex",
  penthouse: "Penthouse", "plot for villa": "Villa plot", office: "Office", retail: "Retail" };
const BEDS = { studio: "Studio", "1 bed": "1 BR", "2 beds": "2 BR", "3 beds": "3 BR", "4 beds": "4 BR", "5 beds": "5+ BR", "5+ beds": "5+ BR", "6+ beds": "5+ BR" };
const SQFT = 10.7639;
const OFFER_TYPE = { Apartment: "apartment", Villa: "villa", Townhouse: "townhouse", Duplex: "duplex", Penthouse: "penthouse" };

/** One CSV line into cells; the export has no embedded newlines (checked by the audit's row count). */
export function csvCells(line) {
  const cells = []; let cell = "", quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted;
    } else if (char === "," && !quoted) { cells.push(cell); cell = ""; } else cell += char;
  }
  cells.push(cell);
  return cells;
}

function readTable(file) {
  const text = readFileSync(file, "utf8").replace(/^﻿/, "");
  const lines = text.split(/\r?\n/);
  const header = csvCells(lines[0]).map(cell => cell.trim());
  const rows = [];
  for (let index = 1; index < lines.length; index++) {
    if (!lines[index]) continue;
    const cells = csvCells(lines[index]);
    rows.push({ line: index + 1, ...Object.fromEntries(header.map((field, i) => [field, cells[i] ?? ""])) });
  }
  return rows;
}

let archiveCache = null;
/** The ADREC export with its exclusion and flag archives, joined by source line. */
export function loadSalesArchive(paths = ARCHIVE_PATHS) {
  if (archiveCache?.paths === paths) return archiveCache;
  const bytes = readFileSync(paths.sales);
  const exclusions = new Map(readTable(paths.exclusions).map(row => [Number(row.source_line), row]));
  const flags = new Map();
  for (const row of readTable(paths.flags)) flags.set(Number(row.source_line), [...(flags.get(Number(row.source_line)) || []), row]);
  archiveCache = { paths, sha256: createHash("sha256").update(bytes).digest("hex"), rows: readTable(paths.sales), exclusions, flags,
    audit: JSON.parse(readFileSync(paths.audit, "utf8")) };
  return archiveCache;
}

/** Python's round(): halves go to the even neighbour, as numpy rounds the published figures. */
export function roundHalfEven(value) {
  const floor = Math.floor(value), part = value - floor;
  if (Math.abs(part - 0.5) < 1e-9) return floor % 2 === 0 ? floor : floor + 1;
  return Math.round(value);
}

const median = values => {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;

function saleRow(row, archive) {
  const areaSqm = Number(row["Property Sold Area (SQM)"]), price = Number(row["Property Sale Price (AED)"]);
  const sizeSqft = areaSqm * SQFT;
  return {
    line: row.line, date: row["Sale Application Date"], district: row.District.trim(), community: row.Community, project: row["Project Name"].trim(),
    propertyType: row["Property Type"], layout: row["Property Layout"], type: TYPE_MAP[row["Property Type"]] || null,
    bedrooms: BEDS[row["Property Layout"]] || "Not stated", areaSqm, sizeSqft, price, share: Number(row["Property Sold Share"]),
    aedPerSqft: sizeSqft > 0 ? price / sizeSqft : null, saleType: { "off-plan": "Off-plan", ready: "Ready" }[row["Sale Application Type"]] || row["Sale Application Type"],
    sequence: row["Sale Sequence"], exclusion: archive.exclusions.get(row.line) || null, flags: archive.flags.get(row.line) || []
  };
}

function inScope(row, scope) {
  return row.date >= scope.start && row.date <= scope.end &&
    (scope.saleSequence === "All" || row.sequence === scope.saleSequence) &&
    (scope.saleType === "All" || row.saleType === scope.saleType) &&
    row.type === scope.type && (scope.bedrooms === "All" || row.bedrooms === scope.bedrooms);
}

/** Recompute a published figure from its rows and say whether it matches. */
export function reproduce(rows, stat = null) {
  if (!rows.length) return { sales: 0, matches: stat ? stat.sales === 0 : true, differences: stat ? ["sales"] : [] };
  const figures = {
    sales: rows.length,
    medianPriceAed: roundHalfEven(median(rows.map(row => row.price))),
    averagePriceAed: roundHalfEven(mean(rows.map(row => row.price))),
    medianAedPerSqft: roundHalfEven(median(rows.map(row => row.aedPerSqft))),
    averageAedPerSqft: roundHalfEven(mean(rows.map(row => row.aedPerSqft))),
    averageSizeSqft: roundHalfEven(mean(rows.map(row => row.sizeSqft))),
    firstSale: rows.reduce((min, row) => row.date < min ? row.date : min, rows[0].date),
    lastSale: rows.reduce((max, row) => row.date > max ? row.date : max, rows[0].date)
  };
  const differences = stat ? Object.keys(figures).filter(key => stat[key] !== figures[key]) : [];
  return { ...figures, matches: Boolean(stat) && !differences.length, differences };
}

const bedLabel = bedrooms => bedrooms == null ? "All" : Number(bedrooms) === 0 ? "Studio" : Number(bedrooms) >= 5 ? "5+ BR" : `${Number(bedrooms)} BR`;
const typeLabel = type => ({ apartment: "Apartment", studio: "Apartment", villa: "Villa", townhouse: "Townhouse", duplex: "Duplex", penthouse: "Penthouse", "villa plot": "Villa plot" })[String(type || "apartment").toLowerCase()] || "Apartment";

/**
 * Everything behind one home's price at one project.
 * bedrooms: 0 for studios, null for every size; type: apartment, villa, townhouse, duplex or penthouse.
 */
export function traceHome({ project, district = null, bedrooms = null, type = "apartment", period = "Last 12 months", saleSequence = "Primary",
  saleType = "Off-plan", budgetAed = null, financing = null, knowledge = loadProjectKnowledge(), ledger = loadPriceLedger(), archive = null, now = Date.now() } = {}) {
  const identities = (knowledge.projects || []).filter(row => areaKey(row.name) === areaKey(project) && (!district || areaKey(row.area) === areaKey(district)));
  const identity = identities.length === 1 ? identities[0] : null;
  const name = identity?.name || project, area = identity?.area || district;
  const scope = { project: name, district: area, period, saleSequence, saleType, type: typeLabel(type), bedrooms: bedLabel(bedrooms),
    ...(knowledge.source?.periods?.[period] || {}) };
  const stat = identity ? lookupProjectSales(knowledge, { project: name, period, saleSequence, saleType })
    .find(row => row.area === area && row.type === scope.type && row.bedrooms === scope.bedrooms) || null : null;
  let rows = { included: [], excluded: [] }, reproduced = null, sourceMatches = null;
  if (identity && scope.start) {
    const loaded = archive || loadSalesArchive();
    sourceMatches = loaded.sha256 === knowledge.source?.sha256;
    const scoped = loaded.rows.filter(row => row["Project Name"].trim() === name && row.District.trim() === area).map(row => saleRow(row, loaded)).filter(row => inScope(row, scope));
    rows = { included: scoped.filter(row => !row.exclusion), excluded: scoped.filter(row => row.exclusion) };
    reproduced = reproduce(rows.included, stat);
  }
  const keys = [pricingKey(name, area || "")];
  const home = { type: OFFER_TYPE[scope.type] || null, bedrooms: bedrooms == null ? null : Number(bedrooms) };
  const buyer = { ...(budgetAed ? { budgetAed: Number(budgetAed) } : {}), ...(financing ? { financing } : {}) };
  const describe = record => ({ record, state: recordState(record, { now }), reasons: record.price?.kind === "none" ? [] : offerReasons(record, home, buyer, now) });
  const offers = recordsForProject(ledger, keys, "offers").map(describe);
  const asking = recordsForProject(ledger, keys, "asking").map(record => ({ record, state: recordState(record, { now }) }));
  const decision = assessHome({ buyer, home, evidence: projectPriceEvidence({ keys, catalog: {}, ledger }), recorded: stat, now });
  return { query: { project, district, bedrooms, type, period, saleSequence, saleType, budgetAed, financing }, identities, scope, stat,
    source: { file: knowledge.source?.file, sha256: knowledge.source?.sha256, dataUpTo: knowledge.source?.dataUpTo, archiveMatches: sourceMatches },
    rows, reproduced, offers, asking, decision };
}

const fmt = value => value == null ? "—" : Number(value).toLocaleString("en-US", { maximumFractionDigits: 0 });

function offerText({ record, state, reasons }, now) {
  const age = currency(record, { now });
  const home = record.home || {};
  const what = home.scope === "project" ? `project-wide${home.label ? ` (${home.label})` : ""}` : `${home.bedrooms === 0 ? "studio" : `${home.bedrooms}-bed`} ${home.type}${home.unitId ? ` unit ${home.unitId}` : ""}`;
  const price = record.price?.kind === "none" ? "no price" : `${record.price.raw ? `"${record.price.raw}"` : "no wording"} → ${record.price.amountAed == null ? "amount unresolved" : `AED ${fmt(record.price.amountAed)}`} (${record.price.kind}, ${record.price.discount})`;
  const lines = [`  ${record.id} · ${record.status}${state.review === "superseded" ? ` (superseded by ${record.supersededBy})` : ""} · ${state.usable ? "USABLE" : "not usable"}`,
    `    ${what}: ${price}`,
    `    payment: ${record.payment?.kind || "unknown"}${record.payment?.summary ? ` (${record.payment.summary})` : ""}${record.discountTerms?.eligibility ? ` · discount for: ${record.discountTerms.eligibility}` : ""}`,
    `    source: ${record.source?.kind} · ${record.source?.reference}`,
    `    dated: ${age.basisDate ? `${age.basis} ${age.basisDate}, ${age.ageDays} days old, ${age.state} (limit ${age.maxAgeDays})` : age.state}${record.checkedOn ? ` · last looked at ${record.checkedOn} (never restarts the clock)` : ""}`];
  if (record.availability?.status && record.availability.status !== "unknown") lines.push(`    availability: ${record.availability.status} · scope ${record.availability.scope}${record.availability.statement ? ` · "${record.availability.statement}"` : ""}`);
  for (const problem of state.blocking) lines.push(`    blocked: ${problem.code} (${problem.field})${problem.question ? ` — ${problem.question}` : ""}`);
  if (reasons.length) lines.push(`    for this home: ${[...new Set(reasons)].join(", ")}`);
  return lines;
}

/** Plain text for the terminal. */
export function formatTrace(result, { now = Date.now(), rowLimit = 40 } = {}) {
  const { scope, stat, reproduced, rows } = result;
  const out = [`Pricing trace · ${scope.project}${scope.district ? ` · ${scope.district}` : ""} · ${scope.type} · ${scope.bedrooms} · ${scope.saleSequence} ${scope.saleType} · ${scope.period}`];
  if (result.identities.length !== 1) out.push(result.identities.length ? `Several recorded projects match: ${result.identities.map(row => `${row.name} (${row.area})`).join(", ")}. Add --district.` : "No recorded project with that name.");
  out.push("", "1. Recorded sales (ADREC export; past sales, never a current price)");
  out.push(`   source ${result.source.file} sha256 ${String(result.source.sha256 || "").slice(0, 12)} · data to ${result.source.dataUpTo} · archive ${result.source.archiveMatches === false ? "DOES NOT MATCH the published figures" : "matches"}`);
  if (stat) {
    out.push(`   bot figure: ${stat.sales} sales · median AED ${fmt(stat.medianPriceAed)} · average AED ${fmt(stat.averagePriceAed)} · about ${fmt(stat.averageSizeSqft)} sq ft · ${stat.firstSale} to ${stat.lastSale} · ${stat.reliability}`);
    out.push(`   key: ${stat.key}`);
  } else out.push("   bot figure: none for this scope");
  if (reproduced) {
    out.push(`   recomputed from the rows below: ${reproduced.sales} sales · median AED ${fmt(reproduced.medianPriceAed)} · average AED ${fmt(reproduced.averagePriceAed)} → ${reproduced.matches ? "reproduced exactly" : stat ? `MISMATCH in ${reproduced.differences.join(", ")}` : "no published figure to compare"}`);
    out.push("", `   included (${rows.included.length}):  line · date · layout · sq ft · AED · AED/sq ft · flags`);
    for (const row of rows.included.slice(0, rowLimit)) {
      out.push(`   ${row.line} · ${row.date} · ${row.layout} · ${fmt(row.sizeSqft)} · ${fmt(row.price)} · ${fmt(row.aedPerSqft)}${row.flags.length ? ` · ${row.flags.map(flag => `${flag.flag}${flag.detail ? ` (${flag.detail})` : ""}`).join("; ")}` : ""}`);
    }
    if (rows.included.length > rowLimit) out.push(`   … ${rows.included.length - rowLimit} more (use --rows ${rows.included.length})`);
    out.push("", `   left out (${rows.excluded.length}), with the rule; nothing is deleted from the export:`);
    for (const row of rows.excluded.slice(0, rowLimit)) {
      const exclusion = row.exclusion;
      out.push(`   ${row.line} · ${row.date} · ${row.layout} · ${fmt(row.sizeSqft)} · ${fmt(row.price)} · share ${row.share} · ${exclusion.reason}${exclusion.threshold_low ? ` (AED/sq ft ${exclusion.aed_per_sqft}; allowed ${exclusion.threshold_low}–${exclusion.threshold_high} for ${exclusion.percentile_group})` : ""}`);
    }
  }
  out.push("", "2. Developer offers and availability notes on file");
  if (!result.offers.length) out.push("   none");
  for (const row of result.offers) out.push(...offerText(row, now).map(line => ` ${line}`));
  out.push("", "3. Resale asking prices (comparison only; never a fit)");
  if (!result.asking.length) out.push("   none");
  for (const { record, state } of result.asking) out.push(`   ${record.id} · ${record.status} · ${record.price?.raw} · ${record.source?.kind} · ${record.source?.reference} · ${state.currency.state}`);
  const { decision } = result;
  out.push("", `4. Decision${result.query.budgetAed ? ` for a budget of AED ${fmt(result.query.budgetAed)}` : " (no budget given)"}${result.query.financing ? `, paying by ${result.query.financing}` : ""}: ${decision.decision}`);
  if (decision.quoted) out.push(`   priced by ${decision.quoted.id} at AED ${fmt(decision.quoted.price.amountAed)}`);
  if (decision.conflict) out.push(`   held back by: ${decision.conflict.map(row => row.id).join(", ")}`);
  if (decision.needsCheck) out.push("   needs a current price check before any fit is claimed");
  return out.join("\n");
}
