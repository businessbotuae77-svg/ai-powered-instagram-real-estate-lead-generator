import { normalizeBuyerText } from "./text.js";

// Scope is determined before retrieving or answering listing terms. A broad
// educational question never needs an invented property as its subject.
export function conversationalScope(message) {
  const text = normalizeBuyerText(message).trim().toLowerCase();
  if (/^how\s+(?:do|can|could|would|will)\s+(?:i|we|you)\s+(?:make|earn)\s+(?:money|income|a profit)\b/.test(text) ||
      /^how\s+much\s+(?:can|could|would|will)\s+(?:i|we)\s+(?:make|earn|profit)\b/.test(text) ||
      /\bhow\s+(?:does|do)\s+(?:property|real estate)\s+(?:investing|investment)\s+work\b/.test(text) ||
      /كيف (?:أكسب|اكسب|أربح|اربح|يمكنني الربح)|كيف يعمل الاستثمار العقاري/.test(text)) return "investment_education";
  if (/^(?:which details|what details|what do you mean|what are you referring to)[.!?]*$/.test(text) ||
      /^(?:أي تفاصيل|ماذا تقصد)[.!؟?]*$/.test(text)) return "clarify_conversation";
  if (/^(?:i'?m not asking|i am not asking|i (?:didn'?t|did not) ask)(?: (?:about )?(?:that|a property|a project))?[.!?]*$/.test(text) ||
      /^(?:لم أسأل عن عقار|لا أسأل عن عقار)[.!؟?]*$/.test(text)) return "correct_conversation";
  return null;
}
