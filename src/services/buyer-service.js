import { emptyBuyer, FINANCING_VALUES, USE_TYPES } from "../schema/fields.js";
import { ADVISORY_FACT_FIELDS, OBJECTION_CATEGORIES, normalizeAdvisoryFacts } from "../conversation/advisory-memory.js";
import { INVESTMENT_PROFILE_FIELDS, deriveInvestmentStrategy } from "../conversation/investment-strategy.js";
import {
  normalizeArea,
  normalizeBedrooms,
  normalizeDeveloper,
  normalizePropertyType,
  parseMoney
} from "../matching/normalize.js";

function nowIso() {
  return new Date().toISOString();
}

function hasValue(value) {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "string") return value.trim() !== "";
  return true;
}

export function mergeBuyer(existing, patch) {
  const base = { ...emptyBuyer(patch.instagramUserId || existing?.instagramUserId), ...(existing || {}) };
  const next = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (key === "instagramUserId") continue;
    if (key === "removedAreas") continue;
    if (["activeRecommendationProjectId", "activeRecommendationUnitId", "lastUpgradeProjectId", "investmentObjective"].includes(key)) {
      if (value === null || (typeof value === "string" && value.trim())) next[key] = value;
      continue;
    }
    if (key === "salesPathStopped" || key === "noCalls") {
      if (value === true || value === false) next[key] = value;
      continue;
    }
    if (key === "preferredContactChannel" || key === "hubspotContactId" || key === "lastAlertKey" || key === "lastAlertAt") {
      if (value !== undefined && value !== null && String(value).trim() !== "") next[key] = value;
      continue;
    }
    if (key === "followUpStatus" && value) {
      next.followUpStatus = value;
      continue;
    }
    if (key === "cashAvailableAed" && (value === null || value === 0 || value === "0")) {
      next.cashAvailableAed = value === null ? null : Number(value);
      continue;
    }
    if (!hasValue(value)) continue;
    next[key] = value;
  }
  if (hasValue(patch.preferredAreas)) {
    // Latest explicit area replaces earlier area (buyer corrections).
    next.preferredAreas = uniqueStrings(patch.preferredAreas);
  }
  if (Array.isArray(patch.removedAreas) && patch.removedAreas.length) {
    const removed = patch.removedAreas.map(normalizeArea);
    next.preferredAreas = next.preferredAreas.filter(area => !removed.includes(normalizeArea(area)));
    if (!next.preferredAreas.length) {
      next.areaFlexibility = "open";
      next.openToOtherAreas = true;
    }
  }
  if (hasValue(patch.propertyTypes)) {
    next.propertyTypes = uniqueStrings(patch.propertyTypes);
  }
  if (hasValue(patch.bedrooms)) {
    // Latest bedroom requirement replaces earlier bedroom counts.
    next.bedrooms = uniqueNumbers(patch.bedrooms);
  }
  if (hasValue(patch.intentSignals)) {
    next.intentSignals = uniqueStrings(patch.intentSignals);
  }
  for (const field of ["priorities", "concerns", "shownProjects", "rejectedProjects"]) {
    if (Array.isArray(patch[field])) next[field] = uniqueStrings([...(base[field] || []), ...patch[field]]).slice(-100);
  }
  if (patch.rejectionReasons && typeof patch.rejectionReasons === "object") next.rejectionReasons = { ...base.rejectionReasons, ...patch.rejectionReasons };
  if (Array.isArray(patch.objections)) {
    const objections = [...(base.objections || [])];
    for (const raw of patch.objections) {
      const objection = typeof raw === "string" ? { category: raw } : raw;
      if (!OBJECTION_CATEGORIES.includes(objection?.category)) continue;
      const entry = { ...objection, projectId: objection.projectId || null, unitId: objection.unitId || null, resolved: objection.resolved === true, at: objection.at || nowIso() };
      const index = objections.findIndex(item => item.category === entry.category && ((item.projectId === entry.projectId && item.unitId === entry.unitId) || (entry.projectId && !item.projectId && !item.resolved)));
      if (index === -1) objections.push(entry);
      else objections[index] = { ...objections[index], ...entry };
    }
    next.objections = objections.slice(-40);
  }
  // Changing the original budget starts a new, firm ceiling unless the buyer also
  // explicitly grants flexibility in the same update.
  if (patch.budgetAed != null && Number(patch.budgetAed) !== Number(base.budgetAed) && patch.budgetFlexible === undefined && patch.budgetFirm !== true) {
    Object.assign(next, { budgetHardCap: true, budgetFirm: false, budgetFlexible: false, budgetFlexibilityPct: 0, budgetStretchAed: 0, budgetFlexibilityAsked: false });
  }
  if (patch.budgetFirm === true || patch.budgetFlexible === false) {
    Object.assign(next, { budgetHardCap: true, budgetFlexible: false, budgetFlexibilityPct: 0, budgetStretchAed: 0 });
  } else if (patch.budgetFlexible === true) {
    next.budgetHardCap = false;
  }
  if (patch.areaFlexibility === "open") next.openToOtherAreas = true;
  if (patch.areaFlexibility === "fixed") next.openToOtherAreas = false;
  if (patch.openToOtherAreas === false && hasValue(patch.preferredAreas) && patch.areaFlexibility === undefined) next.areaFlexibility = "preferred";
  if (patch.openToOtherAreas === true && patch.areaFlexibility === undefined) next.areaFlexibility = next.preferredAreas?.length ? "preferred" : "open";
  if (patch.useType && patch.useType !== "unknown") next.explorationState = false;
  if (patch.useType === "end_use") {
    next.investmentObjective = null;
    for (const field of INVESTMENT_PROFILE_FIELDS) next[field] = field === "investmentStrategy" ? "UNDECIDED" : null;
    next.priorities = next.priorities.filter(priority => !["rental_income", "capital_growth", "balanced_returns"].includes(priority));
  }
  if (patch.investmentObjective) {
    const objectivePriorities = { growth: "capital_growth", rental_income: "rental_income", balanced: "balanced_returns" };
    next.priorities = next.priorities.filter(priority => !["rental_income", "capital_growth", "balanced_returns"].includes(priority) || priority === objectivePriorities[patch.investmentObjective]);
    if (patch.investmentObjective !== base.investmentObjective && patch.growthPriority === undefined) next.growthPriority = null;
    if (patch.investmentObjective !== base.investmentObjective && patch.investmentStrategy === undefined) next.investmentStrategy = "UNDECIDED";
  }
  if (["handover", "before_handover"].includes(patch.exitHorizon)) next.holdingPeriod = null;
  if (next.useType === "investment" || next.investmentObjective || next.investmentGoal) next.investmentStrategy = deriveInvestmentStrategy(next);
  if (patch.contactDeclined === true) next.contactDeclined = true;
  if (patch.contactDeclined === false) next.contactDeclined = false;
  const timestamp = nowIso();
  if (!next.createdAt) next.createdAt = timestamp;
  next.updatedAt = timestamp;
  next.lastSeenAt = timestamp;
  return next;
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => String(value)))];
}

function uniqueNumbers(values) {
  return [...new Set(values.map((value) => Number(value)))];
}

export function buyerFromKnownFacts(instagramUserId, facts = {}) {
  const patch = { instagramUserId };
  if (facts.budget !== undefined) patch.budgetAed = parseMoney(facts.budget);
  if (facts.cash !== undefined) {
    patch.cashAvailableAed = facts.cash === null ? null : parseMoney(facts.cash);
  }
  if (facts.area) patch.preferredAreas = [normalizeArea(facts.area)].filter(Boolean);
  if (facts.areas) patch.preferredAreas = facts.areas.map(normalizeArea).filter(Boolean);
  if (facts.openToOtherAreas === true) patch.openToOtherAreas = true;
  if (facts.openToOtherAreas === false) patch.openToOtherAreas = false;
  const advisory = normalizeAdvisoryFacts(facts);
  for (const field of ADVISORY_FACT_FIELDS) if (advisory[field] !== undefined) patch[field] = advisory[field];
  if (facts.emirate) patch.preferredEmirate = facts.emirate;
  if (facts.developer) patch.developerInterest = normalizeDeveloper(facts.developer);
  if (facts.project) patch.projectInterest = facts.project;
  if (facts.propertyType) patch.propertyTypes = [normalizePropertyType(facts.propertyType)].filter(Boolean);
  if (facts.propertyTypes) patch.propertyTypes = facts.propertyTypes.map(normalizePropertyType).filter(Boolean);
  if (facts.bedrooms !== undefined) {
    const bedrooms = Array.isArray(facts.bedrooms) ? facts.bedrooms : [facts.bedrooms];
    patch.bedrooms = bedrooms.map(normalizeBedrooms).filter((value) => value !== null);
  }
  if (facts.useType && USE_TYPES.includes(facts.useType)) patch.useType = facts.useType;
  if (facts.financing && FINANCING_VALUES.includes(facts.financing)) patch.financing = facts.financing;
  if (facts.timeframe) patch.timeframe = facts.timeframe;
  if (facts.language) patch.language = facts.language;
  if (facts.requestedAction) patch.requestedAction = facts.requestedAction;
  if (facts.name) patch.name = facts.name;
  if (facts.phone) patch.phone = facts.phone;
  if (facts.contactDeclined !== undefined) patch.contactDeclined = facts.contactDeclined;
  if (facts.intentSignals) patch.intentSignals = facts.intentSignals;
  if (facts.preferredContactChannel) patch.preferredContactChannel = facts.preferredContactChannel;
  if (facts.noCalls === true) patch.noCalls = true;
  if (facts.noCalls === false) patch.noCalls = false;
  if (facts.salesPathStopped === true) patch.salesPathStopped = true;
  if (facts.salesPathStopped === false) patch.salesPathStopped = false;
  if (facts.hubspotContactId) patch.hubspotContactId = facts.hubspotContactId;
  if (facts.lastAlertKey) patch.lastAlertKey = facts.lastAlertKey;
  if (facts.lastAlertAt) patch.lastAlertAt = facts.lastAlertAt;
  if (facts.conversationSummary) patch.conversationSummary = facts.conversationSummary;
  if (facts.leadStatus) patch.leadStatus = facts.leadStatus;
  if (facts.followUpStatus) patch.followUpStatus = facts.followUpStatus;
  return patch;
}

export class BuyerService {
  constructor(store) {
    this.store = store;
  }

  async getOrCreate(instagramUserId) {
    const existing = this.store.getBuyer(instagramUserId);
    if (existing) return { ...emptyBuyer(instagramUserId), ...existing };
    const created = mergeBuyer(null, { instagramUserId });
    return this.store.saveBuyer(created);
  }

  async remember(instagramUserId, facts = {}) {
    const existing = await this.getOrCreate(instagramUserId);
    const patch = buyerFromKnownFacts(instagramUserId, facts);
    const merged = mergeBuyer(existing, patch);
    return this.store.saveBuyer(merged);
  }

  async updateMeta(instagramUserId, meta = {}) {
    const existing = await this.getOrCreate(instagramUserId);
    const merged = mergeBuyer(existing, {
      instagramUserId,
      conversationSummary: meta.conversationSummary,
      leadStatus: meta.leadStatus,
      followUpStatus: meta.followUpStatus,
      intentSignals: meta.intentSignals,
      preferredContactChannel: meta.preferredContactChannel,
      hubspotContactId: meta.hubspotContactId,
      lastAlertKey: meta.lastAlertKey,
      lastAlertAt: meta.lastAlertAt,
      ...(meta.noCalls !== undefined ? { noCalls: meta.noCalls } : {}),
      ...(meta.salesPathStopped !== undefined ? { salesPathStopped: meta.salesPathStopped } : {}),
      ...(meta.contactDeclined !== undefined ? { contactDeclined: meta.contactDeclined } : {})
    });
    return this.store.saveBuyer(merged);
  }

  async replaceIntentSignals(instagramUserId, intentSignals = []) {
    const existing = await this.getOrCreate(instagramUserId);
    return this.store.saveBuyer({
      ...existing,
      intentSignals: uniqueStrings(intentSignals),
      updatedAt: nowIso(),
      lastSeenAt: nowIso()
    });
  }

  async patchBuyer(instagramUserId, patch = {}) {
    const existing = await this.getOrCreate(instagramUserId);
    return this.store.saveBuyer(mergeBuyer(existing, { ...patch, instagramUserId }));
  }

  /** Record only inventory actually presented, without replacing buyer criteria. */
  async recordAdvisoryExposure(instagramUserId, { projectIds = [], primaryProjectId = null, primaryUnitId = null, upgradeProjectId = null } = {}) {
    const patch = { shownProjects: projectIds.filter(Boolean) };
    if (primaryProjectId) {
      patch.activeRecommendationProjectId = primaryProjectId;
      patch.activeRecommendationUnitId = primaryUnitId;
    }
    if (upgradeProjectId) patch.lastUpgradeProjectId = upgradeProjectId;
    return this.patchBuyer(instagramUserId, patch);
  }

  /** Bind a current objection to its offer so the next suggestion solves it. */
  async recordObjection(instagramUserId, { projectId = null, unitId = null, category, factFingerprint = null, evidenceState = null } = {}) {
    if (!OBJECTION_CATEGORIES.includes(category)) return this.getOrCreate(instagramUserId);
    const buyer = await this.getOrCreate(instagramUserId);
    const at = nowIso();
    const patch = { concerns: [category], objections: [{ category, projectId, unitId, resolved: false, at }] };
    const propertyRejection = !["needs_time", "already_has_agent", "no_calls", "trust_concern"].includes(category);
    if (projectId && propertyRejection) {
      const prior = buyer.rejectionReasons?.[projectId];
      patch.rejectedProjects = [projectId];
      patch.rejectionReasons = { [projectId]: { categories: uniqueStrings([...(prior?.categories || []), category]), unitId, factFingerprint, evidenceState, resolved: false, at } };
      if (projectId === buyer.lastUpgradeProjectId) patch.upgradeDeclined = true;
    }
    return this.patchBuyer(instagramUserId, patch);
  }

  async resolveProjectObjection(instagramUserId, projectId, category = null) {
    const buyer = await this.getOrCreate(instagramUserId);
    const objections = (buyer.objections || []).filter(item => item.projectId === projectId && (!category || item.category === category)).map(item => ({ ...item, resolved: true }));
    const prior = buyer.rejectionReasons?.[projectId];
    const unresolved = (buyer.objections || []).some(item => item.projectId === projectId && !item.resolved && category && item.category !== category);
    return this.patchBuyer(instagramUserId, { objections, ...(prior ? { rejectionReasons: { [projectId]: { ...prior, resolved: !unresolved } } } : {}) });
  }

  /** Clear search criteria so a buyer can start a new enquiry on the same IG id. */
  async resetCriteria(instagramUserId) {
    const existing = await this.getOrCreate(instagramUserId);
    const blank = emptyBuyer(instagramUserId);
    const next = {
      ...blank,
      name: existing.name,
      phone: existing.phone,
      contactDeclined: existing.contactDeclined,
      preferredContactChannel: existing.preferredContactChannel,
      noCalls: existing.noCalls,
      language: existing.language,
      hubspotContactId: existing.hubspotContactId,
      createdAt: existing.createdAt || nowIso(),
      updatedAt: nowIso(),
      lastSeenAt: nowIso()
    };
    return this.store.saveBuyer(next);
  }

  missingQualificationFields(buyer) {
    const missing = [];
    if (!hasValue(buyer.budgetAed)) missing.push("budgetAed");
    if (!hasValue(buyer.preferredAreas) && !hasValue(buyer.projectInterest) && !buyer.openToOtherAreas && buyer.areaFlexibility !== "open") missing.push("preferredAreas");
    if (!hasValue(buyer.propertyTypes) && !hasValue(buyer.bedrooms)) missing.push("propertyTypes");
    return missing;
  }
}
