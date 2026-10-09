import assert from "node:assert/strict";
import test from "node:test";
import { setupConversation } from "./helpers.js";
import { assessCandidate } from "../src/conversation/fit-assess.js";

/**
 * Fundamental advisor-fit checks.
 * Run: node --test test/step17-advisor-fit.test.js
 */

test("step 17a explicit cash ceiling and required payment plan exclude financing compromises", async () => {
  const { engine } = await setupConversation();
  const result = await engine.handleMessage(
    "ig_m2_advisor_1",
    "AED 2M, Reem, 2 bedrooms, no more than 150k down, payment plan"
  );

  assert.equal(result.fitTier, "none");
  assert.equal(result.matchCount, 0);
  assert.equal(result.buyer.cashAvailableAed, 150_000);
  assert.ok(result.advisor.assessments.some(row => row.hardConstraintFailures.includes("initial_payment_over_cash")));
  assert.doesNotMatch(result.reply, /strong fit|perfect match/i);
  assert.ok(result.check.ok);
});

test("step 17b Reem Gate is exact when financing is not constrained", async () => {
  const { engine } = await setupConversation();
  const result = await engine.handleMessage(
    "ig_m2_advisor_2",
    "I want a 2 bedroom in Reem around AED 2M"
  );

  assert.equal(result.fitTier, "exact");
  assert.equal(result.matches[0].project.name, "Reem Gate");
  assert.match(result.reply, /prefer Reem Gate.*2 bedroom apartment on Al Reem Island in the area you want/is);
  assert.doesNotMatch(result.reply, /compromise|trade-off|no exact match/i);
  assert.ok(result.check.ok);
});

test("step 17c one core gap is a nearby option, not a blanket no-match", async () => {
  const { engine } = await setupConversation();
  const result = await engine.handleMessage(
    "ig_m2_advisor_3",
    "Budget AED 2M, Yas Island, 3 bedrooms"
  );

  assert.equal(result.fitTier, "nearby");
  assert.equal(result.matchCount, 1);
  assert.equal(result.matches[0].unit.bedrooms, 2);
  assert.match(result.reply, /closest confirmed option|trade-off/i);
  assert.match(result.reply, /3 bedroom/i);
  assert.match(result.reply, /2 bedroom apartment/i);
  assert.doesNotMatch(result.reply, /studio ·|1 bedroom apartment/i);
  assert.doesNotMatch(result.reply, /I do not have an exact match/i);
  assert.ok(result.check.ok);
});

test("step 17d multiple material gaps remain a genuine no-match", async () => {
  const { engine } = await setupConversation();
  const result = await engine.handleMessage(
    "ig_m2_advisor_4",
    "Yas Park Views, AED 1M, 3 bedrooms, 50k down, payment plan"
  );

  assert.equal(result.fitTier, "none");
  assert.equal(result.matchCount, 0);
  assert.match(result.reply, /current commercial unit|option.*fits/i);
  assert.doesNotMatch(result.reply, /strong fit/i);
  assert.ok(result.check.ok);
});

test("step 17e scoring classifies financial-only gaps as strong", () => {
  const assessed = assessCandidate(
    {
      project: {
        name: "Reem Gate",
        area: "Al Reem Island",
        emirate: "Abu Dhabi",
        paymentPlanAvailable: false
      },
      unit: {
        bedrooms: 2,
        propertyType: "apartment",
        startingPriceAed: 1_600_000
      },
      downPaymentAed: 1_600_000,
      bedroomLabel: "2 bedrooms"
    },
    {
      preferredAreas: ["Al Reem Island"],
      bedrooms: [2],
      budgetAed: 2_000_000,
      cashAvailableAed: 150_000,
      financing: "payment_plan",
      propertyTypes: []
    }
  );

  assert.equal(assessed.fit.tier, "strong_with_compromise");
  assert.equal(assessed.fit.coreGapCount, 0);
  assert.equal(assessed.fit.financeGapCount, 2);
  assert.ok(assessed.fit.score >= 70);
});

test("step 17f every recommendation carries auditable fit evidence", async () => {
  const { engine } = await setupConversation();
  const result = await engine.handleMessage(
    "ig_m2_advisor_5",
    "AED 2M, Yas, 1 or 2 bedrooms, about 200k down"
  );

  assert.ok(result.matches.length >= 1);
  for (const match of result.matches) {
    assert.ok(match.fit);
    assert.ok(["exact", "strong_with_compromise", "nearby"].includes(match.fit.tier));
    assert.ok(Number.isFinite(match.fit.score));
    assert.ok(Number.isFinite(match.fit.distancePenalty));
    assert.ok(Array.isArray(match.fit.matched));
    assert.ok(Array.isArray(match.fit.compromises));
  }
});

test("step 17g cash shortfall remains a hard constraint instead of a recommendation", async () => {
  const { engine } = await setupConversation();
  const result = await engine.handleMessage(
    "ig_m2_advisor_6",
    "AED 3M, Yas, 3 bedrooms, 50k down, payment plan"
  );

  assert.equal(result.fitTier, "none");
  assert.equal(result.matchCount, 0);
  assert.equal(result.buyer.cashAvailableAed, 50_000);
  assert.ok(result.advisor.assessments.some(row => row.hardConstraintFailures.includes("initial_payment_over_cash")));
  assert.doesNotMatch(result.reply, /strong fit|260,000|800,000/i);
  assert.ok(result.check.ok);
});
