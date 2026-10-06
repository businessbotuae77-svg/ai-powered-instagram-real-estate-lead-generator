// Sales strategy chooses a small useful commitment. Facts and candidates are
// supplied by the opportunity engine; this layer cannot create inventory.
export function determineAdvisorStrategy({ buyer, advisor, message = "", pendingOffer = null }) {
  const text = String(message).toLowerCase();
  const concerns = buyer.concerns || [];
  if (advisor.opportunities.some(o => o.type === "no_push" && o.reasonCodes.includes("resolve_trust_before_recommending"))) {
    return { type: "trust_check", nextAction: null, questionField: "trustConcern" };
  }
  const propertyObjection = [...(buyer.objections || [])].reverse().find(o => !o.resolved &&
    !["no_calls", "not_interested", "needs_time", "already_has_agent", "trust_concern"].includes(o.category));
  if (!advisor.primary && propertyObjection) return { type: "resolve_objection", objection: propertyObjection.category, nextAction: null, questionField: null };
  if (buyer.salesPathStopped || advisor.opportunities.some(o => o.type === "no_push" && o.reasonCodes.includes("respect_buyer_pace")) || /\b(needs? time|need to think|think about it|already (?:have|has) an agent)\b/.test(text)) {
    return { type: "no_push", nextAction: null, questionField: null };
  }
  if (!advisor.primary) return null;
  const candidate = advisor.upgradeAssessment?.permissionCandidate;
  const askFlexibility = candidate && !buyer.budgetFlexible && !buyer.budgetFirm &&
    !buyer.budgetFlexibilityAsked && !buyer.upgradeDeclined;
  if (askFlexibility) return { type: "budget_permission", nextAction: "budget_flexibility", questionField: "budgetFlexible" };
  const yes = /^(yes|sure|ok|okay|please|go ahead)[.!]*$/.test(text.trim());
  if (yes && pendingOffer?.type === "advisory_next_action") {
    return { type: "answer_action", nextAction: pendingOffer.action, questionField: null };
  }
  const objection = [...(buyer.objections || [])].reverse().find(o => !o.resolved);
  const nextAction = advisor.challenger ? "compare" : "payment_details";
  return {
    type: "recommend",
    nextAction,
    questionField: "advisoryNextAction",
    objection: objection?.category || null,
    lowPressure: concerns.includes("trust_concern") || concerns.includes("already_has_agent"),
    objective: buyer.investmentObjective || buyer.useType,
    primary: { projectId: advisor.primary.projectId, unitId: advisor.primary.unitId },
    challenger: advisor.challenger ? { projectId: advisor.challenger.projectId, unitId: advisor.challenger.unitId } : null
  };
}

export function advisoryReady(buyer) {
  return Boolean(buyer.budgetAed && (
    buyer.investmentObjective || buyer.useType === "end_use" ||
    ((buyer.preferredAreas?.length || buyer.projectInterest || buyer.openToOtherAreas) &&
      (buyer.bedrooms?.length || buyer.propertyTypes?.length))
  ));
}
