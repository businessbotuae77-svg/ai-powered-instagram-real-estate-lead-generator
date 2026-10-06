import {
  bedroomLabel,
  normalizeArea,
  normalizeDeveloper,
  normalizePropertyType,
  sameText
} from "./normalize.js";
import { buildFactPack } from "../facts/retrieval.js";

function downPayment(project, unit) {
  if (unit.commercialOffer) return unit.initialPaymentAed ?? null;
  if (unit.initialPaymentAed !== null && unit.initialPaymentAed !== undefined) {
    return unit.initialPaymentAed;
  }
  if (project.initialPaymentAed !== null && project.initialPaymentAed !== undefined) {
    return project.initialPaymentAed;
  }
  return null;
}

function reject(unit, project, reason) {
  return {
    ok: false,
    reason,
    projectId: project.id,
    projectName: project.name,
    unitId: unit.id
  };
}

export function matchCriteria(project, unit, criteria = {}) {
  if (unit.commercialOffer && unit.commercialGate?.ok !== true) return reject(unit, project, "commercial_offer_unusable");
  if (!project.active) return reject(unit, project, "project_inactive");
  if (!project.developerActive) return reject(unit, project, "developer_inactive");
  if (!unit.active) return reject(unit, project, "unit_inactive");

  if (criteria.emirate && !sameText(project.emirate, criteria.emirate)) {
    return reject(unit, project, "emirate");
  }

  if (criteria.area) {
    const wanted = normalizeArea(criteria.area);
    if (!sameText(project.area, wanted)) return reject(unit, project, "area");
  }

  if (criteria.developer) {
    const wanted = normalizeDeveloper(criteria.developer);
    if (!sameText(project.developerName, wanted)) return reject(unit, project, "developer");
  }

  if (criteria.project) {
    if (!sameText(project.name, criteria.project) && !project.name.toLowerCase().includes(String(criteria.project).toLowerCase())) {
      return reject(unit, project, "project");
    }
  }

  if (criteria.propertyType) {
    const wanted = normalizePropertyType(criteria.propertyType);
    if (wanted === "studio") {
      if (unit.bedrooms !== 0) return reject(unit, project, "property_type");
    } else if (unit.propertyType !== wanted) {
      return reject(unit, project, "property_type");
    }
  }

  if (criteria.bedrooms !== null && criteria.bedrooms !== undefined && criteria.bedrooms !== "") {
    const wantedList = Array.isArray(criteria.bedrooms)
      ? criteria.bedrooms.map(Number)
      : [Number(criteria.bedrooms)];
    if (!wantedList.includes(unit.bedrooms)) return reject(unit, project, "bedrooms");
  }

  if (criteria.budgetAed !== null && criteria.budgetAed !== undefined) {
    if (unit.startingPriceAed === null || unit.startingPriceAed === undefined) {
      return reject(unit, project, "price_unconfirmed");
    }
    if (unit.startingPriceAed > criteria.budgetAed) return reject(unit, project, "budget");
  }

  if (criteria.cashAvailableAed !== null && criteria.cashAvailableAed !== undefined) {
    const initial = downPayment(project, unit);
    if (initial === null) return reject(unit, project, "initial_payment_unconfirmed");
    if (initial > criteria.cashAvailableAed) return reject(unit, project, "initial_payment");
  }

  if (criteria.paymentPlanRequired) {
    const available = unit.commercialOffer ? buildFactPack({ project, unit, downPaymentAed: downPayment(project, unit) }).paymentPlanAvailable.value : project.paymentPlanAvailable;
    if (!available) return reject(unit, project, "payment_plan");
  }

  if (criteria.status && !sameText(project.status, criteria.status)) {
    return reject(unit, project, "status");
  }

  return { ok: true, reason: "matched", projectId: project.id, unitId: unit.id };
}

export function matchInventory(catalog, criteria = {}) {
  const rejected = [];
  const matches = [];

  for (const unit of catalog.units) {
    const project = catalog.projects.find((row) => row.id === unit.projectId);
    if (!project) {
      rejected.push({ unitId: unit.id, reason: "missing_project" });
      continue;
    }
    const result = matchCriteria(project, unit, criteria);
    if (!result.ok) {
      rejected.push(result);
      continue;
    }
    matches.push({
      project,
      unit,
      downPaymentAed: downPayment(project, unit),
      bedroomLabel: bedroomLabel(unit.bedrooms)
    });
  }

  matches.sort((a, b) => {
    const priceA = a.unit.startingPriceAed ?? Number.MAX_SAFE_INTEGER;
    const priceB = b.unit.startingPriceAed ?? Number.MAX_SAFE_INTEGER;
    return priceA - priceB;
  });

  return {
    criteria,
    matches,
    rejected,
    matchCount: matches.length
  };
}

export function criteriaFromBuyer(buyer) {
  const beds = buyer.bedrooms?.length
    ? buyer.bedrooms.length === 1
      ? buyer.bedrooms[0]
      : [...buyer.bedrooms]
    : null;
  return {
    emirate: buyer.preferredEmirate || "Abu Dhabi",
    area: buyer.preferredAreas?.[0] || null,
    developer: buyer.developerInterest || null,
    project: buyer.projectInterest || null,
    propertyType: buyer.propertyTypes?.[0] || null,
    bedrooms: beds,
    budgetAed: buyer.budgetAed ?? null,
    cashAvailableAed: buyer.cashAvailableAed ?? null,
    paymentPlanRequired: buyer.financing === "payment_plan"
  };
}
