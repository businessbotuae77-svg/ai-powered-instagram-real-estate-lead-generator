import { comparisonEvidence, sourcedCandidatePrice } from "./comparison-evidence.js";

const same = (a, b) => Boolean(a && b && String(a).trim().toLowerCase() === String(b).trim().toLowerCase());
const numeric = value => typeof value === "number" && Number.isFinite(value);

export const RESEARCH_RELATIONSHIPS = new Set(["same_masterplan", "same_area", "nearby", "direct_competitor",
  "earlier_phase", "later_phase", "similar_price_band", "similar_product", "ready_alternative", "off_plan_alternative"]);
export const CROSS_SELL_RELATIONSHIPS = new Set(["similar_product", "similar_price_band", "off_plan_alternative",
  "ready_alternative", "same_area", "same_masterplan"]);

function provenance(project, field, value = project[field]) {
  return { projectId: project.id, sourceRecordId: project.id, source: project.source,
    verifiedOn: project.lastVerified, scope: "project_knowledge", confidence: "UNKNOWN", evidenceClass: "FACT", field, value };
}

function known(project, now) {
  const verified = Date.parse(project.lastVerified || "");
  return Boolean(project.id && project.active !== false && project.approved !== false && project.source &&
    Number.isFinite(verified) && verified <= now);
}

/** Relationships describe documented positioning, never availability or proximity by name. */
export function buildProjectRelations(projects = [], { units = [], intelligence = {}, factPacks = [], now = Date.now() } = {}) {
  const nodes = [...new Map(projects.filter(project => known(project, now)).map(project => [project.id, project])).values()];
  const edges = [];
  // Every pair of projects is visited, so lookups are indexed: a linear search
  // over all edges for each pair took seconds per buyer message with ~100 projects.
  const edgeIndex = new Map();
  const add = (from, to, relationship, evidence, extra = {}) => {
    const key = `${from.id}\u0000${to.id}\u0000${relationship}`;
    const existing = edgeIndex.get(key);
    if (existing) {
      existing.evidence.push(...evidence.filter(row => !existing.evidence.some(prior => prior.sourceRecordId === row.sourceRecordId && prior.field === row.field)));
      Object.assign(existing, extra);
    } else {
      const edge = { from: from.id, to: to.id, relationship, evidence, ...extra };
      edges.push(edge);
      edgeIndex.set(key, edge);
    }
  };
  const activeUnits = new Map();
  for (const unit of units) {
    if (unit.active === false) continue;
    if (!activeUnits.has(unit.projectId)) activeUnits.set(unit.projectId, []);
    activeUnits.get(unit.projectId).push(unit);
  }
  const unitsById = new Map(units.map(unit => [unit.id, unit]).reverse());
  const prices = new Map();
  const pricesFor = project => {
    if (!prices.has(project.id)) prices.set(project.id, factPacks.filter(pack => pack.projectId === project.id).map(pack =>
      sourcedCandidatePrice({ project, factPack: pack, unit: unitsById.get(pack.unitId) }, { now })).filter(Boolean));
    return prices.get(project.id);
  };
  const bidirectional = (a, b, relationship, evidence, extra) => {
    add(a, b, relationship, evidence, extra); add(b, a, relationship, evidence, extra);
  };
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      if (same(a.area, b.area) && same(a.emirate, b.emirate)) {
        bidirectional(a, b, "same_area", [provenance(a, "area"), provenance(b, "area")]);
      }
      if (same(a.masterplanId, b.masterplanId) || same(a.masterplan, b.masterplan)) {
        const field = a.masterplanId && b.masterplanId ? "masterplanId" : "masterplan";
        bidirectional(a, b, "same_masterplan", [provenance(a, field), provenance(b, field)]);
        if (numeric(a.phaseSequence) && numeric(b.phaseSequence) && a.phaseSequence !== b.phaseSequence) {
          const earlier = a.phaseSequence < b.phaseSequence ? a : b;
          const later = earlier === a ? b : a;
          const evidence = [provenance(earlier, "phaseSequence"), provenance(later, "phaseSequence")];
          add(earlier, later, "later_phase", evidence); add(later, earlier, "earlier_phase", evidence);
        }
      }
      if (same(a.developerId, b.developerId) || same(a.developerName, b.developerName)) {
        const field = a.developerId && b.developerId ? "developerId" : "developerName";
        bidirectional(a, b, "same_developer", [provenance(a, field), provenance(b, field)]);
      }
      const aUnits = activeUnits.get(a.id) || [];
      const bUnits = activeUnits.get(b.id) || [];
      const pair = firstPair(aUnits, bUnits, (unit, other) => same(unit.propertyType, other.propertyType) &&
        numeric(unit.bedrooms) && unit.bedrooms === other.bedrooms);
      if (pair) {
        const evidence = pair.map((unit, index) => ({ ...provenance(index ? b : a, "product"),
          sourceRecordId: unit.id, unitId: unit.id, field: "propertyType_and_bedrooms", scope: "unit_type_knowledge",
          value: { propertyType: unit.propertyType, bedrooms: unit.bedrooms } }));
        bidirectional(a, b, "similar_product", evidence);
        const ready = /^ready$/i.test(a.status || "") ? a : /^ready$/i.test(b.status || "") ? b : null;
        const offPlan = /^off-plan$/i.test(a.status || "") ? a : /^off-plan$/i.test(b.status || "") ? b : null;
        if (ready && offPlan && ready !== offPlan) {
          const evidenceWithStatus = [...evidence, provenance(ready, "status"), provenance(offPlan, "status")];
          add(offPlan, ready, "ready_alternative", evidenceWithStatus);
          add(ready, offPlan, "off_plan_alternative", evidenceWithStatus);
        }
      }
      const pricePair = firstPair(pricesFor(a), pricesFor(b), (left, right) =>
        Math.abs(left.value - right.value) / Math.min(left.value, right.value) <= 0.1);
      if (pricePair) {
        bidirectional(a, b, "similar_price_band", pricePair.map(row => row.evidence),
          { basis: "documented_starting_prices_within_10_percent_not_comparable_valuation" });
      }
    }
  }
  // Geographic/competitive edges require an explicit evidence record. Same
  // area and similar project names never create a nearby edge.
  for (const relation of intelligence.projectRelations || []) {
    const relationship = String(relation.relationship || "").toLowerCase();
    const evidence = comparisonEvidence({ ...relation, scope: relation.scope || "project_relationship",
      field: "relationship", value: relationship }, { now });
    if (!RESEARCH_RELATIONSHIPS.has(relationship) || relation.usable !== true || !evidence) continue;
    const a = nodes.find(node => node.id === relation.from), b = nodes.find(node => node.id === relation.to);
    if (!a || !b || a === b) continue;
    const context = { reason: relation.reason || null, locationContext: relation.locationContext || null,
      comparableProduct: relation.comparableProduct ?? null, comparableBuyer: relation.comparableBuyer ?? null,
      basis: "documented_relationship_candidate_only" };
    add(a, b, relationship, [evidence], context);
    const inverse = { earlier_phase: "later_phase", later_phase: "earlier_phase", ready_alternative: "off_plan_alternative", off_plan_alternative: "ready_alternative" }[relationship] || relationship;
    // Ready/off-plan describe the target; an inverse requires documented status.
    if (!["ready_alternative", "off_plan_alternative"].includes(relationship) ||
      (relationship === "ready_alternative" && /^off-plan$/i.test(a.status || "")) ||
      (relationship === "off_plan_alternative" && /^ready$/i.test(a.status || ""))) add(b, a, inverse, [evidence], context);
  }
  return { nodes: nodes.map(project => ({ projectId: project.id })), edges };
}

// The first [left, right] pair in list order that satisfies the test, or undefined.
function firstPair(lefts, rights, test) {
  for (const left of lefts) for (const right of rights) if (test(left, right)) return [left, right];
  return undefined;
}

export function relationsBetween(graph, projectAId, projectBId) {
  return (graph?.edges || []).filter(edge => edge.from === projectAId && edge.to === projectBId);
}

export function crossSellCandidateIds(graph, projectId) {
  return new Set((graph?.edges || []).filter(edge => edge.from === projectId && CROSS_SELL_RELATIONSHIPS.has(edge.relationship)).map(edge => edge.to));
}
