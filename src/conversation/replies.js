import { answerFactQuestion } from "./fact-answers.js";
import { resolveAffirmation, isAffirmation } from "./affirmation.js";
import { bedroomOptionsFromMatches, canPitchBuyer } from "./match-resolve.js";
import { renderProjectIntro } from "./project-copy.js";
import { nextQualificationQuestion, isCoreQualified } from "./qualify.js";
import { choicesForField } from "./choices.js";

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
    lines.push("Fresh start. What budget are you working with?");
    nextQuestion = {
      field: "budgetAed",
      prompt: "What budget are you working with?",
      choices: budgetRangeChoices()
    };
    return finish(lines, "qualifying", nextQuestion, null);
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
    return "I can only share confirmed listing details. Tell me a budget and area and I will check what we have.";
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
