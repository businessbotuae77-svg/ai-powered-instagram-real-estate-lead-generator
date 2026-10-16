#!/usr/bin/env node
// Developer offers and resale asking prices: add, review, approve, clarify,
// withdraw and re-check. Records are appended to data/pricing/*.json; nothing is
// deleted, and nothing can price a home until the owner approves it.
//
//   npm run pricing:offers -- template > my-price-list.csv
//   npm run pricing:offers -- add my-price-list.csv [--source-file price-list.pdf]
//   npm run pricing:offers -- review
//   npm run pricing:offers -- show OFFER-V3-MSG1-1BR
//   npm run pricing:offers -- clarify OFFER-V3-MSG1-1BR --amount 1500000 --kind exact_quote --received 2026-10-12 --eligibility "All buyers"
//   npm run pricing:offers -- approve OFFER-V3-MSG1-1BR-R1 --by "Owner name"
//   npm run pricing:offers -- withdraw OFFER-... --reason "price list replaced"
//   npm run pricing:offers -- recheck OFFER-V3-WEB-20261016
import { loadPriceLedger, ASKING_PATH, OFFERS_PATH, createPriceLedger, recordState } from "../src/pricing/ledger.js";
import { currency } from "../src/pricing/policy.js";
import { TEMPLATE_COLUMNS, appendRecords, approveRecord, clarifyRecord, ledgerFileFor, readLedgerFile, readTemplate, recheckRecord,
  recordFromRow, reviewQueue, sourceFileFingerprint, withdrawRecord } from "../src/pricing/intake.js";
import { parseAmount, parseArgs } from "./pricing-trace.js";

const today = () => new Date().toISOString().slice(0, 10);
const fresh = () => createPriceLedger({ offers: readLedgerFile(OFFERS_PATH).records, asking: readLedgerFile(ASKING_PATH).records });

function fileOf(id) {
  for (const file of [OFFERS_PATH, ASKING_PATH]) if (readLedgerFile(file).records.some(row => row.id === id)) return file;
  throw new Error(`No record ${id}`);
}

function describe(record, now = Date.now()) {
  const state = recordState(record, { now }), age = currency(record, { now });
  const home = record.home?.scope === "project" ? "whole project" : `${record.home?.bedrooms === 0 ? "studio" : `${record.home?.bedrooms ?? "?"}-bed`} ${record.home?.type || "home"}`;
  const role = record.evidenceType === "resale_asking" ? `asking price, comparison only (${state.currency.state})` : state.usable ? "can price homes" : "cannot price homes";
  const lines = [`${record.id} · ${record.status}${record.supersededBy ? ` · superseded by ${record.supersededBy}` : ""} · ${role}`,
    `  ${record.project?.name} (${record.project?.district}) · ${home} · ${record.price?.kind === "none" ? "no price" : `"${record.price?.raw ?? ""}" → ${record.price?.amountAed ?? "unresolved"} (${record.price?.kind}, ${record.price?.discount})`}`,
    `  payment ${record.payment?.kind}${record.payment?.summary ? ` (${record.payment.summary})` : ""} · source ${record.source?.kind}: ${record.source?.reference}`,
    `  dated ${age.basisDate ? `${age.basis} ${age.basisDate} (${age.ageDays} days, ${age.state})` : age.state}`];
  for (const problem of state.blocking) lines.push(`  ! ${problem.code} (${problem.field})${problem.question ? `: ${problem.question}` : ""}`);
  for (const item of (record.unresolved || []).filter(row => row.blocking === false)) lines.push(`  ? ${item.field}: ${item.question}`);
  return lines.join("\n");
}

const CLARIFY_FLAGS = { amount: ["price.amountAed", parseAmount], "amount-to": ["price.amountToAed", parseAmount], kind: ["price.kind"], discount: ["price.discount"],
  eligibility: ["discountTerms.eligibility"], "discount-description": ["discountTerms.description"], payment: ["payment.kind"], plan: ["payment.summary"],
  "full-payment-months": ["payment.fullPaymentWithinMonths", Number], received: ["receivedOn"], issued: ["issuedOn"], verified: ["verifiedOn"],
  "valid-until": ["validUntil"], unit: ["home.unitId"], "size-from": ["home.sizeSqftFrom", Number], "size-to": ["home.sizeSqftTo", Number],
  availability: ["availability.status"], "availability-scope": ["availability.scope"] };

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { project: argument, options } = parseArgs(rest);
  const on = options.on || today();
  switch (command) {
    case "template":
      console.log(TEMPLATE_COLUMNS.join(","));
      return;
    case "add": {
      if (!argument) throw new Error("Give the filled template: add my-price-list.csv");
      const sourceFile = options["source-file"] ? sourceFileFingerprint(options["source-file"]) : null;
      const records = readTemplate(argument).map((row, index) => recordFromRow(row, { createdOn: on, sourceFile, sequence: index + 1 }));
      for (const kind of ["developer_offer", "resale_asking"]) {
        const group = records.filter(record => record.evidenceType === kind);
        if (!group.length) continue;
        const added = appendRecords(ledgerFileFor(group[0]), group);
        console.log(`Added ${added.length} ${kind === "resale_asking" ? "asking price" : "offer"} record(s) for review:\n`);
        for (const record of added) console.log(`${describe(record)}\n`);
      }
      return;
    }
    case "review": {
      const queue = reviewQueue(loadPriceLedger(), { now: Date.now() });
      for (const [title, rows] of [["Needs clarification", queue.needsClarification], ["Ready for your approval", queue.awaitingApproval],
        ["Approved but no longer able to price homes", queue.approvedButNotUsable], ["Pricing homes now", queue.usable],
        ["Resale asking prices on file (never used to price a home)", queue.askingOnFile]]) {
        console.log(`\n${title} (${rows.length})`);
        for (const { record } of rows) console.log(describe(record));
      }
      return;
    }
    case "show": {
      const ledger = fresh();
      const record = [...ledger.offers, ...ledger.asking].find(row => row.id === argument);
      if (!record) throw new Error(`No record ${argument}`);
      console.log(describe(record));
      return;
    }
    case "approve": {
      const supersedes = options.supersedes ? String(options.supersedes).split(",").map(id => id.trim()).filter(Boolean) : [];
      const record = approveRecord(fileOf(argument), argument, { reviewer: options.by, on, supersedes });
      console.log(`Approved.\n${describe(record)}`);
      return;
    }
    case "clarify": {
      const changes = {};
      for (const [flag, [field, parse]] of Object.entries(CLARIFY_FLAGS)) if (options[flag] !== undefined) changes[field] = parse ? parse(options[flag]) : options[flag];
      if (!Object.keys(changes).length) throw new Error(`Nothing to clarify. Flags: ${Object.keys(CLARIFY_FLAGS).map(flag => `--${flag}`).join(" ")}`);
      const record = clarifyRecord(fileOf(argument), argument, changes, { on, note: options.note || null });
      console.log(`Added ${record.id}, which replaces ${argument} once approved.\n${describe(record)}`);
      return;
    }
    case "withdraw": {
      const record = withdrawRecord(fileOf(argument), argument, { reason: options.reason, on });
      console.log(`Withdrawn: ${record.id}`);
      return;
    }
    case "recheck": {
      const record = recheckRecord(fileOf(argument), argument, { on });
      console.log(`Noted that ${record.id} was looked at on ${on}. Its price date is unchanged; if the price changed, add a new record instead.`);
      return;
    }
    default:
      console.error("Commands: template | add <file.csv> [--source-file <pdf/png>] | review | show <id> | clarify <id> --amount … | approve <id> --by <name> [--supersedes A,B] | withdraw <id> --reason … | recheck <id>");
      process.exit(command ? 1 : 0);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { main(); } catch (error) { console.error(error.message); process.exit(1); }
}
