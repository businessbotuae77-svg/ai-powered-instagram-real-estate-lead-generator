import { factPolicy } from "./freshness.js";
import { selectValue } from "./intelligence.js";

function link(value) { return Array.isArray(value) ? value[0]?.id || value[0] || null : null; }
function amount(value) { return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null; }

export function normalizeCommercialOffer(record, { projects = [], researchOnly = false } = {}) {
  const f = record.fields || {};
  const sheetProjectId = f["Sheet Project ID"] || null;
  const projectId = link(f.Project) || projects.find(p => p.sheetProjectId && p.sheetProjectId === sheetProjectId)?.id || null;
  const beds = f.Bedrooms;
  const bedrooms = beds !== null && beds !== undefined && beds !== "" && /^\d+$/.test(String(beds)) ? Number(beds) : null;
  return {
    id: record.id, offerId: f["Offer ID"] || record.id, projectId, sheetProjectId,
    unitId: link(f.Unit) || null, unitType: selectValue(f["Unit type"] || f["Home type"]) || null,
    bedrooms, phase: f.Phase || f["Phase or unit"] || null,
    price: amount(f["Price AED"] ?? f["Price (AED)"]), priceBasis: selectValue(f["Price basis"]),
    availability: selectValue(f.Availability) || null,
    checkedOn: f["Checked on"] || f["Last verified"] || null, validUntil: f["Valid until"] || null,
    commercialSource: f["Commercial source"] || f.Source || null,
    approval: selectValue(f.Approval), botEnabled: f["Bot enabled"] === true || /^yes$/i.test(selectValue(f["Bot enabled"]) || ""),
    planId: link(f["Payment plan"]) || f["Plan ID"] || null,
    initialPaymentAed: amount(f["Initial payment AED"]), handover: f.Handover || null,
    feesConfirmed: f["Fees confirmed"] === true || /^yes$/i.test(selectValue(f["Fees confirmed"]) || ""),
    researchOnly, sourceCategory: researchOnly ? "research_offer" : "commercial_offer", sourceRecordId: record.id,
    scope: { projectId, unitId: link(f.Unit), unitType: selectValue(f["Unit type"] || f["Home type"]), bedrooms, phase: f.Phase || f["Phase or unit"] || null, priceBasis: selectValue(f["Price basis"]) }
  };
}

// Checked date and quote expiry are independent requirements. A long expiry
// never bypasses the maximum age of the price/availability observation.
export function commercialOfferGate(offer, { now = Date.now(), policy = factPolicy() } = {}) {
  const reasons = [];
  const checked = Date.parse(offer.checkedOn || "");
  const expiry = offer.validUntil ? Date.parse(offer.validUntil.length === 10 ? `${offer.validUntil}T23:59:59.999Z` : offer.validUntil) : null;
  if (offer.researchOnly) reasons.push("research_only");
  if (!/^approved$/i.test(offer.approval || "")) reasons.push("not_approved");
  if (offer.botEnabled !== true) reasons.push("bot_disabled");
  if (!offer.projectId || (!offer.unitId && (!offer.unitType || offer.bedrooms === null || offer.bedrooms === undefined))) reasons.push("incomplete_scope");
  if (!offer.commercialSource || !String(offer.commercialSource).trim()) reasons.push("missing_commercial_source");
  if (offer.price === null || offer.price === undefined || !Number.isFinite(offer.price) || offer.price <= 0 || !offer.priceBasis) reasons.push("unconfirmed_price");
  if (!Number.isFinite(checked) || checked > now || now - checked > policy.commercialDays * 86400000) reasons.push("price_stale_or_unchecked");
  if (!Number.isFinite(checked) || checked > now || now - checked > policy.availabilityDays * 86400000) reasons.push("availability_stale_or_unchecked");
  if (expiry !== null && (!Number.isFinite(expiry) || expiry < now)) reasons.push("expired_or_invalid_validity");
  if (!/^(available|limited|on request)$/i.test(offer.availability || "")) reasons.push("availability_unconfirmed");
  return { ok: reasons.length === 0, reasons, source: offer.commercialSource, recordId: offer.sourceRecordId || offer.id, checkedOn: offer.checkedOn, scope: offer.scope || null };
}

export function approvedCommercialOffers(offers, options) {
  return (offers || []).map(offer => ({ ...offer, commercialGate: commercialOfferGate(offer, options) })).filter(offer => offer.commercialGate.ok);
}

// Preserve known units; an explicit offer is its own quote scope. It must not
// inherit the project's old payment plan, initial commitment or handover.
export function offerUnits(catalog, { now = Date.now(), policy = factPolicy() } = {}) {
  const offers = approvedCommercialOffers(catalog.intelligence?.offers, { now, policy });
  return offers.flatMap(offer => {
    const project = catalog.projects.find(p => p.id === offer.projectId);
    const linkedUnit = catalog.units.find(u => u.id === offer.unitId && u.projectId === offer.projectId);
    if (!project || (offer.unitId && !linkedUnit)) return [];
    const paymentSchedule = offer.planId ? (catalog.intelligence?.paymentSchedules || []).find(schedule =>
      (schedule.planId === offer.planId || schedule.id === offer.planId) && schedule.projectId === offer.projectId &&
      (!schedule.unitId || schedule.unitId === offer.unitId) && (!schedule.offerId || [offer.id, offer.offerId].includes(schedule.offerId))) || null : null;
    return [{
      ...(linkedUnit || {}), id: `offer:${offer.id}`, inventoryUnitId: linkedUnit?.id || null,
      projectId: offer.projectId, propertyType: linkedUnit?.propertyType || offer.unitType,
      bedrooms: linkedUnit?.bedrooms ?? offer.bedrooms, startingPriceAed: offer.price,
      initialPaymentAed: offer.initialPaymentAed ?? null, availability: offer.availability,
      sizeSqftFrom: linkedUnit?.sizeSqftFrom ?? null, sizeSqftTo: linkedUnit?.sizeSqftTo ?? null,
      active: true, commercialOffer: offer, commercialGate: offer.commercialGate, paymentSchedule
    }];
  });
}
