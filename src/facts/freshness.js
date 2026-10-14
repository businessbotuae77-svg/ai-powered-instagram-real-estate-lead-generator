import { commercialOfferGate } from "./commercial-offers.js";

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

// Units inherit the project's verification in the current schema. If a unit has
// its own verification date, both records must be current; never ignore a stale row.
export function approvedUnitFresh(project, unit, { now = Date.now(), maxAgeDays = factPolicy().commercialDays, availability = false } = {}) {
  if (unit.active === false || unit.approved === false || !approvedFresh(project, { now, maxAgeDays })) return false;
  const dates = [unit.lastVerified, ...(availability ? [unit.availabilityVerifiedAt] : [])].filter(value => value != null && value !== "");
  return dates.every(lastVerified => approvedFresh({ active: true, source: unit.source || project.source, lastVerified }, { now, maxAgeDays }));
}

// Remove stale commercial values before scoring as well as before writing copy.
// When suppressAvailability is true, availability is never surfaced regardless of
// freshness. This prevents "available now" / sold-out claims in normal chat while
// still allowing home-type pricing from Units.
export function safeCatalog(catalog, { now = Date.now(), policy = factPolicy(), suppressAvailability = false } = {}) {
  const projects = catalog.projects.filter(p => p.active && p.source && p.approved !== false).map(p => {
    if (approvedFresh(p, { now, maxAgeDays: policy.commercialDays })) return { ...p, availabilityNotes: suppressAvailability ? null : p.availabilityNotes };
    return { ...p, initialPaymentAed: null, paymentPlanAvailable: null,
      paymentPlanSummary: null, handover: null, availabilityNotes: null };
  });
  const units = catalog.units.filter(u => u.active !== false && u.approved !== false && projects.some(p => p.id === u.projectId)).map(u => {
    const p = projects.find(p => p.id === u.projectId);
    if (u.commercialOffer) {
      const gate = commercialOfferGate(u.commercialOffer, { now, policy });
      return { ...u, commercialGate: gate,
        startingPriceAed: gate.ok ? u.commercialOffer.price : null,
        initialPaymentAed: gate.ok ? u.commercialOffer.initialPaymentAed : null,
        availability: suppressAvailability ? null : (gate.ok ? u.commercialOffer.availability : null) };
    }
    const fresh = approvedUnitFresh(p, u, { now, maxAgeDays: policy.commercialDays });
    const availabilityFresh = !suppressAvailability && approvedUnitFresh(p, u, { now, maxAgeDays: policy.availabilityDays, availability: true });
    return { ...u, startingPriceAed: fresh ? u.startingPriceAed : null,
      initialPaymentAed: fresh ? u.initialPaymentAed : null,
      availability: availabilityFresh ? u.availability : null };
  });
  return { ...catalog, projects, units };
}
