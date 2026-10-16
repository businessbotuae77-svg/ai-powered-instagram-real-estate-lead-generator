import { answerFactQuestion } from "./fact-answers.js";
import { resolveAffirmation, isAffirmation } from "./affirmation.js";
import { bedroomOptionsFromMatches, canPitchBuyer } from "./match-resolve.js";
import { renderProjectIntro, renderProjectCard } from "./project-copy.js";
import { nextQualificationQuestion, isCoreQualified } from "./qualify.js";
import { choicesForField } from "./choices.js";
import { comparisonReply } from "./comparison-reply.js";
import { exitQuestion } from "./investment-guidance.js";
import { isFlexiblePreference } from "./preference-state.js";
import { areaPitchSentence, findAreaEntry, loadAreaGuide } from "../facts/area-guide.js";
import { packPaymentStages } from "../facts/payment-stages.js";
import { isAdvisorLedDiscovery } from "./investment-strategy.js";
import { welcomeChoices } from "./welcome.js";
import { budgetChoices, budgetPrompt, cardChoices, cardReason, comparablePacks, compactLine, NEXT_PROMPT, projectCard, welcomeText, WELCOME_PROMPT } from "./concierge.js";

/** Pure greeting with no other request in the same message. */
export function isGreetingOnly(message) {
  return /^\s*(hi|hello|hey|good\s+(morning|afternoon|evening)|salam|assalamu?\s*alaikum)[!?.]*\s*$/i.test(
    String(message || "")
  );
}

export function buildConversationReply({
  buyer,
  message = "",
  intents = [],
  packs = [],
  matches = [],
  matchMode = "none",
  mismatches = [],
  highIntent = false,
  offerCallRequest = false,
  pendingOffer = null,
  unsure = [],
  ack = null,
  lastAskedField = null,
  updatedFields = []
}) {
  const lines = [];
  const declineContact = intents.includes("decline_contact") || intents.includes("decline_call") || Boolean(buyer.contactDeclined);
  let nextPending = null;
  let nextQuestion = null;
  let callRequest = null;

  const ar = buyer.language === "ar";
  if (intents.includes("start_fresh")) {
    lines.push(welcomeText({ ar, fresh: true }));
    nextQuestion = { field: "explorationTopic", prompt: ar ? WELCOME_PROMPT.ar : WELCOME_PROMPT.en, choices: welcomeChoices(ar) };
    return finish(lines, "exploring", nextQuestion, null);
  }

  if (intents.includes("decline_call")) {
    lines.push("No problem. I can keep sharing confirmed details here.");
  }

  if (intents.includes("greet")) {
    lines.push("Hi. Happy to help with Abu Dhabi off-plan options.");
  }
  if (intents.includes("thanks")) {
    lines.push("Glad to help.");
  }
  if (intents.includes("decline_contact") && !intents.includes("decline_call")) {
    lines.push(/\b(phone|number|whatsapp|call)\b/i.test(message) ? "No problem. We can keep looking without a phone number." : "No problem. We can keep going without that.");
  }
  if (ack && !ar) {
    lines.push(ack);
  }
  if (intents.includes("decline_reserve")) {
    lines.push("No reservation on my side. We can keep reviewing confirmed options.");
  }

  // Explicit human help → Request a Call with phone input. No alert until submitted.
  if (offerCallRequest && !declineContact && !intents.includes("call_submitted")) {
    if (buyer.phone) {
      lines.push(
        "I can put in a call request with the number I already have on file. Use Request a Call below to confirm, or send a different number."
      );
    } else {
      lines.push("I can connect you with an advisor. Enter the number you would like us to call, then tap Request Call.");
    }
    callRequest = {
      offered: true,
      title: "Request a Call",
      prompt: "Enter the number you would like us to call:",
      submitLabel: "Request Call",
      phone: buyer.phone || null
    };
    nextPending = { type: "call_request", reason: "buyer_requested_human_help" };
    nextQuestion = {
      field: "phone",
      prompt: "Enter the number you would like us to call:",
      choices: null,
      inputType: "tel"
    };
    // Still allow property context in the same turn when we already have matches.
    if ((canPitchBuyer(buyer) || Boolean(buyer.projectInterest)) && packs.length) {
      const intro = renderProjectIntro({
        buyer,
        packs,
        mode: matchMode,
        mismatches
      });
      if (intro) lines.unshift(intro);
    }
    return finish(lines, "call_offer", nextQuestion, nextPending, callRequest);
  }

  // "Hi" alone must not dump a soft match from an earlier test session.
  if (isGreetingOnly(message) && intents.includes("greet") && !intents.includes("continue")) {
    if (canPitchBuyer(buyer) || Boolean(buyer.projectInterest)) {
      const prompt = ar ? "تبي نكمل من وين وقفنا، ولا نبدأ من جديد؟" : "Want to pick up where we left off, or start fresh?";
      const name = buyer.firstName ? ` ${buyer.firstName}` : "";
      lines.length = 0;
      lines.push(ar ? `هلا فيك من جديد${name} 👋 ${prompt}` : `Welcome back${name} 👋 ${prompt}`);
      nextQuestion = {
        field: "session_choice",
        prompt,
        choices: [
          { id: "continue", label: ar ? "نكمل" : "Continue", value: "Continue" },
          { id: "start_fresh", label: ar ? "بداية جديدة" : "Start fresh", value: "Start fresh" }
        ]
      };
      nextPending = { type: "session_choice" };
      return finish(lines, "welcome_back", nextQuestion, nextPending);
    }
    lines.length = 0;
    lines.push(welcomeText({ name: buyer.firstName || null, ar }));
    nextQuestion = { field: "explorationTopic", prompt: ar ? WELCOME_PROMPT.ar : WELCOME_PROMPT.en, choices: welcomeChoices(ar) };
    return finish(lines, "qualifying", nextQuestion, null);
  }

  const unresolvedUnsure = unsure.filter(field => !isFlexiblePreference(buyer, field) &&
    !(field === "area" && (buyer.openToOtherAreas || buyer.intentSignals?.includes("area_flexible"))));
  if (unresolvedUnsure.length) {
    const unsureReply = buildUnsureFollowUp(buyer, unresolvedUnsure);
    if (unsureReply.text) lines.push(unsureReply.text);
    nextQuestion = unsureReply.nextQuestion;
    return finish(lines, "qualifying", nextQuestion, null);
  }

  if (isAffirmation(message) && pendingOffer) {
    const resolved = resolveAffirmation(pendingOffer, message);
    if (resolved?.clarify) {
      lines.push(resolved.clarify.prompt);
      nextQuestion = {
        field: resolved.clarify.field,
        prompt: resolved.clarify.prompt,
        choices: resolved.clarify.choices
      };
      nextPending = pendingOffer;
      return finish(lines, "clarify", nextQuestion, nextPending);
    }
  }

  if (intents.includes("ask_facts") && packs.length) {
    const factAsk = answerFactQuestion(message, packs);
    if (factAsk.handled) {
      lines.push(factAsk.text);
      return finish(lines, "fact_answer", null, pendingOffer);
    }
  }

  const readyToPitch = canPitchBuyer(buyer) || Boolean(buyer.projectInterest);

  if (readyToPitch && packs.length) {
    const answeringFollowUp =
      matchMode === "exact" &&
      ((lastAskedField === "financing" && updatedFields.includes("financing")) ||
        (lastAskedField === "cashAvailableAed" && updatedFields.includes("cash")));
    if (!answeringFollowUp) {
      const intro = renderProjectIntro({
        buyer,
        packs,
        mode: matchMode,
        mismatches
      });
      if (intro) lines.push(intro);
    }

    const followUp = buildContextualFollowUp(buyer, matches, packs, {
      lastAskedField,
      updatedFields
    });
    if (followUp.text) lines.push(followUp.text);
    nextQuestion = followUp.nextQuestion;
    nextPending = followUp.pendingOffer;

    return finish(lines, matchMode === "exact" ? "matched" : "soft_match", nextQuestion, nextPending);
  }

  if (readyToPitch && !packs.length) {
    if (isFlexiblePreference(buyer, "preferredAreas") || isFlexiblePreference(buyer, "bedrooms") || isFlexiblePreference(buyer, "propertyTypes")) {
      return finish([...lines, "I'll keep those preferences open. I don't have a current listing that I can responsibly put forward from the details available yet."], "no_match", null, null);
    }
    const requestedArea = buyer.preferredAreas?.[0];
    lines.push(
      requestedArea
        ? `I do not have a confirmed option in ${requestedArea} that fits the requirements you shared. I can check a nearby bedroom size there, or compare another Abu Dhabi area with verified stock.`
        : "I do not have a confirmed option that fits those details yet. I can look at nearby bedroom sizes or another Abu Dhabi area with verified stock."
    );
    nextQuestion = {
      field: "preferredAreas",
      prompt: "Want me to check another area, or loosen the bedroom size?",
      choices: [
        ...(choicesForField("preferredAreas")?.choices || []),
        { id: "loosen_beds", label: "Show nearby bedroom sizes", value: "nearby bedrooms" }
      ]
    };
    return finish(lines, "no_match", nextQuestion, null);
  }

  // Not enough to pitch yet: one short question with buttons, in the buyer's language.
  const question = nextQualificationQuestion(buyer, {
    includeCash: false,
    includeFinancing: false
  });
  if (ar) lines.length = 0;
  const answered = lastAskedField === "useType" ? USE_ACK[buyer.useType] : null;
  if (answered) lines.push(ar ? answered[1] : answered[0]);
  // A home to live in starts with the size the family needs, then the budget.
  const needsSize = buyer.useType === "end_use" && !buyer.bedrooms?.length && !buyer.propertyTypes?.length && lastAskedField !== "bedrooms" &&
    !isFlexiblePreference(buyer, "bedrooms") && !isFlexiblePreference(buyer, "propertyTypes");
  if (needsSize) {
    const prompt = ar ? "كم غرفة نوم تحتاج؟" : "How many bedrooms do you need?";
    lines.push(prompt);
    nextQuestion = { field: "bedrooms", prompt, choices: choicesForField("bedrooms", ar ? "ar" : "en")?.choices || null };
  } else if (!buyer.budgetAed && !isFlexiblePreference(buyer, "budgetAed")) {
    const prompt = budgetPrompt(ar);
    lines.push(prompt);
    nextQuestion = { field: "budgetAed", prompt, choices: budgetChoices(ar) };
  } else if (!(buyer.preferredAreas?.length || buyer.projectInterest) && !isFlexiblePreference(buyer, "preferredAreas")) {
    const areaGroup = choicesForField("preferredAreas", ar ? "ar" : "en");
    const flexible = buyer.openToOtherAreas || buyer.intentSignals?.includes("area_flexible");
    const prompt = flexible ? (ar ? "كم غرفة نوم تناسبك؟" : question?.prompt || "What size works best for you?")
      : (ar ? "أي منطقة تفضّل؟" : "Which area are you leaning toward?");
    lines.push(prompt);
    nextQuestion = flexible && question ? { ...question, prompt, choices: choicesForField(question.field, ar ? "ar" : "en")?.choices || question.choices }
      : { field: "preferredAreas", prompt, choices: areaGroup?.choices || null };
  } else {
    lines.push(question?.prompt || "I'll work with the preferences you've shared and keep the remaining choices open.");
    nextQuestion = question;
  }

  return finish(lines, "qualifying", nextQuestion, null);
}

// "To live in", "Investment", "Not sure yet": a word back before the next question.
const USE_ACK = {
  investment: ["Investment, got it 👍", "للاستثمار، تمام 👍"],
  end_use: ["A home to live in, lovely 🏡", "للسكن، حلو 🏡"],
  unknown: ["No problem, we'll work it out together.", "ولا يهمك، نحددها مع بعض."]
};

export function budgetRangeChoices() {
  return [
    { id: "1_5m", label: "Around AED 1.5M", value: "around 1.5M" },
    { id: "2m", label: "Around AED 2M", value: "around 2M" },
    { id: "3m", label: "Around AED 3M", value: "around 3M" },
    { id: "5m", label: "AED 5M+", value: "budget 5M+" }
  ];
}

function buildUnsureFollowUp(buyer, unsureFields) {
  const field = unsureFields[0] || (!buyer.budgetAed ? "budget" : !buyer.preferredAreas?.length ? "area" : "bedrooms");

  if (field === "budget" || (!buyer.budgetAed && field !== "area" && field !== "bedrooms" && field !== "cash")) {
    return {
      text: "Want to pick a rough range so I can show confirmed options?",
      nextQuestion: {
        field: "budgetAed",
        prompt: "Want to pick a rough range so I can show confirmed options?",
        choices: budgetRangeChoices()
      }
    };
  }

  if (field === "area" || (!(buyer.preferredAreas?.length || buyer.projectInterest) && field !== "bedrooms" && field !== "cash")) {
    const areaGroup = choicesForField("preferredAreas");
    return {
      text: "Any area you want to start with, or should I keep it flexible across Abu Dhabi?",
      nextQuestion: {
        field: "preferredAreas",
        prompt: "Any area you want to start with?",
        choices: [
          ...(areaGroup?.choices || []),
          { id: "flexible", label: "Keep area flexible", value: "open to other areas" }
        ]
      }
    };
  }

  if (field === "cash") {
    return {
      text: "Any rough figure for the initial payment, even a ballpark?",
      nextQuestion: {
        field: "cashAvailableAed",
        prompt: "Any rough figure for the initial payment?",
        choices: [
          { id: "100k", label: "About AED 100k", value: "put down about 100k" },
          { id: "300k", label: "About AED 300k", value: "put down about 300k" },
          { id: "500k", label: "About AED 500k", value: "put down about 500k" }
        ]
      }
    };
  }

  return {
    text: "Studio, 1, 2, or 3 bedrooms?",
    nextQuestion: {
      field: "bedrooms",
      prompt: "Studio, 1, 2, or 3 bedrooms?",
      choices: [
        { id: "0", label: "Studio", value: "studio" },
        { id: "1", label: "1 bedroom", value: "1 bedroom" },
        { id: "2", label: "2 bedrooms", value: "2 bedrooms" },
        { id: "3", label: "3 bedrooms", value: "3 bedrooms" }
      ]
    }
  };
}

function buildContextualFollowUp(buyer, matches, packs, { lastAskedField = null, updatedFields = [] } = {}) {
  const hasBeds = Boolean(buyer.bedrooms?.length);
  const beds = bedroomOptionsFromMatches(matches);
  const justCorrectedCore = updatedFields.some((field) =>
    ["budget", "area", "bedrooms"].includes(field)
  );
  const divertedFromCash =
    buyer.cashAvailableAed == null &&
    (justCorrectedCore ||
      (lastAskedField === "cashAvailableAed" &&
        updatedFields.some((field) => ["budget", "area", "bedrooms", "financing"].includes(field))));

  if (!hasBeds && beds.length && !isFlexiblePreference(buyer, "bedrooms") && !isFlexiblePreference(buyer, "propertyTypes")) {
    if (beds.length === 1) {
      return {
        text: `I can open the ${beds[0] === 0 ? "studio" : `${beds[0]} bedroom`} option in more detail if you want.`,
        nextQuestion: {
          field: "bedrooms",
          prompt: "Want me to open that size?",
          choices: [
            {
              id: String(beds[0]),
              label: beds[0] === 0 ? "Studio" : `${beds[0]} bedroom${beds[0] === 1 ? "" : "s"}`,
              value: beds[0]
            }
          ]
        },
        pendingOffer: {
          type: "bedroom_choice",
          options: beds,
          clarifyPrompt: "Should I open that size?"
        }
      };
    }

    const labels = beds.map((n) => (n === 0 ? "studio" : `${n}BR`));
    const compareLabel =
      beds.length === 2 ? "should I show you both" : "should I compare the available sizes";
    const prompt = `Are you looking for ${labels.slice(0, -1).join(", ")} or ${labels.at(-1)}, or ${compareLabel}?`;
    return {
      text: prompt,
      nextQuestion: {
        field: "bedrooms",
        prompt,
        choices: [
          ...beds.map((n) => ({
            id: String(n),
            label: n === 0 ? "Studio" : `${n} bedroom${n === 1 ? "" : "s"}`,
            value: n
          })),
          { id: "both", label: "Show both", value: "both" }
        ]
      },
      pendingOffer: {
        type: "bedroom_choice",
        options: beds,
        clarifyPrompt: `Which size should I open: ${labels.join(" or ")}?`
      }
    };
  }

  // Buyer changed budget/area/beds this turn: show options first. Ask cash on a later turn.
  if (divertedFromCash) {
    if ((!buyer.financing || buyer.financing === "unknown") && !isFlexiblePreference(buyer, "financing")) {
      const financing = choicesForField("financing");
      return {
        text: financing?.prompt || "Do you prefer cash, mortgage, or a payment plan?",
        nextQuestion: {
          field: "financing",
          prompt: financing?.prompt || "Do you prefer cash, mortgage, or a payment plan?",
          choices: financing?.choices || null
        },
        pendingOffer: null
      };
    }
    return { text: null, nextQuestion: null, pendingOffer: null };
  }

  if (buyer.cashAvailableAed == null && !isFlexiblePreference(buyer, "cashAvailableAed")) {
    return {
      text: "How much cash can you put in for the initial payment?",
      nextQuestion: {
        field: "cashAvailableAed",
        prompt: "How much cash can you put in for the initial payment?",
        choices: null
      },
      pendingOffer: null
    };
  }

  if ((!buyer.financing || buyer.financing === "unknown") && !isFlexiblePreference(buyer, "financing")) {
    const financing = choicesForField("financing");
    return {
      text: financing?.prompt || "Do you prefer cash, mortgage, or a payment plan?",
      nextQuestion: {
        field: "financing",
        prompt: financing?.prompt || "Do you prefer cash, mortgage, or a payment plan?",
        choices: financing?.choices || null
      },
      pendingOffer: null
    };
  }

  const primaryFit = packs[0]?.fit;
  if (primaryFit?.tier === "strong_with_compromise") {
    const project = packs[0]?.name?.value || "this option";
    const financeGap = primaryFit.compromises.some((row) =>
      ["cash", "payment_plan"].includes(row.key)
    );
    return {
      text: financeGap
        ? `Would you like to explore ${project} despite the financing gap, or should I compare options with a lower initial payment?`
        : `Would you like to explore ${project} despite that compromise, or compare another option?`,
      nextQuestion: {
        field: "tradeoff",
        prompt: "Explore this option or compare alternatives?",
        choices: null
      },
      pendingOffer: null
    };
  }

  if (primaryFit?.tier === "nearby") {
    const project = packs[0]?.name?.value || "this option";
    return {
      text: `Want to explore ${project} with that trade-off, or keep looking for a closer fit?`,
      nextQuestion: {
        field: "tradeoff",
        prompt: "Explore this option or keep looking?",
        choices: null
      },
      pendingOffer: null
    };
  }

  if (packs.length > 1 && isCoreQualified(buyer)) {
    const names = [...new Set(packs.map((pack) => pack.name.value))];
    if (names.length > 1) {
      return {
        text: "Want me to compare these side by side, or focus on one?",
        nextQuestion: {
          field: "projectInterest",
          prompt: "Which project should I focus on?",
          choices: names.map((name) => ({ id: name, label: name, value: name }))
        },
        pendingOffer: {
          type: "project_choice",
          options: names.map((name) => ({ id: name, name }))
        }
      };
    }
  }

  return { text: null, nextQuestion: null, pendingOffer: null };
}

function finish(lines, stage, nextQuestion, pendingOffer, callRequest = null) {
  return {
    text: lines.filter(Boolean).join("\n\n"),
    stage,
    nextQuestion: nextQuestion || null,
    pendingOffer: pendingOffer || null,
    callRequest: callRequest || null,
    handoffRequired: false
  };
}

export function fallbackSafeText(packs, { language = "en", topic = null } = {}) {
  const ar = language === "ar";
  const labels = ar
    ? { availability: "التوفر الحالي", price: "السعر الحالي", initial: "الدفعة الأولى", paymentPlan: "خطة السداد", handover: "موعد التسليم", rent: "الإيجارات والتكاليف" }
    : { availability: "Current availability", price: "The current price", initial: "The initial payment", paymentPlan: "The payment plan", handover: "The handover date", rent: "Rental figures and costs" };
  const gap = labels[topic];
  const rows = packs.map(pack => {
    const beds = pack.bedrooms?.confirmed ? pack.bedrooms.value : null;
    const unit = beds === 0 ? (ar ? "استوديو" : "studio") : beds != null ? (ar ? `${beds} غرف نوم` : `${beds} bedroom`) : null;
    const price = pack.startingPriceText?.confirmed ? (ar ? `، يبدأ من ${pack.startingPriceText.value}` : `, from ${pack.startingPriceText.value}`) : "";
    return `${pack.name.value}${unit ? ` (${unit})` : ""}${price}.`;
  });
  const notice = gap ? (ar ? `${gap} يحتاج تحققاً حديثاً قبل تأكيده.` : `${gap} needs a current check before I can confirm it.`)
    : (ar ? "تفاصيل الإجابة تحتاج تحققاً إضافياً." : "The requested details need another check.");
  const prompt = packs.length ? (ar ? "تبي نراجع تفاصيل الوحدة المؤكدة هنا؟" : "Want me to review the confirmed unit details here?")
    : (ar ? "أي مشروع تبي أراجعه؟" : "Which project would you like me to check?");
  return [...rows, notice, prompt].join("\n");
}

/** Natural offline composition of the same deterministic advisory strategy. */
// Buyer-facing lead-ins for a second option. Internal opportunity types such as
// "challenger" or "smart_upgrade" never reach the customer.
const ALTERNATIVE_LEADS = {
  smart_upgrade: "One step up",
  lower_cost_alternative: "A lower-cost option",
  easier_payment_alternative: "An option with a lower upfront payment",
  better_timing_alternative: "An option with different timing",
  cash_flow_alternative: "A ready option for rental income",
  growth_alternative: "An off-plan alternative"
};

const OBJECTION_LEADS = {
  too_expensive: "Understood. Let's bring the entry price down without losing what matters to you.",
  initial_payment_too_high: "Understood. I'll keep the upfront payment lower.",
  too_small: "Got it, more space matters.",
  too_large: "Understood, something smaller.",
  handover_too_late: "Understood, timing matters. I'll weigh an earlier handover.",
  handover_too_soon: "Understood. A later handover gives you more time.",
  wrong_area: "Noted. I'll set that area aside.",
  wrong_property_type: "Noted. I'll look at a different property type.",
  payment_plan_bad: "Understood. I'll look for a payment structure that suits you better.",
  developer_concern: "Fair concern. Before committing to any developer, check their completed projects and the delivery and delay terms in the sale contract."
};

function objectionLead(category, message) {
  if (category === "developer_concern" && /\bdelay|late|on time|deliver/i.test(message)) {
    return "That's a fair concern with off-plan. A ready home removes construction-delay risk but needs much more cash upfront. For off-plan, check the developer's record on completed projects and the delay terms in the sale contract.";
  }
  return OBJECTION_LEADS[category];
}

const MORE_SPACE = /\b(?:bigger|larger|more space|extra bedroom|more bedrooms)\b/i;
const WHY_QUESTION = /^(?:why|how come)\b|\bwhy (?:that|this|it|not)\b|\bwhat makes (?:it|that|this)\b|\bwhy do you (?:prefer|recommend|like)\b/i;

export function buildAdvisorReply({ buyer, advisor, strategy, message = "", turnObjections = [], lastAskedField = null, askedFields = new Set(), activePack = null }) {
  if (strategy.type === "resolve_objection") {
    const labels = {
      initial_payment_too_high: "a lower documented initial payment", too_expensive: "a lower entry price",
      wrong_area: "a different area", wrong_property_type: "a different property type", too_small: "more space",
      too_large: "a smaller home", handover_too_late: "an earlier documented handover", handover_too_soon: "a later documented handover",
      payment_plan_bad: "a more suitable documented payment structure", developer_concern: "a different developer"
    };
    return { text: buyer.language === "ar" ? "سأستبعد الخيار الذي رفضته. لا أملك حالياً بديلاً يعالج هذا الاعتراض ويلبي متطلباتك الأخرى، ولن أضغط عليك." :
      `I'll set the option you rejected aside. I don't have an alternative with ${labels[strategy.objection] || "a solution to that concern"} that meets your other requirements right now.`,
      stage: "objection_unresolved", nextQuestion: null, pendingOffer: null, callRequest: null };
  }
  if (strategy.type === "trust_check") {
    const prompt = buyer.language === "ar" ? "ما الذي تريد التحقق منه: تفاصيل المشروع أم الأسعار أم إجراءات الشراء؟" : "What would you like to verify first — the project details, the figures, or the buying process?";
    const answer = buyer.language === "ar"
      ? "سؤال في محله. أنا مساعد عقاري آلي، والأرقام التي أشاركها من قوائمنا الحالية، ولا يتم حجز أو دفع أي شيء عبر هذه المحادثة."
      : "That's a fair question. I'm an automated property guide, the figures I share come from our current listings, and nothing is reserved or paid through this chat.";
    return { text: `${answer} ${prompt}`, stage: "trust_check", nextQuestion: { field: "trustConcern", prompt }, pendingOffer: null, callRequest: null };
  }
  // A budget is enough to show a first option; strategy can follow the project.
  if (strategy.type === "recommend" && buyer.budgetAed && !buyer.shownProjects?.length &&
      !buyer.investmentGoal && !buyer.investmentObjective && !buyer.preferredAreas?.length &&
      !buyer.projectInterest && !buyer.bedrooms?.length && !buyer.propertyTypes?.length) {
    const pack = advisor.packs.find(p => p.projectId === advisor.primary?.projectId && p.unitId === advisor.primary?.unitId);
    if (pack?.startingPriceAed?.confirmed && pack.startingPriceAed.value <= buyer.budgetAed &&
        pack.bedroomLabel?.confirmed && pack.propertyType?.confirmed && pack.area?.confirmed &&
        !advisor.primary.tradeoffs?.length) {
      const ar = buyer.language === "ar";
      const reason = cardReason({ pack, comparable: comparablePacks(advisor), buyer, ar });
      const text = `${ar ? "لقيت لك مشروع يناسب ميزانيتك 👇" : "I found a project that fits your budget 👇"}\n\n${projectCard(pack, { ar, reason, units: advisorUnits(advisor) })}`;
      const single = { ...advisor, challenger: null, matches: advisor.matches.filter(m => m.project.id === pack.projectId && m.unit.id === pack.unitId) };
      return cardDraft(text, single, [pack], ar);
    }
  }
  if (buyer.language === "ar") return buildArabicAdvisorReply({ buyer, advisor, strategy, message });
  if (strategy.type === "no_push") return {
    text: "Take your time. We can pick this up whenever you're ready.", stage: "paused_advice",
    nextQuestion: null, pendingOffer: null, callRequest: null
  };
  const primary = advisor.primary;
  if (!primary) return null;
  const primaryPack = advisor.packs.find(p => p.projectId === primary.projectId && p.unitId === primary.unitId);
  if (!primaryPack) return null;
  const name = primaryPack.name.value;
  if (strategy.type === "transaction_prep") {
    const prompt = "Want me to check the current availability before we discuss the next step?";
    return advisorDraft(`Let's focus on ${name}. The next step is to check its current availability and the applicable offer and EOI terms; nothing has been reserved or submitted.`, advisor, "availability", prompt);
  }
  if (strategy.type === "compare" && advisor.comparison) {
    const text = comparisonReply(advisor.comparison, { preferredName: name });
    return advisorDraft(text, advisor, "payment_details", "Want me to break down the payment commitments?");
  }
  if (strategy.type === "answer_action") {
    // A "yes" answers about the listing the buyer was actually shown last.
    const shown = activePack && activePack.unitId !== primaryPack.unitId ? activePack : null;
    if (shown && strategy.nextAction !== "compare") {
      const exposure = { projectIds: [shown.projectId], primaryProjectId: shown.projectId, primaryUnitId: shown.unitId, upgradeProjectId: null };
      const result = strategy.nextAction === "availability"
        ? advisorDraft(answerFactQuestion("availability", [shown]).text, advisor, null, null, [shown])
        : advisorDraft(paymentBreakdown(shown), advisor, "availability", "Want me to check current availability?", [shown]);
      return { ...result, advisoryExposure: exposure };
    }
    if (strategy.nextAction === "compare") {
      return advisorDraft(comparisonReply(advisor.comparison, { preferredName: name }) || `For your priorities, I'd start with ${name}.`, advisor, "availability", "Want me to check current availability?");
    }
    if (strategy.nextAction === "availability") {
      return advisorDraft(answerFactQuestion("availability", [primaryPack]).text, advisor, null, null, [primaryPack]);
    }
    return advisorDraft(paymentBreakdown(primaryPack), advisor, "availability", "Want me to check current availability?", [primaryPack]);
  }
  const lines = [];
  const advisorLed = isAdvisorLedDiscovery(buyer);
  // Acknowledge a concern only in the turn it is raised, not on every later turn.
  const raised = turnObjections.find(category => OBJECTION_LEADS[category]);
  const reason = raised === "too_expensive" && primary.priceDifferenceAed < 0 ? "it keeps the entry price lower."
    : raised === "initial_payment_too_high" && primary.cashDifferenceAed < 0 ? "it needs less cash upfront."
      : cardReason({ pack: primaryPack, comparable: comparablePacks(advisor), buyer }) || legacyReason(primary.reasonCodes);
  const challenger = advisor.challenger;
  if (!raised && strategy.type === "recommend" && WHY_QUESTION.test(message)) {
    // Explain the reasoning; the cards were already shown.
    const why = cardReason({ pack: primaryPack, comparable: comparablePacks(advisor), buyer }) || legacyReason(primary.reasonCodes) || primaryReason(primary.reasonCodes, buyer, primaryPack);
    lines.push(`I lean towards ${name} because ${String(why).replace(/\.$/, "")}.`);
    const tradeoff = opportunityTradeoffs(primary, buyer);
    if (tradeoff) lines.push(tradeoff);
    const challengerPack = challenger && advisor.packs.find(p => p.projectId === challenger.projectId && p.unitId === challenger.unitId);
    if (challengerPack) {
      const benefit = opportunityBenefit(challenger);
      lines.push(`${challengerPack.name.value} is the alternative.${benefit ? ` ${benefit}` : ""}`);
    }
    return { ...advisorDraft(lines.join("\n"), advisor, null, null), allowsServiceSuggestion: true };
  }
  // Asked for more space but nothing larger fits: say so instead of ignoring it.
  const largerShown = challenger?.buyerBenefit?.some(b => ["additional_bedroom", "larger_supported_size_range"].includes(b.code));
  let lead = advisorLed && /\b(?:idk|don'?t know|do not know|not sure|unsure|no idea|you (?:choose|decide|pick)|up to you|either|anything)\b/i.test(message)
    ? "No problem, I'll pick for you 👇" : "Here's my top pick for you 👇";
  if (raised) lead = `${objectionLead(raised, message)} Here's what I'd suggest 👇`;
  else if (MORE_SPACE.test(message) && !largerShown) lead = "I don't have a larger option that fits your budget and other requirements right now. Here's the closest fit 👇";
  lines.push(lead, "", projectCard(primaryPack, { reason, units: advisorUnits(advisor) }));
  const notes = [];
  if (primary.comparedTo) {
    const benefit = opportunityBenefit(primary);
    if (benefit) notes.push(benefit);
  }
  const primaryTradeoff = opportunityTradeoffs(primary, buyer);
  if (primaryTradeoff) notes.push(primaryTradeoff);
  if (challenger) {
    const pack = advisor.packs.find(p => p.projectId === challenger.projectId && p.unitId === challenger.unitId);
    if (pack) {
      notes.push(`${ALTERNATIVE_LEADS[challenger.type] || "Also worth a look"}: ${compactLine(pack)}.`);
      const benefit = opportunityBenefit(challenger);
      if (benefit) notes.push(benefit);
      const tradeoffs = opportunityTradeoffs(challenger, buyer);
      if (tradeoffs) notes.push(tradeoffs);
    }
  }
  if (notes.length) lines.push("", ...notes);
  // A plain recommendation may carry one complementary service; never an objection answer.
  const allowsServiceSuggestion = strategy.type === "recommend" && !raised && !strategy.lowPressure && !challenger;
  if (strategy.lowPressure || isFlexiblePreference(buyer, "advisoryNextAction")) {
    return { ...advisorDraft(lines.join("\n"), advisor, null, null), allowsServiceSuggestion };
  }
  return { ...cardDraft(lines.join("\n"), advisor, advisor.packs, false), allowsServiceSuggestion };
}

/** A card reply: one open question with buttons for the next step. */
function cardDraft(text, advisor, packs, ar) {
  const prompt = ar ? NEXT_PROMPT.ar : NEXT_PROMPT.en;
  const draft = advisorDraft(text, advisor, null, null, packs);
  const shown = packs.find(pack => pack.projectId === advisor.primary?.projectId && pack.unitId === advisor.primary?.unitId) || packs[0];
  // "Yes" or "I like it" next means this home: the concierge offers the team that can reserve it.
  return { ...draft, text: `${text}\n\n${prompt}`, nextQuestion: { field: "conciergeNext", prompt, choices: cardChoices(ar) },
    pendingOffer: shown ? { type: "concierge_card", projectId: shown.projectId, unitId: shown.unitId } : null };
}

function advisorUnits(advisor) {
  return (advisor.candidates || []).map(row => row.unit).filter(Boolean);
}

// The advisor's own reason codes, when the listings give no clearer comparison.
function legacyReason(codes = []) {
  if (codes.includes("lower_initial_commitment_priority")) return "it needs the least cash upfront.";
  if (codes.includes("ready_income_route")) return "it's already completed, so you could rent it out sooner (check current rents first).";
  if (codes.includes("ready_move_in_route")) return "it's ready, which suits your move-in plans.";
  if (codes.includes("more_space_priority")) return "it gives your family more space.";
  if (codes.includes("off_plan_growth_route")) return "you buy at today's price and spread the payments until handover.";
  if (codes.includes("lower_entry_price_priority")) return "it keeps the entry price lower.";
  return null;
}

// "Break down the payment terms": every confirmed payment figure in one place,
// rather than the plan summary the buyer has already seen on the card.
function paymentBreakdown(pack) {
  const value = key => pack[key]?.confirmed && pack[key].value != null && pack[key].value !== "" ? pack[key].value : null;
  const aed = amount => `AED ${Number(amount).toLocaleString("en-US")}`;
  const rows = [];
  if (value("startingPriceAed") != null) rows.push(`• Starting price: ${aed(value("startingPriceAed"))}`);
  const booking = value("bookingAed") ?? value("downPaymentAed");
  if (booking != null) rows.push(`• Initial payment: ${aed(booking)}`);
  else if (value("downPaymentText")) rows.push(`• Initial payment: ${value("downPaymentText")}`);
  if (value("paymentPlanSummary")) rows.push(`• Plan: ${String(value("paymentPlanSummary")).replace(/\.$/, "")}`);
  const timed = [["cash30DaysAed", "Within 30 days"], ["cash6MonthsAed", "Within 6 months"], ["cash12MonthsAed", "Within 12 months"],
    ["cashBeforeHandoverAed", "Total before handover"], ["cashAtHandoverAed", "On handover"], ["cashAfterHandoverAed", "After handover"]]
    .filter(([key]) => value(key) != null);
  for (const [key, label] of timed) rows.push(`• ${label}: ${aed(value(key))}`);
  // Without a confirmed schedule, show the plan's stages on the starting price.
  const stages = timed.length ? [] : packPaymentStages(pack);
  for (const stage of stages) rows.push(`• ${stage.label} (${stage.percent}%): ${aed(stage.amountAed)}`);
  if (value("handover")) rows.push(`• Handover: ${value("handover")}`);
  if (!rows.length) return `${pack.name.value}: the payment terms are not published yet.`;
  const lines = [`Here's the payment picture for ${pack.name.value}${stages.length ? `, on the ${aed(value("startingPriceAed"))} starting price` : ""}:`, ...rows];
  if (!timed.length) lines.push("Exact instalment dates come from the developer's payment schedule, so confirm those before committing.");
  return lines.join("\n");
}

// What the area is known for, in one line, so a recommendation sells the location too.
function areaPitch(guide, area) {
  return areaPitchSentence(findAreaEntry(guide, area));
}

function advisorDraft(text, advisor, action, prompt, packs = advisor.packs) {
  return {
    text: [text, prompt].filter(Boolean).join("\n"),
    stage: advisor.matches[0]?.fit?.tier === "exact" ? "matched" : "soft_match",
    factPacks: packs,
    nextQuestion: prompt ? { field: "advisoryNextAction", prompt } : null,
    pendingOffer: action ? { type: "advisory_next_action", action } : null,
    callRequest: null,
    advisoryExposure: {
      projectIds: advisor.matches.map(m => m.project.id),
      primaryProjectId: advisor.primary.projectId, primaryUnitId: advisor.primary.unitId,
      upgradeProjectId: advisor.challenger?.type === "smart_upgrade" ? advisor.challenger.projectId : null,
      upgradeUnitId: advisor.challenger?.type === "smart_upgrade" ? advisor.challenger.unitId : null
    }
  };
}

function primaryReason(codes = [], buyer, pack) {
  if (codes.includes("lower_initial_commitment_priority")) return "it needs the least cash upfront";
  if (codes.includes("ready_income_route")) return "it's ready now, so it can be rented out straight away (I'd still check current rents before buying)";
  if (codes.includes("ready_move_in_route")) return "its ready status suits your move-in priority";
  if (codes.includes("more_space_priority")) return "it gives your family more space";
  if (codes.includes("off_plan_growth_route")) return "it is off-plan with a developer payment plan, so you buy at today's entry and spread payments to handover";
  if (codes.includes("lower_entry_price_priority")) return "it keeps the entry price lower";
  // Lead with what the buyer gets: the home, where it is, and how it is paid.
  const unit = pack.bedrooms?.value === 0 ? "a studio" : pack.bedrooms?.confirmed ? `a ${pack.bedrooms.value} bedroom ${pack.propertyType?.value || "home"}` : "a home";
  const area = pack.area?.confirmed ? `${/\bisland$/i.test(pack.area.value) ? "on" : "in"} ${pack.area.value}` : "";
  const split = pack.paymentPlanSummary?.confirmed ? String(pack.paymentPlanSummary.value).match(/\b\d{1,2}\s*\/\s*\d{1,2}\b/)?.[0] : null;
  const preferred = buyer.preferredAreas?.includes(pack.area?.value) ? " in the area you want" : "";
  return `it gives you ${unit} ${area}${preferred}${split ? ` on a ${split.replace(/\s/g, "")} payment plan` : ""}`.replace(/\s+/g, " ").trim();
}

function opportunityBenefit(opportunity) {
  const benefits = opportunity.buyerBenefit || [];
  const beds = benefits.find(b => b.code === "additional_bedroom");
  const cash = benefits.find(b => b.code === "lower_initial_commitment");
  const size = benefits.find(b => b.code === "larger_supported_size_range");
  const price = opportunity.priceDifferenceAed;
  const material = beds ? `moves you from ${beds.from} bedroom${beds.from === 1 ? "" : "s"} to ${beds.to} bedrooms`
    : cash ? `needs AED ${Math.abs(opportunity.cashDifferenceAed).toLocaleString("en-US")} less upfront`
      : size ? `gives you a larger documented size range` : benefits.some(b => b.code === "documented_developer_plan") ? "adds a documented developer payment plan"
        : benefits.some(b => b.code === "earlier_handover") ? "brings the documented handover earlier"
          : benefits.some(b => b.code === "later_handover") ? "moves the documented handover later to suit your timing"
            : benefits.some(b => b.code === "different_area_as_requested") ? "moves the search away from the area you rejected"
              : benefits.some(b => b.code === "property_type_as_requested") ? "changes to the property type you want to compare"
                : benefits.some(b => b.code === "fewer_bedrooms_as_requested" || b.code === "smaller_supported_size_range") ? "offers a smaller home to address your size concern"
                  : benefits.some(b => b.code === "different_developer_as_requested") ? "offers a different developer to address your concern" : null;
  if (price > 0 && material) return `The extra AED ${price.toLocaleString("en-US")} in starting price ${material}.`;
  if (cash && material) return `It ${material}.`;
  if (price < 0) return `It starts AED ${Math.abs(price).toLocaleString("en-US")} lower.`;
  return material ? `It ${material}.` : null;
}

function opportunityTradeoffs(opportunity, buyer) {
  const bits = [];
  if (["within_stretch", "above_original_with_permission"].includes(opportunity.budgetStatus)) bits.push(`it's above your original AED ${Number(buyer.budgetAed).toLocaleString("en-US")} budget`);
  if (opportunity.tradeoffs.some(t => ["different_area", "outside_preferred_area"].includes(t.code))) {
    bits.push(buyer.preferredAreas?.length && !isFlexiblePreference(buyer, "preferredAreas")
      ? `it's outside your preferred area (${buyer.preferredAreas.join(" or ")} stays the priority)`
      : "it's in a different area");
  }
  if (opportunity.cashDifferenceAed > 0) bits.push(`it needs AED ${opportunity.cashDifferenceAed.toLocaleString("en-US")} more upfront`);
  if (opportunity.tradeoffs.some(t => t.code === "different_bedroom_count") && buyer.bedrooms?.length && !isFlexiblePreference(buyer, "bedrooms") && !opportunity.buyerBenefit.some(b => b.code === "additional_bedroom")) bits.push("the bedroom count differs from what you asked for");
  if (opportunity.tradeoffs.some(t => t.code === "different_property_type")) bits.push("it's a different type of home");
  if (opportunity.tradeoffs.some(t => t.code === "different_handover")) bits.push("the handover date is different");
  if (!bits.length) return null;
  const last = bits.pop();
  return `Keep in mind ${bits.length ? `${bits.join(", ")} and ${last}` : last}.`;
}

function arabicBedrooms(count) {
  if (count === 0) return "استوديو";
  if (count === 1) return "غرفة نوم واحدة";
  if (count === 2) return "غرفتا نوم";
  return Number.isFinite(Number(count)) ? `${count} غرف نوم` : null;
}

// Keep the split ("70/30") and drop English notes the buyer did not write.
function arabicPlan(summary) {
  const split = String(summary).match(/\b\d{1,2}\s*\/\s*\d{1,2}\b/)?.[0];
  return split ? split.replace(/\s/g, "") : String(summary);
}

function buildArabicAdvisorReply({ buyer, advisor, strategy, message }) {
  if (strategy.type === "no_push") return { text: "خذ وقتك. يمكننا المتابعة عندما تكون مستعداً.", stage: "paused_advice", nextQuestion: null, pendingOffer: null, callRequest: null };
  if (!advisor.primary) return null;
  const pack = advisor.packs.find(p => p.projectId === advisor.primary.projectId && p.unitId === advisor.primary.unitId);
  const card = p => [
    `${p.name.value} — ${p.area.value}`,
    p.projectLevel ? p.bedroomLabel.value : arabicBedrooms(p.bedrooms.value),
    `السعر يبدأ من ${p.startingPriceText.value}`,
    p.downPaymentText.value ? `الدفعة الأولى ${p.downPaymentText.value}` : null,
    p.paymentPlanSummary.value ? `خطة السداد ${arabicPlan(p.paymentPlanSummary.value)}` : null,
    p.handover.value ? `التسليم ${p.handover.value}` : null
  ].filter(Boolean).join("؛ ") + ".";
  if (strategy.type === "answer_action") {
    const text = strategy.nextAction === "compare" ? advisor.matches.map(m => card(m.factPack)).join("\n")
      : strategy.nextAction === "availability" ? `${pack.name.value}: التوفر ${pack.availability.value || "يحتاج تحققاً حديثاً"}.`
        : `${pack.name.value}: خطة السداد ${pack.paymentPlanSummary.value || "تحتاج تحققاً"}.`;
    const action = strategy.nextAction === "availability" ? null : "availability";
    return advisorDraft(text, advisor, action, action ? "هل تريد التحقق من التوفر الحالي؟" : null);
  }
  const advisorLed = isAdvisorLedDiscovery(buyer);
  const lead = advisorLed && /اختار|اختر|انت اختار|أنت اختار|على راحتك|ما ادري|ما أدري|you choose|up to you/i.test(message)
    ? "ولا يهمك، أنا أختار لك 👇" : "هذا أفضل خيار لك 👇";
  const reason = cardReason({ pack, comparable: comparablePacks(advisor), buyer, ar: true });
  const lines = [lead, "", projectCard(pack, { ar: true, reason, units: advisorUnits(advisor) })];
  const notes = [];
  const challenger = advisor.challenger;
  if (challenger) {
    const other = advisor.packs.find(p => p.projectId === challenger.projectId && p.unitId === challenger.unitId);
    if (other) notes.push(`خيار بديل: ${compactLine(other, true)}.`);
    if (challenger.priceDifferenceAed > 0) notes.push(`فرق سعر البداية ${challenger.priceDifferenceAed.toLocaleString("en-US")} درهم.`);
    const beds = challenger.buyerBenefit.find(b => b.code === "additional_bedroom");
    if (beds) notes.push(`تحصل على ${arabicBedrooms(beds.to)} بدلاً من ${arabicBedrooms(beds.from)}.`);
    if (challenger.cashDifferenceAed < 0) notes.push(`تنخفض الدفعة الأولى بمقدار ${Math.abs(challenger.cashDifferenceAed).toLocaleString("en-US")} درهم.`);
    if (challenger.cashDifferenceAed > 0) notes.push(`تزيد الدفعة الأولى بمقدار ${challenger.cashDifferenceAed.toLocaleString("en-US")} درهم.`);
    if (challenger.budgetStatus === "above_original_with_permission") notes.push(`هذا أعلى من ميزانيتك الأصلية ${buyer.budgetAed.toLocaleString("en-US")} درهم.`);
    if (buyer.preferredAreas?.length && challenger.tradeoffs.some(t => ["different_area", "outside_preferred_area"].includes(t.code))) notes.push(`خارج منطقتك المفضلة؛ تبقى ${buyer.preferredAreas.join(" أو ")} الأولوية.`);
  }
  if (notes.length) lines.push("", ...notes);
  if (strategy.lowPressure || isFlexiblePreference(buyer, "advisoryNextAction")) return advisorDraft(lines.join("\n"), advisor, null, null);
  return cardDraft(lines.join("\n"), advisor, advisor.packs, true);
}
