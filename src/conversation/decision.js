import { normalizeBuyerText, buyerLanguage } from "./text.js";
import { answerListingRequest, compareNamedListings, isListingRequest } from "./listing-answers.js";
import { answerFactQuestion, detectFactTopic } from "./fact-answers.js";
import { comparisonReply } from "./comparison-reply.js";
import { compareProperties } from "./comparison.js";
import { knowledgeAdvice } from "./knowledge-advice.js";
import { conversationalScope } from "./question-scope.js";
import { investmentGuidance, performanceQuestion, investmentRiskReply, exitQuestion } from "./investment-guidance.js";
import { brokerProfile } from "./broker-profile.js";
import { handoffTopic, identityReply, isBareDecline, isIdentityQuestion, judgmentAnswer, judgmentTopic } from "./sales-moments.js";
import { choicesForField } from "./choices.js";
import { isGreeting, welcomeChoices } from "./welcome.js";
import { findPropertyReply, nextChoice, welcomeText, WELCOME_PROMPT } from "./concierge.js";
import { isFlexiblePreference } from "./preference-state.js";
import { areaAnswer } from "./area-answers.js";
import { areaGuideFromCatalog } from "../facts/area-guide.js";
import { extractArea, OTHER_OFFER } from "./extract.js";

function welcome(ar, { name = null, fresh = false } = {}) {
  const prompt = ar ? WELCOME_PROMPT.ar : WELCOME_PROMPT.en;
  const result = response(welcomeText({ name, ar, fresh }), "exploring", "explorationTopic", prompt);
  return { ...result, nextQuestion: { ...result.nextQuestion, choices: welcomeChoices(ar) } };
}

/** "I'm good", "all good", "that's all": a polite close, not a request to stop all contact. */
export function isClosingRemark(text) {
  return /^(?:i'?m good|im good|i am good|all good|that'?s all|thats all|no thanks|no thank you)(?:,?\s*thanks?)?[.!]*$/i.test(String(text).trim());
}

function response(text, stage, field = null, prompt = null) {
  return { text, stage, nextQuestion: field ? { field, prompt } : null, pendingOffer: null, callRequest: null };
}

// Answer-first decisions run before commercial qualification. Content comes from
// the approved catalogue, or clearly identified general education.
export function decideConversation({ message, buyer, catalog, packs = [], intents = [], catalogError = null, advisor = null, lastAskedField = null, askedFields = new Set(), pendingOffer = null, broker = brokerProfile() }) {
  const text = normalizeBuyerText(message);
  const ar = buyer.language === "ar" || buyerLanguage(message) === "ar";
  const say = (en, arabic) => ar ? arabic : en;
  if (intents.includes("stop") || buyer.salesPathStopped) {
    // "I'm good" closes the conversation warmly; "stop" / "leave me alone" is a full stop.
    if (isClosingRemark(text)) return response(say("Of course. I'm here whenever you need me.", "بكل سرور. أنا هنا متى احتجت إليّ."), "paused");
    return response(say("Understood. I'll leave it there. Message me whenever you need help.", "تمام، سأترك الأمر هنا. راسلني متى احتجت للمساعدة."), "paused");
  }
  if ((intents.includes("decline_call") || intents.includes("no_calls")) && !detectFactTopic(text) && !isListingRequest(text)) {
    return response(say("Understood — no calls. We can continue here whenever you need help.", "تمام، بدون مكالمات. يمكننا المتابعة هنا متى احتجت للمساعدة."), "permissions_updated");
  }
  if (intents.includes("decline_contact") && !detectFactTopic(text) && !isListingRequest(text)) {
    return { ...response(say("Of course. You can keep asking about properties here without sharing personal details.",
      "أكيد، نقدر نكمل هنا بدون بيانات شخصية. اسألني عن أي مشروع أو منطقة تهمك."), "permissions_updated"), suppressCommercial: true };
  }
  const nationalityObjection = /شدخلك|ش\s*دخلك|وش دخلك|شو دخلك|ليش.*جنسي|لماذا.*جنسي|why.*nationality|nationality.*(?:necessary|relevant)|none of your business/i.test(text);
  if (nationalityObjection && (lastAskedField === "nationality" || /nationality|جنسي/i.test(text))) {
    const prompt = say("Would you prefer a ready home, or an off-plan project?", "تفضّل عقاراً جاهزاً، ولا مشروعاً على الخارطة؟");
    return { ...response(say(`Fair point. I don't need your nationality to help with property comparisons. ${prompt}`,
      `معك حق، الجنسية ما كانت ضرورية لسؤالك. نكمل على الخيارات العقارية: ${prompt}`), "conversation_repair", "investmentRoute", prompt), suppressCommercial: true };
  }
  if (intents.includes("eoi_info")) {
    return response(say("EOI means expression of interest. It records interest in a property; it is not a confirmed reservation. Any deposit, refund terms, or allocation must be checked for the specific project.", "EOI تعني إبداء الاهتمام بالعقار، وليست حجزاً مؤكداً. يجب التحقق من مبلغ الإيداع وشروط الاسترداد والتخصيص للمشروع المحدد."), "education");
  }
  if (intents.includes("decline_reserve")) {
    return response(say("Understood. I won't submit an EOI or reservation request.", "تمام، لن أرسل طلب إبداء اهتمام أو حجز."), "permissions_updated");
  }
  if (intents.includes("decline_follow_up")) return response(say("Understood. I won't arrange follow-up. You can continue getting property advice here.", "تمام، لن أرتب متابعة. يمكنك الاستمرار في الحصول على المعلومات العقارية هنا."), "permissions_updated");
  if (intents.includes("decline_viewing")) return response(say("Understood. I won't arrange a viewing.", "تمام، لن أرتب معاينة."), "permissions_updated");
  if (intents.includes("decline_price_check")) {
    // The buyer said no to a price check: respect it, and keep the chat useful.
    const prompt = say("What would you like to do next?", "كيف تحب نكمل؟");
    return { text: `${say("No problem, I won't check it.", "تمام، ما راح أتأكد منه.")}\n${prompt}`, stage: "price_check_declined",
      nextQuestion: { field: "conciergeNext", prompt, choices: [nextChoice("more", ar), nextChoice("plans", ar)] }, pendingOffer: null, callRequest: null };
  }
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
    return welcome(ar, { fresh: true });
  }
  // The three welcome choices, tapped or typed.
  const choice = text.trim().replace(/[.!]+$/, "").toLowerCase();
  if (/^(find a property|ابحث عن عقار)$/.test(choice)) {
    const reply = findPropertyReply(ar);
    return { ...reply, nextQuestion: { ...reply.nextQuestion, choices: choicesForField("useType", ar ? "ar" : "en")?.choices || reply.nextQuestion.choices } };
  }
  if (/^(payment plans?|خطط السداد)$/.test(choice)) {
    const prompt = say("Shall I find you homes with plans that suit you?", "تبيني أدور لك عقارات بخطط تناسبك؟");
    const body = say([
      "💳 How off-plan payment plans work:",
      "• On booking: a first payment to reserve your home",
      "• During construction: instalments as the building goes up",
      "• On handover: the balance when you get your keys",
      "Some plans leave a big share for handover, so the first payment only tells part of the story."
    ].join("\n"), [
      "💳 كيف تشتغل خطط السداد على الخارطة:",
      "• دفعة الحجز: أول دفعة عشان تحجز وحدتك",
      "• أثناء البناء: أقساط مع تقدّم البناء",
      "• عند التسليم: الباقي لما تستلم المفتاح",
      "بعض الخطط تخلي جزء كبير للتسليم، فالدفعة الأولى ما تعطيك الصورة كاملة."
    ].join("\n"));
    const result = response(`${body}\n\n${prompt}`, "education", "explorationTopic", prompt);
    return { ...result, pendingOffer: { type: "concierge_find" }, suppressCommercial: true,
      nextQuestion: { ...result.nextQuestion, choices: [nextChoice("homes", ar), nextChoice("cheapest", ar), nextChoice("agent", ar)] } };
  }
  if (/^(ask a question|اسأل سؤالا|اسأل سؤالاً)$/.test(choice)) {
    return response(say("Sure. Ask me anything about Abu Dhabi property: an area, a project, prices, or how buying works.", "أكيد، اسألني أي شي عن عقارات أبوظبي: منطقة، مشروع، أسعار، أو خطوات الشراء."), "exploring");
  }
  // Cases from the brand guide's launch tests, answered before any qualification.
  if (/\b(?:phone|number|contact|details|email|name)\b.{0,40}\b(?:other|another|last|previous)\s+(?:buyer|client|customer|person|user)s?\b|\b(?:other|another|last|previous)\s+(?:buyer|client|customer)'?s?\s+(?:phone|number|contact|details|email)/i.test(text)) {
    return response(say("I can't share anyone else's details. I'm happy to help with your own search.", "لا يمكنني مشاركة بيانات أي شخص آخر. يسعدني مساعدتك في بحثك."), "conversation_repair");
  }
  if (/\bdubai\b|دبي/i.test(text) && !/abu ?dhabi|أبوظبي|ابوظبي/i.test(text)) {
    const prompt = say("Would you like to see similar options in Abu Dhabi instead?", "هل تود رؤية خيارات مشابهة في أبوظبي بدلاً من ذلك؟");
    return response(say(`I currently cover Abu Dhabi projects only, so I can't suggest homes in Dubai yet. ${prompt}`, `أغطي حالياً مشاريع أبوظبي فقط، لذلك لا يمكنني اقتراح عقارات في دبي بعد. ${prompt}`), "exploring", "explorationTopic", prompt);
  }
  if (/sustainab|\bgreen\b|\beco\b|energy|bills?|استدام|فواتير/i.test(text) && /\b(lower|cheaper|save|saving|reduce|less|guarantee)\b|أقل|توفير/i.test(text)) {
    return response(say("I can't promise that. Our name reflects how we work, not the performance of a particular building. Energy and service costs depend on the specific unit and its systems, so they need checking project by project.",
      "لا يمكنني تأكيد ذلك. اسمنا يعكس طريقة عملنا، وليس أداء مبنى معين. تكاليف الطاقة والخدمات تعتمد على الوحدة وأنظمتها، لذا تحتاج إلى تحقق لكل مشروع."), "education");
  }
  if (OTHER_OFFER.test(text)) {
    return response(say("If you send me the offer details, I can compare the unit, payment terms and included charges with what I have.", "إذا أرسلت لي تفاصيل العرض، يمكنني مقارنة الوحدة وشروط الدفع والرسوم المشمولة بما لدي."), "education");
  }
  if (/\bwhich\s+(?:plan|one|option)\s+(?:is\s+)?(?:better|best)\b|\bwhich\s+should\s+i\s+(?:pick|choose|go for)\b|أيهما أفضل/i.test(text) && ["comparisonPreference", "advisoryNextAction"].includes(lastAskedField)) {
    const prompt = say("Is the priority a smaller first payment or a smaller amount left at handover?", "هل الأولوية لدفعة أولى أقل أم لمبلغ أقل عند التسليم؟");
    return response(say(`It depends on when you want to commit the cash. ${prompt}`, `يعتمد ذلك على توقيت دفعك للمبالغ. ${prompt}`), "education", "comparisonPreference", prompt);
  }
  const namesProject = catalog.projects.some(p => text.toLowerCase().includes(String(p.name).toLowerCase()));
  if (!namesProject && !buyer.activeRecommendationProjectId && /\bwhat(?:'s| is) a payment plan\b|\bwhat are payment plans\b|\bhow do(?:es)? (?:these |off-plan )?payment plans? work\b|\bexplain (?:how )?payment plans\b|كيف تعمل خطط السداد|ما هي خطة السداد\s*[؟?]?$/i.test(text)) {
    const prompt = say("Are you looking at a particular project?", "هل تنظر إلى مشروع معين؟");
    return response(say(`A payment plan splits the purchase price across set dates or construction stages: usually a booking payment, instalments while it's built, and a balance at handover. Some leave a large share for handover, so the first payment only tells part of the story. ${prompt}`,
      `خطة السداد تقسّم سعر الشراء على مواعيد أو مراحل بناء: عادة دفعة حجز، ثم أقساط أثناء البناء، ثم رصيد عند التسليم. بعض الخطط تترك جزءاً كبيراً للتسليم، لذا الدفعة الأولى لا تكشف الصورة كاملة. ${prompt}`), "education", "explorationTopic", prompt);
  }
  if (lastAskedField === "explorationTopic" && /^(?:no,?\s*)?(?:i'?m\s+)?(?:just\s+)?(?:learning|browsing|curious|looking)(?:\s+for now)?[.!]*$/i.test(text.trim())) {
    return response(say("The useful comparison is what you pay at the start, during construction and at handover, plus any separate charges. When you have a plan in mind, I can help you read that breakdown.",
      "المقارنة المفيدة هي ما تدفعه في البداية وأثناء البناء وعند التسليم، إضافة إلى أي رسوم منفصلة. عندما تجد خطة معينة، يمكنني مساعدتك في قراءة تفاصيلها."), "education");
  }
  if (/\bstudios?\b|ستوديو/i.test(text)) {
    const asked = extractArea(text);
    const inArea = asked ? catalog.projects.filter(p => p.active && String(p.area).toLowerCase() === String(asked).toLowerCase()) : [];
    const hasStudio = inArea.some(p => catalog.units.some(u => u.projectId === p.id && u.active !== false && Number(u.bedrooms) === 0));
    if (inArea.length && !hasStudio) {
      const prompt = say("Shall I show you the smallest homes there instead, or look at studios in another area?", "هل أعرض لك أصغر الوحدات هناك، أم أبحث عن استوديوهات في منطقة أخرى؟");
      return response(say(`None of the ${asked} projects I cover offer studios; the smallest homes there start at one bedroom. ${prompt}`, `لا تتوفر استوديوهات في مشاريع ${asked} التي أغطيها؛ أصغر الوحدات هناك تبدأ بغرفة نوم واحدة. ${prompt}`), "no_match", "explorationTopic", prompt);
    }
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
  if (split && (/mean|explain|what|اشرح|يعني|معنى/i.test(text) || /^\s*\d{1,2}\s*\/\s*\d{1,2}[.!?؟]*\s*$/.test(text)) && Number(split[1]) + Number(split[2]) === 100) {
    // No project numbers in this educational draft; the checker remains strict.
    const before = Number(split[1]);
    const after = Number(split[2]);
    const named = catalog.projects.find(project => text.toLowerCase().includes(project.name.toLowerCase()));
    const prompt = named ? say(`Want me to check the actual payment plan for ${named.name}?`, `تبي أراجع خطة السداد الفعلية لـ${named.name}؟`) : say("Which project is the plan for?", "الخطة لأي مشروع؟");
    return { ...response(say(`A ${before}/${after} plan splits the price into ${before}% and ${after}%. Payment dates and stages depend on the project's actual plan. ${prompt}`,
      `خطة ${before}/${after} تقسّم سعر العقار إلى ${before}% و${after}%. مواعيد الدفعات ومراحلها تعتمد على خطة المشروع. ${prompt}`), "education", named ? "advisoryNextAction" : "factProject", prompt), educationalSplit: `${before}/${after}`, suppressCommercial: true,
      pendingOffer: named ? { type: "advisory_next_action", action: "payment_details", projectId: named.id } : null };
  }
  const listing = answerListingRequest({ message: text, catalog, buyer, pendingOffer });
  if (listing && !catalogError) return listing;
  // Tapped as the answer to "live in or invest?": go straight to the budget.
  if (lastAskedField !== "useType" && /^(?:investment|investing|استثمار|للاستثمار)[.!?؟]*$/i.test(text.trim()) && (!buyer.investmentStrategy || buyer.investmentStrategy === "UNDECIDED") && !buyer.incomeRequirement) {
    const prompt = say("Would you prefer a ready home to rent now, or an off-plan project where we can assess the area and delivery timeline?",
      "تفضّل عقاراً جاهزاً للتأجير الآن، ولا مشروعاً على الخارطة نقارن فيه المنطقة وموعد التسليم؟");
    const result = response(say(`I can help you compare the options as an investment. ${prompt}`,
      `أقدر أساعدك تقارن الخيارات كاستثمار. ${prompt}`), "exploring", "investmentRoute", prompt);
    return { ...result, suppressCommercial: true, nextQuestion: { ...result.nextQuestion, choices: [
      { id: "off_plan", label: say("Off-plan", "على الخارطة"), value: say("Off-plan", "على الخارطة") },
      { id: "ready", label: say("Ready to rent", "جاهز للتأجير"), value: say("Ready home", "جاهز") }] } };
  }
  if (lastAskedField === "investmentRoute" && /^(?:ready(?: property| home)?|جاهز|عقار جاهز|off[- ]?plan|على الخارطة|مشروع على الخارطة)[.!?؟]*$/i.test(text.trim())) {
    const readyChoice = buyer.investmentStrategy === "READY_INCOME";
    const lead = readyChoice ? say("I'll focus on completed homes, with current availability checked separately.", "تمام، نركز على العقارات الجاهزة، ونتحقق من التوفر الحالي بشكل منفصل.")
      : say("I'll compare off-plan entry prices, the area and delivery timeline; future resale prices need their own evidence.", "تمام، نقارن سعر الدخول والمنطقة وموعد التسليم. سعر إعادة البيع المستقبلي يحتاج أدلة مستقلة.");
    const prompt = buyer.budgetAed ? say("Is there an area you'd like to start with?", "في منطقة تبي نبدأ فيها؟") : say("What budget would you like me to work within?", "كم الميزانية اللي تبي نبحث ضمنها؟");
    return { ...response(`${lead} ${prompt}`, "exploring", buyer.budgetAed ? "preferredAreas" : "budgetAed", prompt), suppressCommercial: true };
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
    // "Projects on Hudayriyat?" lists that area's projects, not the whole catalogue.
    const asked = extractArea(text);
    const inArea = asked ? projects.filter(p => String(p.area).toLowerCase() === String(asked).toLowerCase()) : [];
    if (inArea.length) {
      const list = inArea.map(p => p.name).join(", ");
      return response(say(`On ${asked} I follow ${list}. Which one would you like to hear about, or should I narrow it down by budget?`,
        `في ${asked} أتابع ${list}. أي مشروع تود معرفة المزيد عنه، أم أضيّق الخيارات حسب ميزانيتك؟`), "knowledge_answer");
    }
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
    return compareNamedListings(selected, catalog, buyer);
  }
  // "I want to sell at handover" is a plan, not a question about the handover date.
  const statesPlan = /\b(sell|exit|flip|resell)\b/i.test(text) && !/[?؟]|\b(what|when|how)\b/i.test(text);
  if (!statesPlan && detectFactTopic(text) && (intents.includes("ask_facts") || /is it available|متاح/i.test(text))) {
    const answer = answerFactQuestion(text, packs, { language: buyer.language });
    const prompt = say("Which project would you like me to check?", "أي مشروع تريد أن أتحقق منه؟");
    return { ...response(answer.handled ? answer.text : prompt, "fact_answer", answer.handled ? null : "factProject", answer.handled ? null : prompt), factTopic: answer.topic, factMissing: answer.missing || [] };
  }
  if (isGreeting(text)) {
    // A returning buyer who already told us something is never asked it again.
    const knownUse = buyer.useType === "investment" ? say("investment options", "الخيارات الاستثمارية") : buyer.useType === "end_use" ? say("homes to live in", "المنازل للسكن") : null;
    if (buyer.budgetAed || buyer.preferredAreas?.length || buyer.projectInterest || knownUse) {
      const prompt = !buyer.budgetAed && !buyer.preferredAreas?.length && !buyer.projectInterest
        ? say(`Want to keep looking at ${knownUse}, or start fresh?`, `تبي نكمل على ${knownUse}، ولا نبدأ من جديد؟`)
        : say("Want to pick up where we left off, or start fresh?", "تبي نكمل من وين وقفنا، ولا نبدأ من جديد؟");
      const name = buyer.firstName ? ` ${buyer.firstName}` : "";
      const welcome = response(say(`Welcome back${name} 👋 ${prompt}`, `هلا فيك من جديد${name} 👋 ${prompt}`), "welcome_back", "session_choice", prompt);
      return { ...welcome, pendingOffer: { type: "session_choice" }, nextQuestion: {
        ...welcome.nextQuestion,
        choices: [{ id: "continue", label: say("Continue", "نكمل"), value: "Continue" }, { id: "start_fresh", label: say("Start fresh", "بداية جديدة"), value: "Start fresh" }]
      } };
    }
    return welcome(ar, { name: buyer.firstName || null });
  }
  if (/^(just )?explor(?:ing|e)[.!?]*$/i.test(text.trim())) {
    const prompt = say("What would help first — choosing an area, comparing projects, or seeing what a budget could buy?", "ما الذي يفيدك أولاً — اختيار منطقة أم مقارنة المشاريع أم معرفة ما تتيحه ميزانيتك؟");
    return response(say(`Happy to help. ${prompt}`, `يسعدني مساعدتك. ${prompt}`), "exploring", "explorationTopic", prompt);
  }
  if (buyer.advisorLed && buyer.budgetAed && [null, "advisoryNextAction"].includes(lastAskedField) &&
      /^(?:i (?:don't|do not) know|not sure|unsure|idk|no preference|whatever you think|you choose)[.!?]*$/i.test(text.trim())) {
    return response(say("No problem. I'll keep the shortlist balanced and compare confirmed prices, payment commitments and handover; rental or resale outcomes need project-specific evidence.", "لا مشكلة. سأوازن الخيارات وأقارن الأسعار والتزامات السداد ومواعيد التسليم المؤكدة؛ أما دخل الإيجار أو إعادة البيع فيحتاج إلى أدلة خاصة بكل مشروع."), "exploring");
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
  if (catalogError) return response(say("I couldn't load the current listings just now. I've kept your requirements, and I won't guess prices or availability.", "تعذر تحميل القوائم الحالية الآن. احتفظت بمتطلباتك، ولن أخمّن الأسعار أو التوفر."), "catalog_unavailable");
  return null;
}
