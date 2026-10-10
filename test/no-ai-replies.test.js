import assert from "node:assert/strict";
import test from "node:test";
import { setupConversation } from "./helpers.js";

// The bot runs without a model: these follow-ups must get a real answer, not filler.
const FILLER = /That's everything I have|No problem, take your time|No rush|^Got it\.$/m;

async function talk(id, messages) {
  const { engine } = await setupConversation();
  let last;
  for (const message of messages) last = await engine.handleMessage(id, message, { useLlm: false });
  return last;
}

test("a follow-up about the initial payment answers it for the option on the table", async () => {
  const reply = await talk("initial", ["Budget 2M, 2 bedroom in Yas", "Ok what's the initial payment?"]);
  assert.equal(reply.stage, "fact_answer");
  assert.match(reply.reply, /initial payment/i);
  assert.doesNotMatch(reply.reply, FILLER);
  assert.equal(reply.check.ok, true);
});

test("a rent question is answered honestly without inventing a yield", async () => {
  const reply = await talk("rent", ["I want rental income from day one", "Budget 2.5M", "What would I earn in rent?"]);
  assert.equal(reply.stage, "fact_answer");
  assert.match(reply.reply, /don't have confirmed rent figures/);
  assert.doesNotMatch(reply.reply, /\d+(?:\.\d+)?\s*%/);
  assert.equal(reply.check.ok, true);
});

test("handover answers say what is paid at handover", async () => {
  const reply = await talk("handover", ["Tell me about Yas Park Views", "When is handover?"]);
  assert.match(reply.reply, /hands over in Q4 2027/);
  assert.equal(reply.check.ok, true);
});

test("an exit plan mentioning handover is not treated as a handover question", async () => {
  const reply = await talk("exit", ["Investment, 2M, I want to sell at handover"]);
  assert.notEqual(reply.stage, "fact_answer");
});

test("projects on a named island list only that island", async () => {
  const reply = await talk("island", ["What projects do you have on Hudayriyat?"]);
  assert.match(reply.reply, /^On Hudayriyat Island I follow/);
  assert.doesNotMatch(reply.reply, /Yas Park Views|Reem Gate/);
});

test("repeated vague messages never get an empty filler", async () => {
  const { engine } = await setupConversation();
  for (const message of ["hmm", "what", "ok", "tell me something"]) {
    const reply = await engine.handleMessage("vague", message, { useLlm: false });
    assert.doesNotMatch(reply.reply, FILLER, message);
  }
});
