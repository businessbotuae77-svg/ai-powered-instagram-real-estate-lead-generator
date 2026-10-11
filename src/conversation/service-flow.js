import { isAffirmation } from "./affirmation.js";
import { declinedServiceIds, isServiceRefusal, loadServices, mentionsService, serviceClauses } from "./services.js";
import { normalizeBuyerText } from "./text.js";

// Educational descriptions do not imply that a disabled service is offered.
const TOPICS = [
  { id: "property_management", name: "Leasing and property management", nameAr: "التأجير وإدارة العقارات", keywords: ["property management", "leasing", "manage the rental", "إدارة العقارات", "ادارة العقارات", "إدارة العقار", "تأجير"],
    explanation: "Property management helps with tenant enquiries, rental administration and coordinating maintenance.", explanationAr: "إدارة العقارات تساعد في استفسارات المستأجرين وإجراءات التأجير وتنسيق الصيانة." },
  { id: "mortgage_advice", name: "Mortgage advice", nameAr: "استشارات التمويل العقاري", keywords: ["mortgage advice", "mortgage adviser", "mortgage advisor", "bank offers", "استشارات التمويل", "مستشار التمويل", "استشارة تمويل"],
    explanation: "Mortgage advice helps you review financing options. Eligibility and approval need confirmation from the lender.", explanationAr: "استشارات التمويل العقاري تساعدك في مراجعة خيارات التمويل. الأهلية والموافقة تحتاجان إلى تأكيد من البنك." },
  { id: "snagging_inspection", name: "Handover snagging inspection", nameAr: "فحص العيوب عند التسليم", keywords: ["snagging", "snagging inspection", "فحص العيوب", "فحص التسليم"],
    explanation: "A snagging inspection checks a property for defects before handover.", explanationAr: "فحص العيوب يتحقق من عيوب العقار قبل استلامه." },
  { id: "visa_guidance", name: "Residence visa guidance", nameAr: "إرشادات تأشيرة الإقامة", keywords: ["visa guidance", "visa service", "visa help", "إرشادات التأشيرة", "خدمة التأشيرة", "مساعدة التأشيرة"],
    explanation: "Visa guidance helps you understand the paperwork for your case. Eligibility needs confirmation against the current official requirements.", explanationAr: "إرشادات التأشيرة تساعدك في فهم المستندات المطلوبة لحالتك. الأهلية تحتاج إلى التحقق وفق المتطلبات الرسمية الحالية." },
  { id: "furnishing", name: "Furnishing package", nameAr: "باقة التأثيث", keywords: ["furnishing", "furniture", "furnish", "تأثيث", "تاثيث", "أثاث", "اثاث"],
    explanation: "A furnishing package helps prepare a property with furniture. The contents depend on the agreed package.", explanationAr: "باقة التأثيث تساعد في تجهيز العقار بالأثاث. المحتويات تعتمد على الباقة المتفق عليها." }
];

const REQUEST = /\b(?:i\s+(?:want|need|would like)|please\s+(?:arrange|book|help)|arrange|book|get me|sign me up|interested in|contact me|whatsapp me|call me)\b|(?:أريد|اريد|أحتاج|احتاج|أرغب|ارغب|رتب|احجز|تواصل معي)/i;
const QUESTION = /[?؟]|^\s*(?:what|how|who|which|can|could|do|does|is|are|tell|explain)\b|^\s*(?:ما|ماذا|كيف|من|هل|كم|اشرح)/i;
const FEE = /\b(?:fee|fees|cost|price|how much)\b|(?:الرسوم|رسوم|تكلفة|التكلفة|السعر|سعر|كم)/i;
const PROVIDER = /\b(?:who|provider|company|partner)\b|(?:من يقدم|من ينفذ|الشركة|مقدم الخدمة)/i;
const BARE_DECLINE = /^(?:no|nope|no thanks?|no thank you|not now|not yet|skip|لا|لا شكرا|لا شكراً|ليس الآن|لاحقاً|لاحقا)[.!؟?]*$/i;

function draft(text, extra = {}) {
  return { text, stage: "service_answer", nextQuestion: null, pendingOffer: null, callRequest: null,
    suppressCommercial: true, ...extra };
}

function say(ar, en, arabic) { return ar ? arabic : en; }
function nameOf(service, ar) { return ar ? service.nameAr || "هذه الخدمة" : service.name; }

function requestDraft(service, buyer, declined, now) {
  const ar = buyer.language === "ar";
  const name = nameOf(service, ar);
  const serviceRequest = { serviceId: service.id, name: service.name, nameAr: service.nameAr || null, status: "requested", requestedAt: new Date(now).toISOString() };
  const mayOfferContact = !buyer.salesPathStopped && !buyer.contactDeclined && !(buyer.declinedSuggestions || []).includes("handoff");
  const prompt = say(ar, "Would you like me to connect you with our team to confirm the details?", "هل تريد أن أوصلك بفريقنا لتأكيد التفاصيل؟");
  const text = say(ar, `I've noted your interest in ${name}. Nothing has been booked.`, `سجلت اهتمامك بـ${name}. لم يتم حجز أي شيء.`);
  return draft(mayOfferContact ? `${text}\n${prompt}` : text, { stage: "service_requested", serviceRequest,
    buyerPatch: { serviceRequest, ...(declined.length ? { declinedSuggestions: declined.map(id => `service:${id}`) } : {}) },
    handoffTopic: `Arrange ${service.name}`,
    nextQuestion: mayOfferContact ? { field: "handoffOffer", prompt } : null,
    pendingOffer: mayOfferContact ? { type: "handoff_offer", reason: "service", serviceRequest } : null });
}

/** Explicit service topics precede inferred needs; a bare yes is bound to one stored service offer. */
export function routeServiceTurn({ message, buyer = {}, services = loadServices(), pendingOffer = null, now = Date.now() } = {}) {
  const text = normalizeBuyerText(message).replace(/[\u064B-\u065F\u0670]/g, "").trim();
  if (/\b(?:stop contacting|stop messaging|leave me alone|do not contact|don'?t contact)\b|(?:أوقف التواصل|توقف عن التواصل|لا تتواصل معي)/i.test(text)) return null;
  const ar = buyer.language === "ar";
  const offered = services.filter(service => service.enabled !== false);
  const topics = [...offered, ...TOPICS.filter(topic => !offered.some(service => service.id === topic.id))];
  const mentioned = topics.filter(service => mentionsService(text, service));
  const pendingService = pendingOffer?.type === "service_offer" ? offered.find(service => service.id === pendingOffer.serviceId) : null;
  if (buyer.salesPathStopped && !mentioned.length) return null;
  if (!mentioned.length && !pendingService) return null;
  const declined = declinedServiceIds(text, offered);
  if (!mentioned.length && pendingService && BARE_DECLINE.test(text)) declined.push(pendingService.id);
  const accepted = mentioned.filter(service => !serviceClauses(text).some(clause => mentionsService(clause, service) && isServiceRefusal(clause)));
  const requested = accepted.filter(service => serviceClauses(text).some(clause => mentionsService(clause, service) && REQUEST.test(clause) && !QUESTION.test(clause)));
  const target = requested[0] || accepted[0] || pendingService;
  if (declined.length && (!target || declined.includes(target.id))) {
    const names = offered.filter(service => declined.includes(service.id)).map(service => nameOf(service, ar)).join(ar ? " و" : " and ");
    return draft(say(ar, `Understood, I'll leave ${names} out.`, `تمام، سأستبعد ${names}.`), { stage: "suggestion_declined",
      buyerPatch: { declinedSuggestions: declined.map(id => `service:${id}`),
        ...(buyer.serviceRequest && declined.includes(buyer.serviceRequest.serviceId) ? { serviceRequest: { ...buyer.serviceRequest, status: "cancelled" } } : {}) } });
  }
  if (!target || (!mentioned.length && !isAffirmation(text) && !BARE_DECLINE.test(text))) return null;
  const configured = offered.find(service => service.id === target.id);
  const declinedPatch = declined.length ? { declinedSuggestions: declined.map(id => `service:${id}`) } : null;
  if (!configured) {
    return draft([ar ? target.explanationAr : target.explanation,
      say(ar, "I don't have a confirmed offering, provider or fee for this service in our current list.", "لا توجد لدي خدمة مؤكدة أو مقدم خدمة أو رسوم مؤكدة لهذا الطلب في قائمتنا الحالية.")].filter(Boolean).join(" "));
  }
  if ((pendingService && !mentioned.length && isAffirmation(text)) || requested.some(service => service.id === configured.id)) {
    return requestDraft(configured, buyer, declined, now);
  }
  if (accepted.length > 1) {
    const prompt = say(ar, `Which service would you like to discuss first: ${accepted.map(service => nameOf(service, ar)).join(" or ")}?`,
      `أي خدمة تريد مناقشتها أولاً: ${accepted.map(service => nameOf(service, ar)).join(" أم ")}؟`);
    return draft(prompt, { nextQuestion: { field: "serviceChoice", prompt }, pendingOffer: { type: "service_choice", serviceIds: accepted.map(service => service.id) }, buyerPatch: declinedPatch });
  }
  const fee = ar ? configured.feeTextAr : configured.feeText;
  const provider = ar ? configured.providerAr : configured.provider;
  let answer = ar ? configured.pitchAr || "يمكن لفريقنا تأكيد تفاصيل هذه الخدمة بالعربية." : configured.pitch;
  if (FEE.test(text)) answer += say(ar, fee ? ` The fee is ${fee}.` : " I don't have a confirmed fee; it needs checking for your case.", fee ? ` الرسوم ${fee}.` : " لا توجد لدي رسوم مؤكدة؛ يجب التحقق منها لحالتك.");
  if (PROVIDER.test(text)) answer += say(ar, provider ? ` The provider is ${provider}.` : " The provider is not confirmed in our service details.", provider ? ` مقدم الخدمة ${provider}.` : " مقدم الخدمة غير مؤكد في تفاصيل الخدمة لدينا.");
  if (buyer.salesPathStopped) return draft(answer, { buyerPatch: declinedPatch });
  const prompt = say(ar, `Would you like help arranging ${nameOf(configured, ar)}?`, `هل تريد المساعدة في ترتيب ${nameOf(configured, ar)}؟`);
  return draft(`${answer}\n${prompt}`, { nextQuestion: { field: "serviceOffer", prompt }, pendingOffer: { type: "service_offer", serviceId: configured.id }, buyerPatch: declinedPatch });
}
