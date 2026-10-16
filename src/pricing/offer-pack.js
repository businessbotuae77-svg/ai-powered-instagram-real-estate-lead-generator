// A current developer offer as a fact pack, so the existing fact checker holds
// every figure in a reply to the offer it came from. The pack carries only what
// the offer states: no project plan, handover or availability is borrowed.
import { buildFactPack } from "../facts/retrieval.js";
import { CASH_TERMS, currency, sourceLabel } from "./policy.js";

const fmt = amount => Number(amount).toLocaleString("en-US");
const MONTHS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_AR = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
export const dayLabel = (iso, ar = false) => {
  const [year, month, day] = String(iso).split("-").map(Number);
  return `${day} ${(ar ? MONTHS_AR : MONTHS_EN)[month - 1]} ${year}`;
};

export function offerPack(offer, { now = Date.now() } = {}) {
  const state = currency(offer, { now });
  const home = offer.home || {};
  const project = {
    id: `offer-project:${offer.projectKey}`, name: offer.project.name, developerName: offer.project.developer || null, developerActive: true,
    emirate: "Abu Dhabi", area: offer.project.district, active: true, approved: true, source: offer.source.reference,
    lastVerified: state.basisDate, status: null, handover: null,
    paymentPlanAvailable: offer.payment?.kind === "developer_plan" ? true : null,
    paymentPlanSummary: offer.payment?.kind === "developer_plan" ? offer.payment.summary || null : null
  };
  const unit = {
    id: `offer:${offer.id}`, projectId: project.id, propertyType: home.type, bedrooms: home.bedrooms,
    startingPriceAed: offer.price.amountAed, sizeSqftFrom: home.sizeSqftFrom ?? null, sizeSqftTo: home.sizeSqftTo ?? null,
    initialPaymentAed: null, availability: null, active: true
  };
  const offerDate = { value: state.basisDate, confirmed: Boolean(state.basisDate), source: offer.source.reference, recordId: `offer:${offer.id}`, verifiedAt: state.basisDate };
  return { ...buildFactPack({ project, unit, downPaymentAed: null, bedroomLabel: String(home.bedrooms) }, { now }), offerId: offer.id, ledgerOffer: true, offerDate };
}

const HOME_EN = { apartment: "apartment", penthouse: "penthouse", villa: "villa", townhouse: "townhouse", duplex: "duplex" };
const HOME_AR = { apartment: "شقة", penthouse: "بنتهاوس", villa: "فيلا", townhouse: "تاون هاوس", duplex: "دوبلكس" };

export function offerHome(home = {}, ar = false) {
  const beds = home.bedrooms;
  if (ar) {
    const type = HOME_AR[home.type] || "وحدة";
    if (beds === 0) return "استوديو";
    return beds == null ? type : `${type} ${beds === 1 ? "غرفة نوم" : beds === 2 ? "غرفتين" : `${beds} غرف`}`;
  }
  const type = HOME_EN[home.type] || "home";
  if (beds === 0) return "Studio";
  return beds == null ? type.charAt(0).toUpperCase() + type.slice(1) : `${beds}-bed ${type}`;
}

/** "1-bed apartment · AED 1,150,000 · 60/40 plan · developer price list, 12 Oct 2026" */
export function offerLine(offer, { ar = false, now = Date.now(), withHome = true } = {}) {
  const price = offer.price;
  const amount = ar ? `${fmt(price.amountAed)} درهم` : `AED ${fmt(price.amountAed)}`;
  const priceText = price.kind === "starting_price" ? (ar ? `يبدأ من ${amount}` : `from ${amount}`)
    : price.kind === "range" ? (ar ? `${fmt(price.amountAed)} – ${fmt(price.amountToAed)} درهم` : `AED ${fmt(price.amountAed)}–${fmt(price.amountToAed)}`) : amount;
  const cashOnly = CASH_TERMS.test(`${offer.discountTerms?.eligibility || ""} ${offer.discountTerms?.description || ""}`);
  const discount = price.discount === "before_discount" ? (ar ? "قبل الخصم" : "before discount")
    : price.discount === "after_discount" ? (cashOnly ? (ar ? "بعد خصم الدفع الكامل" : "after full-payment discount") : (ar ? "بعد الخصم، بشروط" : "after discount, conditions apply")) : null;
  const terms = offer.payment?.kind === "full_payment"
    ? (offer.payment.fullPaymentWithinMonths ? (ar ? `بالسداد الكامل خلال ${offer.payment.fullPaymentWithinMonths} أشهر` : `full payment within ${offer.payment.fullPaymentWithinMonths} months`) : (ar ? "بالسداد الكامل" : "full payment"))
    : offer.payment?.kind === "developer_plan" && offer.payment.summary ? offer.payment.summary : null;
  const state = currency(offer, { now });
  const source = state.basisDate ? `${sourceLabel(offer.source.kind, ar)}${ar ? "، " : ", "}${dayLabel(state.basisDate, ar)}` : sourceLabel(offer.source.kind, ar);
  const first = withHome ? `${offerHome(offer.home, ar)} · ${priceText}` : priceText;
  return [first, discount, terms, source].filter(Boolean).join(" · ");
}
