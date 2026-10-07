import { answerFactQuestion } from "./fact-answers.js";
import { resolveAffirmation, isAffirmation } from "./affirmation.js";
import { bedroomOptionsFromMatches, canPitchBuyer } from "./match-resolve.js";
import { renderProjectIntro, renderProjectCard } from "./project-copy.js";
import { nextQualificationQuestion, isCoreQualified } from "./qualify.js";
import { choicesForField } from "./choices.js";
import { comparisonReply } from "./comparison-reply.js";
import { exitQuestion } from "./investment-guidance.js";

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
  handoffRequested = false,
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

  if (intents.includes("start_fresh")) {
    lines.push("Starting fresh. Are you buying a home, investing, or just exploring?");
    nextQuestion = {
      field: "useType",
      prompt: "Are you buying a home, investing, or just exploring?",
      choices: null
    };
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
    lines.push("No problem. We can keep looking without a phone number.");
  }
  if (ack) {
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
      lines.push("Want to continue with your last search, or start fresh?");
      nextQuestion = {
        field: "session_choice",
        prompt: "Want to continue with your last search, or start fresh?",
        choices: [
          { id: "continue", label: "Continue", value: "Continue" },
          { id: "start_fresh", label: "Start fresh", value: "Start fresh" }
        ]
      };
      nextPending = { type: "session_choice" };
      return finish(lines, "welcome_back", nextQuestion, nextPending);
    }
    lines.push("What budget are you working with?");
    nextQuestion = {
      field: "budgetAed",
      prompt: "What budget are you working with?",
      choices: budgetRangeChoices()
    };
    return finish(lines, "qualifying", nextQuestion, null);
  }

  const unresolvedUnsure = unsure.filter(
    (field) =>
      !(
        field === "area" &&
        (buyer.openToOtherAreas || buyer.intentSignals?.includes("area_flexible"))
      )
  );
  if (unresolvedUnsure.length || (intents.includes("unsure") && !unsure.includes("area"))) {
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

  // Not enough to pitch yet: ask one natural question, no "I have noted"
  const question = nextQualificationQuestion(buyer, {
    includeCash: false,
    includeFinancing: false
  });
  if (!buyer.budgetAed) {
    lines.push("What budget are you working with?");
    nextQuestion = question || {
      field: "budgetAed",
      prompt: "What budget are you working with?",
      choices: budgetRangeChoices()
    };
    if (!nextQuestion.choices) nextQuestion = { ...nextQuestion, choices: budgetRangeChoices() };
  } else if (!(buyer.preferredAreas?.length || buyer.projectInterest)) {
    const areaGroup = choicesForField("preferredAreas");
    lines.push(
      buyer.openToOtherAreas || buyer.intentSignals?.includes("area_flexible")
        ? question?.prompt || "What size works best for you?"
        : "Which area are you leaning toward?"
    );
    nextQuestion = question || {
      field: "preferredAreas",
      prompt: "Which area are you leaning toward?",
      choices: areaGroup?.choices || null
    };
  } else {
    lines.push(question?.prompt || "What size are you after?");
    nextQuestion = question;
  }

  return finish(lines, "qualifying", nextQuestion, null);
}

function budgetRangeChoices() {
  return [
    { id: "1_5m", label: "Around AED 1.5M", value: "around 1.5M" },
    { id: "2m", label: "Around AED 2M", value: "around 2M" },
    { id: "3m", label: "Around AED 3M", value: "around 3M" },
    { id: "5m", label: "AED 5M+", value: "budget 5M" }
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

  if (!hasBeds && beds.length) {
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
    if (!buyer.financing || buyer.financing === "unknown") {
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

  if (buyer.cashAvailableAed == null) {
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

  if (!buyer.financing || buyer.financing === "unknown") {
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

export function fallbackSafeText(packs) {
  if (!packs.length) {
    return "I can't give a reliable property comparison from the details available right now. I can still help explain the buying choices.";
  }
  return packs.map((pack) => {
    const bits = [pack.name?.value, pack.developer?.value ? `by ${pack.developer.value}` : null]
      .filter(Boolean)
      .join(" ");
    const price = pack.startingPriceText?.confirmed
      ? `from ${pack.startingPriceText.value}`
      : "starting price not confirmed yet";
    return `${bits} · ${price}`;
  }).join("\n");
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

export function buildAdvisorReply({ buyer, advisor, strategy, message = "", turnObjections = [], lastAskedField = null, askedFields = new Set() }) {
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
      ? "سؤال في محله. أنا مساعد يعمل بالذكاء الاصطناعي، والأرقام التي أشاركها من قوائمنا الحالية، ولا يتم حجز أو دفع أي شيء عبر هذه المحادثة."
      : "That's a fair question. I'm an AI assistant, the figures I share come from our current listings, and nothing is reserved or paid through this chat.";
    return { text: `${answer} ${prompt}`, stage: "trust_check", nextQuestion: { field: "trustConcern", prompt }, pendingOffer: null, callRequest: null };
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
    if (strategy.nextAction === "compare") {
      return advisorDraft(comparisonReply(advisor.comparison, { preferredName: name }) || `For your priorities, I'd start with ${name}.`, advisor, "availability", "Want me to check current availability?");
    }
    const topic = strategy.nextAction === "availability" ? "availability" : "payment plan";
    const answer = answerFactQuestion(topic, [primaryPack]);
    return advisorDraft(answer.text, advisor, strategy.nextAction === "availability" ? null : "availability",
      strategy.nextAction === "availability" ? null : "Want me to check current availability?", [primaryPack]);
  }
  const lines = [];
  // Acknowledge a concern only in the turn it is raised, not on every later turn.
  const raised = turnObjections.find(category => OBJECTION_LEADS[category]);
  if (raised) lines.push(objectionLead(raised, message));
  const reason = raised === "too_expensive" && primary.priceDifferenceAed < 0 ? "it keeps the entry price lower"
    : raised === "initial_payment_too_high" && primary.cashDifferenceAed < 0 ? "its documented initial payment is lower"
      : primaryReason(primary.reasonCodes, buyer, primaryPack);
  const challenger = advisor.challenger;
  if (!raised && strategy.type === "recommend" && WHY_QUESTION.test(message)) {
    // Explain the reasoning; the cards were already shown.
    lines.push(`I lean towards ${name}${reason ? ` because ${reason}` : " because it is the cleaner fit for what you've told me"}.`);
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
  if (!raised && MORE_SPACE.test(message) && !largerShown) lines.push("I don't have a larger option that fits your budget and other requirements right now.");
  lines.push(`For your priorities, I prefer ${name}${reason ? ` because ${reason}` : " as the cleaner fit"}.`);
  lines.push(renderProjectCard(primaryPack));
  if (primary.comparedTo) {
    const benefit = opportunityBenefit(primary);
    if (benefit) lines.push(benefit);
  }
  const primaryTradeoff = opportunityTradeoffs(primary, buyer);
  if (primaryTradeoff) lines.push(primaryTradeoff);
  if (challenger) {
    const pack = advisor.packs.find(p => p.projectId === challenger.projectId && p.unitId === challenger.unitId);
    if (pack) {
      lines.push(`${ALTERNATIVE_LEADS[challenger.type] || "Also worth a look"}: ${renderProjectCard(pack)}`);
      const benefit = opportunityBenefit(challenger);
      if (benefit) lines.push(benefit);
      const tradeoffs = opportunityTradeoffs(challenger, buyer);
      if (tradeoffs) lines.push(tradeoffs);
    }
  }
  if (advisor.upgradeAssessment?.reasonCodes?.includes("no_material_buyer_benefit_for_extra_price") &&
      (/\b(upgrade|extra|more expensive|worth|better)\b/i.test(message) || !buyer.shownProjects?.includes(primary.projectId))) {
    const assessment = advisor.upgradeAssessment.opportunities?.find(o => o.priceDifferenceAed > 0);
    lines.push(assessment ? `There is a pricier option at AED ${assessment.priceDifferenceAed.toLocaleString("en-US")} more, but I would not pay the extra without a material benefit for your priorities.` : "I would not pay extra here without a material benefit for your priorities.");
  }
  if (strategy.type === "budget_permission") {
    const prompt = `Is AED ${Number(buyer.budgetAed).toLocaleString("en-US")} a hard ceiling, or would you stretch slightly for a materially better option?`;
    const draft = advisorDraft(lines.join("\n"), advisor, null, null);
    return { ...draft, text: `${draft.text}\n${prompt}`, nextQuestion: { field: "budgetFlexible", prompt }, pendingOffer: null };
  }
  // An unanswered strategy question is not asked again; the buyer can raise it.
  const horizon = buyer.useType === "investment" && lastAskedField !== "exitHorizon" && !askedFields.has("exitHorizon") ? exitQuestion(buyer) : null;
  // A complementary service may accompany a plain recommendation, never an
  // objection answer or a buyer who asked for a low-pressure conversation.
  // A reply that already weighs two options is long enough without it.
  const allowsServiceSuggestion = strategy.type === "recommend" && !raised && !strategy.lowPressure && !challenger;
  if (horizon && !strategy.lowPressure) {
    const result = advisorDraft(lines.join("\n"), advisor, null, null);
    return { ...result, text: `${result.text}\n${horizon.prompt}`, nextQuestion: horizon, allowsServiceSuggestion };
  }
  const prompt = strategy.lowPressure ? null : challenger ? "Want me to compare these side by side?" : "Want me to break down the payment terms?";
  return { ...advisorDraft(lines.join("\n"), advisor, prompt ? strategy.nextAction : null, prompt), allowsServiceSuggestion };
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
      upgradeProjectId: advisor.challenger?.type === "smart_upgrade" ? advisor.challenger.projectId : null
    }
  };
}

function primaryReason(codes = [], buyer, pack) {
  if (codes.includes("lower_initial_commitment_priority")) return "the documented initial payment better fits your cash priority";
  if (codes.includes("ready_income_route")) return "it is ready, which suits your preference for a rental-income route; rental figures still need checking";
  if (codes.includes("ready_move_in_route")) return "its ready status suits your move-in priority";
  if (codes.includes("more_space_priority")) return "the supported size better suits your need for space";
  if (codes.includes("off_plan_growth_route")) return "its off-plan status and documented payment structure suit the route you want to compare; this is a fit recommendation, not a growth forecast";
  if (codes.includes("lower_entry_price_priority")) return "it keeps the entry price lower";
  return buyer.preferredAreas?.includes(pack.area?.value) ? "it fits your preferred area and price range" : "it fits your price range";
}

function opportunityBenefit(opportunity) {
  const benefits = opportunity.buyerBenefit || [];
  const beds = benefits.find(b => b.code === "additional_bedroom");
  const cash = benefits.find(b => b.code === "lower_initial_commitment");
  const size = benefits.find(b => b.code === "larger_supported_size_range");
  const price = opportunity.priceDifferenceAed;
  const material = beds ? `moves you from ${beds.from} bedroom${beds.from === 1 ? "" : "s"} to ${beds.to} bedrooms`
    : cash ? `reduces the documented initial commitment by AED ${Math.abs(opportunity.cashDifferenceAed).toLocaleString("en-US")}`
      : size ? `gives you a larger documented size range` : benefits.some(b => b.code === "documented_developer_plan") ? "adds a documented developer payment plan"
        : benefits.some(b => b.code === "earlier_handover") ? "brings the documented handover earlier"
          : benefits.some(b => b.code === "later_handover") ? "moves the documented handover later to suit your timing"
            : benefits.some(b => b.code === "different_area_as_requested") ? "moves the search away from the area you rejected"
              : benefits.some(b => b.code === "property_type_as_requested") ? "changes to the property type you want to compare"
                : benefits.some(b => b.code === "fewer_bedrooms_as_requested" || b.code === "smaller_supported_size_range") ? "offers a smaller home to address your size concern"
                  : benefits.some(b => b.code === "different_developer_as_requested") ? "offers a different developer to address your concern" : null;
  if (price > 0 && material) return `The extra AED ${price.toLocaleString("en-US")} in starting price ${material}.`;
  if (cash && material) return `This alternative ${material}.`;
  if (price < 0) return `Its starting price is AED ${Math.abs(price).toLocaleString("en-US")} lower.`;
  return material ? `This alternative ${material}.` : null;
}

function opportunityTradeoffs(opportunity, buyer) {
  const bits = [];
  if (["within_stretch", "above_original_with_permission"].includes(opportunity.budgetStatus)) bits.push(`above your original AED ${Number(buyer.budgetAed).toLocaleString("en-US")} budget`);
  // An open-area buyer has no preferred area to trade away.
  if (buyer.preferredAreas?.length && opportunity.tradeoffs.some(t => ["different_area", "outside_preferred_area"].includes(t.code))) bits.push(`outside your preferred area; ${buyer.preferredAreas.join(" or ")} remains the priority`);
  if (opportunity.cashDifferenceAed > 0) bits.push(`AED ${opportunity.cashDifferenceAed.toLocaleString("en-US")} more in documented initial payment`);
  if (opportunity.tradeoffs.some(t => t.code === "different_bedroom_count") && !opportunity.buyerBenefit.some(b => b.code === "additional_bedroom")) bits.push("a different bedroom count");
  if (opportunity.tradeoffs.some(t => t.code === "different_property_type")) bits.push("a different property type");
  if (opportunity.tradeoffs.some(t => t.code === "different_handover")) bits.push("a different handover date");
  return bits.length ? `The trade-off: ${bits.join("; ")}.` : null;
}

function buildArabicAdvisorReply({ buyer, advisor, strategy, message }) {
  if (strategy.type === "no_push") return { text: "خذ وقتك. يمكننا المتابعة عندما تكون مستعداً.", stage: "paused_advice", nextQuestion: null, pendingOffer: null, callRequest: null };
  if (!advisor.primary) return null;
  const pack = advisor.packs.find(p => p.projectId === advisor.primary.projectId && p.unitId === advisor.primary.unitId);
  const card = p => `${p.name.value} — ${p.area.value}؛ ${p.bedrooms.value} غرف نوم؛ السعر يبدأ من ${p.startingPriceText.value}؛ الدفعة الأولى ${p.downPaymentText.value || "تحتاج تحققاً"}؛ خطة السداد ${p.paymentPlanSummary.value || "تحتاج تحققاً"}؛ التسليم ${p.handover.value || "يحتاج تحققاً"}.`;
  if (strategy.type === "answer_action") {
    const text = strategy.nextAction === "compare" ? advisor.matches.map(m => card(m.factPack)).join("\n")
      : strategy.nextAction === "availability" ? `${pack.name.value}: التوفر ${pack.availability.value || "يحتاج تحققاً حديثاً"}.`
        : `${pack.name.value}: خطة السداد ${pack.paymentPlanSummary.value || "تحتاج تحققاً"}.`;
    const action = strategy.nextAction === "availability" ? null : "availability";
    return advisorDraft(text, advisor, action, action ? "هل تريد التحقق من التوفر الحالي؟" : null);
  }
  const lines = [`أفضل ${pack.name.value} وفقاً لأولوياتك وسعر الدخول والتزامات السداد؛ هذا ترجيح للملاءمة وليس توقعاً للعائد.`, card(pack)];
  const challenger = advisor.challenger;
  if (challenger) {
    const other = advisor.packs.find(p => p.projectId === challenger.projectId && p.unitId === challenger.unitId);
    lines.push(`الخيار البديل: ${card(other)}`);
    if (challenger.priceDifferenceAed > 0) lines.push(`فرق سعر البداية AED ${challenger.priceDifferenceAed.toLocaleString("en-US")}.`);
    const beds = challenger.buyerBenefit.find(b => b.code === "additional_bedroom");
    if (beds) lines.push(`تحصل على ${beds.to} غرف نوم بدلاً من ${beds.from}.`);
    if (challenger.cashDifferenceAed < 0) lines.push(`تنخفض الدفعة الأولى بمقدار AED ${Math.abs(challenger.cashDifferenceAed).toLocaleString("en-US")}.`);
    if (challenger.cashDifferenceAed > 0) lines.push(`تزداد الدفعة الأولى بمقدار AED ${challenger.cashDifferenceAed.toLocaleString("en-US")}.`);
    if (challenger.budgetStatus === "above_original_with_permission") lines.push(`هذا أعلى من ميزانيتك الأصلية AED ${buyer.budgetAed.toLocaleString("en-US")}.`);
    if (buyer.preferredAreas?.length && challenger.tradeoffs.some(t => ["different_area", "outside_preferred_area"].includes(t.code))) lines.push(`خارج منطقتك المفضلة؛ تبقى ${buyer.preferredAreas.join(" أو ")} الأولوية.`);
  }
  if (advisor.upgradeAssessment.reasonCodes.includes("no_material_buyer_benefit_for_extra_price") && (/upgrade|extra|worth|better|أغلى|زيادة/.test(message) || !buyer.shownProjects?.includes(advisor.primary.projectId))) lines.push("لا أنصح بدفع الزيادة دون فائدة ملموسة تناسب أولوياتك.");
  if (strategy.type === "budget_permission") {
    const prompt = `هل AED ${buyer.budgetAed.toLocaleString("en-US")} سقف ثابت أم يمكن زيادته قليلاً لخيار أفضل بفائدة ملموسة؟`;
    return { ...advisorDraft(lines.join("\n"), advisor, null, null), text: `${lines.join("\n")}\n${prompt}`, nextQuestion: { field: "budgetFlexible", prompt } };
  }
  const prompt = strategy.lowPressure ? null : challenger ? "هل تريد مقارنة الخيارين جنباً إلى جنب؟" : "هل تريد شرح تفاصيل السداد؟";
  return advisorDraft(lines.join("\n"), advisor, prompt ? strategy.nextAction : null, prompt);
}
