import { approvedFresh, factPolicy } from "./freshness.js";
import { formatAed } from "../matching/normalize.js";
import { commercialOfferGate } from "./commercial-offers.js";
import { analyzePaymentSchedule } from "../conversation/payment-analysis.js";

function field(value, provenance = {}) {
  const confirmed = value !== null && value !== undefined && value !== "";
  return {
    value: confirmed ? value : null,
    confirmed,
    ...provenance
  };
}

export function buildFactPack(match, options = {}) {
  const { project, unit, downPaymentAed, bedroomLabel, fit = null } = match;
  const policy = options.policy || factPolicy();
  const fresh = approvedFresh(project, { now: options.now, maxAgeDays: policy.commercialDays });
  const available = approvedFresh(project, { now: options.now, maxAgeDays: policy.availabilityDays });
  const offer = unit.commercialOffer || null;
  const gate = offer ? commercialOfferGate(offer, { now: options.now, policy }) : null;
  const quoteFresh = offer ? gate.ok : fresh;
  const projectEvidence = { source: project.source, recordId: project.id, scope: "project_knowledge", verifiedAt: project.lastVerified || null };
  const unitEvidence = { ...projectEvidence, recordId: unit.inventoryUnitId || unit.id, scope: "unit_type" };
  const commercialEvidence = offer
    ? { source: offer.commercialSource, recordId: offer.sourceRecordId || offer.id, scope: offer.priceBasis, verifiedAt: offer.checkedOn, offerId: offer.offerId }
    : { ...projectEvidence, recordId: unit.id, scope: "unit_type_starting_price" };
  const commercial = value => field(quoteFresh ? value : null, commercialEvidence);
  const initial = offer ? offer.initialPaymentAed : downPaymentAed;
  const payment = offer && gate.ok ? analyzePaymentSchedule(unit.paymentSchedule, {
    priceAed: offer.price, projectId: project.id, offerId: offer.offerId, offerRecordId: offer.id || offer.sourceRecordId, planId: offer.planId, now: options.now
  }) : null;
  const scheduleSummary = payment?.status === "COMPLETE" ? payment.milestones.map(m => `${m.kind.replaceAll("_", " ")} ${m.percent}%`).join("; ") : null;
  const pack = {
    fit,
    projectId: project.id,
    unitId: unit.id,
    name: field(project.name),
    developer: field(project.developerName),
    emirate: field(project.emirate),
    area: field(project.area),
    propertyType: field(unit.propertyType),
    bedrooms: field(unit.bedrooms),
    bedroomLabel: field(bedroomLabel),
    offerId: offer?.offerId || null,
    planId: field(offer?.planId || unit.planId, commercialEvidence),
    commercialGate: gate,
    paymentAnalysis: payment,
    startingPriceAed: commercial(offer ? offer.price : unit.startingPriceAed),
    startingPriceText: commercial(formatAed(offer ? offer.price : unit.startingPriceAed)),
    sizeSqftFrom: field(unit.sizeSqftFrom),
    sizeSqftTo: field(unit.sizeSqftTo),
    downPaymentAed: commercial(initial),
    downPaymentText: commercial(formatAed(initial)),
    paymentPlanAvailable: commercial(offer ? (payment?.status === "COMPLETE" ? true : null) : project.paymentPlanAvailable),
    paymentPlanSummary: commercial(offer ? scheduleSummary : project.paymentPlanSummary),
    handover: commercial(offer ? offer.handover : project.handover),
    status: field(project.status),
    availability: field((offer ? gate.ok : available) && unit.availability !== "Unknown" ? unit.availability : null, commercialEvidence),
    availabilityNotes: field(!offer && available ? project.availabilityNotes : null, commercialEvidence),
    description: field(project.description),
    features: field(project.features),
    source: field(offer ? offer.commercialSource : project.source),
    lastVerified: field(offer ? offer.checkedOn : project.lastVerified)
  };
  for (const [key, fact] of Object.entries(pack)) {
    if (!fact || typeof fact !== "object" || !("confirmed" in fact) || fact.source) continue;
    Object.assign(fact, ["propertyType", "bedrooms", "bedroomLabel", "sizeSqftFrom", "sizeSqftTo"].includes(key) ? unitEvidence : projectEvidence);
  }
  if (payment?.status === "COMPLETE") {
    const row = payment.evidence[0];
    const provenance = { source: row.source, recordId: row.sourceRecordId, scope: row.scope, verifiedAt: row.verifiedOn };
    for (const key of ["bookingAed", "cash30DaysAed", "cash6MonthsAed", "cash12MonthsAed", "cashBeforeHandoverAed", "cashAtHandoverAed", "cashAfterHandoverAed"]) pack[key] = field(payment[key], provenance);
  }
  return pack;
}

/** Knowledge has its own scope and cannot turn a known project into a quote. */
export function buildProjectKnowledgePack(project) {
  const evidence = { source: project.source, recordId: project.id, scope: "project_knowledge", verifiedAt: project.lastVerified || null };
  const pack = { projectId: project.id, unitId: null, knowledgeOnly: true };
  const values = { name: project.name, developer: project.developerName, emirate: project.emirate,
    area: project.area, status: project.status, description: project.description, features: project.features };
  for (const [key, value] of Object.entries(values)) pack[key] = field(value, evidence);
  for (const key of ["bedrooms", "bedroomLabel", "propertyType", "sizeSqftFrom", "sizeSqftTo", "startingPriceAed", "startingPriceText", "downPaymentAed", "downPaymentText", "paymentPlanAvailable", "paymentPlanSummary", "handover", "availability", "availabilityNotes"]) pack[key] = field(null);
  pack.source = field(project.source, evidence);
  pack.lastVerified = field(project.lastVerified, evidence);
  return pack;
}

export function retrieveFacts(matches) {
  return matches.map(buildFactPack);
}

export function missingCommercialFields(pack) {
  const keys = ["startingPriceAed", "downPaymentAed", "paymentPlanSummary", "handover", "availability"];
  return keys.filter((key) => !pack[key].confirmed);
}

export function collectAllowedClaims(packs, evidenceClaims = []) {
  const amounts = new Set();
  const percents = new Set();
  const dates = new Set();
  const availability = new Set();
  const phrases = new Set();

  for (const pack of packs) {
    for (const key of ["bookingAed", "cash30DaysAed", "cash6MonthsAed", "cash12MonthsAed", "cashBeforeHandoverAed", "cashAtHandoverAed", "cashAfterHandoverAed"]) {
      if (pack[key]?.confirmed) amounts.add(Number(pack[key].value));
    }
    for (const key of ["startingPriceAed", "downPaymentAed", "sizeSqftFrom", "sizeSqftTo", "bedrooms"]) {
      if (pack[key]?.confirmed) amounts.add(Number(pack[key].value));
    }
    if (pack.paymentPlanSummary.confirmed) {
      const plan = String(pack.paymentPlanSummary.value);
      for (const percent of plan.match(/\d+(?:\.\d+)?%/g) || []) {
        percents.add(percent.replace(/%/g, ""));
      }
      for (const hit of plan.match(/(\d+(?:\.\d+)?)\s*percent/gi) || []) {
        percents.add(String(hit).match(/\d+(?:\.\d+)?/)[0]);
      }
      for (const pair of plan.match(/\d+\s*\/\s*\d+/g) || []) {
        const compact = pair.replace(/\s+/g, "");
        phrases.add(compact);
        const [left, right] = compact.split("/");
        percents.add(left);
        percents.add(right);
      }
      phrases.add(plan.toLowerCase());
    }
    if (pack.handover.confirmed) {
      const text = String(pack.handover.value);
      for (const hit of text.match(/Q[1-4]\s*20\d{2}|20\d{2}/gi) || []) {
        dates.add(hit.replace(/\s+/g, " ").toUpperCase());
      }
      phrases.add(text.toLowerCase());
    }
    if (pack.availability.confirmed) availability.add(String(pack.availability.value).toLowerCase());
    if (pack.availabilityNotes.confirmed) phrases.add(String(pack.availabilityNotes.value).toLowerCase());
    if (pack.startingPriceText.confirmed) phrases.add(String(pack.startingPriceText.value).toLowerCase());
    if (pack.name.confirmed) phrases.add(String(pack.name.value).toLowerCase());
    if (pack.developer.confirmed) phrases.add(String(pack.developer.value).toLowerCase());
    if (pack.area.confirmed) phrases.add(String(pack.area.value).toLowerCase());
  }

  for (const claim of evidenceClaims) {
    if (!claim?.evidenceId || !claim.source || !claim.recordId || !claim.scope || !claim.verifiedAt) continue;
    if (typeof claim.value === "number" && Number.isFinite(claim.value)) amounts.add(claim.value);
    if (typeof claim.value === "string") {
      phrases.add(claim.value.toLowerCase());
      for (const date of claim.value.match(/\b20\d{2}\b|Q[1-4]\s*20\d{2}/gi) || []) dates.add(date.toUpperCase());
    }
    for (const date of String(claim.verifiedAt).match(/\b20\d{2}\b/g) || []) dates.add(date);
  }

  return { amounts, percents, dates, availability, phrases };
}
