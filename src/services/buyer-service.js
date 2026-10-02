import { emptyBuyer, FINANCING_VALUES, USE_TYPES } from "../schema/fields.js";
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
  const base = existing ? { ...existing } : emptyBuyer(patch.instagramUserId);
  const next = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (key === "instagramUserId") continue;
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
    if (existing) return existing;
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
    if (!hasValue(buyer.preferredAreas) && !hasValue(buyer.projectInterest)) missing.push("preferredAreas");
    if (!hasValue(buyer.propertyTypes) && !hasValue(buyer.bedrooms)) missing.push("propertyTypes");
    return missing;
  }
}
