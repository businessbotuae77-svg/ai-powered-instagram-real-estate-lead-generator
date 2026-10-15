import { answerFactQuestion } from "./fact-answers.js";
import { loadQualificationChoices } from "./choices.js";
import { BUDGET_CHOICES } from "./concierge.js";

const BUTTONS_AR = { "Continue": "نكمل", "Start fresh": "بداية جديدة", "More options": "خيارات أكثر", "About the area": "عن المنطقة",
  "Talk to an agent": "كلّم موظف", "Show me homes": "ابحث عن عقار", "Find a property": "ابحث عن عقار", "Payment plans": "خطط السداد",
  "Yes, connect me": "إي، وصلني", "Not now": "مو الحين", "Phone call": "مكالمة", "WhatsApp": "WhatsApp", "Here on Instagram": "هنا في إنستغرام",
  "Show nearby bedroom sizes": "غرف قريبة من طلبك", "Keep area flexible": "أي منطقة", "Show both": "الاثنين", "Show the cheapest": "أرخص الخيارات" };

// Buttons keep working in Arabic: every label translated, or none shown (never a mix).
function arabicChoices(choices) {
  if (!choices?.length) return null;
  const table = new Map(Object.entries(BUTTONS_AR));
  for (const group of Object.values(loadQualificationChoices())) for (const choice of group.choices || []) if (choice.labelAr) table.set(choice.label, choice.labelAr);
  for (const choice of BUDGET_CHOICES) table.set(choice.label, choice.labelAr);
  const mapped = choices.map(choice => table.has(choice.label) ? { ...choice, label: table.get(choice.label) } : null);
  return mapped.every(Boolean) ? mapped : null;
}
// Deterministic Arabic fallback for control flows; catalogue names stay verbatim.
export function localizeDraft(draft, buyer, packs) {
  if (buyer.language !== "ar" || /[\u0600-\u06ff]/.test(draft.text)) return draft;
  const prompts = {
    budgetAed: "ما الميزانية التقريبية؟", preferredAreas: "أي منطقة تفضل؟",
    propertyTypes: "ما نوع العقار أو عدد غرف النوم المطلوب؟", bedrooms: "كم غرفة نوم تفضل؟",
    financing: "هل تفضل الدفع النقدي أم التمويل العقاري أم خطة سداد؟",
    cashAvailableAed: "كم المبلغ المتاح للدفعة الأولى؟",
    preferredContactChannel: "هل تفضل المتابعة هنا على إنستغرام أم واتساب؟",
    phone: buyer.preferredContactChannel === "phone" ? "ما الرقم الذي تسمح لنا بالاتصال به؟" : "ما رقم واتساب المناسب؟"
  };
  const nextQuestion = draft.nextQuestion ? { ...draft.nextQuestion,
    prompt: prompts[draft.nextQuestion.field] || "ما الخيار الذي تفضله؟", choices: arabicChoices(draft.nextQuestion.choices) } : null;
  let text;
  if (draft.stage === "follow_up_channel") text = "بالتأكيد. هل تفضل المتابعة هنا على إنستغرام أم واتساب؟";
  else if (draft.stage === "follow_up_phone" || draft.stage === "call_offer") text = prompts.phone;
  else if (draft.stage === "follow_up_requested" || draft.stage === "call_requested") text = "تلقيت طلب المتابعة. سأؤكد لك عندما يصل إلى المستشار.";
  else if (draft.stage === "qualifying") text = [buyer.budgetAed ? `الميزانية المحفوظة ${Number(buyer.budgetAed).toLocaleString("en-US")} درهم.` : null, nextQuestion?.prompt].filter(Boolean).join(" ");
  else if (draft.stage === "fact_answer" && packs.length && draft.factTopic) {
    text = answerFactQuestion(draft.factTopic, packs, { language: "ar" }).text;
  }
  else if (draft.stage === "fact_answer" || draft.stage === "comparison" || draft.stage === "matched" || draft.stage === "soft_match") {
    text = packs.map(p => [`${p.name.value} — ${p.area.value}`,
      p.startingPriceText.value ? `السعر يبدأ من ${p.startingPriceText.value}` : null,
      p.downPaymentText.value ? `الدفعة الأولى ${p.downPaymentText.value}` : null,
      p.handover?.value ? `التسليم ${p.handover.value}` : null].filter(Boolean).join("؛ ") + ".").join("\n");
    const gaps = packs.flatMap(p => p.fit?.compromises || []);
    if (gaps.length) text += " هذه الخيارات لا تحقق جميع المتطلبات؛ توجد فروق في " + [...new Set(gaps.map(g => ({ budget: "الميزانية", cash: "الدفعة الأولى", bedrooms: "غرف النوم", area: "المنطقة", payment_plan: "خطة السداد" })[g.key] || "المتطلبات"))].join("، ") + ".";
    if (nextQuestion) text += ` ${nextQuestion.prompt}`;
  } else if (draft.stage === "transaction_next_step") {
    text = "يسعدني ذلك. سيؤكد لك فريقنا السعر الحالي والوحدات المتاحة وخطوات الحجز.";
  } else if (draft.stage === "no_match") {
    text = "لا أجد حالياً خياراً مؤكداً يطابق كل ما ذكرته. هل نجرب عدد غرف مختلفاً أو منطقة أخرى أو ميزانية أعلى قليلاً؟";
  } else text = nextQuestion?.prompt
    ? `يسعدني مساعدتك. ${nextQuestion.prompt}`
    : "يسعدني مساعدتك. أخبرني بميزانية تقريبية أو منطقة أو اسم مشروع، وسأعطيك التفاصيل المؤكدة.";
  return { ...draft, text, nextQuestion };
}
