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
    prompt: prompts[draft.nextQuestion.field] || "ما الخيار الذي تفضله؟", choices: null } : null;
  let text;
  if (draft.stage === "follow_up_channel") text = "بالتأكيد. هل تفضل المتابعة هنا على إنستغرام أم واتساب؟";
  else if (draft.stage === "follow_up_phone" || draft.stage === "call_offer") text = prompts.phone;
  else if (draft.stage === "follow_up_requested" || draft.stage === "call_requested") text = "تلقيت طلب المتابعة. سأؤكد لك عندما يصل إلى المستشار.";
  else if (draft.stage === "qualifying") text = [buyer.budgetAed ? `الميزانية المحفوظة ${Number(buyer.budgetAed).toLocaleString("en-US")} درهم.` : null, nextQuestion?.prompt].filter(Boolean).join(" ");
  else if (draft.stage === "fact_answer" && packs.length) {
    const fields = { availability: "availability", price: "startingPriceText", initial: "downPaymentText", paymentPlan: "paymentPlanSummary", handover: "handover" };
    const field = fields[draft.factTopic];
    text = packs.map(p => `${p.name.value}: ${p[field]?.confirmed ? p[field].value : "هذه المعلومة غير مؤكدة حالياً"}`).join("\n");
  }
  else if (draft.stage === "fact_answer" || draft.stage === "comparison" || draft.stage === "matched" || draft.stage === "soft_match") {
    text = packs.map(p => `${p.name.value} — ${p.area.value}. السعر: ${p.startingPriceText.value || "غير مؤكد"}؛ الدفعة الأولى: ${p.downPaymentText.value || "غير مؤكدة"}؛ خطة السداد: ${p.paymentPlanSummary.value || "غير مؤكدة"}.`).join("\n");
    const gaps = packs.flatMap(p => p.fit?.compromises || []);
    if (gaps.length) text += " هذه الخيارات لا تحقق جميع المتطلبات؛ توجد فروق في " + [...new Set(gaps.map(g => ({ budget: "الميزانية", cash: "الدفعة الأولى", bedrooms: "غرف النوم", area: "المنطقة", payment_plan: "خطة السداد" })[g.key] || "المتطلبات"))].join("، ") + ".";
    if (nextQuestion) text += ` ${nextQuestion.prompt}`;
  } else text = "لا أملك تفاصيل حالية مؤكدة لهذا الطلب. يمكنني إعادة التحقق من الكتالوج.";
  return { ...draft, text, nextQuestion };
}
