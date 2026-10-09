import assert from "node:assert/strict";
import test from "node:test";
import { setupConversation } from "./helpers.js";
import { composeReplyWithModel, createAnthropicClient } from "../src/conversation/llm.js";
import { understandMessageWithModel } from "../src/conversation/understand.js";
import { cachedSystem, DEFAULT_UNDERSTANDING_MODEL, systemText, thinkingOff } from "../src/conversation/model-request.js";
import { modelRuntimeStatus, recordModelUsage } from "../src/conversation/model-runtime.js";
import { KeyedQueue } from "../src/conversation/keyed-queue.js";

const understanding = { facts: { budget: 3000000 }, unsure: [], intents: ["search"], signals: [], ack: null };
const reply = value => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: JSON.stringify(value) }] }) });

function recordingClient(respond, requests = []) {
  const client = createAnthropicClient({ apiKey: "test-only", model: "test-reply-model", understandingModel: "test-understanding-model", baseUrl: "https://example.test" });
  client.fetchImpl = async (_url, request) => { const body = JSON.parse(request.body); requests.push(body); return respond(body); };
  return client;
}

test("thinking is turned off in the form each model accepts", () => {
  assert.deepEqual(thinkingOff("claude-sonnet-5"), { thinking: { type: "disabled" } });
  assert.deepEqual(thinkingOff("claude-haiku-5-5"), { thinking: { type: "disabled" } });
  assert.deepEqual(thinkingOff("claude-sonnet-5-5"), { thinking: { type: "between_tools" } });
  assert.deepEqual(thinkingOff("claude-opus-5-5"), { output_config: { effort: "low" } });
});

test("the fixed system prompt is one cached block and per-request text follows uncached", () => {
  const system = cachedSystem("fixed rules", "Write natural English.", null);
  assert.deepEqual(system, [
    { type: "text", text: "fixed rules", cache_control: { type: "ephemeral" } },
    { type: "text", text: "Write natural English." }
  ]);
  assert.equal(systemText(system), "fixed rules\nWrite natural English.");
});

test("understanding defaults to the cheaper model; replies keep the configured model", () => {
  const saved = process.env.ANTHROPIC_UNDERSTANDING_MODEL;
  delete process.env.ANTHROPIC_UNDERSTANDING_MODEL;
  try {
    const client = createAnthropicClient({ apiKey: "test-only", model: "claude-sonnet-5" });
    assert.equal(client.model, "claude-sonnet-5");
    assert.equal(client.understandingModel, DEFAULT_UNDERSTANDING_MODEL);
    process.env.ANTHROPIC_UNDERSTANDING_MODEL = "claude-sonnet-5";
    assert.equal(createAnthropicClient({ apiKey: "test-only" }).understandingModel, "claude-sonnet-5");
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_UNDERSTANDING_MODEL;
    else process.env.ANTHROPIC_UNDERSTANDING_MODEL = saved;
  }
});

test("understanding and composition requests use their own model, a cached prompt and no thinking", async () => {
  const requests = [];
  const client = recordingClient(() => reply(understanding), requests);
  await understandMessageWithModel(client, { message: "3 million" });
  client.fetchImpl = async (_url, request) => { requests.push(JSON.parse(request.body)); return reply({ message: "Hello!", claims: [] }); };
  await composeReplyWithModel(client, { language: "ar" });
  const [understand, compose] = requests;
  assert.equal(understand.model, "test-understanding-model");
  assert.equal(compose.model, "test-reply-model");
  for (const body of [understand, compose]) {
    assert.deepEqual(body.thinking, { type: "disabled" });
    assert.deepEqual(body.system[0].cache_control, { type: "ephemeral" });
    assert.equal(body.system.slice(1).some(block => block.cache_control), false);
  }
  assert.match(understand.system[0].text, /extract structured buyer requirements/);
  assert.equal(compose.system.at(-1).text.startsWith("Write natural Arabic"), true, "the language line stays out of the cached block");
  assert.doesNotMatch(compose.system[0].text, /Write natural/);
});

test("broker replies run without thinking and with the cached broker prompt", async () => {
  const setup = await setupConversation();
  const requests = [];
  setup.engine.llm = recordingClient(body => /senior property advisor/.test(systemText(body.system))
    ? reply({ message: "Happy to help with Yas.", recommended: [], questionField: null, offer: null })
    : { ok: false, status: 503, json: async () => ({}) }, requests);
  await setup.engine.handleMessage("broker-cost", "2M Yas 2 bedroom");
  const broker = requests.find(body => /senior property advisor/.test(systemText(body.system)));
  assert.ok(broker, "the turn reached broker mode");
  assert.equal(broker.model, "test-reply-model");
  assert.deepEqual(broker.thinking, { type: "disabled" });
  assert.deepEqual(broker.system[0].cache_control, { type: "ephemeral" });
});

test("token usage and latency add up per stage for the health endpoint", t => {
  t.mock.method(console, "info", () => {});
  const client = { apiKey: "test-only" };
  recordModelUsage(client, "composition", { model: "m", startedAt: Date.now(), usage: { input_tokens: 4000, cache_read_input_tokens: 1200, output_tokens: 300 } });
  recordModelUsage(client, "composition", { model: "m", startedAt: Date.now(), usage: { input_tokens: 3000, cache_creation_input_tokens: 1200, output_tokens: 100 } });
  recordModelUsage(client, "understanding", { model: "m", usage: null });
  const { usage } = modelRuntimeStatus(client);
  assert.deepEqual(Object.keys(usage), ["composition"], "a response without usage counts nothing");
  assert.equal(usage.composition.requests, 2);
  assert.equal(usage.composition.inputTokens, 7000);
  assert.equal(usage.composition.cacheReadTokens, 1200);
  assert.equal(usage.composition.cacheWriteTokens, 1200);
  assert.equal(usage.composition.outputTokens, 400);
  assert.equal(typeof usage.composition.averageMs, "number");
  assert.equal(modelRuntimeStatus({ apiKey: "unused" }).usage, undefined);
});

test("one buyer's slow reply does not hold up another buyer", { timeout: 10_000 }, async t => {
  t.mock.method(console, "warn", () => {});
  const setup = await setupConversation();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let started;
  const modelCalled = new Promise(resolve => { started = resolve; });
  setup.engine.llm = { apiKey: "test-only", model: "test-model", baseUrl: "https://example.test",
    fetchImpl: async () => { started(); await gate; return { ok: false, status: 503, json: async () => ({}) }; } };
  const slow = setup.engine.handleMessage("buyer-a", "Budget 3M in Yas");
  await modelCalled;
  const fast = await setup.engine.handleMessage("buyer-b", "Hi", { useLlm: false });
  assert.ok(fast.reply, "buyer B was answered while buyer A's model call was still open");
  release();
  assert.ok((await slow).reply);
});

test("messages from one buyer still run in the order they arrived", async () => {
  const queue = new KeyedQueue();
  const order = [];
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  await Promise.all([
    queue.run("a", async () => { await delay(20); order.push("a1"); }),
    queue.run("a", async () => { order.push("a2"); }),
    queue.run("b", async () => { order.push("b1"); })
  ]);
  assert.deepEqual(order, ["b1", "a1", "a2"]);
  assert.equal(queue.size, 0, "finished buyers leave no queue behind");
  await assert.rejects(queue.run("a", async () => { throw new Error("boom"); }));
  assert.equal(await queue.run("a", async () => "next"), "next", "a failed turn does not block the buyer's next message");
});
