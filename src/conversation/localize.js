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
  else if (draft.stage === "fact_answer" && packs.length && draft.factTopic === "rent") {
    text = `لا أملك أرقام إيجار مؤكدة لـ ${packs[0].name.value}، لذلك لن أخمّن العائد. يمكن لفريقنا تزويدك بإيجارات حديثة لعقارات مشابهة قريبة.`;
  }
  else if (draft.stage === "fact_answer" && packs.length) {
    const fields = { availability: "availability", price: "startingPriceText", initial: "downPaymentText", paymentPlan: "paymentPlanSummary", handover: "handover" };
    const labels = { availability: "التوفر", price: "السعر يبدأ من", initial: "الدفعة الأولى", paymentPlan: "خطة السداد", handover: "التسليم" };
    const unknown = { availability: "التوفر غير مؤكد بعد", price: "سعر البداية غير مؤكد بعد", initial: "الدفعة الأولى غير مؤكدة بعد",
      paymentPlan: "خطة السداد غير مؤكدة بعد", handover: "موعد التسليم غير مؤكد بعد" };
    const field = fields[draft.factTopic];
    text = [...new Map(packs.map(p => [p.projectId, p])).values()]
      .map(p => `${p.name.value}: ${p[field]?.confirmed ? `${labels[draft.factTopic] || ""} ${p[field].value}`.trim() : unknown[draft.factTopic] || "هذه المعلومة غير مؤكدة بعد"}`).join("\n");
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
