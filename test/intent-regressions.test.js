import assert from "node:assert/strict";
import test from "node:test";
import { agentEducationReply, isAgentEducationQuestion, wantsHuman } from "../src/conversation/contact.js";
import { extractFactsFromMessage } from "../src/conversation/extract.js";
import { isNegatedBuying } from "../src/conversation/intent-policy.js";
import { identityReply } from "../src/conversation/sales-moments.js";
import { talk } from "./helpers.js";

test("agent education is distinct from a request for a person in both languages", () => {
  for (const message of ["Do I need an agent?", "What does a broker do?", "هل أحتاج وسيط؟", "ما دور الوسيط؟"]) {
    assert.equal(isAgentEducationQuestion(message), true, message);
    assert.equal(wantsHuman(message), false, message);
    const result = extractFactsFromMessage(message);
    assert.ok(!result.intents.includes("agent"), message);
    assert.ok(!result.intents.includes("high_intent"), message);
    assert.equal(agentEducationReply(message).nextQuestion, null);
  }
  for (const message of ["I need an agent", "Can I talk to a human?", "Please connect me to a broker", "أريد التحدث مع مستشار", "هل يمكنني التحدث مع وسيط؟"])
    assert.equal(wantsHuman(message), true, message);
});

test("negated buying never becomes buying interest", () => {
  for (const message of ["I don't want to buy yet", "I am not ready to buy", "I'm not interested in buying", "لا أريد شراء عقار الآن", "لست جاهز للشراء"]) {
    assert.equal(isNegatedBuying(message), true, message);
    const result = extractFactsFromMessage(message);
    assert.ok(!result.intents.includes("high_intent"), message);
    assert.ok(!result.signals.includes("buy_interest"), message);
  }
  assert.ok(extractFactsFromMessage("I don't want to buy yet, but can I talk to an agent?").intents.includes("agent"));
});

test("Arabic bedroom words and numerals fill the buyer's requirement", () => {
  for (const [message, bedrooms] of [["شقة غرفتين في ياس", 2], ["أريد شقة بغرفتان", 2], ["ثلاث غرف نوم", 3], ["غرفة نوم واحدة", 1], ["شقة ٢ غرف نوم", 2], ["غرفتين أو ثلاث غرف", [2, 3]]])
    assert.deepEqual(extractFactsFromMessage(message).facts.bedrooms, bedrooms, message);
});

test("identity replies accurately describe the deterministic assistant", () => {
  const en = identityReply({ buyer: {}, broker: {} });
  const ar = identityReply({ buyer: { language: "ar" }, broker: {} });
  assert.match(en, /automated property assistant/);
  assert.match(ar, /مساعد عقاري آلي/);
  assert.doesNotMatch(en, /AI property|human broker/);
  assert.doesNotMatch(ar, /الذكاء الاصطناعي/);
  assert.equal(isAgentEducationQuestion("Are you an agent?"), false);
  assert.equal(isAgentEducationQuestion("هل أنت وسيط؟"), false);
});

test("real-engine agent education answers without contact requests or alerts", async () => {
  for (const message of ["Do I need an agent?", "هل أحتاج وسيط؟"]) {
    const { last } = await talk([message]);
    assert.equal(last.stage, "education");
    assert.equal(last.nextQuestion, null);
    assert.equal(last.intentAlert, null);
    assert.equal(last.followUpSubmitted, false);
    assert.doesNotMatch(last.reply, /What budget|الميزانية/);
  }
});

test("a buyer who is not ready to buy is not pushed or alerted", async () => {
  for (const message of ["I don't want to buy yet", "لا أريد شراء عقار الآن"]) {
    const { last } = await talk([message]);
    assert.equal(last.nextQuestion, null);
    assert.equal(last.intentAlert, null);
    assert.equal(last.followUpSubmitted, false);
    assert.ok(!last.intents.includes("high_intent"));
  }
});
