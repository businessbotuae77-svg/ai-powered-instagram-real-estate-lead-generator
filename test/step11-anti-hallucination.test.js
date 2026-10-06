import assert from "node:assert/strict";
import test from "node:test";
import { setupConversation } from "./helpers.js";
import { validateMessage } from "../src/facts/checker.js";
import { buildConversationReply } from "../src/conversation/replies.js";

test("step 11a matched reply passes fact check", async () => {
  const { engine } = await setupConversation();
  const result = await engine.handleMessage(
    "ig_m2_fc1",
    "AED 3M budget, Yas, 3 bedroom, 500k cash, payment plan"
  );
  assert.ok(result.matchCount >= 1 && result.matchCount <= 2);
  assert.equal(result.matches[0].project.name, "Yas Park Views");
  if (result.advisor.challenger) assert.ok(result.advisor.challenger.reasonCodes.length);
  assert.ok(result.check.ok);
  assert.equal(result.check.violations.length, 0);
  assert.match(result.reply, /2,600,000|2600000/);
  assert.doesNotMatch(result.reply, /2,100,000/);
});

test("step 11b invented commercial claim is blocked by checker", async () => {
  const { engine } = await setupConversation();
  const result = await engine.handleMessage(
    "ig_m2_fc2",
    "AED 3M budget, Yas, 3 bedroom, 500k cash, payment plan"
  );
  const bad = "Yas Park Views starts at AED 2,100,000 and is sold out.";
  const check = validateMessage(bad, result.packs);
  assert.equal(check.ok, false);
  assert.ok(check.violations.length >= 1);
});

test("step 11c missing price project stays not confirmed", async () => {
  const { engine } = await setupConversation();
  const result = await engine.handleMessage(
    "ig_m2_fc3",
    "Budget 5M, Yas Waterfront Residences, 2 bedroom"
  );
  // May or may not match depending on filters; if packs exist, unconfirmed price wording must not invent amounts
  if (result.packs.length) {
    for (const pack of result.packs) {
      if (pack.name.value === "Yas Waterfront Residences") {
        assert.equal(pack.startingPriceAed.confirmed, false);
      }
    }
    assert.ok(result.check.ok);
    assert.doesNotMatch(result.reply, /AED\s*1,\d{3},\d{3}/);
  }
});

test("step 11d high intent offers follow-up channel without inventing numbers", async () => {
  const { engine } = await setupConversation();
  await engine.handleMessage(
    "ig_m2_fc4",
    "AED 3M, Yas, 3BR, 500k cash, payment plan"
  );
  const result = await engine.handleMessage("ig_m2_fc4", "I want to reserve this");
  assert.ok(result.signals.includes("reserve_interest") || result.intents.includes("request_call"));
  assert.equal(result.buyer.leadStatus, "engaged");
  assert.equal(result.alertRecommended, false);
  assert.equal(result.pendingOffer?.type, "contact_channel");
  assert.ok(result.check.ok);
  assert.match(result.reply, /Instagram or on WhatsApp/i);
  assert.doesNotMatch(result.reply, /AED\s*1,\d{3},\d{3}/);
});

test("step 11e reply builder never marks missing data as handoff", () => {
  const draft = buildConversationReply({
    buyer: {
      budgetAed: 3_000_000,
      preferredAreas: ["Yas Island"],
      bedrooms: [3],
      propertyTypes: [],
      financing: "payment_plan",
      intentSignals: []
    },
    packs: [],
    matchCount: 0,
    intents: ["search"]
  });
  assert.equal(draft.handoffRequired, false);
});
