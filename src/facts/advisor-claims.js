// Only application-created evidence can enter the composition claim allowlist.
export function confirmedEvidenceClass(row) {
  return !row?.evidenceClass || ["FACT", "CALCULATION"].includes(row.evidenceClass);
}

export function thesisClaims(theses = [], { now = Date.now() } = {}) {
  const claims = new Map();
  const add = (row, thesis, fieldOverride = null) => {
    if (!row || row.usable === false || !confirmedEvidenceClass(row)) return;
    const recordId = row.sourceRecordId || row.recordId;
    const verifiedAt = row.verifiedOn || row.verifiedAt || row.checkedOn;
    const checked = Date.parse(verifiedAt || "");
    if (!row.source || !recordId || !row.scope || !Number.isFinite(checked) || checked > now ||
        row.value == null || row.value === "UNKNOWN" || typeof row.value === "object") return;
    const field = fieldOverride || (row.field === "priceAed" ? "observedPriceAed" : row.field);
    if (!field) return;
    const evidenceClass = row.evidenceClass || "FACT";
    const evidenceId = `${recordId}:${field}:${JSON.stringify(row.scope)}:${JSON.stringify(row.value)}`;
    claims.set(evidenceId, {
      evidenceId, projectId: row.projectId || thesis.projectId, unitId: row.unitId || null,
      field, value: row.value, source: row.source, recordId, sourceRecordId: recordId,
      scope: row.scope, verifiedAt, verifiedOn: verifiedAt,
      confidence: row.confidence || "Unrated", evidenceClass,
      dimension: row.dimension || null, caveat: row.caveat || null,
      calculationInputs: row.calculationInputs || null, inputEvidence: row.inputEvidence || null,
      sourceConfidence: row.sourceConfidence || null,
      researchOnly: row.researchOnly === true || row.commercialQuote === false || row.purchasePriceExample === true ||
        field === "investmentEvidence" || ["observedPriceAed", "historicalPriceAed", "launchPriceAed"].includes(field),
      commercialQuote: row.commercialQuote ?? null, purchasePriceExample: row.purchasePriceExample === true
    });
  };
  for (const thesis of theses) {
    const sections = [thesis.entryCase, thesis.areaCase, thesis.projectCase, thesis.paymentCase,
      thesis.supplyCase, thesis.liquidityCase, thesis.exitCase, thesis.rentalCase];
    for (const section of sections) {
      for (const row of section?.evidence || []) add(row, thesis);
      for (const item of section?.catalysts || []) add(item.evidence, thesis, "catalyst");
    }
    for (const row of thesis.evidenceRegistry || []) add(row, thesis);
    for (const reason of thesis.riskCase || []) for (const row of reason.evidence || []) add(row, thesis);
  }
  return [...claims.values()];
}
