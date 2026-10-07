import { buildInvestmentStrategy } from "./investment-strategy.js";
import { isFlexiblePreference } from "./preference-state.js";

function draft(text, stage, question = null) {
  return { text, stage, nextQuestion: question, pendingOffer: null, callRequest: null };
}

export function exitQuestion(buyer) {
  if (buyer.exitHorizon || buyer.holdingPeriod || buyer.incomeRequirement === "immediate" ||
      buyer.advisorLed === true || isFlexiblePreference(buyer, "investmentObjective") || isFlexiblePreference(buyer, "exitHorizon")) return null;
  return { field: "exitHorizon", prompt: buyer.language === "ar"
    ? "هل تفكر في البيع عند التسليم أم الاحتفاظ بالعقار لعدة سنوات بعده؟"
    : "Are you thinking of exiting around handover, or holding for a few years after?" };
}

/** A missing approved offer is an evidence gap, not a reason to restart the interview. */
export function advisorLedDiscoveryGuidance({ buyer, catalogError = null }) {
  if (!buildInvestmentStrategy(buyer).advisorLedDiscovery) return null;
  const ar = buyer.language === "ar";
  const budget = Number(buyer.budgetAed).toLocaleString("en-US");
  const text = ar
    ? `لا بأس — سأقوم بالتصفية لك ضمن ميزانية ${budget} درهم. سأقارن سعر الدخول ومرحلة المشروع وتطور المنطقة والمحركات الموثقة وجودة المنتج وخطة السداد والمبالغ المدفوعة وتوقيت التسليم والمعروض المنافس وأدلة إعادة البيع وخيار الإيجار والمخاطر المدعومة بالأدلة. لا تتوفر لدي حالياً خيارات بشروط تجارية حديثة ومعتمدة تكفي لإعداد قائمة موثقة.`
    : `That's fine — you're open, so I'll do the filtering for you. With around AED ${budget} for investment, I'll compare entry price, project stage, area development, documented catalysts, product differences, payment structure, cash exposure, handover timing, competing supply, resale evidence, rental fallback where supported, and factual risks. I don't currently have enough approved, current commercial evidence to present a useful shortlist.`;
  let question = null;
  if (buyer.cashAvailableAed == null && !isFlexiblePreference(buyer, "cashAvailableAed")) {
    question = { field: "cashAvailableAed", prompt: ar
      ? "ما المبلغ النقدي الذي تريد تخصيصه للدفعة الأولى؟"
      : "What initial cash amount should I use when checking payment commitments?" };
  } else if ((!buyer.financing || buyer.financing === "unknown") && !isFlexiblePreference(buyer, "financing")) {
    question = { field: "financing", prompt: ar
      ? "هل تفضل الدفع النقدي أم الرهن العقاري أم خطة سداد من المطور؟"
      : "Do you prefer cash, mortgage, or a developer payment plan?" };
  }
  const unavailable = catalogError ? ar ? " التحقق الحالي من العقارات غير متاح." : " The current property check is unavailable." : "";
  return draft([text + unavailable, question?.prompt].filter(Boolean).join(" "), "advisor_discovery", question);
}

/** General strategy advice uses no property claims and works with no units. */
export function investmentGuidance({ buyer, message = "", hasCommercialOptions = false, catalogError = null }) {
  if (buyer.useType !== "investment") return null;
  const text = String(message).toLowerCase();
  const profile = buildInvestmentStrategy(buyer);
  if (profile.advisorLedDiscovery) {
    return hasCommercialOptions ? null : advisorLedDiscoveryGuidance({ buyer, catalogError });
  }
  const ar = buyer.language === "ar";
  const say = (en, arabic) => ar ? arabic : en;
  const roi = /\b(?:roi|return on investment|best returns?|strongest investment)\b|أفضل عائد/.test(text);
  const growthAnswer = /^(?:capital\s+)?(?:growth|appreciation)[.!?]*$/.test(text.trim()) || /^(?:نمو رأس المال|النمو)[.!؟?]*$/.test(text.trim());
  const strategyAnswer = /\b(?:sell|exit|hold|holding|handover)\b/.test(text) || /التسليم|احتفاظ|أحتفظ/.test(text);
  const immediate = buyer.incomeRequirement === "immediate";
  if (roi || growthAnswer || (!hasCommercialOptions && (strategyAnswer || /rental income.*(?:day one|immediate)|income.*now/.test(text) || /^(?:show|recommend|find).*(?:options?|properties|projects)|^what.*(?:recommend|buy)/.test(text)))) {
    let advice;
    if (immediate) advice = say("For rental income from day one, I'd focus on ready property and compare documented rent, service charges, vacancy and purchase costs. Off-plan cannot provide rent before handover.", "لدخل إيجاري من اليوم الأول، أركز على العقارات الجاهزة وأقارن الإيجارات الموثقة ورسوم الخدمة والشغور وتكاليف الشراء. العقار قيد الإنشاء لا يحقق إيجاراً قبل التسليم.");
    else if (profile.strategy === "HANDOVER_EXIT" || profile.strategy === "OFF_PLAN_APPRECIATION" && buyer.exitHorizon === "before_handover") advice = say("For that exit strategy, entry timing, cash deployed before sale, competing handovers and resale liquidity matter most. I'd compare documented entry prices and release stages alongside the payment commitments; higher later-phase pricing alone would not prove your resale profit.", "لهذا التوقيت، أهم ما أقارنه هو سعر وتوقيت الدخول والمبالغ المدفوعة قبل البيع والمعروض عند التسليم وسيولة إعادة البيع. ارتفاع سعر مرحلة لاحقة وحده لا يثبت ربح إعادة البيع.");
    else if (profile.strategy === "LONG_TERM_HOLD") advice = say("For a longer hold, I'd put more weight on the area's development, product quality, competing supply and tenant or end-user appeal. Rental income after handover can be a fallback, but the rent and ownership costs need evidence before comparing returns.", "للاحتفاظ لمدة أطول، أعطي وزناً أكبر لتطور المنطقة وجودة المنتج والمعروض المنافس وملاءمته للمستأجر أو الساكن. الإيجار بعد التسليم قد يكون خياراً، لكن مقارنة العائد تحتاج إيجاراً وتكاليف موثقة.");
    else if (growthAnswer) advice = say("Then I'd prioritize appreciation as the main return driver. I'd compare entry point, release stage, surrounding development, payment structure and eventual resale competition.", "إذن أركز على نمو القيمة كمصدر أساسي للعائد. أقارن سعر الدخول ومرحلة الإطلاق والتطور المحيط وخطة السداد والمنافسة عند إعادة البيع.");
    else advice = say("I'd treat ROI as the overall investment return: appreciation plus rental income, less costs. For off-plan, I'd compare entry price, project and area stage, cash deployment, future supply and resale competition.", "العائد الاستثماري يشمل نمو القيمة ودخل الإيجار بعد خصم التكاليف. في العقارات قيد الإنشاء، أقارن سعر الدخول ومرحلة المشروع والمنطقة والمبالغ المدفوعة والمعروض والمنافسة عند إعادة البيع.");
    if (!hasCommercialOptions && (buyer.exitHorizon || immediate)) advice += say(" I don't have a current commercial unit to quote, but we can still compare project positioning and build the investment case.", " لا أملك وحدة بشروط تجارية حالية لأعرضها، لكن يمكننا مقارنة توجه المشاريع وبناء فكرة الاستثمار.");
    if (catalogError) advice += say(" The current property check is unavailable.", " التحقق من العقارات غير متاح حالياً.");
    const question = exitQuestion(buyer);
    return draft([advice, question?.prompt].filter(Boolean).join(" "), "investment_advice", question);
  }
  return null;
}

export function performanceQuestion(message, buyer) {
  if (!/\b(?:will|expect|guarantee|promise|could)\b.{0,65}\b(?:appreciat|grow|return)|\bappreciat\w*\b.{0,30}\d|(?:سيرتفع|مضمون|تتوقع).*\d/i.test(message)) return null;
  return draft(buyer.language === "ar"
    ? "لا أستطيع وعدك بزيادة مستقبلية. أسعار الإطلاق والمراحل اللاحقة الموثقة تصف ما حدث؛ سيناريو بيع افتراضي يحتاج افتراضات واضحة ولا يمثل توقعاً. أراجع سعر الدخول والتكاليف والتوقيت والسيولة قبل الحكم على الفرصة."
    : "I wouldn't promise a future increase. Sourced launch and later-release prices describe historical observations; a hypothetical resale calculation needs explicit assumptions and is not a forecast. I'd assess entry price, costs, timing and liquidity before judging the opportunity.", "investment_risk");
}

export function investmentRiskReply({ buyer, thesis = null }) {
  const ar = buyer.language === "ar";
  // Risk codes describe an evidenced exposure or a specific missing input. They
  // must never turn an unknown into a claim that competing supply exists.
  const labels = {
    high_handover_balloon: "a large documented payment at handover",
    concentrated_handover_cash_exposure: "a large documented payment at handover",
    historical_price_increase_not_resale_profit: "historical developer pricing that does not establish resale profit",
    competing_supply: "documented competing supply around the intended exit",
    limited_resale_evidence: "limited comparable resale evidence",
    payment_schedule_unknown: "an incomplete dated payment schedule",
    liquidity_unknown: "missing resale transaction depth",
    supply_unknown: "missing evidence about competing supply at your exit",
    costs_unknown: "missing ownership and exit costs"
  };
  const codes = (thesis?.riskCase || []).map(r => typeof r === "string" ? r : r.code);
  const unknownLabels = { reconciled_payment_schedule: "an incomplete dated payment schedule", resale_transaction_depth: "missing comparable resale transaction depth", competing_supply_and_handover_clustering: "missing evidence about competing supply at your exit", net_rental_income_and_costs: "missing ownership and exit costs" };
  const risks = [...new Set([...codes.map(code => labels[code]), ...(thesis?.unknowns || []).map(key => unknownLabels[key])].filter(Boolean))].slice(0, 3);
  const gap = risks.length ? risks.join(", ") : "the payment exposure at handover, competing stock at your exit, resale liquidity and ownership or exit costs";
  return draft(ar
    ? "أراجع التزامات السداد عند التسليم والمعروض المنافس وسيولة إعادة البيع وتكاليف الملكية والبيع. لا أملك دليلاً كافياً لأحكم على كل هذه المخاطر للمشروع، ولن أعتبر غياب البيانات دليلاً على انخفاض المخاطر."
    : `I'd check ${gap}. Missing project evidence leaves the risk unknown; I'd resolve those gaps before a purchase decision rather than assume a smooth exit.`, "investment_risk");
}
