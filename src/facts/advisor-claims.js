// Only server-created evidence can enter the composition claim allowlist.
export function thesisClaims(theses = []) {
  const claims = new Map();
  for (const thesis of theses) {
    const sections = [thesis.entryCase, thesis.areaCase, thesis.projectCase, thesis.paymentCase, thesis.supplyCase, thesis.liquidityCase];
    for (const section of sections) {
      for (const row of section?.evidence || []) {
        const recordId = row.sourceRecordId || row.recordId;
        const verifiedAt = row.verifiedOn || row.verifiedAt;
        if (!row.source || !recordId || !row.scope || !verifiedAt || row.value == null || typeof row.value === "object") continue;
        const field = row.field === "priceAed" ? "observedPriceAed" : row.field;
        const evidenceId = `${recordId}:${field}:${JSON.stringify(row.scope)}`;
        claims.set(evidenceId, { evidenceId, projectId: row.projectId || thesis.projectId, unitId: row.unitId || null,
          field, value: row.value, source: row.source, recordId, scope: row.scope, verifiedAt });
      }
      for (const item of section?.catalysts || []) {
        const row = item.evidence;
        if (!row?.source || !row.sourceRecordId || !row.scope || !row.verifiedOn || typeof row.value !== "string") continue;
        const evidenceId = `${row.sourceRecordId}:catalyst:${row.value}`;
        claims.set(evidenceId, { evidenceId, projectId: thesis.projectId, unitId: null, field: "catalyst", value: row.value,
          source: row.source, recordId: row.sourceRecordId, scope: row.scope, verifiedAt: row.verifiedOn });
      }
    }
  }
  return [...claims.values()];
}
