import { normalizeBuyerText, buyerLanguage } from "./text.js";
import { answerFactQuestion, detectFactTopic } from "./fact-answers.js";
import { buildFactPack } from "../facts/retrieval.js";
import { conversationalScope } from "./question-scope.js";

function response(text, stage, field = null, prompt = null) {
  return { text, stage, nextQuestion: field ? { field, prompt } : null, pendingOffer: null, callRequest: null };
}

// Answer-first decisions run before commercial qualification. Content comes from
// the approved catalogue, or clearly identified general education.
export function decideConversation({ message, buyer, catalog, packs = [], intents = [], catalogError = null }) {
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
  if (intents.includes("start_fresh")) {
    const prompt = say("Are you buying a home, investing, or just exploring?", "هل تبحث عن منزل للسكن أم للاستثمار أم تستكشف الخيارات؟");
    return response(say(`Starting fresh. ${prompt}`, `لنبدأ من جديد. ${prompt}`), "exploring", "useType", prompt);
  }
  const scope = conversationalScope(text);
  if (scope === "investment_education") {
    const explanation = say("Property can generate rental income and, if its value rises, a profit when you sell. I would compare the income or resale proceeds after purchase, financing and ownership costs, alongside your holding period. Neither income nor growth is guaranteed.", "قد يحقق العقار دخلاً من الإيجار وربحاً عند البيع إذا ارتفعت قيمته. أقارن ما يتبقى بعد تكاليف الشراء والتمويل والملكية والمدة التي يمكنك الاحتفاظ بها. دخل الإيجار والنمو غير مضمونين.");
    const prompt = buyer.investmentObjective ? null : say("Are you more interested in regular rental income, long-term growth, or a mix?", "هل تفضل دخل الإيجار المنتظم أم النمو على المدى الطويل أم كليهما؟");
    return response([explanation, prompt].filter(Boolean).join(" "), "education", prompt ? "investmentObjective" : null, prompt);
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
  if (buyer.useType === "investment" && !buyer.investmentObjective &&
      (/\broi\b|rental (yield|income)|capital growth|return on investment|عائد|استثمار/i.test(text) || buyer.explorationState)) {
    const prompt = say("Are you more interested in regular rental income, long-term growth, or a mix?", "هل تفضل دخل الإيجار المنتظم أم النمو على المدى الطويل أم كليهما؟");
    return response(say(`We can keep the area open for now. Rental income and long-term growth can favour different properties. ${prompt}`, `يمكننا ترك المنطقة مفتوحة حالياً. دخل الإيجار والنمو على المدى الطويل قد يناسبان عقارات مختلفة. ${prompt}`), "exploring", "investmentObjective", prompt);
  }
  const projects = catalog.projects.filter(p => p.active && p.source && p.developerActive);
  if (/areas?.*(potential|best|know|recommend)|which areas|مناطق|منطقة.*أفضل/i.test(text)) {
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
      const rows = packs.slice(0, 2).map(pack => `${pack.name.value}: ${pack.area.value}; ${pack.bedrooms.value} bedrooms; price ${pack.startingPriceText.value || "not confirmed"}; initial payment ${pack.downPaymentText.value || "not confirmed"}; plan ${pack.paymentPlanSummary.value || "not confirmed"}.`);
      return { ...response(rows.join("\n"), "comparison"), factPacks: packs.slice(0, 2) };
    }
    if (selected.length !== 2) return response(say("Which two projects would you like to compare?", "أي مشروعين تريد مقارنتهما؟"), "comparison", "comparisonProjects", "Which two projects?");
    const comparisonPacks = [];
    const rows = selected.map(project => {
      const unit = catalog.units.find(u => u.projectId === project.id && u.active);
      if (!unit) return `${project.name}: ${project.area}; commercial details not confirmed.`;
      const pack = buildFactPack({ project, unit, downPaymentAed: unit.initialPaymentAed ?? project.initialPaymentAed, bedroomLabel: String(unit.bedrooms) });
      comparisonPacks.push(pack);
      return `${project.name}: ${project.area}; ${unit.bedrooms} bedrooms; price ${pack.startingPriceText.value || "not confirmed"}; plan ${pack.paymentPlanSummary.value || "not confirmed"}.`;
    });
    return { ...response(`${rows.join("\n")} ${say("Compare location and unit size first; any commercial trade-off needs current verified terms.", "قارن الموقع وحجم الوحدة أولاً؛ أي مفاضلة مالية تحتاج شروطاً حديثة ومعتمدة.")}`, "comparison"), factPacks: comparisonPacks };
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
  if (buyer.budgetAed && !buyer.investmentObjective && !buyer.preferredAreas?.length && !buyer.projectInterest && !buyer.bedrooms?.length && !buyer.propertyTypes?.length && buyer.useType !== "end_use") {
    const prompt = say("What matters most to you in the property?", "ما الذي يهمك أكثر في العقار؟");
    return response(say(`Around AED ${Number(buyer.budgetAed).toLocaleString("en-US")} — got it. ${prompt}`, `الميزانية حوالي AED ${Number(buyer.budgetAed).toLocaleString("en-US")}. ${prompt}`), "exploring", "priorities", prompt);
  }
  if (/^(i (don't|do not) know|not sure|unsure|idk|ما أعرف|لا أعرف)[.!?]*$/i.test(text.trim()) && !buyer.budgetAed) {
    return response(say("No problem. We can start with what matters most: a home to live in, investment potential, a lower entry price, or an easier payment plan?", "لا مشكلة. ما الذي يهمك أكثر: منزل للسكن أم الاستثمار أم سعر دخول أقل أم خطة سداد أسهل؟"), "exploring", "useType", "What matters most?");
  }
  if (catalogError) return response(say("The property catalogue check failed. I've kept your requirements and can retry; I won't guess prices or availability.", "تعذر التحقق من كتالوج العقارات. احتفظت بمتطلباتك ويمكنني إعادة المحاولة؛ لن أخمن الأسعار أو التوفر."), "catalog_unavailable");
  return null;
}
