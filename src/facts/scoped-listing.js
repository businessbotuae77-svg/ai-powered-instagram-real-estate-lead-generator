/** Phase labels are identities; only explicit equivalent labels are folded. */
export function normalizePhase(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const label = String(value).trim().toLowerCase().replace(/[٠-٩۰-۹]/g, digit => {
    const arabic = "٠١٢٣٤٥٦٧٨٩".indexOf(digit);
    return String(arabic < 0 ? "۰۱۲۳۴۵۶۷۸۹".indexOf(digit) : arabic);
  }).replace(/\s+/g, " ");
  if (!label) return null;
  const numbered = label.match(/^(?:(?:phase|launch|stage|المرحلة|المرحله|مرحلة|مرحله)\s*[-:#]?\s*)?(\d+)$/);
  if (numbered) return String(Number(numbered[1]));
  const names = { first: "1", second: "2", third: "3", fourth: "4", fifth: "5", sixth: "6",
    "الأولى": "1", "الاولى": "1", "الأول": "1", "الاول": "1", "الثانية": "2", "الثاني": "2", "الثالثة": "3", "الثالث": "3",
    "الرابعة": "4", "الرابع": "4", "الخامسة": "5", "الخامس": "5", "السادسة": "6", "السادس": "6" };
  const ordinal = label.replace(/^(?:phase|launch|stage|المرحلة|المرحله|مرحلة|مرحله)\s+/, "").replace(/\s+(?:phase|launch|stage)$/, "");
  return names[ordinal] || label;
}

export function hasPhase(unit) {
  return normalizePhase(unit?.phase) !== null;
}

export function phaseMatches(unit, requestedPhase) {
  return requestedPhase == null || normalizePhase(unit?.phase) === normalizePhase(requestedPhase);
}

export function phasePlanAvailable(value) {
  if (value === true || value === false) return value;
  const label = typeof value === "object" && value ? value.name : value;
  if (typeof label !== "string") return null;
  if (/^yes$/i.test(label.trim())) return true;
  if (/^no$/i.test(label.trim())) return false;
  return null;
}

/** A named phase owns its commercial facts; blank phases keep the legacy route. */
export function projectForListing(project, unit) {
  if (!project || !hasPhase(unit)) return project;
  return {
    ...project,
    phase: String(unit.phase).trim(), phaseScoped: true,
    projectSource: project.projectSource ?? project.source ?? null,
    projectLastVerified: project.projectLastVerified ?? project.lastVerified ?? null,
    startingPriceAed: unit.startingPriceAed ?? null,
    startingPriceBasis: "phase_home_type_starting_price",
    initialPaymentAed: unit.initialPaymentAed ?? null,
    paymentPlanAvailable: phasePlanAvailable(unit.paymentPlanAvailable),
    paymentPlanSummary: unit.paymentPlanSummary || null,
    handover: unit.handover || null,
    source: unit.source || null,
    lastVerified: unit.lastVerified || null,
    approved: project.approved !== false && unit.approved !== false,
    active: Boolean(project.active && unit.active),
    availabilityNotes: null
  };
}

export function offerMatchesPhase(unit) {
  const offer = unit?.commercialOffer;
  if (!offer || !hasPhase(unit)) return true;
  if (!offer.phase || normalizePhase(offer.phase) !== normalizePhase(unit.phase)) return false;
  if (offer.projectId && offer.projectId !== unit.projectId) return false;
  if (offer.unitId) return offer.unitId === (unit.inventoryUnitId || unit.id);
  return offer.bedrooms === unit.bedrooms && String(offer.unitType || "").toLowerCase() === String(unit.propertyType || "").toLowerCase();
}
