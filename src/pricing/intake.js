// Turning a price list, quotation, developer message or screenshot into
// reviewable ledger records. Nothing is inferred: a blank cell stays missing, an
// ambiguous amount stays unresolved with its possible reading noted, and no
// record is approved without the owner. Records are appended, never edited away.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { csvCells } from "./trace.js";
import { ASKING_PATH, OFFERS_PATH, createPriceLedger, recordState } from "./ledger.js";
import { EVIDENCE_TYPES, SOURCE_POLICY, validDate } from "./policy.js";

export const TEMPLATE_COLUMNS = Object.freeze([
  "record_type", "project", "registry_name", "district", "community", "developer", "phase", "building",
  "home_scope", "home_type", "bedrooms", "unit_id", "size_sqft_from", "size_sqft_to",
  "price_raw", "price_aed", "price_to_aed", "price_kind", "discount", "discount_description", "discount_eligibility",
  "payment_kind", "payment_summary", "booking_pct", "construction_pct", "handover_pct", "post_handover_pct", "post_handover_months", "full_payment_within_months",
  "availability_status", "availability_scope", "availability_statement",
  "source_kind", "source_reference", "source_quote", "issued_on", "received_on", "verified_on", "listed_on", "valid_until", "notes"
]);

const digits = text => String(text ?? "").replace(/[٠-٩]/g, c => String(c.charCodeAt(0) - 0x660)).replace(/[۰-۹]/g, c => String(c.charCodeAt(0) - 0x6f0))
  .replace(/٫/g, ".").replace(/٬/g, ",");
const blank = value => value == null || String(value).trim() === "";
const textOrNull = value => blank(value) ? null : String(value).trim();
const numberOrNull = value => {
  if (blank(value)) return null;
  const number = Number(digits(value).replace(/,/g, ""));
  return Number.isFinite(number) ? number : Number.NaN;
};

/**
 * Read a written amount without guessing. "AED 2.44M", "1,150,000" and "850k"
 * are clear; "1,5" or "1.5" without a unit are not, so the amount stays empty
 * and the likely reading is recorded for the owner to confirm.
 */
export function readAmount(raw) {
  const text = digits(raw).replace(/\b(?:AED|Dhs?|dirhams?)\b|درهم|دراهم/gi, "").replace(/\s+/g, " ").trim().replace(/^from\s+|^يبدأ من\s+/i, "");
  if (!text) return { amountAed: null, readings: [] };
  const unit = text.match(/^(\d+(?:[.,]\d+)?)\s*(m|mn|million|مليون|k|thousand|ألف|الف)$/i);
  if (unit) {
    const [, number, word] = unit;
    const scale = /^(?:k|thousand|ألف|الف)$/i.test(word) ? 1e3 : 1e6;
    // A comma before one or two digits could be a decimal comma or a typo: ask.
    if (/,\d{1,2}$/.test(number)) return { amountAed: null, readings: [{ amountAed: Math.round(Number(number.replace(",", ".")) * scale), reading: `"${raw}" read with a decimal comma. Not confirmed.` }] };
    return { amountAed: Math.round(Number(number.replace(/,/g, "")) * scale), readings: [] };
  }
  if (/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(text)) return { amountAed: Math.round(Number(text.replace(/,/g, ""))), readings: [] };
  if (/^\d{1,3}(?:\.\d{3}){2,}$/.test(text)) return { amountAed: Number(text.replace(/\./g, "")), readings: [] };
  if (/^\d{5,}$/.test(text)) return { amountAed: Number(text), readings: [] };
  const short = text.match(/^(\d+)(?:[.,](\d{1,2}))?$/);
  if (short) {
    const value = Number(`${short[1]}.${short[2] || 0}`);
    const scale = value < 100 ? 1e6 : 1e3;
    return { amountAed: null, readings: [{ amountAed: Math.round(value * scale), reading: `"${raw}" read as ${scale === 1e6 ? "millions" : "thousands"} of dirhams. Not confirmed.` }] };
  }
  return { amountAed: null, readings: [] };
}

const SLUG = value => String(value || "").toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "X";
const STAGES = [["booking_pct", "bookingPct"], ["construction_pct", "constructionPct"], ["handover_pct", "handoverPct"], ["post_handover_pct", "postHandoverPct"]];

/** One template row as a ledger record, with every open question written down. */
export function recordFromRow(row, { createdOn, sourceFile = null, sequence = 1 } = {}) {
  const type = String(row.record_type || "offer").trim().toLowerCase();
  const evidenceType = type === "asking" ? EVIDENCE_TYPES.ASKING : EVIDENCE_TYPES.OFFER;
  const sourceKind = textOrNull(row.source_kind) || (type === "asking" ? "broker_listing" : null);
  const unresolved = [];
  const ask = (field, question, blocking = true) => unresolved.push({ field, question, blocking });
  const rawPrice = textOrNull(row.price_raw);
  const typedAmount = numberOrNull(row.price_aed);
  const read = typedAmount == null && rawPrice ? readAmount(rawPrice) : { amountAed: typedAmount, readings: [] };
  const noPrice = type === "availability" || (!rawPrice && typedAmount == null && type !== "asking" && !blank(row.availability_status));
  let kind = noPrice ? "none" : textOrNull(row.price_kind) || "unspecified";
  if (!noPrice) {
    if (read.amountAed == null) ask("price.amountAed", rawPrice ? `What exact amount does "${rawPrice}" mean?` : "What is the price?");
    if (kind === "unspecified") ask("price.kind", "Is this one specific unit's price, a starting price, or a range?");
  }
  const discount = textOrNull(row.discount) || "not_stated";
  if (discount === "after_discount" && blank(row.discount_eligibility)) ask("discountTerms", "Who qualifies for the discount (for example full-payment buyers only)?");
  const stages = Object.fromEntries(STAGES.map(([column, key]) => [key, numberOrNull(row[column])]).filter(([, value]) => value != null));
  if (!blank(row.post_handover_months)) stages.postHandoverMonths = numberOrNull(row.post_handover_months);
  const paymentKind = textOrNull(row.payment_kind) || "unknown";
  if (!noPrice && paymentKind === "unknown") ask("payment", "Which payment terms does this price assume?", false);
  const dates = { issuedOn: textOrNull(row.issued_on), receivedOn: textOrNull(row.received_on), verifiedOn: textOrNull(row.verified_on), listedOn: textOrNull(row.listed_on) };
  const basis = SOURCE_POLICY[sourceKind]?.basis || [];
  if (basis.length && !basis.some(field => dates[field])) ask(basis[0], `On what date was this ${sourceKind === "developer_message" ? "message received" : "price issued"}?`);
  const home = { scope: textOrNull(row.home_scope) || (blank(row.unit_id) ? "home_type" : "exact_unit"), type: textOrNull(row.home_type)?.toLowerCase() || null,
    bedrooms: blank(row.bedrooms) ? null : /^studio$/i.test(String(row.bedrooms).trim()) ? 0 : numberOrNull(row.bedrooms), unitId: textOrNull(row.unit_id),
    sizeSqftFrom: numberOrNull(row.size_sqft_from), sizeSqftTo: numberOrNull(row.size_sqft_to) };
  const fullPaymentMonths = numberOrNull(row.full_payment_within_months);
  const day = dates.receivedOn || dates.issuedOn || dates.listedOn || dates.verifiedOn || createdOn;
  return {
    id: `${evidenceType === EVIDENCE_TYPES.ASKING ? "ASK" : noPrice ? "AVAIL" : "OFFER"}-${SLUG(row.project)}-${home.bedrooms ?? "ALL"}${home.type === "penthouse" ? "PH" : ""}-${String(day).replace(/-/g, "")}-${sequence}`,
    evidenceType, status: unresolved.some(item => item.blocking) ? "needs_clarification" : "draft",
    project: { name: textOrNull(row.project), registryName: textOrNull(row.registry_name), district: textOrNull(row.district), community: textOrNull(row.community),
      developer: textOrNull(row.developer), phase: textOrNull(row.phase), building: textOrNull(row.building) },
    home,
    price: { raw: rawPrice, amountAed: noPrice ? null : read.amountAed, amountToAed: numberOrNull(row.price_to_aed), kind, discount, currency: "AED",
      ...(read.readings.length ? { readings: read.readings } : {}) },
    discountTerms: { description: textOrNull(row.discount_description), eligibility: textOrNull(row.discount_eligibility) },
    payment: { kind: paymentKind, summary: textOrNull(row.payment_summary), ...(Object.keys(stages).length ? { stages } : {}),
      ...(fullPaymentMonths != null ? { fullPaymentWithinMonths: fullPaymentMonths } : {}) },
    availability: { status: textOrNull(row.availability_status) || "unknown", scope: textOrNull(row.availability_scope), statement: textOrNull(row.availability_statement) },
    source: { kind: sourceKind, reference: textOrNull(row.source_reference), quote: textOrNull(row.source_quote),
      ...(sourceFile ? { fileName: sourceFile.name, fileSha256: sourceFile.sha256 } : {}) },
    ...dates, firstSeenOn: createdOn, checkedOn: createdOn, validUntil: textOrNull(row.valid_until),
    supersedes: [], unresolved, notes: textOrNull(row.notes), createdOn, reviewedBy: null, reviewedOn: null
  };
}

export function readTemplate(file) {
  const lines = readFileSync(file, "utf8").replace(/^﻿/, "").split(/\r?\n/).filter(line => line.trim());
  const header = csvCells(lines[0] || "").map(cell => cell.trim());
  const unknown = header.filter(column => !TEMPLATE_COLUMNS.includes(column));
  if (unknown.length) throw new Error(`Unknown template columns: ${unknown.join(", ")}`);
  return lines.slice(1).map(line => { const cells = csvCells(line); return Object.fromEntries(header.map((column, i) => [column, cells[i] ?? ""])); });
}

/** The document a record came from, by name and fingerprint; the file itself stays with the owner. */
export function sourceFileFingerprint(file) {
  return { name: path.basename(file), sha256: createHash("sha256").update(readFileSync(file)).digest("hex") };
}

// One stable layout, so each change is a small, readable diff.
function inline(value) {
  if (Array.isArray(value)) return value.length ? `[${value.map(inline).join(", ")}]` : "[]";
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    return entries.length ? `{ ${entries.map(([key, item]) => `${JSON.stringify(key)}: ${inline(item)}`).join(", ")} }` : "{}";
  }
  return JSON.stringify(value);
}

export function formatLedgerFile(data) {
  const record = row => `    {\n${Object.entries(row).map(([key, value]) => Array.isArray(value) && value.some(item => item && typeof item === "object")
    ? `      ${JSON.stringify(key)}: [\n${value.map(item => `        ${inline(item)}`).join(",\n")}\n      ]`
    : `      ${JSON.stringify(key)}: ${inline(value)}`).join(",\n")}\n    }`;
  const head = Object.entries(data).filter(([key]) => key !== "records").map(([key, value]) => `  ${JSON.stringify(key)}: ${inline(value)}`);
  const records = data.records?.length ? `  "records": [\n${data.records.map(record).join(",\n")}\n  ]` : `  "records": []`;
  return `{\n${[...head, records].join(",\n")}\n}\n`;
}

export const readLedgerFile = file => JSON.parse(readFileSync(file, "utf8"));
export const writeLedgerFile = (file, data) => writeFileSync(file, formatLedgerFile(data));
export const ledgerFileFor = record => record.evidenceType === EVIDENCE_TYPES.ASKING ? ASKING_PATH : OFFERS_PATH;

/** Validation exactly as the bot will apply it, for the records as they would stand. */
export function validate(records, evidenceType = EVIDENCE_TYPES.OFFER) {
  const ledger = createPriceLedger(evidenceType === EVIDENCE_TYPES.ASKING ? { asking: records } : { offers: records });
  return evidenceType === EVIDENCE_TYPES.ASKING ? ledger.asking : ledger.offers;
}

function uniqueId(records, id) {
  const taken = new Set(records.map(row => row.id));
  if (!taken.has(id)) return id;
  let index = 2;
  while (taken.has(`${id}-${index}`)) index++;
  return `${id}-${index}`;
}

/** Append new records (never approved here). Returns them as the bot would see them. */
export function appendRecords(file, records) {
  const data = readLedgerFile(file);
  const added = [];
  for (const record of records) {
    const row = { ...record, id: uniqueId(data.records, record.id) };
    data.records.push(row);
    added.push(row.id);
  }
  writeLedgerFile(file, data);
  const evidenceType = records[0]?.evidenceType || EVIDENCE_TYPES.OFFER;
  return validate(data.records, evidenceType).filter(row => added.includes(row.id));
}

function find(data, id) {
  const record = data.records.find(row => row.id === id);
  if (!record) throw new Error(`No record ${id}`);
  return record;
}

/**
 * Approve a record the owner has checked. Refused while anything blocks it,
 * so an ambiguous amount, a missing date or an open question cannot price a home.
 */
export function approveRecord(file, id, { reviewer, on, supersedes = [] } = {}) {
  if (!reviewer) throw new Error("Say who approved it (--by).");
  if (!validDate(on)) throw new Error("Approval date must be YYYY-MM-DD.");
  const data = readLedgerFile(file);
  const record = find(data, id);
  if (!["draft", "needs_clarification"].includes(record.status)) throw new Error(`${id} is ${record.status}; only draft or needs_clarification records can be approved.`);
  for (const old of supersedes) {
    const replaced = find(data, old);
    if (replaced.project?.name !== record.project?.name) throw new Error(`${old} is for ${replaced.project?.name}, not ${record.project?.name}.`);
  }
  const candidate = { ...record, status: "approved", supersedes: [...new Set([...(record.supersedes || []), ...supersedes])] };
  const blocking = validate(data.records.map(row => row.id === id ? candidate : row), record.evidenceType).find(row => row.id === id).problems.filter(problem => problem.blocking);
  if (blocking.length) {
    const error = new Error(`${id} cannot be approved yet:\n${blocking.map(problem => `- ${problem.code} (${problem.field})${problem.question ? `: ${problem.question}` : ""}`).join("\n")}`);
    error.blocking = blocking;
    throw error;
  }
  Object.assign(record, candidate, { reviewedBy: reviewer, reviewedOn: on });
  writeLedgerFile(file, data);
  return validate(data.records, record.evidenceType).find(row => row.id === id);
}

const setPath = (target, field, value) => {
  const keys = field.split(".");
  let node = target;
  for (const key of keys.slice(0, -1)) node = node[key] = { ...(node[key] || {}) };
  node[keys.at(-1)] = value;
};

/**
 * Answer open questions in a NEW record that supersedes the old one once it is
 * approved. The original wording and record stay on file unchanged.
 * changes: { "price.amountAed": 1500000, "price.kind": "exact_quote", receivedOn: "2026-10-12", ... }
 */
export function clarifyRecord(file, id, changes, { on, note = null } = {}) {
  if (!validDate(on)) throw new Error("Clarification date must be YYYY-MM-DD.");
  const data = readLedgerFile(file);
  const original = find(data, id);
  const next = structuredClone(original);
  for (const [field, value] of Object.entries(changes)) setPath(next, field, value);
  // A question is answered by a change to its field, a part of it, or the whole of it.
  const answers = Object.keys(changes);
  const answered = field => answers.some(key => key === field || key.startsWith(`${field}.`) || String(field).startsWith(`${key}.`));
  next.unresolved = (original.unresolved || []).filter(item => !answered(item.field));
  if (changes["price.amountAed"] != null && next.price?.readings) delete next.price.readings;
  Object.assign(next, { id: uniqueId(data.records, `${id}-R1`), status: next.unresolved.some(item => item.blocking !== false) ? "needs_clarification" : "draft",
    supersedes: [id], createdOn: on, firstSeenOn: original.firstSeenOn, checkedOn: on, reviewedBy: null, reviewedOn: null,
    notes: [original.notes, note ? `${on}: ${note}` : `${on}: clarifies ${id}.`].filter(Boolean).join(" ") });
  data.records.push(next);
  writeLedgerFile(file, data);
  return validate(data.records, next.evidenceType).find(row => row.id === next.id);
}

/** Withdraw a record (sold out, price list replaced, entered in error). It stays on file. */
export function withdrawRecord(file, id, { reason, on } = {}) {
  if (!reason) throw new Error("Give a reason for withdrawing it.");
  if (!validDate(on)) throw new Error("Date must be YYYY-MM-DD.");
  const data = readLedgerFile(file);
  const record = find(data, id);
  record.status = "withdrawn";
  record.notes = [record.notes, `${on}: withdrawn — ${reason}`].filter(Boolean).join(" ");
  writeLedgerFile(file, data);
  return record;
}

/**
 * Note that someone looked at the source again and it had not changed. This
 * moves checkedOn only; the price's own date, and so its age, stay the same.
 */
export function recheckRecord(file, id, { on } = {}) {
  if (!validDate(on)) throw new Error("Date must be YYYY-MM-DD.");
  const data = readLedgerFile(file);
  const record = find(data, id);
  record.checkedOn = on;
  writeLedgerFile(file, data);
  return record;
}

/** What needs the owner, most urgent first. Asking prices are listed apart: they never price a home. */
export function reviewQueue(ledger, { now = Date.now() } = {}) {
  const open = records => records.map(record => ({ record, state: recordState(record, { now }) }))
    .filter(({ record }) => !["rejected", "withdrawn"].includes(record.status) && !record.supersededBy);
  const offers = open(ledger.offers), asking = open(ledger.asking);
  return {
    needsClarification: [...offers, ...asking].filter(({ record }) => record.status === "needs_clarification"),
    awaitingApproval: [...offers, ...asking].filter(({ record }) => record.status === "draft"),
    approvedButNotUsable: offers.filter(({ record, state }) => record.status === "approved" && !state.usable),
    usable: offers.filter(({ state }) => state.usable),
    askingOnFile: asking.filter(({ record }) => record.status === "approved")
  };
}
