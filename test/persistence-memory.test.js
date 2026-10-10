import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { setupServices } from "./helpers.js";
import { ConversationEngine } from "../src/conversation/engine.js";
import { DurableConversationMemory } from "../src/integrations/durable-memory.js";
import { IntegrationOrchestrator } from "../src/integrations/orchestrator.js";
import { JsonFileStore } from "../src/integrations/json-store.js";
import { ProcessedEventStore } from "../src/integrations/processed-events.js";

// Production was killed for exceeding its 1 GB limit. Each buyer message re-read
// and re-parsed processed-events.json about 17 times, rewrote it 10 times, and
// copied and rewrote every buyer's conversation memory 5 times: about 350 MB of
// garbage per message.

test("a JSON store parses its file once and shares writes between concurrent changes", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "json-store-"));
  const file = path.join(dir, "counter.json");
  await writeFile(file, JSON.stringify({ count: 0 }));
  const store = new JsonFileStore(file);
  await Promise.all(Array.from({ length: 20 }, () => [
    store.read({ count: 0 }),
    store.update(current => ({ count: current.count + 1 }), { count: 0 })
  ]).flat());
  assert.equal(store.loads, 1);
  assert.ok(store.writes < 20, `${store.writes} writes for 20 changes`);
  assert.equal(JSON.parse(await readFile(file, "utf8")).count, 20, "every change reached the file");
  assert.equal((await new JsonFileStore(file).read({})).count, 20);
});

test("stored event rows are returned as copies", async () => {
  const events = new ProcessedEventStore({ rootDir: await mkdtemp(path.join(os.tmpdir(), "event-copy-")) });
  await events.save("mid_copy", { status: "failed", event: { mid: "mid_copy", senderId: "u" }, result: { reply: "original" } });
  (await events.get("mid_copy")).result.reply = "changed by a caller";
  (await events.pending())[0].result.reply = "changed by a retry";
  assert.equal((await events.get("mid_copy")).result.reply, "original");
});

test("buyer messages parse each state file once and batch conversation memory writes", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "turn-persistence-"));
  // Production-shaped history: a full event log and other buyers' conversations.
  const events = Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`old_${i}`,
    { status: "completed", at: new Date(Date.now() - 86_400_000 + i).toISOString(), senderId: `other_${i % 50}` }]));
  await writeFile(path.join(rootDir, "processed-events.json"), JSON.stringify({ events }));
  const turns = Object.fromEntries(Array.from({ length: 50 }, (_, b) => [`other_${b}`,
    Array.from({ length: 40 }, (_, t) => ({ role: t % 2 ? "assistant" : "user", text: "What is the payment plan?" }))]));
  await writeFile(path.join(rootDir, "conversation-memory.json"), JSON.stringify({ turns, pending: {}, lastAsked: {}, semanticQuestions: {} }));

  const services = await setupServices();
  const memory = new DurableConversationMemory({ rootDir });
  await memory.ensureReady();
  const engine = new ConversationEngine({ buyers: services.buyers, properties: services.properties, memory });
  const orchestrator = new IntegrationOrchestrator({ engine, buyers: services.buyers, rootDir,
    env: { META_PAGE_ACCESS_TOKEN: "t", META_PAGE_ID: "p" },
    fetchImpl: async () => ({ ok: true, json: async () => ({ message_id: "out" }) }) });
  const messages = ["Hi", "Investing", "3 million", "Yas Island", "2 bedrooms", "Why that one?"];
  for (const [index, text] of messages.entries()) {
    const outcome = await orchestrator.processMessageEvent({ mid: `turn_${index}`, senderId: "buyer", text }, { useLlm: false });
    assert.equal(outcome.pending, false);
  }

  assert.equal(orchestrator.events.store.loads, 1, "processed-events.json is parsed once, not per call");
  assert.equal(orchestrator.log.store.loads, 1);
  assert.equal(memory.store.loads, 1);
  assert.ok(memory.store.writes <= messages.length * 3, `${memory.store.writes} memory writes for ${messages.length} messages`);
  assert.equal((await orchestrator.processMessageEvent({ mid: "turn_0", senderId: "buyer", text: "Hi" })).duplicate, true);

  // Everything still reaches the volume: a restart sees it all.
  const restarted = new DurableConversationMemory({ rootDir });
  await restarted.ensureReady();
  assert.equal(restarted.getTurns("buyer").length, messages.length * 2);
  assert.equal(restarted.getTurns("other_49").length, 40);
  const reloaded = new ProcessedEventStore({ rootDir });
  for (const index of messages.keys()) assert.equal((await reloaded.get(`turn_${index}`)).status, "completed");
  assert.ok(await reloaded.has("old_1999"));
});
