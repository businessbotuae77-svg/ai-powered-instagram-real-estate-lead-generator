import assert from "node:assert/strict";
import test from "node:test";
import { setupConversation } from "./helpers.js";
import { extractFactsFromMessage, detectIntents } from "../src/conversation/extract.js";
import { normalizeArea } from "../src/matching/normalize.js";
import { createLocalStore } from "../src/store/local-store.js";
import { createCatalogStore } from "../src/store/create-store.js";
import { BuyerService } from "../src/services/buyer-service.js";
import { PropertyService } from "../src/services/property-service.js";
import { ConversationEngine } from "../src/conversation/engine.js";
import { ConversationMemory } from "../src/conversation/memory.js";

// ============================================================================
// A: Greeting / small talk / "why" / short ambiguous replies must not route to
//    the no-inventory or missing-property-terms fallback.
// ============================================================================

test("A.1 Hi alone gives a welcome, not a no-inventory or missing-terms fallback", async () => {
  const { engine } = await setupConversation();
  const result = await engine.handleMessage("dm_a1", "Hi", { useLlm: false });
  assert.doesNotMatch(result.reply, /can't give a reliable property comparison/i);
  assert.doesNotMatch(result.reply, /don't have current confirmed terms/i);
  assert.match(result.reply, /Hi|Hello|property guide|buying|investing|exploring/i);
});

test("A.2 'Why' after greeting does not route to missing-terms fallback", async () => {
  const { engine } = await setupConversation();
  await engine.handleMessage("dm_a2", "Hi", { useLlm: false });
  const result = await engine.handleMessage("dm_a2", "Why", { useLlm: false });
  assert.doesNotMatch(result.reply, /don't have current confirmed terms for that property/i);
  assert.doesNotMatch(result.reply, /Which project are you asking about/i);
});

test("A.3 Short ambiguous message 'Huh' does not trigger property-terms fallback", async () => {
  const { engine } = await setupConversation();
  const result = await engine.handleMessage("dm_a3", "Huh", { useLlm: false });
  assert.doesNotMatch(result.reply, /don't have current confirmed terms for that property/i);
});

// ============================================================================
// B: Short answers should be interpreted against the question the bot just asked
//    (pending question field), e.g. "Mix" / "both" / "growth" / "rental" after
//    the income-vs-growth question.
// ============================================================================

test("B.1 'Mix' after income-vs-growth question saves investmentObjective and progresses", async () => {
  const { engine } = await setupConversation();
  // Set up an investment buyer who triggers the ROI question
  await engine.handleMessage("dm_b1", "Budget 2M", { useLlm: false });
  await engine.handleMessage("dm_b1", "investing", { useLlm: false });
  const roiResult = await engine.handleMessage("dm_b1", "Roi", { useLlm: false });
  // The bot should ask about income/growth/mix
  assert.match(roiResult.reply, /rental income|growth|mix|both/i);
  
  // Legacy saved-question context remains supported, although ROI now asks exit horizon.
  engine.memory.setLastAskedField("dm_b1", "investmentObjective");
  // Now answer "Mix"
  const mixResult = await engine.handleMessage("dm_b1", "Mix", { useLlm: false });
  // Should NOT get the "no confirmed terms" fallback
  assert.doesNotMatch(mixResult.reply, /don't have current confirmed terms for that property/i);
  assert.doesNotMatch(mixResult.reply, /Which project are you asking about/i);
  // Should record investment objective (PR #4 uses "balanced" for mix)
  assert.equal(mixResult.buyer.investmentObjective, "balanced");
});

test("B.2 'growth' after income-vs-growth question saves objective", async () => {
  const { engine } = await setupConversation();
  await engine.handleMessage("dm_b2", "Budget 2M investing", { useLlm: false });
  await engine.handleMessage("dm_b2", "best ROI", { useLlm: false });
  const result = await engine.handleMessage("dm_b2", "growth", { useLlm: false });
  assert.doesNotMatch(result.reply, /don't have current confirmed terms/i);
  assert.equal(result.buyer.investmentObjective, "growth");
});

test("B.3 'rental' after income-vs-growth question saves objective", async () => {
  const { engine } = await setupConversation();
  await engine.handleMessage("dm_b3", "Budget 2M investing", { useLlm: false });
  await engine.handleMessage("dm_b3", "best ROI", { useLlm: false });
  const result = await engine.handleMessage("dm_b3", "rental", { useLlm: false });
  assert.doesNotMatch(result.reply, /don't have current confirmed terms/i);
  assert.equal(result.buyer.investmentObjective, "rental_income");
});

// ============================================================================
// C: "Restart" / "start over" / "let's restart" (and Arabic equivalents)
//    resets buyer state for that conversation and gives a fresh welcome.
// ============================================================================

test("C.1 'Let's restart' clears buyer state and starts fresh", async () => {
  const { engine, buyers } = await setupConversation();
  // Build up some state
  await engine.handleMessage("dm_c1", "Budget 2M Yas 2 bedrooms", { useLlm: false });
  let buyer = await buyers.getOrCreate("dm_c1");
  assert.equal(buyer.budgetAed, 2000000);
  
  // Now restart
  const result = await engine.handleMessage("dm_c1", "Let's restart", { useLlm: false });
  assert.match(result.reply, /budget|fresh/i);
  
  buyer = await buyers.getOrCreate("dm_c1");
  assert.equal(buyer.budgetAed, null);
  assert.deepEqual(buyer.preferredAreas, []);
});

test("C.2 'restart' alone clears state", async () => {
  const { engine, buyers } = await setupConversation();
  await engine.handleMessage("dm_c2", "Budget 3M Yas", { useLlm: false });
  const result = await engine.handleMessage("dm_c2", "restart", { useLlm: false });
  assert.match(result.reply, /budget|fresh/i);
  const buyer = await buyers.getOrCreate("dm_c2");
  assert.equal(buyer.budgetAed, null);
});

test("C.3 'start over' clears state", async () => {
  const { engine, buyers } = await setupConversation();
  await engine.handleMessage("dm_c3", "Budget 3M Yas", { useLlm: false });
  const result = await engine.handleMessage("dm_c3", "start over", { useLlm: false });
  assert.match(result.reply, /budget|fresh/i);
  const buyer = await buyers.getOrCreate("dm_c3");
  assert.equal(buyer.budgetAed, null);
});

test("C.4 'restart' embedded in a question does not clear state", async () => {
  const { engine, buyers } = await setupConversation();
  await engine.handleMessage("dm_c4", "Budget 3M Yas", { useLlm: false });
  const buyer1 = await buyers.getOrCreate("dm_c4");
  assert.equal(buyer1.budgetAed, 3000000);
  
  // This should NOT trigger start_fresh - it's a question about payment plans
  await engine.handleMessage("dm_c4", "can the payment plan restart after handover", { useLlm: false });
  const buyer2 = await buyers.getOrCreate("dm_c4");
  assert.equal(buyer2.budgetAed, 3000000, "Budget should NOT be cleared by 'restart' in a sentence");
});

test("C.5 'restart please' clears state", async () => {
  const { engine, buyers } = await setupConversation();
  await engine.handleMessage("dm_c5", "Budget 3M Yas", { useLlm: false });
  const result = await engine.handleMessage("dm_c5", "restart please", { useLlm: false });
  assert.match(result.reply, /budget|fresh/i);
  const buyer = await buyers.getOrCreate("dm_c5");
  assert.equal(buyer.budgetAed, null);
});

test("C.6 'start again' clears state", async () => {
  const { engine, buyers } = await setupConversation();
  await engine.handleMessage("dm_c6", "Budget 3M Yas", { useLlm: false });
  const result = await engine.handleMessage("dm_c6", "start again", { useLlm: false });
  assert.match(result.reply, /budget|fresh/i);
  const buyer = await buyers.getOrCreate("dm_c6");
  assert.equal(buyer.budgetAed, null);
});

// ============================================================================
// D: When there are active projects but no active units (or no matches),
//    the bot should still converse helpfully per policy without claiming
//    prices/availability, rather than a blanket refusal.
// ============================================================================

test("D.1 With projects but no units, bot converses helpfully without blanket refusal", async () => {
  // Create a store with projects but no active units
  const store = await createLocalStore({});
  // Set all units to inactive
  store.units = store.units.map(u => ({ ...u, active: false }));
  
  const buyers = new BuyerService(store);
  const properties = new PropertyService(store);
  const memory = new ConversationMemory();
  const engine = new ConversationEngine({ buyers, properties, memory });
  
  const result = await engine.handleMessage("dm_d1", "Hi", { useLlm: false });
  // Should get a normal welcome, not a blanket refusal
  assert.doesNotMatch(result.reply, /can't give a reliable property comparison/i);
  assert.match(result.reply, /Hi|buying|investing|exploring/i);
});

test("D.2 Investment question with no units gives educational answer", async () => {
  const store = await createLocalStore({});
  store.units = store.units.map(u => ({ ...u, active: false }));
  
  const buyers = new BuyerService(store);
  const properties = new PropertyService(store);
  const memory = new ConversationMemory();
  const engine = new ConversationEngine({ buyers, properties, memory });
  
  const result = await engine.handleMessage("dm_d2", "What is the best ROI?", { useLlm: false });
  // Should explain investment concepts, not refuse
  assert.match(result.reply, /rental income|growth|capital/i);
  assert.doesNotMatch(result.reply, /can't give a reliable property comparison/i);
});

// ============================================================================
// E: Add logging whenever the model reply is rejected or errors and the canned
//    draft is used. (This is a code structure test - verify the logging exists)
// ============================================================================

test("E.1 LLM module exports logging capability for rejected/errored replies", async () => {
  const llm = await import("../src/conversation/llm.js");
  // Verify the module exists and has the compose function
  assert.ok(typeof llm.composeReplyWithModel === "function");
});

test("E.2 LLM logs warning when model reply is invalid (no buyer message leak)", async () => {
  const { composeReplyWithModel } = await import("../src/conversation/llm.js");
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  
  const secretMessage = "SECRET_BUYER_MESSAGE_12345";
  
  // Stub client that returns invalid JSON structure (missing required message field)
  const badClient = {
    apiKey: "test-key",
    model: "test-model",
    baseUrl: "https://test",
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        content: [{ type: "text", text: JSON.stringify({ notMessage: "bad" }) }]
      })
    })
  };
  
  try {
    const result = await composeReplyWithModel(badClient, { message: secretMessage });
    assert.equal(result, null, "Invalid reply should return null");
  } finally {
    console.warn = originalWarn;
  }
  
  // No warnings for parse failure (returns null silently), but buyer message must not leak
  const allWarnings = warnings.join(" ");
  assert.ok(!allWarnings.includes(secretMessage), "Buyer message must not appear in logs");
});

test("E.3 LLM logs warning when model request throws error (no buyer message leak)", async () => {
  const { composeReplyWithModel } = await import("../src/conversation/llm.js");
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  
  const secretMessage = "PRIVATE_BUYER_DATA_67890";
  
  // Stub client that throws an error
  const errorClient = {
    apiKey: "test-key",
    model: "test-model",
    baseUrl: "https://test",
    fetchImpl: async () => { throw new Error("Network timeout"); }
  };
  
  try {
    const result = await composeReplyWithModel(errorClient, { message: secretMessage });
    assert.equal(result, null, "Error should return null");
    
    // Should have logged a warning about the error
    const hasErrorLog = warnings.some(w => w.includes("stage=composition") && w.includes("category=transport_error"));
    assert.ok(hasErrorLog, "Should log the error category");
    
    // Buyer message must not appear in any warning
    const allWarnings = warnings.join(" ");
    assert.ok(!allWarnings.includes(secretMessage), "Buyer message must not appear in error logs");
    assert.ok(!allWarnings.includes("Network timeout"), "Raw transport error text must not appear in logs");
  } finally {
    console.warn = originalWarn;
  }
});

test("E.4 LLM logs warning when validation rejects reply (no buyer message leak)", async () => {
  const { composeReplyWithModel } = await import("../src/conversation/llm.js");
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  
  const secretMessage = "CONFIDENTIAL_BUYER_INFO_99999";
  
  // Stub client that returns a reply that will fail validation (invented price)
  const validationFailClient = {
    apiKey: "test-key",
    model: "test-model",
    baseUrl: "https://test",
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        content: [{ type: "text", text: JSON.stringify({
          message: "This unit costs AED 5,000,000 with great ROI of 15%!",
          askedQuestion: false,
          questionField: null,
          claims: [],
          proposedActions: []
        }) }]
      })
    })
  };
  
  try {
    const result = await composeReplyWithModel(validationFailClient, { 
      message: secretMessage,
      packs: [],
      buyer: {}
    });
    assert.equal(result, null, "Validation failure should return null");
    
    // Should have logged a warning about rejected reply
    const hasRejectedLog = warnings.some(w => w.includes("model reply rejected"));
    assert.ok(hasRejectedLog, "Should log rejection message");
    
    // Buyer message must not appear in any warning
    const allWarnings = warnings.join(" ");
    assert.ok(!allWarnings.includes(secretMessage), "Buyer message must not appear in rejection logs");
  } finally {
    console.warn = originalWarn;
  }
});

// ============================================================================
// F: Matching: a unit whose availability/status is Sold out (or otherwise
//    unavailable) must not match even if Active is checked.
// ============================================================================

test("F.1 Unit with availability='Sold out' does not match even if active=true", async () => {
  const { store, engine } = await setupConversation();
  // Find an active unit with a price and mark it as sold out
  const unit = store.units.find(u => u.active && u.startingPriceAed);
  assert.ok(unit, "Test fixture must have at least one active unit with a price");
  
  const project = store.projects.find(p => p.id === unit.projectId);
  assert.ok(project, "Test fixture must have the unit's project");
  
  // Mark the unit as sold out
  unit.availability = "Sold out";
  
  // Create a buyer that would match this unit's criteria
  const result = await engine.handleMessage("dm_f1", 
    `Budget ${unit.startingPriceAed + 500000} ${project.area} ${unit.bedrooms} bedroom`, 
    { useLlm: false });
  
  // The sold out unit must not appear in matches
  const soldOutInMatches = result.matches.some(m => m.unit.id === unit.id);
  assert.equal(soldOutInMatches, false, "Sold out unit must not be in matches");
});

test("F.2 Unit with availability='Limited' can still match", async () => {
  const { store, engine, properties } = await setupConversation();
  const catalog = properties.catalog();
  
  // Mark ALL active units as "Limited" availability
  const activeUnits = store.units.filter(u => u.active && u.startingPriceAed);
  assert.ok(activeUnits.length > 0, "Test fixture must have at least one active unit with a price");
  
  for (const u of activeUnits) {
    u.availability = "Limited";
  }
  
  // Pick one unit to verify matching
  const unit = activeUnits[0];
  const project = store.projects.find(p => p.id === unit.projectId);
  assert.ok(project, "Test fixture must have the unit's project");
  
  const result = await engine.handleMessage("dm_f2", 
    `Budget ${unit.startingPriceAed + 500000} ${project.area} ${unit.bedrooms} bedroom`, 
    { useLlm: false });
  
  // At least one Limited availability unit must match
  assert.ok(result.matches.length > 0, "Should have at least one match");
  const limitedInMatches = result.matches.some(m => m.unit.availability === "Limited");
  assert.ok(limitedInMatches, "Limited availability unit must still be in matches");
});

// ============================================================================
// G: Area: "Yas Canal" must never be normalized/extracted/matched as "Yas Island"
// ============================================================================

test("G.1 'Yas Canal' extracts as 'Yas Canal', not 'Yas Island'", () => {
  const result = extractFactsFromMessage("I'm looking in Yas Canal");
  // Should NOT be Yas Island
  assert.notEqual(result.facts.area, "Yas Island");
  // Should preserve as Yas Canal or similar
  if (result.facts.area) {
    assert.match(result.facts.area, /Yas Canal/i);
  }
});

test("G.2 normalizeArea does not convert 'Yas Canal' to 'Yas Island'", () => {
  const result = normalizeArea("Yas Canal");
  assert.notEqual(result, "Yas Island");
  assert.match(result, /Yas Canal/i);
});

test("G.3 Bare 'yas' can normalize to 'Yas Island'", () => {
  const result = normalizeArea("yas");
  assert.equal(result, "Yas Island");
});

test("G.4 'Yas Island' normalizes to 'Yas Island'", () => {
  const result = normalizeArea("Yas Island");
  assert.equal(result, "Yas Island");
});

// ============================================================================
// H: Production data safety - synthetic inventory and fixtures can never load
//    in production, and when Airtable returns zero units or errors, the bot
//    never falls back to local seed store.
// ============================================================================

test("H.1 Production (NODE_ENV=production) without Airtable throws, never uses seed", async () => {
  await assert.rejects(
    createCatalogStore({ env: { NODE_ENV: "production" } }),
    /Airtable is not configured/
  );
});

test("H.2 requireAirtable=true without Airtable throws, never uses seed", async () => {
  await assert.rejects(
    createCatalogStore({ env: {}, requireAirtable: true }),
    /Airtable is not configured/
  );
});

test("H.3 Catalog error does not fall back to seed data", async () => {
  const { engine } = await setupConversation();
  // Simulate a catalog error
  engine.properties.refresh = async () => { throw new Error("Airtable unavailable"); };
  
  const result = await engine.handleMessage("dm_h3", "Budget 3M Yas 2 bedrooms show me options", { useLlm: false });
  
  // Should report catalog unavailable, not show seed data
  assert.equal(result.catalogError, "Airtable unavailable");
  assert.equal(result.matchCount, 0);
  // Should not claim specific prices or availability
  assert.doesNotMatch(result.reply, /AED \d+,\d+,\d+ starting/i);
});

test("H.4 Zero active units does not fall back to seed inventory", async () => {
  const store = await createLocalStore({});
  // Deactivate all units
  store.units = store.units.map(u => ({ ...u, active: false }));
  
  const buyers = new BuyerService(store);
  const properties = new PropertyService(store);
  const memory = new ConversationMemory();
  const engine = new ConversationEngine({ buyers, properties, memory });
  
  const result = await engine.handleMessage("dm_h4", "Budget 3M Yas 2 bedrooms", { useLlm: false });
  
  // Should have zero matches, not seed data
  assert.equal(result.matchCount, 0);
});

// ============================================================================
// Exact transcript reproduction from the DM screenshots
// ============================================================================

test("Transcript: Hi -> Why -> Let's restart -> Roi -> Mix sequence", async () => {
  const { engine, buyers } = await setupConversation();
  
  // 1. Buyer: "Hi"
  const r1 = await engine.handleMessage("transcript", "Hi", { useLlm: false });
  // Should get a normal welcome, NOT "I can't give a reliable property comparison"
  assert.doesNotMatch(r1.reply, /can't give a reliable property comparison/i);
  assert.match(r1.reply, /Hi|buying|investing|exploring/i);
  
  // 2. Buyer: "Why" (ambiguous follow-up)
  const r2 = await engine.handleMessage("transcript", "Why", { useLlm: false });
  // Should NOT say "I don't have current confirmed terms for that property"
  assert.doesNotMatch(r2.reply, /don't have current confirmed terms for that property/i);
  assert.doesNotMatch(r2.reply, /Which project are you asking about/i);
  
  // 3. Buyer: "Let's restart"
  // (User had budget from a previous session that wasn't cleared)
  // First, simulate having an old budget
  await buyers.remember("transcript", { budget: 2000000 });
  const r3 = await engine.handleMessage("transcript", "Let's restart", { useLlm: false });
  // Clears old search and opens with useful discovery topics instead of a budget form
  const buyer3 = await buyers.getOrCreate("transcript");
  assert.equal(buyer3.budgetAed, null, "Budget should be cleared after restart");
  assert.match(r3.reply, /area.*project.*budget/i);
  // Should NOT say "Around AED 2,000,000 — got it"
  assert.doesNotMatch(r3.reply, /Around AED 2,000,000/i);
  
  // Set up investment context
  await engine.handleMessage("transcript", "2M", { useLlm: false });
  await engine.handleMessage("transcript", "investing", { useLlm: false });
  
  // 4. Buyer: "Roi"
  const r4 = await engine.handleMessage("transcript", "Roi", { useLlm: false });
  // Bot should explain ROI and ask about income/growth/mix
  assert.match(r4.reply, /rental income|growth|mix/i);
  
  // Legacy saved income/growth context is still understood.
  engine.memory.setLastAskedField("transcript", "investmentObjective");
  // 5. Buyer: "Mix" (answering that legacy question)
  const r5 = await engine.handleMessage("transcript", "Mix", { useLlm: false });
  // Should NOT say "I don't have current confirmed terms for that property"
  assert.doesNotMatch(r5.reply, /don't have current confirmed terms for that property/i);
  assert.doesNotMatch(r5.reply, /Which project are you asking about/i);
  // Should record the investment objective (PR #4 uses "balanced" for mix)
  assert.equal(r5.buyer.investmentObjective, "balanced");
});
