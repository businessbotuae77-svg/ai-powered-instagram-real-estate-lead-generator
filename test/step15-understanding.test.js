import assert from "node:assert/strict";
import test from "node:test";
import { setupConversation } from "./helpers.js";
import { understandMessageLocally, mergeUnderstanding } from "../src/conversation/understand.js";
import { extractFactsFromMessage } from "../src/conversation/extract.js";
import { polishReplyWithModel } from "../src/conversation/llm.js";

test("step 15a unsure buyer explores priorities without a budget form", async () => {
  const { engine } = await setupConversation();
  await engine.handleMessage("ig_m2_u1", "Hi");
  const unsure = await engine.handleMessage("ig_m2_u1", "Not sure");
  assert.equal(unsure.stage, "exploring");
  assert.match(unsure.reply, /range|No problem/i);
  assert.doesNotMatch(unsure.reply, /^What budget are you working with\?$/m);
  assert.equal(unsure.nextQuestion?.field, "useType");
  assert.ok(unsure.unsure?.includes("budget") || unsure.intents.includes("unsure"));
});

test("step 15b around 2M sets budget", async () => {
  const { engine } = await setupConversation();
  const result = await engine.handleMessage("ig_m2_u2", "around 2M");
  assert.equal(result.buyer.budgetAed, 2_000_000);
  assert.match(result.reply, /area|Yas|budget|doors|look/i);
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

test("step 15g unknown area becomes flexible and does not loop", async () => {
  const { engine } = await setupConversation();
  await engine.handleMessage("ig_m2_u7", "2M");
  await engine.handleMessage("ig_m2_u7", "But I have like 300k for down payment");
  const result = await engine.handleMessage("ig_m2_u7", "I dknt know");

  assert.equal(result.buyer.budgetAed, 2_000_000);
  assert.equal(result.buyer.cashAvailableAed, 300_000);
  assert.ok(
    result.buyer.openToOtherAreas ||
      result.buyer.intentSignals?.includes("area_flexible")
  );
  assert.doesNotMatch(result.reply, /Which area are you leaning toward/i);
  assert.doesNotMatch(result.reply, /Any area you want to start with/i);
  assert.match(result.reply, /size|studio|bedroom|property type/i);
  assert.equal(result.nextQuestion?.field, "propertyTypes");
});

test("step 15h local typo I dknt know maps to the last asked field", () => {
  const local = understandMessageLocally("I dknt know", {
    lastAskedField: "preferredAreas"
  });
  assert.ok(local.unsure.includes("area"));
  assert.equal(local.facts.openToOtherAreas, true);
  assert.ok(local.signals.includes("area_flexible"));
});

test("step 15i Claude polish preserves the code-owned next question", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    async json() {
      return { content: [{ type: "text", text: "AED 2M gives us a useful starting point." }] };
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
    assert.ok(reply.endsWith(question));
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

test("step 15m amount-only reply answers the pending initial cash question", async () => {
  const { engine } = await setupConversation();
  await engine.handleMessage("ig_m2_u13", "Budget AED 3M, Yas, studio");
  const financing = await engine.handleMessage("ig_m2_u13", "Cash");
  const result = await engine.handleMessage("ig_m2_u13", "AED 85,000");

  assert.doesNotMatch(financing.reply, /Yas Studio One by/i);
  assert.equal(result.buyer.budgetAed, 3_000_000);
  assert.equal(result.buyer.cashAvailableAed, 85_000);
  assert.doesNotMatch(result.reply, /How much cash can you put in/i);
  assert.doesNotMatch(result.reply, /Yas Studio One by/i);
});
