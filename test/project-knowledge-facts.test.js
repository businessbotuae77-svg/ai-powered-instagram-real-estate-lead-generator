import assert from "node:assert/strict";
import test from "node:test";
import { buildProjectKnowledgePack } from "../src/facts/retrieval.js";
import { factPolicy } from "../src/facts/freshness.js";
import { validateMessage } from "../src/facts/checker.js";
import { answerFactQuestion } from "../src/conversation/fact-answers.js";

function project(overrides = {}) {
  return { id: "documented-project", name: "Documented Project", area: "Yas Island", active: true,
    approved: true, status: "Off-plan", handover: "Q3 2028", source: "https://developer.example/project",
    lastVerified: new Date(Date.now() - 3600000).toISOString(),
    startingPriceAed: 4_444_444, initialPaymentAed: 444_444, paymentPlanAvailable: true,
    paymentPlanSummary: "10/90", availability: "Available", ...overrides };
}

test("a fresh project handover is answerable without a priced unit and keeps its own provenance", () => {
  const input = project();
  const pack = buildProjectKnowledgePack(input);
  assert.equal(pack.unitId, null);
  assert.equal(pack.knowledgeOnly, true);
  assert.equal(pack.handover.confirmed, true);
  assert.equal(pack.handover.value, "Q3 2028");
  assert.equal(pack.handover.scope, "project_handover");
  assert.equal(pack.handover.source, input.source);
  assert.equal(pack.handover.recordId, input.id);
  assert.equal(pack.handover.verifiedAt, input.lastVerified);
  const answer = answerFactQuestion("handover", [pack]);
  assert.match(answer.text, /hands over in Q3 2028/);
  assert.equal(validateMessage(answer.text, [pack]).ok, true);
  assert.doesNotMatch(answer.text, /AED|available|ready|near|close/i);

  for (const key of ["startingPriceAed", "startingPriceText", "downPaymentAed", "downPaymentText",
    "paymentPlanAvailable", "paymentPlanSummary", "availability", "availabilityNotes"]) {
    assert.equal(pack[key].confirmed, false, key);
    assert.equal(pack[key].value, null, key);
  }
  for (const unsupported of ["Documented Project starts from AED 4,444,444.",
    "Documented Project has a 10/90 payment plan.", "Documented Project is available now."]) {
    assert.equal(validateMessage(unsupported, [pack]).ok, false, unsupported);
  }
});

test("a stale, future, unapproved or incomplete project cannot confirm a handover", () => {
  const stale = new Date(Date.now() - (factPolicy().commercialDays + 1) * 86400000).toISOString();
  for (const overrides of [{ lastVerified: stale }, { lastVerified: new Date(Date.now() + 86400000).toISOString() },
    { lastVerified: null }, { source: null }, { active: false }, { approved: false }, { handover: null }]) {
    const pack = buildProjectKnowledgePack(project(overrides));
    assert.equal(pack.handover.confirmed, false, JSON.stringify(overrides));
    assert.equal(pack.handover.value, null);
    assert.doesNotMatch(answerFactQuestion("handover", [pack]).text, /Q3 2028/);
    assert.equal(validateMessage("Documented Project hands over in Q3 2028.", [pack]).ok, false);
  }
});
