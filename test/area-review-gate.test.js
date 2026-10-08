import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAreaIntelligence } from "../src/facts/intelligence.js";

const now = Date.parse("2026-10-08T06:00:00Z");
const source = "https://example.test/area";
const item = { description: "Documented park", source, verifiedOn: "2026-10-06", approved: true };
function record(approval) {
  return { id: "test-area", fields: { Name: "Test Island", "Source URL": source,
    "Checked on": "2026-10-06", Confidence: "High", Summary: "Area summary", Masterplan: "Masterplan",
    Catalysts: JSON.stringify([item]), Risks: JSON.stringify([item]),
    "Competing supply": JSON.stringify([{ ...item, projectId: "test-project" }]), ...approval } };
}

test("explicit pending or negative area approval overrides a checked Verified flag", () => {
  for (const name of ["Needs review", "Draft", "Rejected", "Unverified"]) {
    const area = normalizeAreaIntelligence(record({ Verified: true, Approval: { name } }), { now });
    assert.equal(area.usable, false, name);
    assert.ok(area.rejectionReasons.includes("not_verified"));
    assert.equal(area.summary, null);
    assert.equal(area.masterplan, null);
    assert.deepEqual([area.catalysts, area.risks, area.supply], [[], [], []]);
  }
});

test("area authority supports legacy single gates and consistent approved gates", () => {
  for (const fields of [{ Verified: true }, { Approval: "Approved" }, { Verified: true, Approval: "Approved" }]) {
    const area = normalizeAreaIntelligence(record(fields), { now });
    assert.equal(area.usable, true);
    assert.equal(area.catalysts.length, 1);
  }
  for (const fields of [{}, { Verified: false, Approval: "Approved" }, { Verified: true, Approval: "" }]) {
    assert.equal(normalizeAreaIntelligence(record(fields), { now }).usable, false);
  }
});
