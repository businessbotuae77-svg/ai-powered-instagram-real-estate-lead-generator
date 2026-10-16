import assert from "node:assert/strict";
import test from "node:test";
import { setupConversation } from "./helpers.js";
import { buttonLabel } from "../src/conversation/concierge.js";

// Names buyers actually type: part of a name, a family of projects, a name we
// do not have. Each gets project cards or an honest answer, never "no option".

test("a family name shows its projects as cards, busiest developer sales first", async () => {
  const { engine } = await setupConversation();
  await engine.handleMessage("family", "2 bedroom in Shamkha under 1.5M");
  const reeman = await engine.handleMessage("family", "What about Reeman?");
  assert.equal(reeman.check.ok, true, JSON.stringify(reeman.check.violations));
  assert.match(reeman.reply, /^\d+ Reeman projects in Al Shamkhah had sales in the last 12 months\. Here are the busiest 👇\n\n🏙️ /u);
  assert.match(reeman.reply, /\nAlso:\n2️⃣ .*Reeman/u);
  assert.doesNotMatch(reeman.reply, /confirmed option/);
  assert.ok(reeman.nextQuestion.choices.slice(0, 3).every(choice => /Reeman/.test(choice.value)));

  const radiant = await engine.handleMessage("family-2", "Radiant");
  assert.match(radiant.reply, /Radiant projects in Al Reem Island had sales in the last 12 months/);
  assert.equal(radiant.check.ok, true, JSON.stringify(radiant.check.violations));
});

test("part of a project's name opens that project's card", async () => {
  const { engine, store } = await setupConversation();
  // As in production, where Yas Park Views is not one of the listed projects.
  store.projects = store.projects.filter(project => project.name !== "Yas Park Views");
  const views = await engine.handleMessage("partial", "Tell me about Yas Park Views");
  assert.equal(views.check.ok, true, JSON.stringify(views.check.violations));
  assert.match(views.reply, /^🏙️ Noya - Phase 5 - Yas Park Views\n📍 Yas Island/u);
  const grove = await engine.handleMessage("partial-2", "Tell me about Saadiyat Grove Residences");
  assert.match(grove.reply, /^🏙️ Saadiyat Grove - The Source Residences\n/u);
});

test("a project name we do not have is said plainly, with the team offered", async () => {
  const { engine } = await setupConversation();
  const unknown = await engine.handleMessage("unknown", "Tell me about Sunset Heights");
  assert.equal(unknown.check.ok, true, JSON.stringify(unknown.check.violations));
  assert.match(unknown.reply, /^I don't have Sunset Heights in my records yet\. Our team can check it for you\./);
  assert.equal(unknown.nextQuestion.field, "handoffOffer");
  // A place is still a place: "Yas beaches" gets the area guide.
  const beaches = await engine.handleMessage("unknown-2", "Tell me about yas beaches");
  assert.equal(beaches.stage, "area_guide", beaches.reply);
});

test("asking whether we have the buyer's number gets a straight answer", async () => {
  const { engine } = await setupConversation();
  await engine.buyers.patchBuyer("number", { phone: "+971501234567", preferredContactChannel: "whatsapp" });
  const known = await engine.handleMessage("number", "Do you have my number");
  assert.equal(known.check.ok, true, JSON.stringify(known.check.violations));
  assert.match(known.reply, /^Yes 👍 I have your number ending in 4567\. Our team will reach you on WhatsApp\./);
  assert.doesNotMatch(known.reply, /501234567|confirmed option/);
  const none = await engine.handleMessage("no-number", "Do you have my number?");
  assert.match(none.reply, /^Not yet\./);
  const arabic = await engine.handleMessage("no-number-ar", "عندك رقمي؟");
  assert.match(arabic.reply, /^لا، ما عندي رقمك للحين/);
});

test("a message that is not a search never gets 'no confirmed option'", async () => {
  const { engine } = await setupConversation();
  const search = await engine.handleMessage("open", "4 bedroom villa in Saadiyat under 1M");
  assert.equal(search.stage, "no_match", search.reply);
  const reply = await engine.handleMessage("open", "hmm ok");
  assert.equal(reply.check.ok, true, JSON.stringify(reply.check.violations));
  assert.match(reply.reply, /^Happy to help 🙂 I can show you more homes within your budget/);
  assert.doesNotMatch(reply.reply, /confirmed option/);
  assert.deepEqual(reply.nextQuestion.choices.map(choice => choice.label), ["More options", "Payment plans", "Talk to an agent"]);
});

test("long project names fit Instagram buttons and keep what tells them apart", () => {
  assert.equal(buttonLabel("Al Reeman 2 - Phase 2"), "Al Reeman 2 Phase 2");
  assert.equal(buttonLabel("Al Reeman 1 - Phase 2 (Plots)"), "Al Reeman 1 Phase 2");
  assert.equal(buttonLabel("Bab Al Qasr Residence 22"), "Bab Al Qasr Res 22");
  assert.equal(buttonLabel("Saadiyat Lagoons - Wilds - Phase 1"), "Saadiyat Lagoons… 1");
  for (const name of ["Emirates Palace, Mandarin Oriental Mansions", "Noya - Phase 5 - Yas Park Views"]) assert.ok(buttonLabel(name).length <= 20, name);
});
