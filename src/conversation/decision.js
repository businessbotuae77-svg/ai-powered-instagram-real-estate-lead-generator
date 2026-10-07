import { normalizeBuyerText, buyerLanguage } from "./text.js";
import { answerFactQuestion, detectFactTopic } from "./fact-answers.js";
import { buildFactPack } from "../facts/retrieval.js";
import { comparisonReply } from "./comparison-reply.js";
import { compareProperties } from "./comparison.js";
import { knowledgeAdvice } from "./knowledge-advice.js";
import { conversationalScope } from "./question-scope.js";
import { investmentGuidance, performanceQuestion, investmentRiskReply, exitQuestion } from "./investment-guidance.js";
import { brokerProfile } from "./broker-profile.js";
import { handoffTopic, identityReply, isBareDecline, isIdentityQuestion, judgmentAnswer, judgmentTopic } from "./sales-moments.js";

function response(text, stage, field = null, prompt = null) {
  return { text, stage, nextQuestion: field ? { field, prompt } : null, pendingOffer: null, callRequest: null };
}

// Answer-first decisions run before commercial qualification. Content comes from
// the approved catalogue, or clearly identified general education.
export function decideConversation({ message, buyer, catalog, packs = [], intents = [], catalogError = null, advisor = null, lastAskedField = null, askedFields = new Set(), broker = brokerProfile() }) {
  const text = normalizeBuyerText(message);
  const ar = buyer.language === "ar" || buyerLanguage(message) === "ar";
  const say = (en, arabic) => ar ? arabic : en;
  if (intents.includes("stop") || buyer.salesPathStopped) {
    return response(say("Understood. I'll leave it there. Message me whenever you need help.", "تمام، سأترك الأمر هنا. راسلني متى احتجت للمساعدة."), "paused");
  }
  if (intents.includes("decline_call") || intents.includes("no_calls")) {
    return response(say("Understood — no calls. We can continue here whenever you need help.", "تمام، بدون مكالمات. يمكننا المتابعة هنا متى احتجت للمساعدة."), "permissions_updated");
  }
  if (intents.includes("eoi_info")) {
    return response(say("EOI means expression of interest. It records interest in a property; it is not a confirmed reservation. Any deposit, refund terms, or allocation must be checked for the specific project.", "EOI تعني إبداء الاهتمام بالعقار، وليست حجزاً مؤكداً. يجب التحقق من مبلغ الإيداع وشروط الاسترداد والتخصيص للمشروع المحدد."), "education");
  }
  if (intents.includes("decline_reserve")) {
    return response(say("Understood. I won't submit an EOI or reservation request.", "تمام، لن أرسل طلب إبداء اهتمام أو حجز."), "permissions_updated");
  }
  if (intents.includes("decline_follow_up")) return response(say("Understood. I won't arrange follow-up. You can continue getting property advice here.", "تمام، لن أرتب متابعة. يمكنك الاستمرار في الحصول على المعلومات العقارية هنا."), "permissions_updated");
  if (intents.includes("decline_viewing")) return response(say("Understood. I won't arrange a viewing.", "تمام، لن أرتب معاينة."), "permissions_updated");
  if (intents.includes("decline_handoff") && isBareDecline(text)) {
    return response(say("No problem. I'm happy to keep helping here whenever you have more questions.", "لا مشكلة. يسعدني متابعة المساعدة هنا متى كانت لديك أسئلة."), "handoff_declined");
  }
  // A simple thanks closes the turn politely; it is not a new question.
  if (/^(?:ok(?:ay)?[,!.]?\s*)?(?:thanks|thank you|thx|cheers|great,? thanks)(?: (?:a lot|so much))?[.!]*$|^شكرا/i.test(text.trim())) {
    return response(say("You're welcome. I'm here if you want to look at anything else.", "على الرحب. أنا هنا إذا أردت الاطلاع على أي شيء آخر."), "acknowledged");
  }
  // Be plain about what this assistant is before anything else.
  if (isIdentityQuestion(text)) return response(identityReply({ buyer, broker }), "identity");
  // Visa, mortgage eligibility and legal or tax questions need a professional:
  // give the general answer, then the engine may add a service and an offer.
  const topic = judgmentTopic(text);
  if (topic) return { ...response(judgmentAnswer(topic, buyer), "professional_topic"), handoffReason: topic, handoffTopic: handoffTopic(topic), serviceTopic: topic };
  if (intents.includes("start_fresh")) {
    const prompt = say("Are you buying a home, investing, or just exploring?", "هل تبحث عن منزل للسكن أم للاستثمار أم تستكشف الخيارات؟");
    return response(say(`Starting fresh. ${prompt}`, `لنبدأ من جديد. ${prompt}`), "exploring", "useType", prompt);
  }
  const scope = conversationalScope(text);
  if (scope === "investment_education") {
    const explanation = say("Property can generate rental income and, if its value rises, a profit when you sell. I would compare the income or resale proceeds after purchase, financing and ownership costs, alongside your holding period. Neither income nor growth is guaranteed.", "قد يحقق العقار دخلاً من الإيجار وربحاً عند البيع إذا ارتفعت قيمته. أقارن ما يتبقى بعد تكاليف الشراء والتمويل والملكية والمدة التي يمكنك الاحتفاظ بها. دخل الإيجار والنمو غير مضمونين.");
    const question = exitQuestion(buyer);
    return response([explanation, question?.prompt].filter(Boolean).join(" "), "education", question?.field, question?.prompt);
  }
  if (scope === "clarify_conversation") {
    return response(say("I mean what you would like help understanding — areas, prices, investing, or how buying works. You don't need to choose a property to start.", "أقصد ما الذي تود فهمه: المناطق أم الأسعار أم الاستثمار أم إجراءات الشراء. لا تحتاج إلى اختيار عقار كي نبدأ."), "conversation_repair");
  }
  if (scope === "correct_conversation") {
    return response(say("Understood. We can discuss general property questions here, whenever you're ready.", "تمام. يمكننا مناقشة الأسئلة العقارية العامة هنا متى أردت."), "conversation_repair");
  }
  const split = text.match(/(\d{1,2})\s*\/\s*(\d{1,2})/);
  if (split && /mean|explain|what|يعني|معنى/i.test(text) && Number(split[1]) + Number(split[2]) === 100) {
    // No project numbers in this educational draft; the checker remains strict.
    const before = Number(split[1]);
    const after = Number(split[2]);
    return { ...response(say(`In a ${before}/${after} plan, ${before} percent of the price is generally paid during construction and ${after} percent at handover. The booking amount and instalment dates depend on the project; this is an explanation, not confirmation of a project's terms.`, `في خطة ${before}/${after}، يُدفع عادة ${before} بالمئة أثناء البناء و${after} بالمئة عند التسليم. مبلغ الحجز ومواعيد الأقساط تعتمد على المشروع؛ هذا شرح عام وليس تأكيداً لشروط مشروع معين.`), "education"), educationalSplit: `${before}/${after}` };
  }
  const performance = performanceQuestion(text, buyer);
  if (performance) return performance;
  if (/\b(?:what are|what.*watch|tell me|explain).*\brisks?\b|\brisks?\s*[?؟]|مخاطر/i.test(text)) {
    const thesis = advisor?.investmentTheses?.find(t => t.projectId === buyer.activeRecommendationProjectId) || advisor?.investmentTheses?.[0];
    return investmentRiskReply({ buyer, thesis });
  }
  const namedKnowledge = catalog.projects.some(p => text.toLowerCase().includes(p.name.toLowerCase()));
  if (namedKnowledge && /tell me|about|explain|compare|قارن|عن/i.test(text) && !advisor?.primary && !catalog.units.some(u => u.active && catalog.projects.some(p => p.id === u.projectId && text.toLowerCase().includes(p.name.toLowerCase())))) {
    const knowledge = knowledgeAdvice({ buyer, catalog, message: text, advisor });
    if (knowledge) return knowledge;
  }
  const guidance = investmentGuidance({ buyer, message: text, hasCommercialOptions: Boolean(advisor?.primary), catalogError });
  if (guidance) return guidance;
  const projects = catalog.projects.filter(p => p.active && p.source && p.developerActive);
  if (/areas?.*(potential|best|know|recommend|cover|have|offer)|which areas|مناطق|منطقة.*أفضل/i.test(text)) {
    const areas = [...new Set(projects.map(p => p.area))].slice(0, 4);
    const differences = areas.map(area => `${area}: ${[...new Set(projects.filter(p => p.area === area).flatMap(p => p.propertyTypes || []))].join(" and ") || "project details available"}`).join("; ");
    return response(say(areas.length ? `The areas I cover include ${differences}. I would compare entry price, payment commitments and timing before choosing; future returns need comparable rental and cost figures.` : "Area details are unavailable right now. I can still explain how to compare rental demand, costs, and investment horizons.", areas.length ? `تشمل المناطق التي أغطيها ${areas.join("، ")}. أقارن سعر الدخول والتزامات السداد والتوقيت قبل الاختيار؛ مقارنة العوائد تحتاج أرقام إيجار وتكاليف قابلة للمقارنة.` : "تفاصيل المناطق غير متاحة حالياً. يمكنني شرح مقارنة الطلب الإيجاري والتكاليف ومدة الاستثمار."), "knowledge_answer");
  }
  if (/what projects|which projects|projects.*(know|have)|مشاريع/i.test(text)) {
    const groups = new Map();
    for (const p of projects) groups.set(p.area, [...(groups.get(p.area) || []), p.name]);
    const names = [...groups].slice(0, 4).map(([area, names]) => `${area}: ${names.slice(0, 3).join(", ")}`).join("; ");
    return response(say(names ? `The projects I cover include ${names}. Current prices and availability need a fresh check.` : "Project details are unavailable right now. I can retry the check.", names ? `تشمل المشاريع التي أغطيها ${names}. الأسعار والتوفر الحالي يحتاجان إلى تحقق حديث.` : "تفاصيل المشاريع غير متاحة حالياً. يمكنني إعادة التحقق."), "knowledge_answer");
  }
  if (/\bcompare\b|comparison|قارن|مقارنة/i.test(text)) {
    const selected = projects.filter(p => text.toLowerCase().includes(p.name.toLowerCase()));
    if (!selected.length && packs.length > 1) {
      const comparisonFacts = advisor?.comparison || compareProperties({ factPack: packs[0] }, { factPack: packs[1] }, buyer);
      return { ...response(comparisonReply(comparisonFacts, { language: buyer.language }), "comparison"),
        factPacks: packs.slice(0, 2), comparisonFacts };
    }
    if (selected.length !== 2) return response(say("Which two projects would you like to compare?", "أي مشروعين تريد مقارنتهما؟"), "comparison", "comparisonProjects", "Which two projects?");
    const candidates = selected.map(project => {
      const unit = catalog.units.find(u => u.projectId === project.id && u.active);
      if (!unit) return null;
      const candidate = { project, unit };
      candidate.factPack = buildFactPack({ ...candidate, downPaymentAed: unit.initialPaymentAed ?? project.initialPaymentAed, bedroomLabel: String(unit.bedrooms) });
      return candidate;
    });
    if (candidates.some(c => !c)) return knowledgeAdvice({ buyer, catalog, message: text, advisor });
    const comparisonFacts = compareProperties(candidates[0], candidates[1], buyer);
    return { ...response(comparisonReply(comparisonFacts, { language: buyer.language }), "comparison"),
      factPacks: candidates.map(c => c.factPack), comparisonFacts };
  }
  if (detectFactTopic(text) && (intents.includes("ask_facts") || /is it available|متاح/i.test(text))) {
    const answer = answerFactQuestion(text, packs);
    const prompt = say("Which project would you like me to check?", "أي مشروع تريد أن أتحقق منه؟");
    return { ...response(answer.handled ? answer.text : prompt, "fact_answer", answer.handled ? null : "factProject", answer.handled ? null : prompt), factTopic: answer.topic };
  }
  if (/^(hi|hello|hey|salam|مرحبا|السلام عليكم)[.!?]*$/i.test(text.trim())) {
    if (buyer.budgetAed || buyer.preferredAreas?.length || buyer.projectInterest) {
      const prompt = say("Want to continue with your last search, or start fresh?", "هل تريد متابعة البحث السابق أم البدء من جديد؟");
      const welcome = response(say(`Hi. Happy to help with Abu Dhabi property. ${prompt}`, `مرحباً، يسعدني مساعدتك في عقارات أبوظبي. ${prompt}`), "welcome_back", "session_choice", prompt);
      return { ...welcome, pendingOffer: { type: "session_choice" }, nextQuestion: {
        ...welcome.nextQuestion,
        choices: [{ id: "continue", label: "Continue", value: "Continue" }, { id: "start_fresh", label: "Start fresh", value: "Start fresh" }]
      } };
    }
    return response(say("Hi 👋 I'm an AI property guide. Are you buying a home, investing, or just exploring?", "مرحباً 👋 أنا دليل عقاري بالذكاء الاصطناعي. هل تبحث عن منزل للسكن أم للاستثمار أم تستكشف الخيارات؟"), "exploring", "useType", say("Are you buying a home, investing, or just exploring?", "هل تبحث عن منزل للسكن أم للاستثمار أم تستكشف الخيارات؟"));
  }
  if (/^(just )?explor(?:ing|e)[.!?]*$/i.test(text.trim())) {
    const prompt = say("What would you like to understand first — areas, prices, investment, or how buying works?", "ما الذي تود فهمه أولاً: المناطق أم الأسعار أم الاستثمار أم إجراءات الشراء؟");
    return response(say(`Happy to help. ${prompt}`, `يسعدني مساعدتك. ${prompt}`), "exploring", "explorationTopic", prompt);
  }
  const unsure = /^(i (don't|do not) know|not sure|unsure|idk|no idea|ما أعرف|لا أعرف)[.!?]*$/i.test(text.trim());
  const budgetOnly = buyer.budgetAed && !buyer.investmentGoal && !buyer.investmentObjective && !buyer.preferredAreas?.length && !buyer.projectInterest && !buyer.bedrooms?.length && !buyer.propertyTypes?.length && buyer.useType !== "end_use";
  // Ask the open priorities question once. An unsure buyer then gets concrete
  // options once; after that the conversation moves on to matching.
  if (budgetOnly && unsure && lastAskedField === "priorities") {
    const investor = buyer.useType === "investment";
    const prompt = investor
      ? say("Is rental income, capital growth, or a mix closer to what you want?", "هل الأقرب لك دخل الإيجار أم نمو رأس المال أم مزيج منهما؟")
      : say("Is it a home to live in, an investment, or are you still deciding?", "هل هو منزل للسكن أم استثمار أم ما زلت تقرر؟");
    const lead = investor
      ? say("No problem. Most investors pick one of three goals: steady rental income, capital growth, or a mix of both.", "لا مشكلة. معظم المستثمرين يختارون أحد ثلاثة أهداف: دخل إيجاري ثابت أو نمو رأس المال أو مزيج منهما.")
      : say("No problem. Let's start with the purpose of the purchase.", "لا مشكلة. لنبدأ بالغرض من الشراء.");
    const reply = response(`${lead} ${prompt}`, "exploring", investor ? "investmentObjective" : "useType", prompt);
    return { ...reply, nextQuestion: { ...reply.nextQuestion, choices: investor
      ? [{ id: "income", label: "Rental income", value: "Rental income" }, { id: "growth", label: "Capital growth", value: "Capital growth" }, { id: "mix", label: "A mix", value: "A mix" }]
      : [{ id: "home", label: "A home", value: "A home to live in" }, { id: "invest", label: "Investment", value: "Investment" }, { id: "deciding", label: "Still deciding", value: "Just exploring" }] } };
  }
  if (budgetOnly && !askedFields.has("priorities")) {
    const prompt = say("What matters most to you in the property?", "ما الذي يهمك أكثر في العقار؟");
    return response(say(`Around AED ${Number(buyer.budgetAed).toLocaleString("en-US")} — got it. ${prompt}`, `الميزانية حوالي AED ${Number(buyer.budgetAed).toLocaleString("en-US")}. ${prompt}`), "exploring", "priorities", prompt);
  }
  if (/^(i (don't|do not) know|not sure|unsure|idk|ما أعرف|لا أعرف)[.!?]*$/i.test(text.trim()) && !buyer.budgetAed) {
    return response(say("No problem. We can start with what matters most: a home to live in, investment potential, a lower entry price, or an easier payment plan?", "لا مشكلة. ما الذي يهمك أكثر: منزل للسكن أم الاستثمار أم سعر دخول أقل أم خطة سداد أسهل؟"), "exploring", "useType", "What matters most?");
  }
  if (catalogError) return response(say("The property catalogue check failed. I've kept your requirements and can retry; I won't guess prices or availability.", "تعذر التحقق من كتالوج العقارات. احتفظت بمتطلباتك ويمكنني إعادة المحاولة؛ لن أخمن الأسعار أو التوفر."), "catalog_unavailable");
  return null;
}
