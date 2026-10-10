export function isAffirmation(message) {
  const text = String(message || "").trim().toLowerCase();
  if (!text) return false;
  return /^(yes|yeah|yep|yup|sure|ok|okay|please|go ahead|sounds good|that works|both|either|any|show me|yes please|ok please|نعم|أيوه|ايوه|اكيد|أكيد|تمام|حسنا|حسناً|موافق|نعم من فضلك)([.!]?)$/i.test(
    text
  );
}

/**
 * Resolve a short yes/sure against the last pending offer stored on memory.
 * Returns a fact patch, a clarifying question, or null.
 */
export function resolveAffirmation(pendingOffer, message) {
  if (!pendingOffer || !isAffirmation(message)) return null;

  if (pendingOffer.type === "bedroom_choice") {
    const options = pendingOffer.options || [];
    if (options.length === 1) {
      return {
        facts: { bedrooms: options[0] },
        clearPending: true,
        clarify: null
      };
    }
    if (/^both|either|any$/i.test(String(message).trim())) {
      return {
        facts: {},
        clearPending: false,
        clarify: {
          field: "bedrooms",
          prompt: pendingOffer.clarifyPrompt || "Which size should I open first?",
          choices: options.map((beds) => ({
            id: String(beds),
            label: beds === 0 ? "Studio" : `${beds} bedroom${beds === 1 ? "" : "s"}`,
            value: beds
          }))
        }
      };
    }
    return {
      facts: {},
      clearPending: false,
      clarify: {
        field: "bedrooms",
        prompt:
          pendingOffer.clarifyPrompt ||
          `Just to be sure, which one do you want to see: ${options
            .map((beds) => (beds === 0 ? "studio" : `${beds}BR`))
            .join(" or ")}?`,
        choices: options.map((beds) => ({
          id: String(beds),
          label: beds === 0 ? "Studio" : `${beds} bedroom${beds === 1 ? "" : "s"}`,
          value: beds
        }))
      }
    };
  }

  if (pendingOffer.type === "project_choice") {
    const options = pendingOffer.options || [];
    if (options.length === 1) {
      return {
        facts: { project: options[0].name },
        clearPending: true,
        clarify: null
      };
    }
    return {
      facts: {},
      clearPending: false,
      clarify: {
        field: "projectInterest",
        prompt: `Which project should I open first: ${options.map((row) => row.name).join(" or ")}?`,
        choices: options.map((row) => ({
          id: row.id,
          label: row.name,
          value: row.name
        }))
      }
    };
  }

  if (pendingOffer.type === "session_choice") {
    return {
      facts: {},
      clearPending: true,
      clarify: null
    };
  }

  if (pendingOffer.type === "show_options") {
    return {
      facts: {},
      clearPending: true,
      clarify: null,
      acceptShow: true
    };
  }

  return {
    facts: {},
    clearPending: false,
    clarify: {
      field: null,
      prompt: "Happy to help. Which option did you mean?",
      choices: null
    }
  };
}
