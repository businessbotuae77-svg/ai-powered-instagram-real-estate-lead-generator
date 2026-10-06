const same = (a, b) => Boolean(a && b && String(a).trim().toLowerCase() === String(b).trim().toLowerCase());
const numeric = value => typeof value === "number" && Number.isFinite(value);

function provenance(project, field, value = project[field]) {
  return { projectId: project.id, sourceRecordId: project.id, source: project.source,
    verifiedOn: project.lastVerified, scope: "project_knowledge", field, value };
}

function known(project, now) {
  const verified = Date.parse(project.lastVerified || "");
  return Boolean(project.id && project.active !== false && project.approved !== false && project.source &&
    Number.isFinite(verified) && verified <= now);
}

/** Relationships describe documented positioning, never availability or proximity by name. */
export function buildProjectRelations(projects = [], { units = [], intelligence = {}, factPacks = [], now = Date.now() } = {}) {
  const nodes = projects.filter(project => known(project, now));
  const edges = [];
  const add = (from, to, relationship, evidence, extra = {}) => {
    if (!edges.some(edge => edge.from === from.id && edge.to === to.id && edge.relationship === relationship)) {
      edges.push({ from: from.id, to: to.id, relationship, evidence, ...extra });
    }
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
      const aUnits = units.filter(unit => unit.projectId === a.id && unit.active !== false);
      const bUnits = units.filter(unit => unit.projectId === b.id && unit.active !== false);
      const pair = aUnits.flatMap(unit => bUnits.filter(other => same(unit.propertyType, other.propertyType) &&
        numeric(unit.bedrooms) && unit.bedrooms === other.bedrooms).map(other => [unit, other]))[0];
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
      const aPack = factPacks.find(pack => pack.projectId === a.id && pack.startingPriceAed?.confirmed);
      const bPack = factPacks.find(pack => pack.projectId === b.id && pack.startingPriceAed?.confirmed);
      const priceA = aPack?.startingPriceAed.value, priceB = bPack?.startingPriceAed.value;
      const backed = pack => (pack?.startingPriceAed?.source || pack?.source?.value) &&
        (pack?.startingPriceAed?.verifiedAt || pack?.lastVerified?.value);
      if (backed(aPack) && backed(bPack) && numeric(priceA) && numeric(priceB) && priceA > 0 && priceB > 0 && Math.abs(priceA - priceB) / Math.min(priceA, priceB) <= 0.1) {
        bidirectional(a, b, "same_price_band", [aPack, bPack].map(pack => ({
          ...(pack.startingPriceAed.provenance || {}), sourceRecordId: pack.startingPriceAed.recordId || pack.unitId, projectId: pack.projectId,
          unitId: pack.unitId, field: "startingPriceAed", value: pack.startingPriceAed.value,
          source: pack.startingPriceAed.source || pack.startingPriceAed.provenance?.source || pack.source?.value,
          verifiedOn: pack.startingPriceAed.verifiedAt || pack.startingPriceAed.provenance?.verifiedOn || pack.lastVerified?.value,
          scope: pack.startingPriceAed.scope || "unit_type_starting_price"
        })), { basis: "documented_starting_prices_within_10_percent_not_comparable_valuation" });
      }
    }
  }
  // Geographic/competitive edges require an explicit evidence record. Same
  // area and similar project names never create a nearby edge.
  const allowed = new Set(["nearby", "direct_competitor"]);
  for (const relation of intelligence.projectRelations || []) {
    const verified = Date.parse(relation.verifiedOn || "");
    if (!allowed.has(relation.relationship) || relation.usable !== true || !relation.source ||
      !relation.sourceRecordId || !Number.isFinite(verified) || verified > now) continue;
    const a = nodes.find(node => node.id === relation.from), b = nodes.find(node => node.id === relation.to);
    if (a && b && a !== b) bidirectional(a, b, relation.relationship, [{ source: relation.source,
      sourceRecordId: relation.sourceRecordId, scope: relation.scope || "project_relationship",
      verifiedOn: relation.verifiedOn, field: "relationship", value: relation.relationship }]);
  }
  return { nodes: nodes.map(project => ({ projectId: project.id })), edges };
}

export function relationsBetween(graph, projectAId, projectBId) {
  return (graph?.edges || []).filter(edge => edge.from === projectAId && edge.to === projectBId);
}
