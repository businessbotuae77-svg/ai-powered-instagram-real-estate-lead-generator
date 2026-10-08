import assert from "node:assert/strict";
import test from "node:test";
import { composeReplyWithModel } from "../src/conversation/llm.js";
import { understandMessageWithModel } from "../src/conversation/understand.js";
import { classifyModelHttpError, modelRuntimeStatus } from "../src/conversation/model-runtime.js";

const understanding = { facts: { budget: 3000000 }, unsure: [], intents: ["search"], signals: [], ack: null };
const composition = { message: "Hello!", askedQuestion: false, questionField: null, claims: [], proposedActions: [] };
const success = value => ({ ok: true, json: async () => ({ content: [{ type: "text", text: JSON.stringify(value) }] }) });
const makeClient = fetchImpl => ({ apiKey: "test-private-key", baseUrl: "https://example.test", model: "test-model", fetchImpl });

test("a configured key is unverified until both model stages succeed", async () => {
  assert.deepEqual(modelRuntimeStatus(null), { status: "disabled", stages: {} });
  const client = makeClient(async () => success(understanding));
  assert.equal(modelRuntimeStatus(client).status, "unverified");
  const result = await understandMessageWithModel(client, { message: "3 million" });
  assert.equal(result.facts.budget, 3000000);
  assert.equal(result.source, "claude");
  assert.equal(modelRuntimeStatus(client).status, "partially_verified");
  client.fetchImpl = async () => success(composition);
  assert.equal((await composeReplyWithModel(client)).message, "Hello!");
  assert.equal(modelRuntimeStatus(client).status, "healthy");
  const status = modelRuntimeStatus(client);
  status.stages.understanding.status = "failed";
  assert.equal(modelRuntimeStatus(client).status, "healthy", "callers cannot alter stored observations");
});

test("understanding HTTP errors are visible without exposing provider bodies or buyer data", async t => {
  const logs = [];
  t.mock.method(console, "warn", (...args) => logs.push(args.join(" ")));
  const privateText = "test-private-key buyer@example.test +971501234567";
  const client = makeClient(async () => ({ ok: false, status: 400,
    json: async () => ({ error: { message: `Your credit balance is too low. ${privateText}` } }) }));
  assert.equal(await understandMessageWithModel(client, { message: privateText }), null);
  const status = modelRuntimeStatus(client);
  assert.equal(status.status, "degraded");
  assert.equal(status.stages.understanding.category, "billing_required");
  assert.equal(status.stages.understanding.httpStatus, 400);
  assert.match(logs.join(" "), /stage=understanding category=billing_required/);
  for (const value of privateText.split(" ")) assert.equal(JSON.stringify({ logs, status }).includes(value), false);
});

test("a successful composition cannot hide a still-failing understanding stage", async t => {
  t.mock.method(console, "warn", () => {});
  const client = makeClient(async () => ({ ok: false, status: 401, json: async () => ({}) }));
  await understandMessageWithModel(client, { message: "Hi" });
  client.fetchImpl = async () => success(composition);
  await composeReplyWithModel(client);
  assert.equal(modelRuntimeStatus(client).status, "degraded");
  client.fetchImpl = async () => success(understanding);
  await understandMessageWithModel(client, { message: "3 million" });
  assert.equal(modelRuntimeStatus(client).status, "healthy");
});

test("non-JSON composition errors keep fallback safe and distinguish provider failure", async t => {
  t.mock.method(console, "warn", () => {});
  const client = makeClient(async () => ({ ok: false, status: 503, json: async () => { throw new SyntaxError("secret"); } }));
  assert.equal(await composeReplyWithModel(client), null);
  assert.equal(modelRuntimeStatus(client).stages.composition.category, "provider_unavailable");
});

test("malformed understanding is not counted as Claude success", async () => {
  for (const value of [null, [], { message: "wrong shape" }, { facts: [] }]) {
    const client = makeClient(async () => success(value));
    assert.equal(await understandMessageWithModel(client, { message: "3 million" }), null);
    assert.equal(modelRuntimeStatus(client).stages.understanding.category, "invalid_response_shape");
  }
});

test("transport errors and invalid composition output never mark the model healthy", async t => {
  const logs = [];
  t.mock.method(console, "warn", (...args) => logs.push(args.join(" ")));
  const client = makeClient(async () => { throw new DOMException("private provider error", "TimeoutError"); });
  assert.equal(await composeReplyWithModel(client), null);
  assert.equal(modelRuntimeStatus(client).stages.composition.category, "timeout");
  client.fetchImpl = async () => success({ unexpected: "private buyer text" });
  assert.equal(await composeReplyWithModel(client), null);
  assert.equal(modelRuntimeStatus(client).stages.composition.category, "invalid_response_shape");
  assert.doesNotMatch(logs.join(" "), /private provider|private buyer/);
});

test("HTTP diagnosis uses fixed categories and never forwards arbitrary error text", () => {
  const examples = [[400, "Credit balance is too low", "billing_required"],
    [400, "model not available", "model_unavailable"], [400, "thinking type invalid", "thinking_configuration"],
    [400, "max_tokens limit exceeded", "token_limit"], [400, "sensitive arbitrary error", "invalid_request"],
    [401, "", "authentication_failed"], [403, "", "permission_denied"], [413, "", "request_too_large"],
    [429, "", "rate_limited"], [529, "", "provider_unavailable"], [404, "", "provider_error"]];
  for (const [status, message, expected] of examples) assert.equal(classifyModelHttpError(status, { error: { message } }), expected);
});
