// What the buyer was shown, and where each figure came from, so the owner can
// trace a quoted number back to its rows or record in one step.
import { currency, sourceLabel } from "./policy.js";

const fmt = amount => Number(amount).toLocaleString("en-US");
const quote = value => `"${String(value).replace(/"/g, "'")}"`;

function traceCommand(project, bedrooms, type) {
  return `npm run pricing:trace -- ${quote(project)}${bedrooms != null ? ` --bedrooms ${bedrooms}` : ""}${type && type !== "apartment" ? ` --type ${type}` : ""}`;
}

const beds = label => label === "Studio" ? 0 : /^\d/.test(String(label)) ? Number(String(label)[0]) : null;

export function shownRecorded(row, { data, home, decision = null } = {}) {
  const source = data?.source || {};
  return {
    project: row.project, district: row.area, home, evidenceType: "recorded_transaction", amountAed: row.medianPriceAed,
    figure: `recorded median AED ${fmt(row.medianPriceAed)}`,
    basis: `${row.sales} ${row.saleSequence} ${String(row.saleType).toLowerCase()} sales, ${row.firstSale} to ${row.lastSale}`,
    source: `ADREC ${String(source.sha256 || "").slice(0, 12)}`, key: row.key,
    decision, trace: traceCommand(row.project, beds(row.bedrooms), String(row.type).toLowerCase())
  };
}

export function shownOffer(offer, { home, decision = null, now = Date.now() } = {}) {
  const state = currency(offer, { now });
  const terms = offer.payment?.kind === "full_payment" ? `; ${offer.payment.summary || "full payment"}` : offer.payment?.summary ? `; ${offer.payment.summary}` : "";
  return {
    project: offer.project.name, district: offer.project.district, home, evidenceType: "developer_offer", amountAed: offer.price.amountAed,
    figure: `${offer.price.kind === "starting_price" ? "from " : ""}AED ${fmt(offer.price.amountAed)}`,
    basis: `${sourceLabel(offer.source.kind)}${state.basisDate ? `, ${state.basis} ${state.basisDate}` : ", undated"}${terms}`,
    source: offer.source.reference || offer.source.kind, key: offer.id, decision,
    sourceKind: offer.source.kind, basisDate: state.basisDate,
    trace: traceCommand(offer.project.name, offer.home?.bedrooms, offer.home?.type)
  };
}

/** A listing price from the catalogue (Airtable Units), which the broker keeps current. */
export function shownListing(row, { decision = null } = {}) {
  const verified = String(row.project?.lastVerified || "").slice(0, 10) || null;
  return {
    project: row.name, district: row.district, home: row.bedrooms === 0 ? "studio" : `${row.bedrooms}-bed ${row.type}`,
    evidenceType: "catalogue_listing", amountAed: row.price, figure: `from AED ${fmt(row.price)}`,
    basis: `our current listing${verified ? `, verified ${verified}` : ", verification date missing"}`,
    source: `Airtable unit ${row.unit?.id || "unknown"}`, key: `listing:${row.unit?.id || row.name}`, decision,
    trace: traceCommand(row.name, row.bedrooms, row.type)
  };
}

const KIND_NOTE = { recorded_transaction: "past sales, not a current price", catalogue_listing: "current listing price", developer_offer: "current offer" };

/** Lines for the owner alert: newest first, one per figure, at most three. */
export function shownLines(entries = []) {
  const seen = new Set();
  return [...entries].reverse().filter(entry => !seen.has(entry.key) && seen.add(entry.key)).slice(0, 3).map(entry =>
    `- ${entry.project}${entry.home ? ` · ${entry.home}` : ""}: ${entry.figure}, ${KIND_NOTE[entry.evidenceType] || entry.evidenceType} (${entry.basis}; ${entry.source})`);
}
