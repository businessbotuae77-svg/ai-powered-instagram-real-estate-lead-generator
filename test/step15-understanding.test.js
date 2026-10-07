import assert from "node:assert/strict";
import test from "node:test";
import { setupConversation } from "./helpers.js";
import { understandMessageLocally, mergeUnderstanding } from "../src/conversation/understand.js";
import { extractFactsFromMessage } from "../src/conversation/extract.js";
import { polishReplyWithModel } from "../src/conversation/llm.js";

test("step 15a uncertainty closes the asked use-type slot and advances with an explanation", async () => {
  const { engine } = await setupConversation();
  await engine.handleMessage("ig_m2_u1", "Hi");
  const unsure = await engine.handleMessage("ig_m2_u1", "Not sure");
  assert.equal(unsure.stage, "exploring");
  assert.match(unsure.reply, /No problem.*explain|entry price/i);
  assert.doesNotMatch(unsure.reply, /^What budget are you working with\?$/m);
  assert.equal(unsure.buyer.preferenceStates.useType, "flexible");
  assert.equal(unsure.nextQuestion, null);
  assert.doesNotMatch(unsure.reply, /buying.*investing.*exploring\?/i);
  assert.ok(unsure.unsure?.includes("budget") || unsure.intents.includes("unsure"));
});

test("step 15b around 2M remembers budget and opens a useful priorities conversation", async () => {
  const { engine } = await setupConversation();
  const result = await engine.handleMessage("ig_m2_u2", "around 2M");
  assert.equal(result.buyer.budgetAed, 2_000_000);
  assert.match(result.reply, /what should i optimise for/i);
  assert.equal(result.nextQuestion?.field, "investmentObjective");
  assert.ok(result.nextQuestion.choices.some(choice => choice.id === "you_choose" && choice.value === "UNDECIDED"));
  assert.doesNotMatch(result.reply, /What budget|Which area/i);
});

test("step 15c maybe Yas but open to other areas", async () => {
  const { engine } = await setupConversation();
  await engine.handleMessage("ig_m2_u3", "around 2M");
  const result = await engine.handleMessage(
    "ig_m2_u3",
    "maybe Yas but open to other areas"
  );
  assert.ok(result.buyer.preferredAreas?.some((a) => /Yas/i.test(a)));
  assert.ok(
    result.buyer.openToOtherAreas ||
      result.buyer.intentSignals?.includes("area_flexible") ||
      result.signals?.includes("area_flexible")
  );
  assert.ok(result.matchCount >= 1);
});

test("step 15d actually make that 2 bedrooms replaces prior size", async () => {
  const { engine } = await setupConversation();
  await engine.handleMessage("ig_m2_u4", "Budget AED 3M, Yas, 3 bedroom");
  const result = await engine.handleMessage("ig_m2_u4", "actually make that 2 bedrooms");
  assert.deepEqual(result.buyer.bedrooms, [2]);
});

test("step 15e put down about 300k stores cash", async () => {
  const { engine } = await setupConversation();
  await engine.handleMessage("ig_m2_u5", "AED 3M Yas");
  const result = await engine.handleMessage("ig_m2_u5", "I can put down about 300k");
  assert.equal(result.buyer.cashAvailableAed, 300_000);
});

test("step 15f local understand merges with regex extract", () => {
  const base = extractFactsFromMessage("actually make that 2 bedrooms");
  const local = understandMessageLocally("not sure", { lastAskedField: "budgetAed" });
  assert.ok(local.unsure.includes("budget"));
  const merged = mergeUnderstanding(base, local);
  assert.ok(merged.intents.includes("unsure"));
  assert.equal(merged.facts.bedrooms, 2);
});

test("step 15g unknown area advances to investment objectives without losing budget or cash", async () => {
  const { engine } = await setupConversation();
  await engine.handleMessage("ig_m2_u7", "2M");
  await engine.handleMessage("ig_m2_u7", "But I have like 300k for down payment");
  const result = await engine.handleMessage("ig_m2_u7", "I don't know the area. I want the best ROI");

  assert.equal(result.buyer.budgetAed, 2_000_000);
  assert.equal(result.buyer.cashAvailableAed, 300_000);
  assert.ok(
    result.buyer.openToOtherAreas ||
      result.buyer.intentSignals?.includes("area_flexible")
  );
  assert.doesNotMatch(result.reply, /Which area are you leaning toward/i);
  assert.doesNotMatch(result.reply, /Any area you want to start with/i);
  assert.equal(result.buyer.useType, "investment");
  assert.match(result.reply, /rental income|growth/i);
  assert.equal(result.nextQuestion?.field, "exitHorizon");
  assert.doesNotMatch(result.reply, /What budget|approved evidence/i);
  const growth = await engine.handleMessage("ig_m2_u7", "Growth");
  assert.equal(growth.buyer.investmentObjective, "growth");
  assert.equal(growth.buyer.budgetAed, 2_000_000);
  assert.equal(growth.buyer.cashAvailableAed, 300_000);
  assert.notEqual(growth.nextQuestion?.field, "budgetAed");
  assert.notEqual(growth.nextQuestion?.field, "preferredAreas");
});

test("step 15h local typo I dknt know maps to the last asked field", () => {
  const local = understandMessageLocally("I dknt know", {
    lastAskedField: "preferredAreas"
  });
  assert.ok(local.unsure.includes("area"));
  assert.equal(local.facts.openToOtherAreas, true);
  assert.ok(local.signals.includes("area_flexible"));
});

test("step 15i Claude composes one paraphrased code-owned question without appending", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    async json() {
      return { content: [{ type: "text", text: JSON.stringify({
        message: "Your AED 2M budget gives us a useful starting point. Which area would you prefer?",
        askedQuestion: true, questionField: "preferredAreas", claims: [], proposedActions: []
      }) }] };
    }
  });
  try {
    const question = "Which area are you leaning toward?";
    const reply = await polishReplyWithModel(
      { apiKey: "test", model: "claude-sonnet-5", baseUrl: "https://example.test" },
      {
        buyer: {
          budgetAed: 2_000_000,
          cashAvailableAed: null,
          preferredAreas: [],
          bedrooms: [],
          financing: "unknown"
        },
        packs: [],
        draftText: `Got it, your budget is around AED 2,000,000.\n\n${question}`,
        intents: ["provide_facts"],
        requiredQuestion: question
      }
    );
    assert.match(reply, /useful starting point/);
    assert.ok(reply.endsWith("Which area would you prefer?"));
    assert.equal((reply.match(/\?/g) || []).length, 1);
    assert.doesNotMatch(reply, /Which area are you leaning toward/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("step 15j natural unknown-area sentence keeps the search flexible", async () => {
  const { engine } = await setupConversation();
  const result = await engine.handleMessage(
    "ig_m2_u10",
    "Hi, I'm looking for a place in Abu Dhabi but I honestly don't know which area would suit me."
  );

  assert.equal(result.buyer.openToOtherAreas, true);
  assert.doesNotMatch(result.reply, /Which area are you leaning toward/i);
  assert.match(result.reply, /budget/i);
});

test("step 15k budget and full-number down payment do not become bedrooms", async () => {
  const { engine } = await setupConversation();
  await engine.handleMessage(
    "ig_m2_u11",
    "Hi, I'm looking for a place in Abu Dhabi but I honestly don't know which area would suit me."
  );
  const result = await engine.handleMessage(
    "ig_m2_u11",
    "My budget is around AED 2 million, and I have roughly AED 300,000 ready for the down payment."
  );

  assert.equal(result.buyer.budgetAed, 2_000_000);
  assert.equal(result.buyer.cashAvailableAed, 300_000);
  assert.deepEqual(result.buyer.bedrooms, []);
  assert.doesNotMatch(result.reply, /Which area are you leaning toward/i);
});

test("step 15l not an investment is remembered as end use", async () => {
  const { engine } = await setupConversation();
  const result = await engine.handleMessage(
    "ig_m2_u12",
    "I'd prefer a two bedroom apartment. It's for me to live in, not an investment."
  );

  assert.deepEqual(result.buyer.bedrooms, [2]);
  assert.deepEqual(result.buyer.propertyTypes, ["apartment"]);
  assert.equal(result.buyer.useType, "end_use");
});

test("step 15m amount-only reply to a genuine pending cash question does not overwrite budget", async () => {
  const { engine, memory } = await setupConversation();
  await engine.handleMessage("ig_m2_u13", "Budget AED 3M, Yas, studio");
  // Ordinary recommendations now use a payment-details next step. Simulate the
  // separate cash question only where that information was actually requested.
  memory.setLastAskedField("ig_m2_u13", "cashAvailableAed");
  const result = await engine.handleMessage("ig_m2_u13", "AED 85,000");

  assert.equal(result.buyer.budgetAed, 3_000_000);
  assert.equal(result.buyer.cashAvailableAed, 85_000);
  assert.doesNotMatch(result.reply, /How much cash can you put in/i);
  assert.notEqual(result.nextQuestion?.field, "cashAvailableAed");
});
