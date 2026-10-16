import assert from "node:assert/strict";
import test from "node:test";
import { createPriceLedger, loadPriceLedger, pricingKey, recordState } from "../src/pricing/ledger.js";
import { currency } from "../src/pricing/policy.js";
import { DECISIONS, assessHome, budgetPosition, offerReasons, projectPriceEvidence } from "../src/pricing/assess.js";
import { dayLabel, offerLine, offerPack } from "../src/pricing/offer-pack.js";
import { shownLines, shownOffer } from "../src/pricing/shown.js";
import { validateMessage } from "../src/facts/checker.js";
import { matchCriteria } from "../src/matching/matcher.js";
import { projectListing } from "../src/facts/project-listings.js";
import { candidateConstraintFailures } from "../src/conversation/fit-assess.js";

// Recorded sales, developer offers and resale asking prices stay separate.
// Only an approved, current offer for the same home and payment terms can
// price a home; anything else can only make an answer more careful.

const NOW = Date.parse("2026-10-16T09:00:00Z");
const daysBefore = days => new Date(NOW - days * 86400000).toISOString().slice(0, 10);
const VISTA_3 = [pricingKey("Vista 3", "Al Reem Island")];
const RECORDED_2BR = { reliability: "OK", medianPriceAed: 948132, sales: 11 };
const RECORDED_1BR = { reliability: "OK", medianPriceAed: 715735, sales: 7 };
const TWO_BED = { type: "apartment", bedrooms: 2 };

const merge = (base, extra) => Object.fromEntries([...new Set([...Object.keys(base), ...Object.keys(extra)])].map(key => {
  const value = extra[key];
  const nested = value && typeof value === "object" && !Array.isArray(value) && base[key] && typeof base[key] === "object";
  return [key, nested ? { ...base[key], ...value } : key in extra ? value : base[key]];
}));

/** An approved developer price-list quote for a Vista 3 2-bed, issued three days ago, unless overridden. */
function offer(extra = {}) {
  return merge({
    id: "OFFER-TEST", evidenceType: "developer_offer", status: "approved",
    project: { name: "Vista 3", district: "Al Reem Island", developer: "Reportage" },
    home: { scope: "home_type", type: "apartment", bedrooms: 2 },
    price: { raw: "AED 1,350,000", amountAed: 1350000, kind: "exact_quote", discount: "not_stated", currency: "AED" },
    discountTerms: { description: null, eligibility: null },
    payment: { kind: "developer_plan", summary: "60/40 payment plan" },
    availability: { status: "unknown" },
    source: { kind: "developer_price_list", reference: "Reportage price list (test)" },
    issuedOn: daysBefore(3), supersedes: [], unresolved: []
  }, extra);
}

const normalized = record => createPriceLedger({ offers: [record] }).offers[0];
const evidenceOf = (...records) => projectPriceEvidence({ keys: VISTA_3, ledger: createPriceLedger({ offers: records }) });
const assess = (buyer, home, records, recorded = null) => assessHome({ buyer, home, evidence: evidenceOf(...records), recorded, now: NOW });

test("checking an unchanged page again never makes its old price current", () => {
  const page = offer({ source: { kind: "official_developer_page", reference: "https://reportagegroup.com/projects/residential-apartments/vista-3/" },
    home: { scope: "project", bedrooms: null }, price: { raw: "From AED 835k", amountAed: 835000, kind: "starting_price" },
    issuedOn: "2026-04-20", firstSeenOn: "2026-10-16", checkedOn: "2026-10-16" });
  assert.deepEqual(currency(page, { now: NOW }), { state: "stale", basis: "issuedOn", basisDate: "2026-04-20", ageDays: 179, maxAgeDays: 30 });
  const later = Date.parse("2026-11-01T09:00:00Z");
  assert.equal(currency({ ...page, checkedOn: "2026-11-01" }, { now: later }).basisDate, "2026-04-20");
  assert.equal(currency({ ...page, checkedOn: "2026-11-01" }, { now: later }).state, "stale");
  // Without a page date, the price counts from when it was first seen, never from a later look.
  const undated = { ...page, issuedOn: null };
  assert.equal(currency(undated, { now: Date.parse("2026-11-10T09:00:00Z") }).state, "current");
  assert.equal(currency({ ...undated, checkedOn: "2026-12-01" }, { now: Date.parse("2026-12-01T09:00:00Z") }).state, "stale");
  assert.equal(currency({ ...undated, firstSeenOn: null }, { now: NOW }).state, "undated");
  // An undated message, an expired offer and a future date never count as current.
  assert.equal(currency(offer({ source: { kind: "developer_message", reference: "message" }, issuedOn: null }), { now: NOW }).state, "undated");
  assert.equal(currency(offer({ validUntil: daysBefore(1) }), { now: NOW }).state, "expired");
  assert.equal(currency(offer({ issuedOn: "2026-10-20" }), { now: NOW }).state, "future_dated");
});

test("the repository ledger keeps the Vista 3 developer message unresolved, separate and unusable", () => {
  const ledger = loadPriceLedger();
  const byId = Object.fromEntries(ledger.offers.map(record => [record.id, record]));
  const oneBed = byId["OFFER-V3-MSG1-1BR"];
  assert.equal(oneBed.price.raw, "1,5", "the developer's wording is preserved");
  assert.equal(oneBed.price.amountAed, null, "an ambiguous amount stays missing");
  for (const code of ["ambiguous_amount", "price_kind_unspecified"]) assert.ok(oneBed.problems.some(problem => problem.code === code), code);
  for (const field of ["price.amountAed", "discountTerms", "payment", "receivedOn"]) {
    assert.ok(oneBed.problems.some(problem => problem.code === "unresolved" && problem.field === field && problem.question), field);
  }
  assert.equal(recordState(oneBed, { now: NOW }).usable, false);
  const penthouse = byId["OFFER-V3-MSG1-3BR-PH"];
  assert.deepEqual([penthouse.home.type, penthouse.home.bedrooms, penthouse.price.amountAed, penthouse.payment.kind, penthouse.payment.fullPaymentWithinMonths],
    ["penthouse", 3, 2440000, "full_payment", 6]);
  assert.equal(recordState(penthouse, { now: NOW }).usable, false);
  const noStock = byId["AVAIL-V3-MSG1-2BR"];
  assert.deepEqual([noStock.price.kind, noStock.availability.status, noStock.availability.scope], ["none", "not_available", "contact_inventory"]);
  const page = byId["OFFER-V3-WEB-20261016"];
  assert.deepEqual(page.problems, []);
  assert.equal(page.home.scope, "project");
  assert.equal(recordState(page, { now: NOW }).currency.state, "stale");
  // Every record names its source, ids are unique, and nothing can price Vista 3 today.
  for (const record of [...ledger.offers, ...ledger.asking]) assert.ok(record.source?.reference, record.id);
  assert.equal(new Set(ledger.offers.map(record => record.id)).size, ledger.offers.length);
  assert.deepEqual(ledger.offers.filter(record => recordState(record, { now: NOW }).usable), []);
  assert.ok(ledger.asking.length > 0 && ledger.asking.every(record => record.evidenceType === "resale_asking" && record.source.kind === "broker_listing"));
});

test("a newer approved record supersedes an older one, and the older one stays on file", () => {
  const old = offer({ id: "OLD", issuedOn: daysBefore(10) });
  const update = offer({ id: "NEW", status: "needs_clarification", supersedes: ["OLD"], price: { raw: "AED 1,400,000", amountAed: 1400000 } });
  let ledger = createPriceLedger({ offers: [old, update] });
  assert.equal(ledger.offers[0].supersededBy, null, "a record under review supersedes nothing");
  assert.equal(recordState(ledger.offers[0], { now: NOW }).usable, true);
  ledger = createPriceLedger({ offers: [old, { ...update, status: "approved" }] });
  const [before, after] = ledger.offers;
  assert.equal(before.supersededBy, "NEW");
  assert.equal(recordState(before, { now: NOW }).review, "superseded");
  assert.equal(recordState(before, { now: NOW }).usable, false);
  assert.equal(recordState(after, { now: NOW }).usable, true);
  assert.equal(ledger.offers.length, 2, "history is kept");
});

test("recorded sales below the budget never outrank a current quote above it", () => {
  const buyer = { budgetAed: 1200000 };
  const quoted = assess(buyer, TWO_BED, [offer()], RECORDED_2BR);
  assert.equal(quoted.decision, DECISIONS.QUOTED_OUTSIDE);
  assert.equal(quoted.quoted.price.amountAed, 1350000);
  const history = assess(buyer, TWO_BED, [], RECORDED_2BR);
  assert.equal(history.decision, DECISIONS.HISTORY_WITHIN, "past sales alone only shortlist");
  assert.equal(history.needsCheck, true);
  assert.equal(assess({ budgetAed: 1500000 }, TWO_BED, [offer()], RECORDED_2BR).decision, DECISIONS.QUOTED_WITHIN);
  assert.equal(assess({ budgetAed: 800000 }, TWO_BED, [], RECORDED_2BR).decision, DECISIONS.HISTORY_OUTSIDE);
});

test("a full-payment or cash-discount price never shows what a payment-plan buyer can afford", () => {
  const cash = offer({ id: "CASH", price: { raw: "AED 1,050,000 after discount", amountAed: 1050000, discount: "after_discount" },
    discountTerms: { description: "10% discount", eligibility: "Full payment buyers only" }, payment: { kind: "unknown", summary: null } });
  const plan = assess({ budgetAed: 1200000, financing: "payment_plan" }, TWO_BED, [cash]);
  assert.equal(plan.decision, DECISIONS.UNKNOWN);
  assert.deepEqual(plan.paymentMismatch.map(record => record.id), ["CASH"]);
  assert.deepEqual(offerReasons(normalized(cash), TWO_BED, { financing: "payment_plan" }, NOW), ["discount_needs_full_payment"]);
  assert.equal(assess({ budgetAed: 1200000, financing: "cash" }, TWO_BED, [cash]).decision, DECISIONS.QUOTED_WITHIN);
  // Until the buyer says how they pay, the price is shown with its terms but never called a fit.
  assert.equal(assess({ budgetAed: 1200000 }, TWO_BED, [cash]).decision, DECISIONS.QUOTED_TERMS_UNCONFIRMED);
  const penthouse = offer({ id: "PH", home: { type: "penthouse", bedrooms: 3 }, price: { raw: "AED 2.44M", amountAed: 2440000 },
    payment: { kind: "full_payment", summary: "full payment within six months", fullPaymentWithinMonths: 6 } });
  assert.deepEqual(offerReasons(normalized(penthouse), { type: "penthouse", bedrooms: 3 }, { financing: "payment_plan" }, NOW), ["needs_full_payment"]);
  assert.equal(assess({ budgetAed: 2500000, financing: "payment_plan" }, { type: "penthouse", bedrooms: 3 }, [penthouse]).decision, DECISIONS.UNKNOWN);
  assert.equal(assess({ budgetAed: 1500000, financing: "payment_plan" }, TWO_BED, [offer()]).decision, DECISIONS.QUOTED_WITHIN);
  assert.equal(assess({ budgetAed: 1500000, financing: "payment_plan" }, TWO_BED, [offer({ payment: { kind: "unknown", summary: null } })]).decision,
    DECISIONS.QUOTED_TERMS_UNCONFIRMED);
});

test("missing, stale, ambiguous and conflicting prices keep the answer careful", () => {
  const buyer = { budgetAed: 1200000 };
  assert.equal(assess(buyer, TWO_BED, []).decision, DECISIONS.UNKNOWN);
  // A stale quote never prices the home: below the budget it adds nothing, above it blocks the shortlist.
  assert.equal(assess(buyer, TWO_BED, [offer({ price: { raw: "AED 1,000,000", amountAed: 1000000 }, issuedOn: daysBefore(60) })], RECORDED_2BR).decision,
    DECISIONS.HISTORY_WITHIN);
  const careful = assess(buyer, TWO_BED, [offer({ issuedOn: daysBefore(60) })], RECORDED_2BR);
  assert.equal(careful.decision, DECISIONS.CONFLICT);
  assert.deepEqual(careful.cautions.map(record => record.id), ["OFFER-TEST"]);
  // Two current quotes for the same home and terms disagree: both are kept, neither is averaged.
  const conflict = assess(buyer, TWO_BED, [offer({ id: "A", price: { amountAed: 1100000 } }), offer({ id: "B", price: { amountAed: 1300000 } })], RECORDED_2BR);
  assert.equal(conflict.decision, DECISIONS.CONFLICT);
  assert.deepEqual(conflict.conflict.map(record => record.id).sort(), ["A", "B"]);
  assert.equal(conflict.quoted, null);
  // The written "1,5": its only reading sits above a 1.2M budget, so past 1-bed sales cannot shortlist it.
  const written = loadPriceLedger().offers.find(record => record.id === "OFFER-V3-MSG1-1BR");
  const oneBed = { type: "apartment", bedrooms: 1 };
  assert.equal(assessHome({ buyer, home: oneBed, evidence: { offers: [written], availability: [] }, recorded: RECORDED_1BR, now: NOW }).decision, DECISIONS.CONFLICT);
  assert.equal(assessHome({ buyer: { budgetAed: 2000000 }, home: oneBed, evidence: { offers: [written], availability: [] }, recorded: RECORDED_1BR, now: NOW }).decision,
    DECISIONS.HISTORY_WITHIN);
});

test("a quote for another bedroom count, home type or project never prices this home", () => {
  const buyer = { budgetAed: 1200000 };
  const twoBed = assess(buyer, TWO_BED, [offer({ id: "1BR", home: { bedrooms: 1 }, price: { amountAed: 1500000 } })], RECORDED_2BR);
  assert.equal(twoBed.decision, DECISIONS.HISTORY_WITHIN, "a 1-bed price says nothing about 2-bed homes");
  assert.ok(twoBed.rejected[0].reasons.includes("other_bedrooms"));
  const flat = assess({ budgetAed: 1500000 }, { type: "apartment", bedrooms: 3 },
    [offer({ id: "PH", home: { type: "penthouse", bedrooms: 3 }, price: { amountAed: 2440000 } })], { reliability: "OK", medianPriceAed: 1077300 });
  assert.equal(flat.decision, DECISIONS.HISTORY_WITHIN, "a penthouse price says nothing about apartments");
  assert.ok(flat.rejected[0].reasons.includes("other_home_type"));
  assert.equal(evidenceOf(offer({ id: "V2", project: { name: "Vista 2", district: "Al Maryah Island" } })).offers.length, 0, "another phase is another project");
  // A project-wide starting price can rule a budget out, but never prices one bedroom count.
  const floor = offer({ id: "FROM", home: { scope: "project", bedrooms: null }, price: { raw: "From AED 835k", amountAed: 835000, kind: "starting_price" },
    source: { kind: "official_developer_page", reference: "developer page" } });
  assert.equal(assess({ budgetAed: 800000 }, TWO_BED, [floor], { reliability: "OK", medianPriceAed: 760000 }).decision, DECISIONS.STARTING_ABOVE);
  const covered = assess({ budgetAed: 1000000 }, TWO_BED, [floor], RECORDED_2BR);
  assert.equal(covered.decision, DECISIONS.HISTORY_WITHIN);
  assert.equal(covered.quoted, null);
  assert.ok(covered.rejected[0].reasons.includes("project_wide_price"));
  // The same page price, months old, still makes the answer careful when it sits above the budget.
  assert.equal(assess({ budgetAed: 800000 }, TWO_BED, [{ ...floor, id: "FROM-OLD", issuedOn: "2026-04-20" }], { reliability: "OK", medianPriceAed: 760000 }).decision,
    DECISIONS.CONFLICT);
});

test("a contact's no-stock note stays scoped to that contact and never removes a project", () => {
  const note = offer({ id: "AVAIL", price: { raw: null, amountAed: null, kind: "none" }, payment: { kind: "unknown", summary: null },
    availability: { status: "not_available", scope: "contact_inventory", statement: "no two-bedroom stock through that contact" },
    source: { kind: "developer_message", reference: "developer message" }, issuedOn: null, receivedOn: daysBefore(2) });
  const evidence = evidenceOf(note);
  assert.equal(evidence.offers.length, 0, "a note without a price is not an offer");
  const result = assessHome({ buyer: { budgetAed: 1200000 }, home: TWO_BED, evidence, recorded: RECORDED_2BR, now: NOW });
  assert.equal(result.decision, DECISIONS.HISTORY_WITHIN);
  assert.deepEqual(result.notes.map(row => [row.status, row.scope, row.buyerFacing]), [["not_available", "contact_inventory", true]]);
  const unscoped = createPriceLedger({ offers: [{ ...note, availability: { status: "not_available" } }] }).offers[0];
  assert.ok(unscoped.problems.some(problem => problem.code === "availability_scope_missing"));
});

test("budget positions depend on the kind of price", () => {
  const range = { budgetRange: { min: 1000000, max: 1500000 } };
  assert.equal(budgetPosition({ kind: "starting_price", amountAed: 900000 }, range), "within", "homes above a lower starting price may still fit");
  assert.equal(budgetPosition({ kind: "exact_quote", amountAed: 900000 }, range), "below");
  assert.equal(budgetPosition({ kind: "exact_quote", amountAed: 1600000 }, { budgetAed: 1500000 }), "above");
  assert.equal(budgetPosition({ kind: "exact_quote", amountAed: 1600000 }, {}), "no_budget");
});

test("an offer's figures and date pass the fact check only with its own pack", () => {
  const record = createPriceLedger({ offers: [offer({ home: { bedrooms: 1 }, price: { raw: "AED 1,150,000", amountAed: 1150000 } })] }).offers[0];
  const pack = offerPack(record, { now: NOW });
  const line = `💰 Current price: ${offerLine(record, { now: NOW })}`;
  assert.equal(line, `💰 Current price: 1-bed apartment · AED 1,150,000 · 60/40 payment plan · developer price list, ${dayLabel(daysBefore(3))}`);
  assert.equal(validateMessage(line, [pack]).ok, true);
  assert.equal(validateMessage(line.replace("1,150,000", "1,050,000"), [pack]).ok, false);
  assert.equal(validateMessage(line.replace("60/40", "70/30"), [pack]).ok, false);
  assert.equal(validateMessage(line.replace(/Oct 2026/, "Sep 2026"), [pack]).ok, false);
  assert.equal(validateMessage(`${line}\nHandover Q4 2027.`, [pack]).ok, false, "the pack borrows no handover");
  assert.equal(validateMessage(`💰 السعر الحالي: ${offerLine(record, { now: NOW, ar: true })}`, [pack]).ok, true);
  const full = createPriceLedger({ offers: [offer({ price: { discount: "after_discount" }, discountTerms: { eligibility: "cash buyers only" }, payment: { kind: "full_payment", fullPaymentWithinMonths: 6, summary: null } })] }).offers[0];
  assert.match(offerLine(full, { now: NOW }), /^2-bed apartment · AED 1,350,000 · after full-payment discount · full payment within 6 months · developer price list/);
});

test("the owner sees each figure with its kind, basis, source and trace command", () => {
  const record = createPriceLedger({ offers: [offer({ home: { bedrooms: 1 }, price: { raw: "AED 1,150,000", amountAed: 1150000 } })] }).offers[0];
  const entry = shownOffer(record, { home: "1-bed apartment", now: NOW });
  assert.equal(shownLines([entry])[0], `- Vista 3 · 1-bed apartment: AED 1,150,000, current offer (developer price list, issuedOn ${daysBefore(3)}; 60/40 payment plan; Reportage price list (test))`);
  assert.equal(entry.trace, 'npm run pricing:trace -- "Vista 3" --bedrooms 1');
  assert.equal(shownLines([entry, entry, { ...entry, key: "other" }, { ...entry, key: "third" }, { ...entry, key: "fourth" }]).length, 3, "at most three figures, no repeats");
});

test("a catalogue project's starting price never answers a bedroom-specific budget", () => {
  const project = { id: "perla-heights", name: "Perla Heights", active: true, developerActive: true, emirate: "Abu Dhabi", area: "Yas Island",
    startingPriceAed: 700000, bedroomRange: "Studio–4BR apartments", propertyTypes: ["apartment"] };
  const listing = projectListing(project);
  assert.equal(matchCriteria(project, listing, { budgetAed: 900000, bedrooms: 2 }).reason, "bedroom_price_unconfirmed");
  assert.equal(matchCriteria(project, listing, { budgetAed: 900000 }).ok, true, "it still fits a budget with no size asked");
  assert.equal(matchCriteria(project, listing, { budgetAed: 600000, bedrooms: 2 }).reason, "budget", "and can still rule a budget out");
  assert.ok(candidateConstraintFailures({ project, unit: listing }, { budgetAed: 900000, bedrooms: [2] }).includes("bedroom_price_unconfirmed"));
  const oneSize = projectListing({ ...project, bedroomRange: "2BR apartments" });
  assert.equal(matchCriteria(project, oneSize, { budgetAed: 900000, bedrooms: 2 }).ok, true, "a price published for one size does price it");
});
