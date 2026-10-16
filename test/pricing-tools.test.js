import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { ASKING_PATH, OFFERS_PATH, createPriceLedger, recordState } from "../src/pricing/ledger.js";
import { currency } from "../src/pricing/policy.js";
import { TEMPLATE_COLUMNS, appendRecords, approveRecord, clarifyRecord, formatLedgerFile, readAmount, readLedgerFile, readTemplate,
  recheckRecord, recordFromRow, reviewQueue, sourceFileFingerprint, withdrawRecord } from "../src/pricing/intake.js";
import { ARCHIVE_PATHS, formatTrace, loadSalesArchive, traceHome } from "../src/pricing/trace.js";
import { loadProjectKnowledge, lookupProjectSales } from "../src/facts/project-knowledge.js";
import { projectCommunity } from "../src/facts/project-geography.js";

// The owner's tools: intake that never guesses, approval that cannot skip an
// open question, history that is never erased, and a trace from any quoted
// recorded figure back to the export rows (and exclusions) behind it.

const daysAgo = days => new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
const csvLine = values => values.map(value => /[",\n]/.test(String(value ?? "")) ? `"${String(value).replace(/"/g, '""')}"` : String(value ?? "")).join(",");

function tempLedger() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pricing-ledger-"));
  const offers = path.join(dir, "developer-offers.json"), asking = path.join(dir, "resale-asking.json");
  copyFileSync(OFFERS_PATH, offers);
  copyFileSync(ASKING_PATH, asking);
  return { dir, offers, asking };
}

function template(rows) {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), "pricing-template-")), "intake.csv");
  writeFileSync(file, [TEMPLATE_COLUMNS.join(","), ...rows.map(row => csvLine(TEMPLATE_COLUMNS.map(column => row[column] ?? "")))].join("\n"));
  return file;
}

const VISTA_3 = { project: "Vista 3", district: "Al Reem Island", developer: "Reportage" };

test("a written amount is read only when it is unambiguous", () => {
  for (const [raw, amount] of [["AED 2.44M", 2440000], ["1,150,000", 1150000], ["850k", 850000], ["1150000", 1150000], ["1.150.000", 1150000],
    ["From AED 835k", 835000], ["AED 1.5 million", 1500000], ["٢٫٤٤ مليون", 2440000]]) {
    assert.deepEqual(readAmount(raw), { amountAed: amount, readings: [] }, raw);
  }
  for (const [raw, reading] of [["1,5", 1500000], ["1.5", 1500000], ["1,5M", 1500000], ["850", 850000], ["2,44", 2440000]]) {
    const read = readAmount(raw);
    assert.equal(read.amountAed, null, `${raw} stays unresolved`);
    assert.equal(read.readings[0].amountAed, reading);
    assert.match(read.readings[0].reading, /Not confirmed/);
  }
});

test("a filled template becomes reviewable records with every open question written down", () => {
  const ledger = tempLedger();
  const file = template([
    { ...VISTA_3, record_type: "offer", home_type: "apartment", bedrooms: "1", price_raw: "AED 1,150,000", price_kind: "exact_quote", discount: "not_stated",
      payment_kind: "developer_plan", payment_summary: "10% booking, 50% during construction, 40% on handover", booking_pct: "10", construction_pct: "50", handover_pct: "40",
      source_kind: "developer_price_list", source_reference: "Reportage price list, October", issued_on: daysAgo(4) },
    { ...VISTA_3, record_type: "offer", home_type: "apartment", bedrooms: "1", price_raw: "1,5", discount: "before_discount",
      source_kind: "developer_message", source_reference: "WhatsApp from the developer's sales contact", source_quote: "1 bed 1,5 before discount" },
    { ...VISTA_3, record_type: "availability", home_type: "apartment", bedrooms: "2", availability_status: "not_available", availability_scope: "contact_inventory",
      availability_statement: "no two-bedroom stock through that contact", source_kind: "developer_message", source_reference: "Same message", received_on: daysAgo(2) },
    { project: "Rotana Residences South", district: "Al Reem Island", record_type: "asking", home_type: "apartment", bedrooms: "2", price_raw: "AED 2,300,000",
      price_kind: "starting_price", source_reference: "https://example.com/listing", listed_on: daysAgo(5) }
  ]);
  const document = path.join(ledger.dir, "price-list.pdf");
  writeFileSync(document, "price list bytes");
  const records = readTemplate(file).map((row, index) => recordFromRow(row, { createdOn: daysAgo(0), sourceFile: sourceFileFingerprint(document), sequence: index + 1 }));
  const [list, message, note, asking] = records;
  assert.equal(list.status, "draft", "complete, but still waits for the owner");
  assert.deepEqual(list.payment.stages, { bookingPct: 10, constructionPct: 50, handoverPct: 40 });
  assert.equal(list.source.fileSha256, createHash("sha256").update("price list bytes").digest("hex"));
  assert.equal(message.status, "needs_clarification");
  assert.equal(message.price.raw, "1,5");
  assert.equal(message.price.amountAed, null);
  assert.equal(message.price.readings[0].amountAed, 1500000);
  assert.deepEqual(message.unresolved.filter(item => item.blocking).map(item => item.field), ["price.amountAed", "price.kind", "receivedOn"]);
  assert.equal(message.availability.status, "unknown", "no availability is inferred from a price");
  assert.equal(note.price.kind, "none");
  assert.equal(asking.evidenceType, "resale_asking");
  const offers = appendRecords(ledger.offers, [list, message, note]);
  assert.equal(offers.length, 3);
  assert.ok(offers.every(record => !recordState(record).usable), "nothing prices a home before approval");
  assert.deepEqual(offers[0].problems, []);
  appendRecords(ledger.asking, [asking]);
  const queue = reviewQueue(createPriceLedger({ offers: readLedgerFile(ledger.offers).records, asking: readLedgerFile(ledger.asking).records }));
  assert.ok(queue.awaitingApproval.some(({ record }) => record.id === list.id));
  assert.ok(queue.needsClarification.some(({ record }) => record.id === message.id));
  assert.ok(queue.askingOnFile.every(({ record }) => record.evidenceType === "resale_asking"));
  assert.equal(queue.usable.length, 0);
  // Stages are kept as written and must add up.
  const short = recordFromRow({ ...VISTA_3, home_type: "apartment", bedrooms: "1", price_raw: "AED 1,150,000", price_kind: "exact_quote", payment_kind: "developer_plan",
    booking_pct: "10", handover_pct: "80", source_kind: "developer_price_list", source_reference: "list", issued_on: daysAgo(4) }, { createdOn: daysAgo(0) });
  assert.ok(createPriceLedger({ offers: [short] }).offers[0].problems.some(problem => problem.code === "payment_stages_do_not_sum"));
});

test("approval waits for every answer; a clarification supersedes the original without erasing it", () => {
  const ledger = tempLedger();
  assert.throws(() => approveRecord(ledger.offers, "OFFER-V3-MSG1-1BR", { reviewer: "Owner", on: daysAgo(0) }), error =>
    error.blocking.some(problem => problem.code === "ambiguous_amount") && /What exact amount does “1,5” mean\?/.test(error.message));
  const clarified = clarifyRecord(ledger.offers, "OFFER-V3-MSG1-1BR", { "price.amountAed": 1500000, "price.kind": "exact_quote", receivedOn: daysAgo(3),
    "discountTerms.description": "Developer discount, amount to confirm", "discountTerms.eligibility": "All buyers", "payment.kind": "unknown" },
  { on: daysAgo(0), note: "Developer confirmed 1,5 means AED 1,500,000 for one unit" });
  assert.equal(clarified.id, "OFFER-V3-MSG1-1BR-R1");
  assert.deepEqual(clarified.supersedes, ["OFFER-V3-MSG1-1BR"]);
  assert.equal(clarified.price.raw, "1,5", "the developer's wording travels with the answer");
  assert.equal(clarified.price.readings, undefined);
  assert.deepEqual(clarified.unresolved.map(item => item.field), ["home.sizeSqftFrom"]);
  assert.equal(clarified.status, "draft");
  approveRecord(ledger.offers, clarified.id, { reviewer: "Owner", on: daysAgo(0) });
  const after = createPriceLedger({ offers: readLedgerFile(ledger.offers).records }).offers;
  const original = after.find(record => record.id === "OFFER-V3-MSG1-1BR");
  assert.equal(original.price.amountAed, null, "the original record is unchanged");
  assert.equal(original.supersededBy, "OFFER-V3-MSG1-1BR-R1");
  assert.equal(recordState(original).usable, false);
  assert.equal(recordState(after.find(record => record.id === clarified.id)).usable, true);
  assert.throws(() => approveRecord(ledger.offers, clarified.id, { reviewer: "Owner", on: daysAgo(0) }), /approved; only draft/);
  assert.throws(() => approveRecord(ledger.offers, "AVAIL-V3-MSG1-2BR", { on: daysAgo(0) }), /Say who approved it/);
  const withdrawn = withdrawRecord(ledger.offers, clarified.id, { reason: "sold", on: daysAgo(0) });
  assert.equal(withdrawn.status, "withdrawn");
  assert.equal(readLedgerFile(ledger.offers).records.filter(record => record.id.startsWith("OFFER-V3-MSG1-1BR")).length, 2, "both records stay on file");
});

test("re-checking an unchanged page moves only the date it was looked at", () => {
  const ledger = tempLedger();
  const later = Date.parse("2026-11-20T09:00:00Z");
  const before = readLedgerFile(ledger.offers).records.find(record => record.id === "OFFER-V3-WEB-20261016");
  const after = recheckRecord(ledger.offers, "OFFER-V3-WEB-20261016", { on: "2026-11-20" });
  assert.equal(after.checkedOn, "2026-11-20");
  assert.equal(after.issuedOn, before.issuedOn);
  assert.deepEqual(currency(after, { now: later }), currency(before, { now: later }));
  assert.equal(currency(after, { now: later }).state, "stale");
});

test("the ledger files keep the layout the intake tool writes, so each change is a small diff", () => {
  for (const file of [OFFERS_PATH, ASKING_PATH]) assert.equal(formatLedgerFile(readLedgerFile(file)), readFileSync(file, "utf8"), file);
});

test("the trace reproduces Vista 3's quoted 2-bed figure from its export rows", () => {
  const two = traceHome({ project: "vista 3", bedrooms: 2, budgetAed: 1200000 });
  assert.equal(two.stat.key, "Last 12 months | Al Reem Island | Vista 3 | Primary | Off-plan | Apartment | 2 BR");
  assert.deepEqual([two.stat.sales, two.stat.medianPriceAed, two.stat.averagePriceAed], [11, 948132, 969980]);
  assert.equal(two.reproduced.matches, true, JSON.stringify(two.reproduced.differences));
  assert.equal(two.rows.included.length, 11);
  assert.equal(two.rows.excluded.length, 0);
  assert.equal(two.source.archiveMatches, true);
  assert.equal(two.decision.decision, "history_within");
  assert.deepEqual(two.offers.map(row => row.record.id).sort(), ["AVAIL-V3-MSG1-2BR", "OFFER-V3-MSG1-1BR", "OFFER-V3-MSG1-3BR-PH", "OFFER-V3-WEB-20261016"]);
  const text = formatTrace(two);
  assert.match(text, /recomputed from the rows below: 11 sales · median AED 948,132 · average AED 969,980 → reproduced exactly/);
  assert.match(text, /What exact amount does “1,5” mean\?/);
  // Low sales outside the district's 1st-99th percentile band are left out with their rule, not deleted.
  const four = traceHome({ project: "Vista 3", bedrooms: 4 });
  assert.equal(four.reproduced.matches, true);
  assert.deepEqual(four.rows.excluded.map(row => [row.price, row.exclusion.reason]), [[1020000, "aed_per_sqft_below_p01"], [985000, "aed_per_sqft_below_p01"]]);
  assert.match(formatTrace(four), /allowed 584\.58–1850\.47 for Al Reem Island \| Apartment \| 4 BR/);
});

test("the export archive is intact, every exclusion is explained, and the published figures reproduce", () => {
  const archive = loadSalesArchive();
  const knowledge = loadProjectKnowledge();
  assert.equal(archive.sha256, "a00fa4473c2df91be39c26192aabd0b861ce1970ab810dcc1ab89a7435018329", "the original export is unchanged");
  assert.equal(archive.sha256, knowledge.source.sha256);
  assert.equal(archive.audit.source.sha256, archive.sha256);
  assert.equal(archive.rows.length, archive.audit.source.rows);
  assert.equal(archive.exclusions.size, archive.audit.excludedRows);
  const reasons = Object.keys(archive.audit.exclusionRules);
  for (const row of archive.exclusions.values()) {
    assert.ok(reasons.includes(row.reason), row.reason);
    if (row.reason === "partial_share") assert.notEqual(Number(row.sold_share), 1);
    if (row.reason.startsWith("aed_per_sqft")) assert.ok(row.threshold_low && row.threshold_high && row.percentile_group, row.source_line);
  }
  for (const [line, flags] of archive.flags) for (const flag of flags) assert.equal(flag.in_price_figures === "True", !archive.exclusions.has(line), `${line} ${flag.flag}`);
  // Every developer-sale figure the bot can quote in the five reference areas reproduces from its rows.
  // Masdar City projects are recorded under the Khalifa City district in the export.
  const areas = ["Al Reem Island", "Al Shamkhah", "Masdar City", "Yas Island", "Al Hidayriyyat"];
  const stats = lookupProjectSales(knowledge, { period: "Last 12 months", saleSequence: "Primary", saleType: "Off-plan" })
    .filter(row => areas.includes(projectCommunity(row.project, row.area)) && row.reliability === "OK" && /^(?:Studio|[1-4] BR)$/.test(row.bedrooms) &&
      ["Apartment", "Villa", "Townhouse"].includes(row.type));
  assert.ok(stats.length > 150, `${stats.length} figures`);
  for (const area of areas) assert.ok(stats.some(row => projectCommunity(row.project, row.area) === area), area);
  const byProject = new Map();
  for (const row of archive.rows) {
    const key = `${row["Project Name"].trim()}|${row.District.trim()}`;
    if (!byProject.has(key)) byProject.set(key, []);
    byProject.get(key).push(row);
  }
  for (const stat of stats) {
    const result = traceHome({ project: stat.project, district: stat.area, bedrooms: stat.bedrooms === "Studio" ? 0 : Number(stat.bedrooms[0]), type: stat.type.toLowerCase(),
      archive: { ...archive, rows: byProject.get(`${stat.project}|${stat.area}`) || [] } });
    assert.equal(result.reproduced?.matches, true, `${stat.key}: ${JSON.stringify(result.reproduced?.differences)}`);
  }
  assert.equal(ARCHIVE_PATHS.sales.endsWith("recent_sales.csv"), true);
});
