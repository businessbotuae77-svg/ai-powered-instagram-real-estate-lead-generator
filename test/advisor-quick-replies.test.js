import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { parseInstagramMessages, sendInstagramText } from "../src/integrations/meta.js";
import { contentDedupKey, IntegrationOrchestrator } from "../src/integrations/orchestrator.js";
import { choicesForField } from "../src/conversation/choices.js";
import { setupConversation } from "./helpers.js";

const env = { META_PAGE_ACCESS_TOKEN: "test-token", META_PAGE_ID: "test-page" };
const choices = [
  { id: "best_overall", label: "Best overall", value: "best overall" },
  { id: "growth_potential", label: "Growth potential", value: "growth potential" },
  { id: "lowest_cash_upfront", label: "Lowest cash upfront", value: "lowest cash upfront" },
  { id: "safer_exit", label: "Safer exit", value: "safer exit" },
  { id: "you_choose", label: "You choose", value: "you choose" }
];

function inbound(message) {
  return { entry: [{ id: "test-page", messaging: [{ sender: { id: "buyer" }, timestamp: Date.now(), message: { mid: "inbound", ...message } }] }] };
}

function confirmed(messageId = "confirmed") {
  return { ok: true, json: async () => ({ message_id: messageId }) };
}

test("Instagram choices use native quick replies and retain stable choice ids", async () => {
  const sent = [];
  const output = await sendInstagramText({ recipientId: "buyer", text: "What should I optimise for?", choices, env,
    fetchImpl: async (url, options) => { sent.push(JSON.parse(options.body)); return confirmed(); } });
  assert.equal(output.messageId, "confirmed");
  assert.equal(sent[0].message.text, "What should I optimise for?");
  assert.equal(sent[0].messaging_type, "RESPONSE");
  assert.deepEqual(sent[0].message.quick_replies.map(reply => JSON.parse(reply.payload).id), choices.map(choice => choice.id));
  assert.ok(sent[0].message.quick_replies.every(reply => reply.content_type === "text" && reply.title.length <= 20));
});

test("ordinary Instagram text and Instagram Login transport retain existing API behavior", async () => {
  let request;
  await sendInstagramText({ recipientId: "buyer", text: "I'll do the filtering for you.", env: { META_PAGE_ACCESS_TOKEN: "IGAA-test-token" },
    fetchImpl: async (url, options) => { request = { url, body: JSON.parse(options.body) }; return confirmed(); } });
  assert.match(request.url, /graph\.instagram\.com\/v21\.0\/me\/messages$/);
  assert.deepEqual(request.body, { recipient: { id: "buyer" }, message: { text: "I'll do the filtering for you." } });
});

test("every production investment quick reply survives send, webhook and engine understanding", async () => {
  const group = choicesForField("investmentObjective");
  const { engine } = await setupConversation();
  for (const choice of group.choices) {
    const userId = `quick-priority-${choice.id}`;
    await engine.handleMessage(userId, "Start fresh", { useLlm: false });
    await engine.handleMessage(userId, "Exploring investment opportunities", { useLlm: false });
    const budget = await engine.handleMessage(userId, "3 million", { useLlm: false });
    assert.equal(budget.nextQuestion.field, "investmentObjective");
    let button;
    await sendInstagramText({ recipientId: userId, text: budget.reply, choices: budget.nextQuestion.choices, env,
      fetchImpl: async (url, options) => {
        button = JSON.parse(options.body).message.quick_replies.find(row => JSON.parse(row.payload).id === choice.id);
        return confirmed();
      } });
    const [event] = parseInstagramMessages(inbound({ text: button.title, quick_reply: { payload: button.payload } }));
    const result = await engine.handleMessage(userId, event.text, { useLlm: false });
    assert.equal(result.buyer.budgetAed, 3_000_000, choice.id);
    assert.notEqual(result.nextQuestion?.field, "investmentObjective", choice.id);
    if (["best_overall", "you_choose"].includes(choice.id)) {
      assert.equal(result.buyer.advisorLed, true, choice.id);
      assert.equal(result.buyer.investmentPreferenceState, "flexible", choice.id);
    } else if (choice.id === "growth_potential") {
      assert.equal(result.buyer.investmentObjective, "growth", choice.id);
    } else if (choice.id === "lowest_cash_upfront") {
      assert.equal(result.buyer.cashDeploymentPreference, "lower_initial", choice.id);
    } else if (choice.id === "safer_exit") {
      assert.equal(result.buyer.liquidityPriority, "high", choice.id);
    }
  }
});

test("a quick reply works from displayed text, stable payload alone, or full structured value", () => {
  assert.equal(parseInstagramMessages(inbound({ text: "You choose" }))[0].text, "You choose");
  assert.equal(parseInstagramMessages(inbound({ quick_reply: { payload: "you_choose" } }))[0].text, "you choose");
  const value = "put down about 100k";
  assert.equal(parseInstagramMessages(inbound({ text: "About AED 100k", quick_reply: { payload: JSON.stringify({ id: "100k", text: value }) } }))[0].text, value);
  assert.equal(parseInstagramMessages(inbound({ is_echo: true, quick_reply: { payload: "you_choose" } })).length, 0);
});

test("quick reply titles stay within Meta's limit without cutting an emoji or losing the selected value", async () => {
  let message;
  const value = "This is the complete selection value";
  await sendInstagramText({ recipientId: "buyer", text: "Choose one?", choices: [{ id: "long", label: `${"a".repeat(19)}🏠 full label`, value }], env,
    fetchImpl: async (url, options) => { message = JSON.parse(options.body).message; return confirmed(); } });
  assert.equal(message.quick_replies[0].title, "a".repeat(19));
  assert.equal(JSON.parse(message.quick_replies[0].payload).text, value);
});

test("long validated advice retains every character, its citations, and the final question", async () => {
  const sent = [];
  const text = `${"a".repeat(999)}🏠\n${"Evidence-backed candidate details. ".repeat(60)}\nSource: https://example.test/document\nCompare the top two?`;
  const output = await sendInstagramText({ recipientId: "buyer", text, choices, env,
    fetchImpl: async (url, options) => { sent.push(JSON.parse(options.body).message); return confirmed(`part-${sent.length}`); } });
  assert.ok(sent.length > 1);
  assert.equal(sent.map(part => part.text).join(""), text);
  assert.ok(sent.every(part => part.text.length <= 1000 && !/[\uD800-\uDBFF]$/.test(part.text) && !/^[\uDC00-\uDFFF]/.test(part.text)));
  assert.ok(sent.slice(0, -1).every(part => !part.quick_replies));
  assert.equal(sent.at(-1).quick_replies.length, choices.length);
  assert.match(sent.at(-1).text, /Compare the top two\?$/);
  assert.equal(output.messageIds.length, sent.length);
});

test("native quick reply payloads preserve webhook and poller content deduplication", () => {
  const timestamp = Date.now();
  const [webhook] = parseInstagramMessages(inbound({ text: "About AED 100k", quick_reply: { payload: JSON.stringify({ id: "100k", text: "put down about 100k" }) } }));
  webhook.timestamp = timestamp;
  const poller = { senderId: "buyer", text: "About AED 100k", timestamp, source: "poller" };
  assert.equal(contentDedupKey(webhook), contentDedupKey(poller));
});

test("orchestrator forwards advisor choices and resumes only unconfirmed advice parts after restart", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "advisor-choices-"));
  const sent = [];
  let engineTurns = 0;
  let shouldFail = true;
  const reply = `${"Documented comparison details. ".repeat(75)}\nSource: https://example.test/approved\nWhat should I optimise for?`;
  const engine = { async handleMessage(userId, text) {
    engineTurns++;
    assert.equal(text, "you choose");
    return { buyer: { instagramUserId: userId, budgetAed: 3_000_000, useType: "investment" }, reply, nextQuestion: { field: "priorities", choices },
      alertRecommended: false, matches: [], intents: [], stage: "advising", matchCount: 0 };
  } };
  const fetchImpl = async (url, options) => {
    const message = JSON.parse(options.body).message;
    sent.push(message);
    if (shouldFail && sent.length === 2) {
      shouldFail = false;
      return { ok: false, status: 503, json: async () => ({ error: { message: "temporary Meta outage" } }) };
    }
    return confirmed(`part-${sent.length}`);
  };
  const create = () => new IntegrationOrchestrator({ engine, rootDir, env, fetchImpl });
  const event = { ...parseInstagramMessages(inbound({ quick_reply: { payload: "you_choose" } }))[0], mid: "partial-advice" };
  const first = await create().processMessageEvent(event);
  assert.equal(first.pending, true);
  const retry = await create().processMessageEvent(event, { retry: true });
  assert.equal(retry.pending, false);
  assert.equal(engineTurns, 1);
  assert.deepEqual(sent[1], sent[2]);
  assert.equal([sent[0], ...sent.slice(2)].map(message => message.text).join(""), reply);
  assert.equal(sent.at(-1).quick_replies.length, choices.length);
  assert.equal(retry.alert.skipped, true);
  const duplicate = await create().processMessageEvent(event);
  assert.equal(duplicate.duplicate, true);
  assert.equal(engineTurns, 1);
});
