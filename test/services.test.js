import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { routeServiceTurn } from "../src/conversation/service-flow.js";
import { configuredServiceTerms, declinedServiceIds, loadServices, normalizeServices, suggestService } from "../src/conversation/services.js";
import { contactDecision } from "../src/conversation/contact.js";
import { buildCallRequestSummary } from "../src/conversation/intent-policy.js";
import { validateMessage } from "../src/facts/checker.js";
import { setupConversation } from "./helpers.js";
import { DurableConversationMemory } from "../src/integrations/durable-memory.js";

const services = normalizeServices([
  { id: "property_management", enabled: true, name: "Property management", nameAr: "إدارة العقارات",
    pitch: "Our property management service helps coordinate your rental.", pitchAr: "خدمة إدارة العقارات لدينا تساعد في تنسيق تأجير العقار.",
    triggers: ["rental_investor"], keywords: ["property management"], keywordsAr: ["إدارة العقارات", "ادارة العقارات"] },
  { id: "mortgage_advice", enabled: true, name: "Mortgage advice", nameAr: "استشارات التمويل العقاري",
    pitch: "Our mortgage advice service helps compare lender offers.", pitchAr: "خدمة استشارات التمويل العقاري لدينا تساعد في مقارنة عروض البنوك.",
    triggers: ["mortgage_buyer"], keywords: ["mortgage advice"], keywordsAr: ["استشارات التمويل", "استشارة تمويل"] },
  { id: "furnishing", enabled: true, name: "Furnishing package", nameAr: "باقة التأثيث",
    pitch: "Our furnishing package helps prepare the home with furniture.", pitchAr: "باقة التأثيث لدينا تساعد في تجهيز المنزل بالأثاث.",
    feeText: "AED 1,500", feeTextAr: "1,500 درهم", provider: "Example furnishing team", providerAr: "فريق التأثيث التجريبي",
    triggers: ["end_use_buyer"], keywords: ["furnishing", "furniture"], keywordsAr: ["تأثيث", "تاثيث", "أثاث"] }
]);

const route = (message, buyer = {}, pendingOffer = null) => routeServiceTurn({ message, buyer, pendingOffer, services });

test("real services remain disabled and are never advertised", () => {
  const rows = JSON.parse(readFileSync(new URL("../data/services.json", import.meta.url), "utf8")).services;
  assert.ok(rows.every(service => service.enabled === false));
  assert.deepEqual(loadServices(), []);
  assert.equal(suggestService({ buyer: { useType: "end_use" }, services: loadServices() }), null);
  const answer = routeServiceTurn({ message: "What is property management?", services: loadServices() });
  assert.match(answer.text, /Property management helps/);
  assert.match(answer.text, /don't have a confirmed offering/);
  assert.equal(answer.serviceRequest, undefined);
  assert.equal(answer.pendingOffer, null);
});

test("an explicit service question takes priority over other inferred needs", () => {
  const answer = route("How much is the furnishing package?", { useType: "investment", investmentObjective: "rental_income" });
  assert.match(answer.text, /AED 1,500/);
  assert.doesNotMatch(answer.text, /property management|budget/i);
  assert.equal(answer.pendingOffer.serviceId, "furnishing");
  assert.equal(answer.serviceRequest, undefined);
});

test("service fees and providers are quoted only when supplied", () => {
  const unknown = route("Who provides property management and how much does it cost?");
  assert.match(unknown.text, /don't have a confirmed fee/);
  assert.match(unknown.text, /provider is not confirmed/);
  assert.doesNotMatch(unknown.text, /AED|Example furnishing team/);
  const known = route("Who provides furnishing and how much is it?");
  assert.match(known.text, /AED 1,500/);
  assert.match(known.text, /Example furnishing team/);
  const terms = configuredServiceTerms(services);
  assert.equal(validateMessage(known.text, [], { configuredAmounts: terms.amounts, configuredPercents: terms.percents }).ok, true);
  assert.equal(validateMessage(known.text.replace("1,500", "9,500"), [], { configuredAmounts: terms.amounts }).ok, false);
});

test("Arabic service names, pitches and confirmed fees are retained", () => {
  const answer = route("كم رسوم باقة التأثيث؟", { language: "ar" });
  assert.match(answer.text, /باقة التأثيث|تجهيز المنزل/);
  assert.match(answer.text, /1,500 درهم/);
  assert.doesNotMatch(answer.text, /Would you|Our furnishing/);
  const terms = configuredServiceTerms(services);
  assert.equal(validateMessage(answer.text, [], { configuredAmounts: terms.amounts }).ok, true);
});

test("English and Arabic refusals apply to their own clauses", () => {
  for (const message of ["I don't need mortgage advice, I need furnishing", "No mortgage advice; yes furnishing", "No mortgage advice but I want furnishing"])
    assert.deepEqual(declinedServiceIds(message, services), ["mortgage_advice"], message);
  assert.deepEqual(declinedServiceIds("لا أريد إدارة العقارات، أريد باقة التأثيث", services), ["property_management"]);
  assert.deepEqual(declinedServiceIds("لا أريد استشارات التمويل ولكن أحتاج تأثيث", services), ["mortgage_advice"]);
  const answer = route("I don't need mortgage advice, I need furnishing");
  assert.equal(answer.serviceRequest.serviceId, "furnishing");
  assert.deepEqual(answer.buyerPatch.declinedSuggestions, ["service:mortgage_advice"]);
});

test("a bare yes only accepts the pending service offer", () => {
  const offer = route("Tell me about property management");
  const accepted = route("yes", {}, structuredClone(offer.pendingOffer));
  assert.equal(accepted.serviceRequest.serviceId, "property_management");
  assert.equal(accepted.pendingOffer.type, "handoff_offer");
  assert.match(accepted.text, /Nothing has been booked/);
  for (const pending of [null, { type: "handoff_offer" }, { type: "comparison_choice" }, { type: "service_choice", serviceIds: ["furnishing"] }])
    assert.equal(route("yes", {}, pending), null);
  assert.equal(route("Actually show me Yas properties", {}, offer.pendingOffer), null);
});

test("accepting a service does not grant contact permission; contact has its own offer", () => {
  const request = route("I want property management");
  assert.equal(request.serviceRequest.status, "requested");
  assert.ok(Number.isFinite(Date.parse(request.serviceRequest.requestedAt)));
  assert.equal(contactDecision({ message: "I want property management", buyer: {}, pending: null }), null);
  const contact = contactDecision({ message: "yes", buyer: {}, pending: request.pendingOffer });
  assert.equal(contact.stage, "follow_up_channel");
  assert.equal(contact.submitted, undefined);
  const followUp = contactDecision({ message: "Here on Instagram", buyer: {}, pending: contact.pendingOffer });
  assert.equal(followUp.submitted, true);
  assert.equal(followUp.channel, "instagram");
});

test("declining a service and existing contact restrictions are respected", () => {
  const answer = route("no thanks", {}, { type: "service_offer", serviceId: "furnishing" });
  assert.equal(answer.stage, "suggestion_declined");
  assert.deepEqual(answer.buyerPatch.declinedSuggestions, ["service:furnishing"]);
  assert.equal(answer.pendingOffer, null);
  const declinedContact = route("I want furnishing", { contactDeclined: true });
  assert.equal(declinedContact.pendingOffer, null);
  assert.equal(declinedContact.nextQuestion, null);
  assert.equal(route("Stop contacting me about furnishing"), null);
  const cancelled = route("No property management", { serviceRequest: { serviceId: "property_management", status: "requested" } });
  assert.equal(cancelled.buyerPatch.serviceRequest.status, "cancelled");
  const paused = route("How much is furnishing?", { salesPathStopped: true });
  assert.equal(paused.nextQuestion, null);
  assert.equal(paused.pendingOffer, null);
});

test("the broker summary retains the requested service and selected home", () => {
  const summary = buildCallRequestSummary({ instagramUserId: "synthetic", serviceRequest: { serviceId: "furnishing", name: "Furnishing package", status: "requested" } },
    { matches: [{ project: { name: "Example project" }, unit: { propertyType: "Apartment", bedrooms: 2 } }] });
  assert.match(summary, /Service requested: Furnishing package/);
  assert.match(summary, /Selected home: Apartment, 2 bedrooms/);
  assert.match(summary, /Contact requested: no/);
});

test("the real engine answers service enquiries and keeps the request through permitted handoff", async () => {
  const { engine } = await setupConversation();
  engine.services = services;
  const first = await engine.handleMessage("service_flow", "What is property management?");
  assert.equal(first.stage, "service_answer");
  assert.doesNotMatch(first.reply, /budget/i);
  const request = await engine.handleMessage("service_flow", "yes");
  assert.equal(request.buyer.serviceRequest.serviceId, "property_management");
  assert.equal(request.followUpSubmitted, false);
  assert.equal(request.alertRecommended, false);
  const channel = await engine.handleMessage("service_flow", "yes");
  assert.equal(channel.stage, "follow_up_channel");
  const submitted = await engine.handleMessage("service_flow", "Here on Instagram");
  assert.equal(submitted.followUpSubmitted, true);
  assert.equal(submitted.buyer.serviceRequest.serviceId, "property_management");
  assert.match(submitted.callSummary, /Service requested: Property management/);
});

test("Arabic service acceptance and refusal survive real-engine routing", async () => {
  const { engine } = await setupConversation();
  engine.services = services;
  const offered = await engine.handleMessage("service_ar", "كم رسوم باقة التأثيث؟");
  assert.equal(offered.stage, "service_answer");
  assert.match(offered.reply, /1,500 درهم/);
  const declined = await engine.handleMessage("service_ar", "لا شكرًا");
  assert.equal(declined.stage, "suggestion_declined");
  assert.equal(declined.buyer.salesPathStopped, false);
  assert.ok(declined.buyer.declinedSuggestions.includes("service:furnishing"));
  const requested = await engine.handleMessage("service_ar", "أريد إدارة العقارات");
  assert.equal(requested.buyer.serviceRequest.serviceId, "property_management");
  assert.equal(requested.followUpSubmitted, false);
});

test("mixed service refusal and acceptance preserve the intended service in the real engine", async () => {
  for (const [id, message] of [["mixed_en", "I don't need mortgage advice, I need furnishing"], ["mixed_ar", "لا أريد استشارات التمويل، أريد باقة التأثيث"]]) {
    const { engine } = await setupConversation();
    engine.services = services;
    const answer = await engine.handleMessage(id, message);
    assert.equal(answer.stage, "service_requested");
    assert.equal(answer.buyer.serviceRequest.serviceId, "furnishing");
    assert.ok(answer.buyer.declinedSuggestions.includes("service:mortgage_advice"));
    assert.equal(answer.followUpSubmitted, false);
    assert.equal(answer.alertRecommended, false);
  }
});

test("an explicit service and contact request retain service context without booking it", async () => {
  const { engine } = await setupConversation();
  engine.services = services;
  const answer = await engine.handleMessage("combined_service", "Call me about furnishing");
  assert.equal(answer.buyer.serviceRequest.serviceId, "furnishing");
  assert.equal(answer.stage, "call_offer");
  assert.equal(answer.followUpSubmitted, false);
  assert.doesNotMatch(answer.reply, /booked|reserved/);
});

test("a proactive service prompt binds yes to its exact offer instead of a property question", () => {
  const suggestion = suggestService({ buyer: { useType: "end_use" }, services });
  assert.equal(suggestion.pendingOffer.type, "service_offer");
  assert.match(suggestion.prompt, /help arranging Furnishing package/);
  assert.equal(route("yes", {}, suggestion.pendingOffer).serviceRequest.serviceId, "furnishing");
  assert.equal(route("yes", {}, { type: "project_choice", options: [{ id: "example" }] }), null);
});

test("the real engine binds a proactive service offer without consuming a property answer", async () => {
  const { engine } = await setupConversation();
  engine.services = services;
  const first = await engine.handleMessage("proactive", "Budget 2M, 2 bedrooms in Yas to live in");
  assert.equal(engine.memory.getPendingOffer("proactive").type, "concierge_card");
  assert.doesNotMatch(first.reply, /help arranging/);
  const propertyAnswer = await engine.handleMessage("proactive", "yes");
  assert.equal(propertyAnswer.buyer.serviceRequest, null);
  const why = await engine.handleMessage("proactive", "Why do you recommend that?");
  assert.equal(engine.memory.getPendingOffer("proactive").type, "service_offer");
  assert.equal(why.nextQuestion.field, "serviceOffer");
  assert.equal((why.reply.match(/\?/g) || []).length, 1);
  const accepted = await engine.handleMessage("proactive", "yes");
  assert.equal(accepted.buyer.serviceRequest.serviceId, "furnishing");
  assert.equal(accepted.followUpSubmitted, false);
  const cancelled = await engine.handleMessage("proactive", "No furnishing");
  assert.equal(cancelled.buyer.serviceRequest.status, "cancelled");
  assert.equal(cancelled.buyer.contactDeclined, false);
  assert.ok(!cancelled.buyer.declinedSuggestions.includes("handoff"));
});

test("a stored service offer survives a conversation-memory restart", async () => {
  const { engine } = await setupConversation();
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "service-memory-"));
  engine.services = services;
  engine.memory = new DurableConversationMemory({ rootDir });
  await engine.handleMessage("restart_service", "What is property management?");
  await engine.memory.flush();
  engine.memory = new DurableConversationMemory({ rootDir });
  const answer = await engine.handleMessage("restart_service", "yes");
  assert.equal(answer.buyer.serviceRequest.serviceId, "property_management");
  assert.equal(answer.followUpSubmitted, false);
});
