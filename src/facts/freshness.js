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
export function safeCatalog(catalog, { now = Date.now(), policy = factPolicy() } = {}) {
  const projects = catalog.projects.filter(p => p.active && p.source && p.approved !== false).map(p => {
    if (approvedFresh(p, { now, maxAgeDays: policy.commercialDays })) return { ...p };
    return { ...p, initialPaymentAed: null, paymentPlanAvailable: null,
      paymentPlanSummary: null, handover: null, availabilityNotes: null };
  });
  const units = catalog.units.filter(u => projects.some(p => p.id === u.projectId)).map(u => {
    const p = projects.find(p => p.id === u.projectId);
    const fresh = approvedFresh(p, { now, maxAgeDays: policy.commercialDays });
    return { ...u, startingPriceAed: fresh ? u.startingPriceAed : null,
      initialPaymentAed: fresh ? u.initialPaymentAed : null,
      availability: approvedFresh(p, { now, maxAgeDays: policy.availabilityDays }) ? u.availability : null };
  });
  return { ...catalog, projects, units };
}
