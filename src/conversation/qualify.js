import { choicesForField } from "./choices.js";

const FIELD_LABELS = {
  budgetAed: "budget",
  preferredAreas: "preferred area",
  propertyTypes: "property type or bedrooms",
  cashAvailableAed: "cash available for the initial payment",
  financing: "payment preference",
  useType: "buy or invest goal",
  name: "name",
  phone: "phone number"
};

const ASK_PROMPTS = {
  budgetAed: "What budget are you working with?",
  preferredAreas: "Which area are you leaning toward?",
  propertyTypes: "What size works best for you?",
  cashAvailableAed: "How much cash can you put in for the initial payment?",
  financing: "Do you prefer cash, mortgage, or a payment plan?",
  useType: "Are you buying, investing, or just exploring?",
  name: "What name should I put on the enquiry?",
  phone: "If you want an advisor to follow up, what number works best?"
};

/** Core fields needed before we run a confident inventory match. */
export const CORE_QUALIFICATION = ["budgetAed", "preferredAreas", "propertyTypes"];

/** Extra fields asked after a match, especially for high-intent paths. */
export const CONTACT_QUALIFICATION = ["name", "phone"];

export function qualificationGaps(
  buyer,
  { includeCash = false, includeFinancing = false, includeContact = false, includeUseType = false } = {}
) {
  const missing = [];
  const hasAreaOrProject = Boolean(
    buyer.preferredAreas?.length ||
      buyer.projectInterest ||
      buyer.openToOtherAreas ||
      buyer.areaFlexibility === "open" ||
      buyer.intentSignals?.includes("area_flexible")
  );
  const hasTypeOrBeds = Boolean(buyer.propertyTypes?.length || buyer.bedrooms?.length || buyer.propertyTypeFlexibility);

  if (buyer.budgetAed === null || buyer.budgetAed === undefined) missing.push("budgetAed");
  if (!hasAreaOrProject) missing.push("preferredAreas");
  if (!hasTypeOrBeds) missing.push("propertyTypes");
  if (includeUseType && (!buyer.useType || buyer.useType === "unknown")) missing.push("useType");
  if (includeCash && (buyer.cashAvailableAed === null || buyer.cashAvailableAed === undefined)) {
    missing.push("cashAvailableAed");
  }
  if (includeFinancing && (!buyer.financing || buyer.financing === "unknown")) {
    missing.push("financing");
  }
  if (includeContact && !buyer.contactDeclined) {
    if (!buyer.name) missing.push("name");
    if (!buyer.phone) missing.push("phone");
  }
  return missing;
}

export function nextQualificationQuestion(buyer, options = {}) {
  const missing = qualificationGaps(buyer, options);
  if (!missing.length) return null;
  const field = missing[0];
  const choiceGroup = choicesForField(field);
  const prompt = choiceGroup?.prompt || ASK_PROMPTS[field] || `Could you share your ${FIELD_LABELS[field] || field}?`;
  return {
    field,
    label: FIELD_LABELS[field] || field,
    prompt,
    choices: choiceGroup?.choices || null
  };
}

export function isCoreQualified(buyer) {
  return qualificationGaps(buyer).length === 0;
}

export function summarizeBuyer(buyer) {
  const parts = [];
  if (buyer.budgetAed) parts.push(`budget AED ${Number(buyer.budgetAed).toLocaleString("en-US")}`);
  if (buyer.cashAvailableAed) {
    parts.push(`cash AED ${Number(buyer.cashAvailableAed).toLocaleString("en-US")}`);
  }
  if (buyer.preferredAreas?.length) parts.push(`area ${buyer.preferredAreas.join(", ")}`);
  if (buyer.projectInterest) parts.push(`project ${buyer.projectInterest}`);
  if (buyer.bedrooms?.length) {
    const beds = buyer.bedrooms.map((n) => (n === 0 ? "studio" : `${n}BR`)).join("/");
    parts.push(beds);
  }
  if (buyer.propertyTypes?.length) parts.push(buyer.propertyTypes.join("/"));
  if (buyer.financing && buyer.financing !== "unknown") {
    parts.push(buyer.financing.replace("_", " "));
  }
  if (buyer.investmentObjective) parts.push(`investment objective ${buyer.investmentObjective.replaceAll("_", " ")}`);
  if (buyer.holdingPeriod) parts.push(`holding period ${buyer.holdingPeriod} years`);
  return parts.join(", ") || "no filters yet";
}
