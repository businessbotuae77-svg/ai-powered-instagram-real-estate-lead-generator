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
import { choicesForField } from "./choices.js";
import { isFlexiblePreference } from "./preference-state.js";
import { areaAnswer } from "./area-answers.js";
import { areaGuideFromCatalog } from "../facts/area-guide.js";

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
    const prompt = say("What are you curious about — an area, a project, or what your budget could buy?", "ما الذي تود معرفته — منطقة أم مشروع أم الخيارات التي تناسب ميزانيتك؟");
    return response(say(`Fresh start. ${prompt}`, `لنبدأ من جديد. ${prompt}`), "exploring", "explorationTopic", prompt);
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
  const area = areaAnswer({ text, buyer, catalog, lastAskedField, ar, askedFields });
  if (area) return area;
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
  const guidance = investmentGuidance({ buyer, message: text, hasCommercialOptions: Boolean(advisor?.primary), catalogError, areaGuide: areaGuideFromCatalog(catalog) });
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
    // A returning buyer who already told us something is never asked it again.
    const knownUse = buyer.useType === "investment" ? say("investment options", "الخيارات الاستثمارية") : buyer.useType === "end_use" ? say("homes to live in", "المنازل للسكن") : null;
    if (buyer.budgetAed || buyer.preferredAreas?.length || buyer.projectInterest || knownUse) {
      const prompt = !buyer.budgetAed && !buyer.preferredAreas?.length && !buyer.projectInterest
        ? say(`Want to keep looking at ${knownUse}, or start fresh?`, `هل تريد متابعة ${knownUse} أم البدء من جديد؟`)
        : say("Want to continue with your last search, or start fresh?", "هل تريد متابعة البحث السابق أم البدء من جديد؟");
      const welcome = response(say(`Hi. Happy to help with Abu Dhabi property. ${prompt}`, `مرحباً، يسعدني مساعدتك في عقارات أبوظبي. ${prompt}`), "welcome_back", "session_choice", prompt);
      return { ...welcome, pendingOffer: { type: "session_choice" }, nextQuestion: {
        ...welcome.nextQuestion,
        choices: [{ id: "continue", label: "Continue", value: "Continue" }, { id: "start_fresh", label: "Start fresh", value: "Start fresh" }]
      } };
    }
    const prompt = say("What are you curious about — an area, a project, or what your budget could buy?", "ما الذي تود معرفته — منطقة أم مشروع أم الخيارات التي تناسب ميزانيتك؟");
    return response(say(`Hi 👋 I can help you explore Abu Dhabi areas, compare current projects, or understand payment plans. ${prompt}`, `مرحباً 👋 أساعدك في استكشاف مناطق أبوظبي ومقارنة المشاريع الحالية وفهم خطط السداد. ${prompt}`), "exploring", "explorationTopic", prompt);
  }
  if (/^(just )?explor(?:ing|e)[.!?]*$/i.test(text.trim())) {
    const prompt = say("What would help first — choosing an area, comparing projects, or seeing what a budget could buy?", "ما الذي يفيدك أولاً — اختيار منطقة أم مقارنة المشاريع أم معرفة ما تتيحه ميزانيتك؟");
    return response(say(`Happy to help. ${prompt}`, `يسعدني مساعدتك. ${prompt}`), "exploring", "explorationTopic", prompt);
  }
  if (buyer.advisorLed && buyer.budgetAed && [null, "advisoryNextAction"].includes(lastAskedField) &&
      /^(?:i (?:don't|do not) know|not sure|unsure|idk|no preference|whatever you think|you choose)[.!?]*$/i.test(text.trim())) {
    return response(say("No problem. I'll keep the shortlist balanced and compare confirmed prices, payment commitments and handover; rental or resale outcomes need project-specific evidence.", "لا مشكلة. سأوازن الخيارات وأقارن الأسعار والتزامات السداد ومواعيد التسليم المؤكدة؛ أما دخل الإيجار أو إعادة البيع فيحتاج إلى أدلة خاصة بكل مشروع."), "exploring");
  }
  if (buyer.budgetAed && !buyer.investmentGoal && !buyer.investmentObjective && !buyer.cashDeploymentPreference && !buyer.liquidityPriority && !isFlexiblePreference(buyer, "priorities") && !buyer.advisorLed && !buyer.preferredAreas?.length && !buyer.projectInterest && !buyer.bedrooms?.length && !buyer.propertyTypes?.length && buyer.useType !== "end_use") {
    const prompt = say("Should I start with a balanced shortlist, lower upfront cash, growth potential, or evidence for an easier resale?", "هل أبدأ بقائمة متوازنة أم بدفعة أولى أقل أم بفرص النمو أم بأدلة تسهّل إعادة البيع؟");
    const result = response(say(`I can compare current options by entry price, payment timing and handover; rental or resale performance needs project-specific evidence. ${prompt}`, `أستطيع مقارنة الخيارات الحالية بسعر الدخول ومواعيد السداد والتسليم؛ أما أداء الإيجار أو إعادة البيع فيحتاج إلى أدلة خاصة بكل مشروع. ${prompt}`), "exploring", "investmentObjective", prompt);
    return { ...result, nextQuestion: { ...result.nextQuestion, choices: choicesForField("investmentObjective")?.choices || null } };
  }
  if (/^(i (don't|do not) know|not sure|unsure|idk|ما أعرف|لا أعرف)[.!?]*$/i.test(text.trim()) && !buyer.budgetAed) {
    if (lastAskedField === "explorationTopic") {
      const overview = areaAnswer({ text: "areas", buyer, catalog, lastAskedField, ar, askedFields });
      if (overview) return { ...overview, text: say(`No problem. Here's a quick Abu Dhabi starting point:\n${overview.text}`, `لا مشكلة. إليك بداية سريعة للتعرف على أبوظبي:\n${overview.text}`) };
      return response(say("No problem. Tell me any area or project that caught your eye, and I'll start there.", "لا مشكلة. أخبرني بأي منطقة أو مشروع لفت انتباهك وسأبدأ منه."), "exploring");
    }
    if (isFlexiblePreference(buyer, "useType")) {
      const explanation = say("No problem — I can explain the property choices as we go. For a home, I'd start with how you want to live. For investment, I'd compare entry price, payment commitments and resale evidence before selecting a property.", "لا مشكلة — أستطيع شرح الخيارات العقارية معك. للسكن أبدأ بما يناسب حياتك، وللاستثمار أقارن سعر الدخول والتزامات السداد وأدلة إعادة البيع قبل اختيار العقار.");
      return response(explanation, "exploring");
    }
    return response(say("No problem. We can start with what matters most: a home to live in, investment potential, a lower entry price, or an easier payment plan?", "لا مشكلة. ما الذي يهمك أكثر: منزل للسكن أم الاستثمار أم سعر دخول أقل أم خطة سداد أسهل؟"), "exploring", "useType", "What matters most?");
  }
  if (catalogError) return response(say("The property catalogue check failed. I've kept your requirements and can retry; I won't guess prices or availability.", "تعذر التحقق من كتالوج العقارات. احتفظت بمتطلباتك ويمكنني إعادة المحاولة؛ لن أخمن الأسعار أو التوفر."), "catalog_unavailable");
  return null;
}
