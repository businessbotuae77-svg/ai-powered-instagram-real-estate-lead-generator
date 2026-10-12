import { commercialOfferGate } from "./commercial-offers.js";
import { hasPhase, projectForListing, offerMatchesPhase } from "./scoped-listing.js";

export function factPolicy(env = process.env) {
  const days = (key, fallback) => {
    const n = Number(env[key] ?? fallback);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return { commercialDays: days("FACT_MAX_AGE_DAYS", 30), availabilityDays: days("AVAILABILITY_MAX_AGE_DAYS", 1) };
}

export function approvedFresh(project, { now = Date.now(), maxAgeDays = factPolicy().commercialDays } = {}) {
  const verified = Date.parse(project.lastVerified || "");
  const age = now - verified;
  return Boolean(project.active && project.source && project.approved !== false &&
    Number.isFinite(verified) && age >= 0 && age <= maxAgeDays * 86400000);
}

// Remove stale commercial values before scoring as well as before writing copy.
// When suppressAvailability is true, availability is never surfaced regardless of
// freshness. This prevents "available now" / sold-out claims in normal chat while
// retaining internal sold-out exclusions and home-type pricing from Units.
export function safeCatalog(catalog, { now = Date.now(), policy = factPolicy(), suppressAvailability = false } = {}) {
  const projects = catalog.projects.filter(p => p.active && p.source && p.approved !== false).map(p => {
    if (approvedFresh(p, { now, maxAgeDays: policy.commercialDays })) return { ...p, availabilityNotes: suppressAvailability ? null : p.availabilityNotes };
    return { ...p, initialPaymentAed: null, paymentPlanAvailable: null,
      paymentPlanSummary: null, handover: null, availabilityNotes: null };
  });
  const units = catalog.units.filter(u => projects.some(p => p.id === u.projectId)).map(u => {
    const p = projects.find(p => p.id === u.projectId);
    const availabilitySuppressed = suppressAvailability || u.availabilitySuppressed === true;
    if (u.commercialOffer) {
      const observedGate = commercialOfferGate(u.commercialOffer, { now, policy });
      const gate = offerMatchesPhase(u) ? observedGate : { ...observedGate, ok: false, reasons: [...observedGate.reasons, "phase_scope_mismatch"] };
      return { ...u, commercialGate: gate, availabilitySuppressed, availabilityBlocked: false,
        availabilityBlockedVerifiedOn: null, availabilityBlockedSource: null,
        startingPriceAed: gate.ok ? u.commercialOffer.price : null,
        initialPaymentAed: gate.ok ? u.commercialOffer.initialPaymentAed : null,
        availability: availabilitySuppressed ? null : (gate.ok ? u.commercialOffer.availability : null) };
    }
    const scopedProject = projectForListing(p, u);
    const fresh = approvedFresh(scopedProject, { now, maxAgeDays: policy.commercialDays });
    const availabilityFresh = approvedFresh(scopedProject, { now, maxAgeDays: policy.availabilityDays });
    // Copy suppression must not erase a current sold-out exclusion. Retain only
    // the exclusion and its checked scope; never restore a buyer-facing claim.
    const availabilityBlocked = availabilityFresh && (String(u.availability || "").trim().toLowerCase() === "sold out" ||
      (u.availability == null && u.availabilityBlocked === true &&
        u.availabilityBlockedVerifiedOn === scopedProject.lastVerified && u.availabilityBlockedSource === scopedProject.source));
    const phaseTerms = hasPhase(u) ? { phaseScoped: true,
      paymentPlanAvailable: fresh ? scopedProject.paymentPlanAvailable : null,
      paymentPlanSummary: fresh ? scopedProject.paymentPlanSummary : null,
      handover: fresh ? scopedProject.handover : null } : {};
    return { ...u, ...phaseTerms, startingPriceAed: fresh ? u.startingPriceAed : null,
      initialPaymentAed: fresh ? u.initialPaymentAed : null,
      availabilitySuppressed, availabilityBlocked,
      availabilityBlockedVerifiedOn: availabilityBlocked ? scopedProject.lastVerified : null,
      availabilityBlockedSource: availabilityBlocked ? scopedProject.source : null,
      availability: !availabilitySuppressed && availabilityFresh ? u.availability : null };
  });
  return { ...catalog, projects, units };
}
