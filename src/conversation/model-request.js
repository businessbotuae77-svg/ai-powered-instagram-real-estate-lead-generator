// Request settings shared by the understanding, composition and broker calls.

export const DEFAULT_MODEL = "claude-sonnet-5";
// Understanding is structured extraction: a small model is fast and cheap enough.
export const DEFAULT_UNDERSTANDING_MODEL = "claude-haiku-5-5";

/**
 * Thinking off, in the form the model accepts. Thinking adds seconds and
 * billed output to every reply and shares max_tokens with the JSON answer.
 * Claude Sonnet 5.5 rejects "disabled"; Opus 5.5 and Fable cannot turn it
 * off, so they run at low effort instead.
 */
export function thinkingOff(model = "") {
  if (/^claude-sonnet-5-5/.test(model)) return { thinking: { type: "between_tools" } };
  if (/^claude-(?:opus-5-5|fable|mythos)/.test(model)) return { output_config: { effort: "low" } };
  return { thinking: { type: "disabled" } };
}

/**
 * The fixed instructions as one cached block, then any per-request text
 * uncached. Repeat requests within five minutes read the fixed part at a
 * tenth of the input price.
 */
export function cachedSystem(fixed, ...rest) {
  return [
    { type: "text", text: fixed, cache_control: { type: "ephemeral" } },
    ...rest.filter(Boolean).map(text => ({ type: "text", text }))
  ];
}

/** The system prompt as plain text, for logs and tests. */
export function systemText(system) {
  return Array.isArray(system) ? system.map(block => block.text).join("\n") : String(system ?? "");
}
