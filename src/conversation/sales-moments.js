import { normalizeBuyerText } from "./text.js";
import { brokerLabel, brokerShortName, brokerSubject } from "./broker-profile.js";

// Moments where a human adds real value: the buyer wants to transact, wants an
// exact quote, or asks something that needs a professional determination. The
// bot answers what it can first, then offers a connection once. Explicit
// requests to speak to someone are handled immediately by contact.js.

const IDENTITY = /\b(?:are|r)\s+(?:you|u)\s+(?:a\s+|an\s+)?(?:real|human|person|bot|robot|ai|machine|chat\s?bot|licensed|registered|rera|broker|real estate agent|agent)\b|\b(?:am i|are we)\s+(?:talking|speaking|chatting)\s+(?:to|with)\s+(?:a\s+)?(?:human|person|bot|real person|ai|machine)\b|\bis this (?:a\s+)?(?:bot|human|real person|ai|automated|robot)\b|\bwho am i (?:talking|speaking|chatting) (?:to|with)\b|^who are you\b|هل أنت (?:إنسان|بوت|روبوت|شخص حقيقي|وسيط)|هل أتحدث مع (?:إنسان|بوت|شخص)/i;
const VISA = /\b(?:golden visa|residen(?:ce|cy) (?:visa|permit)|investor visa|property visa|visas?)\b|الإقامة الذهبية|التأشيرة الذهبية|تأشيرة|إقامة/i;
const MORTGAGE = /\bmortgage\b[^.?!]{0,60}\b(?:eligib|qualif|approv|non[- ]?residents?|interest rates?|ltv|loan[- ]to[- ]value|borrow)|\b(?:can|could|will|would) (?:i|we) (?:get|qualify for|be approved for) (?:a |an )?(?:mortgage|home loan|bank (?:loan|finance))\b|\bhow much can i borrow\b|تمويل عقاري|رهن عقاري/i;
const LEGAL = /\b(?:legal(?:ly)?|lawyer|solicitor|conveyancing|contract review|review the contract|sale and purchase agreement|tax(?:es)?|inheritance|sharia|power of attorney|title deed|can foreigners (?:buy|own)|ownership rights)\b|محامي|ضريبة|ميراث|عقد البيع/i;
const QUOTE = /\b(?:quote|quotation|final price|best price|exact price|price breakdown|all[- ]in (?:price|cost)|total cost (?:including|with) fees|offer letter)\b|عرض سعر|السعر النهائي/i;
const DISCOUNT = /\b(?:discount|negotia\w*|lower the price|best deal|any deals?|promotion|waive)\b|خصم|تفاوض/i;
const BUYING = /\b(?:(?:i )?want to buy (?:it|this|that|this one|that one|the (?:unit|apartment|villa|townhouse|property))|ready to (?:buy|proceed|move forward|go ahead|reserve)|i'?ll take it|let'?s (?:do it|go ahead|proceed)|how (?:do|can) i (?:reserve|book|buy|proceed|secure)|what(?:'s| is| are) the next steps?|next step to (?:buy|reserve)|i want (?:this|that) (?:one|unit|apartment|villa|property))\b|أريد شراء|جاهز للشراء|كيف أحجز/i;
const TAILORED = /\b(?:tailor(?:ed)?|personali[sz]ed|bespoke|custom(?:ised|ized)? (?:advice|plan|recommendation|search)|someone (?:who )?(?:can|could) (?:look|review)|professional advice|expert advice)\b/i;
const QUESTION = /[?؟]|^(?:what|which|how|can|could|do|does|is|are|will|would|should|may)\b|^(?:هل|كيف|ما|متى)/i;

export function isIdentityQuestion(message) {
  return IDENTITY.test(normalizeBuyerText(message));
}

/** Professional-judgment topic asked as a question, or null. */
export function judgmentTopic(message) {
  const text = normalizeBuyerText(message).trim();
  if (!QUESTION.test(text)) return null;
  if (MORTGAGE.test(text)) return "mortgage";
  if (VISA.test(text)) return "visa";
  // "SPA" (sale and purchase agreement) is matched case-sensitively, so "a spa" is not legal.
  if (LEGAL.test(text) || /\bSPA\b/.test(text)) return "legal";
  return null;
}

/** Commercial moment that warrants a connection offer, or null. */
export function transactionMoment(message) {
  const text = normalizeBuyerText(message);
  if (/\b(?:don'?t|do not|not|never)\s+(?:want|ready|going)\b.{0,20}\b(?:buy|reserve|proceed|quote)\b/i.test(text)) return null;
  if (BUYING.test(text)) return "buying";
  if (DISCOUNT.test(text)) return "discount";
  if (QUOTE.test(text)) return "quote";
  if (TAILORED.test(text)) return "tailored";
  return null;
}

/** A short decline of a pending connection offer ("no thanks", "not now"). */
export function declinesOffer(message) {
  return /^(?:no|nope|nah|no thanks?|no thank you|not now|not yet|not really|maybe later|later|not at the moment|i'?m ok(?:ay)?|no need|لا|لا شكرا|لاحقا|ليس الآن)\b/i.test(normalizeBuyerText(message).trim());
}

export function isBareDecline(message) {
  return /^(?:no|nope|nah|no thanks?|no thank you|not now|not yet|not really|maybe later|later|not at the moment|i'?m ok(?:ay)?|no need|لا|لا شكرا|لاحقا|ليس الآن)[\s.!,]*(?:thanks?|thank you)?[.!]*$/i.test(normalizeBuyerText(message).trim());
}

const OFFERS = {
  buying: ["can check live availability for the exact unit, confirm the current price and walk you through reserving", "يمكنه التحقق من توفر الوحدة والسعر الحالي وشرح خطوات الحجز"],
  quote: ["can confirm the exact unit price, fees and availability and send you a written quote", "يمكنه تأكيد سعر الوحدة والرسوم والتوفر وإرسال عرض سعر مكتوب"],
  discount: ["can check with the developer whether any current offer applies", "يمكنه التحقق مع المطور من وجود أي عرض حالي"],
  tailored: ["can look at your situation in detail and shortlist with you", "يمكنه دراسة وضعك بالتفصيل وإعداد قائمة مناسبة معك"],
  visa: ["can point you to the right specialist to confirm eligibility for your case", "يمكنه توجيهك إلى المختص المناسب لتأكيد الأهلية في حالتك"],
  mortgage: ["can introduce you to the right person to confirm what you could borrow", "يمكنه تعريفك بالشخص المناسب لتأكيد قدرتك على التمويل"],
  legal: ["can point you to a qualified professional for your case", "يمكنه توجيهك إلى مختص مؤهل لحالتك"],
  verify: ["can check this with the developer and come back to you with the confirmed answer", "يمكنه التحقق من ذلك مع المطور والعودة إليك بالإجابة المؤكدة"],
  research: ["can pull project-specific evidence for you, such as recent sales and upcoming supply", "يمكنه جمع أدلة خاصة بالمشروع لك، مثل المبيعات الأخيرة والمعروض القادم"],
  match: ["can look beyond what I have listed here and come back with options that fit", "يمكنه البحث خارج ما هو مدرج هنا والعودة إليك بخيارات مناسبة"],
  system: ["can take your requirements now and come back to you with options", "يمكنه أخذ متطلباتك الآن والعودة إليك بخيارات مناسبة"]
};

/**
 * One connection offer, or null when it would be unwelcome: the buyer paused
 * the conversation, declined contact or this offer, or was just asked.
 */
export function handoffOffer({ buyer, broker, reason, lastAskedField = null }) {
  if (!OFFERS[reason]) return null;
  if (buyer.salesPathStopped || buyer.contactDeclined || buyer.declinedSuggestions?.includes("handoff")) return null;
  if (lastAskedField === "handoffOffer") return null;
  const ar = buyer.language === "ar";
  const label = brokerSubject(broker, buyer.language);
  const [en, arabic] = OFFERS[reason];
  const prompt = ar ? "هل تريد أن أوصلك به؟" : "Want me to connect you?";
  const line = ar ? `${label} ${arabic}. ${prompt}` : `${capitalize(label)} ${en}. ${prompt}`;
  return { line, prompt, nextQuestion: { field: "handoffOffer", prompt }, pendingOffer: { type: "handoff_offer", reason } };
}

/** Plain account of what this assistant is. Never claims to be a person or licensed. */
export function identityReply({ buyer, broker }) {
  const ar = buyer.language === "ar";
  const label = brokerSubject(broker, buyer.language);
  const hasHuman = Boolean(broker.name || broker.role);
  if (ar) return `أنا مساعد عقاري يعمل بالذكاء الاصطناعي، ولست شخصاً ولا وسيطاً مرخصاً. أشرح المشاريع والأسعار وخطط السداد من بيانات القوائم لدينا${hasHuman ? `، ويمكن لـ${label} المساعدة في أي قرار أو معاملة` : ""}.`;
  return `I'm an AI property assistant, not a person or a licensed broker. I can explain projects, prices and payment plans from our listings${hasHuman ? `, and ${label} can help with anything that needs a human decision or a transaction` : ", and our team can help with anything that needs a human decision or a transaction"}.`;
}

/** General, non-determinative answer for a professional-judgment topic. */
export function judgmentAnswer(topic, buyer) {
  const ar = buyer.language === "ar";
  if (topic === "visa") return ar
    ? "توجد في الإمارات تأشيرات إقامة مرتبطة بتملك العقار، لكن الأهلية تعتمد على قيمة العقار وطريقة تمويله وحالة إنجازه والقواعد الرسمية الحالية. لا يمكنني تأكيد أهليتك، ويجب التحقق منها وفق المعايير الرسمية الحالية."
    : "The UAE does offer property-linked residence visas, but eligibility depends on the property's value, its financing, its completion status and the current official rules. I can't confirm eligibility for your case; it needs checking against the current official criteria.";
  if (topic === "mortgage") return ar
    ? "الأهلية للتمويل العقاري تعتمد على البنك ودخلك وإقامتك والعقار نفسه، لذلك لا يؤكدها إلا البنك أو مستشار التمويل. يمكنني أيضاً عرض خيارات بخطط سداد من المطور."
    : "Mortgage eligibility depends on the lender, your income, your residency status and the property itself, so only a bank or mortgage adviser can confirm what you'd qualify for. I can also show options with developer payment plans, which are agreed with the developer rather than a bank.";
  return ar
    ? "هذا يعتمد على ظروفك والأنظمة الحالية، لذلك يحتاج إلى مختص مؤهل لتأكيده. يمكنني شرح خطوات الشراء العامة في الأثناء."
    : "That depends on your circumstances and the current regulations, so it needs a qualified professional to confirm. I can explain the general buying steps in the meantime.";
}

/** Answer-first reply for buying intent, quote or discount questions. */
export function transactionAnswer({ moment, buyer, pack = null, broker }) {
  const ar = buyer.language === "ar";
  const name = pack?.name?.value || null;
  const price = pack?.startingPriceText?.confirmed ? pack.startingPriceText.value : null;
  const who = brokerShortName(broker, buyer.language);
  if (ar) {
    if (moment === "discount") return "لا يمكنني تأكيد أي خصم؛ تنطبق فقط شروط العرض الحالية من المطور.";
    if (moment === "quote") return name && price ? `${name} يبدأ من ${price} حسب القائمة الحالية، والسعر النهائي للوحدة والرسوم يحتاجان إلى تأكيد.` : "عرض السعر الدقيق يحتاج إلى تحديد الوحدة وتأكيد السعر والرسوم الحالية.";
    if (moment === "buying") return `${name ? `للمضي في ${name}، ` : ""}الخطوة التالية هي تأكيد توفر الوحدة والسعر وشروط الحجز الحالية. لم يتم حجز أي شيء بعد.`;
    return "يمكنني متابعة المساعدة هنا أيضاً.";
  }
  if (moment === "discount") return "I can't confirm any discount; only the developer's current offer terms apply.";
  if (moment === "quote") return name && price
    ? `On the current listing, ${name} starts from ${price}. The final price for a specific unit, plus registration and other fees, needs confirming before a quote can be issued.`
    : "An exact quote needs a specific unit, plus confirmation of the current price and fees.";
  if (moment === "buying") return `${name ? `To move ahead on ${name}, the` : "The"} next step is confirming the exact unit's availability, the current price and the reservation terms. Nothing has been reserved yet${who === "our team" ? "" : `, and ${who} would confirm each step with you first`}.`;
  return "I can keep helping here too.";
}

/** Short summary topic stored for the human handoff. */
export function handoffTopic(reason, pack = null) {
  const name = pack?.name?.value;
  return {
    buying: `Next steps to buy${name ? ` ${name}` : ""}`,
    quote: `Exact quote${name ? ` for ${name}` : ""}`,
    discount: `Whether any current offer applies${name ? ` to ${name}` : ""}`,
    tailored: "Tailored recommendation",
    visa: "Residence visa eligibility",
    mortgage: "Mortgage eligibility",
    legal: "Legal or tax question"
  }[reason] || null;
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
