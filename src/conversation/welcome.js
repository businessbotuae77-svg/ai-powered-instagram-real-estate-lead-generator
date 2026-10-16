// The opening: who we are in one line, then four doors. Free text always works too.
export const WELCOME_CHOICES = [
  { id: "find_property", label: "Find a property", value: "Find a property" },
  { id: "explore_budget", label: "Explore by budget", value: "Explore by budget" },
  { id: "payment_plans", label: "Payment plans", value: "Payment plans" },
  { id: "talk_agent", label: "Talk to an agent", value: "Talk to an agent" }
];

export const WELCOME_CHOICES_AR = [
  { id: "find_property", label: "ابحث عن عقار", value: "ابحث عن عقار" },
  { id: "explore_budget", label: "خيارات حسب ميزانيتك", value: "خيارات حسب ميزانيتك" },
  { id: "payment_plans", label: "خطط السداد", value: "خطط السداد" },
  { id: "talk_agent", label: "كلّم موظف", value: "كلم موظف" }
];

export function welcomeChoices(ar = false) {
  return (ar ? WELCOME_CHOICES_AR : WELCOME_CHOICES).map(choice => ({ ...choice }));
}

// A hello and nothing else, in English, Arabic or the Gulf way of saying it.
const GREETING = /^(?:hi|hello|hey|hiya|yo|hi there|hello there|hey there|good (?:morning|afternoon|evening)|salam|salaam|as?salam(?:u|o)?\s*(?:alaikum|alaykum|aleikum)|مرحبا|مرحباً|هلا|هلا والله|هلا وغلا|اهلا|أهلا|اهلين|أهلين|هاي|سلام|السلام عليكم|السلام عليكم ورحمة الله(?: وبركاته)?|صباح الخير|مساء الخير|صباح النور|مساء النور)[\s.!?؟,،]*$/i;

export function isGreeting(message) {
  return GREETING.test(String(message || "").replace(/[\p{Extended_Pictographic}️‍]/gu, "").trim());
}
