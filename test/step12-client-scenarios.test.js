import assert from "node:assert/strict";
import test from "node:test";
import { setupConversation } from "./helpers.js";
import { resolveChoice } from "../src/conversation/choices.js";
import { extractFactsFromMessage } from "../src/conversation/extract.js";

test("step 12a client scenario progressive Yas flow remembers then recommends", async () => {
  const { engine } = await setupConversation();
  const user = "ig_client_flow";

  const t1 = await engine.handleMessage(user, "I have AED 3M.");
  assert.equal(t1.buyer.budgetAed, 3000000);

  const t2 = await engine.handleMessage(user, "Yas Island, 3 bedroom.");
  assert.deepEqual(t2.buyer.preferredAreas, ["Yas Island"]);
  assert.deepEqual(t2.buyer.bedrooms, [3]);

  const t3 = await engine.handleMessage(
    user,
    "I have AED 500k available now and need a payment plan."
  );
  assert.equal(t3.buyer.cashAvailableAed, 500000);
  assert.equal(t3.buyer.financing, "payment_plan");
  assert.equal(t3.buyer.budgetAed, 3000000);

  const t4 = await engine.handleMessage(user, "What do you recommend?");
  assert.ok(t4.matchCount >= 1 && t4.matchCount <= 2);
  if (t4.advisor.challenger) assert.ok(t4.advisor.challenger.reasonCodes.length);
  assert.equal(t4.matches[0].project.name, "Yas Park Views");
  assert.doesNotMatch(t4.reply, /What budget are you working with/i);
  assert.ok(t4.check.ok);
});

test("step 12b bedroom correction replaces earlier 3BR", async () => {
  const { engine } = await setupConversation();
  const user = "ig_client_beds";
  await engine.handleMessage(user, "I have AED 3M.");
  await engine.handleMessage(user, "Yas Island, 3 bedroom.");
  await engine.handleMessage(user, "I have AED 500k available now and need a payment plan.");
  const updated = await engine.handleMessage(user, "Actually make that 2 bedrooms.");
  assert.deepEqual(updated.buyer.bedrooms, [2]);
  assert.ok(!updated.buyer.bedrooms.includes(3));
});

test("step 12c payment plan question uses only confirmed Airtable facts", async () => {
  const { engine } = await setupConversation();
  const user = "ig_client_plan";
  await engine.handleMessage(user, "I have AED 3M.");
  await engine.handleMessage(user, "Yas Island, 3 bedroom.");
  await engine.handleMessage(user, "500k cash and payment plan");
  const ask = await engine.handleMessage(user, "What's the payment plan?");
  assert.ok(ask.check.ok);
  assert.match(ask.reply, /80\/20|payment plan|not confirmed/i);
  assert.doesNotMatch(ask.reply, /90\/10/);
});

test("step 12d blank commercial field stays not confirmed", async () => {
  const { engine } = await setupConversation();
  const user = "ig_client_blank";
  await engine.handleMessage(user, "Budget 5M for Yas Waterfront Residences, 2 bedroom");
  const ask = await engine.handleMessage(user, "What is the starting price?");
  assert.ok(ask.check.ok);
  if (ask.packs.length) {
    assert.match(ask.reply, /not confirmed/i);
  }
});

test("step 12e returning same buyer keeps saved filters", async () => {
  const { engine, store } = await setupConversation();
  const user = "ig_client_return";
  await engine.handleMessage(user, "I have AED 3M.");
  await engine.handleMessage(user, "Yas Island, 3 bedroom.");
  await engine.handleMessage(user, "500k cash, payment plan");
  const saved = store.getBuyer(user);
  assert.equal(saved.budgetAed, 3000000);
  assert.deepEqual(saved.preferredAreas, ["Yas Island"]);
  assert.deepEqual(saved.bedrooms, [3]);

  const again = await engine.handleMessage(user, "Show recommendations again");
  assert.equal(again.buyer.budgetAed, 3000000);
  assert.deepEqual(again.buyer.preferredAreas, ["Yas Island"]);
  assert.deepEqual(again.buyer.bedrooms, [3]);
  assert.ok(again.matchCount >= 1 && again.matchCount <= 2);
  assert.equal(again.matches[0].project.name, "Yas Park Views");
  if (again.advisor.challenger) assert.ok(again.advisor.challenger.reasonCodes.length);
});

test("step 12f declining phone does not keep asking for contact", async () => {
  const { engine } = await setupConversation();
  const user = "ig_client_nophone";
  await engine.handleMessage(user, "I have AED 3M.");
  await engine.handleMessage(user, "Yas Island, 3 bedroom.");
  await engine.handleMessage(user, "500k cash, payment plan");
  await engine.handleMessage(user, "I want to reserve");
  const declined = await engine.handleMessage(user, "I don't want to give my phone number.");
  assert.equal(declined.buyer.contactDeclined, true);
  assert.doesNotMatch(declined.reply, /What phone number/i);
  const next = await engine.handleMessage(user, "Any other options?");
  assert.doesNotMatch(next.reply, /What phone number/i);
});

test("step 12g quick replies and free text map to the same structured values", () => {
  assert.equal(resolveChoice("financing", "Payment plan").value, "payment_plan");
  assert.equal(resolveChoice("financing", "I need a payment plan please").value, "payment_plan");
  assert.equal(resolveChoice("preferredAreas", "Yas").value, "Yas Island");
  assert.equal(resolveChoice("propertyTypes", "Villa").value, "villa");
  assert.equal(resolveChoice("useType", "Invest").value, "investment");

  const fromChoice = extractFactsFromMessage("Payment plan");
  assert.equal(fromChoice.facts.financing, "payment_plan");
  const fromText = extractFactsFromMessage("I need a payment plan");
  assert.equal(fromText.facts.financing, "payment_plan");
});
