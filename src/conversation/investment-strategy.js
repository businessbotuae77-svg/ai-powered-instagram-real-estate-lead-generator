import { normalizeBuyerText } from "./text.js";
import { isFlexiblePreference } from "./preference-state.js";

export const INVESTMENT_STRATEGIES = [
  "OFF_PLAN_APPRECIATION", "HANDOVER_EXIT", "LONG_TERM_HOLD",
  "INCOME_AFTER_HANDOVER", "READY_INCOME", "BALANCED", "UNDECIDED"
];
export const INVESTMENT_PROFILE_FIELDS = [
  "investmentGoal", "investmentStrategy", "exitHorizon", "holdingPeriod",
  "incomeRequirement", "growthPriority", "liquidityPriority", "riskTolerance",
  "cashDeploymentPreference", "handoverStrategy"
];

const ENUMS = {
  investmentGoal: ["total_return", "capital_appreciation", "income", "balanced"],
  investmentStrategy: INVESTMENT_STRATEGIES,
  exitHorizon: ["before_handover", "handover", "long_term"],
  incomeRequirement: ["immediate", "after_handover", "none", "flexible"],
  growthPriority: ["high", "medium", "low"],
  liquidityPriority: ["high", "medium", "low"],
  riskTolerance: ["low", "medium", "high"],
  cashDeploymentPreference: ["lower_initial", "lower_construction", "minimize_total_price", "balanced"],
  handoverStrategy: ["sell", "hold", "rent"]
};

export function normalizeInvestmentProfile(input = {}) {
  const profile = {};
  for (const [field, values] of Object.entries(ENUMS)) {
    if (values.includes(input[field])) profile[field] = input[field];
  }
  if (input.holdingPeriod != null && Number.isFinite(Number(input.holdingPeriod)) && Number(input.holdingPeriod) > 0 && Number(input.holdingPeriod) <= 50) {
    profile.holdingPeriod = Number(input.holdingPeriod);
  }
  return profile;
}

function positiveObjectiveText(text) {
  const goal = "(?:rental\\s+(?:income|yield)|rent(?:al)?|income|cash\\s*flow|(?:capital\\s+)?growth|capital\\s+gains?|appreciation|investment|roi)";
  return text.replace(/(?:لا (?:أريد|اريد|أرغب|ارغب)|ليس|بدون)\s+(?:النمو|نمو رأس المال|دخل (?:الإيجار|الايجار)|استثمار)/g, " ")
    .replace(new RegExp(`\\b(?:don'?t|do not|not|no|rather than|instead of|avoid|without)\\s+(?:(?:want|need|prefer|interested in|looking for|focused on|focus on|care about|prioritiz(?:e|ing))\\s+)?(?:regular\\s+|long[- ]term\\s+|an?\\s+)?${goal}\\b`, "gi"), " ")
    .replace(new RegExp(`\\b${goal}\\s+(?:is not|isn'?t|is no longer)\\s+(?:important|(?:my\\s+)?priority|(?:what\\s+)?i (?:want|need))\\b`, "gi"), " ");
}

/** Preferences only: no project facts, return estimates, or sales permission. */
export function parseInvestmentFacts(message, { buyer = null, lastAskedField = null } = {}) {
  const text = normalizeBuyerText(message).trim().toLowerCase();
  const positive = positiveObjectiveText(text);
  const facts = {};
  const endUse = /\b(?:not (?:an? )?investment|end\s*use|live in|for (?:my )?family|for my (?:own )?home|buying (?:my |a |an? )?home|my own home)\b/.test(text) || /للسكن|بيتي|ليس استثمار/.test(text);
  if (endUse) return { useType: "end_use" };

  const roi = /\b(?:roi|return on investment|best (?:return|investment|opportunity)|strongest investment)\b/.test(positive) || /أفضل عائد|افضل عائد|أفضل استثمار|عائد الاستثمار/.test(positive);
  const investment = roi || /\b(?:invest(?:ment|ing|or)?|rental (?:income|yield)|capital growth|appreciation)\b/.test(positive) || /استثمار|عائد|دخل (?:الإيجار|الايجار)|نمو رأس المال/.test(positive);
  const factQuestion = /\b(?:will|does|can|could|how much|what is|what are)\b.{0,60}\b(?:appreciat|growth|yield|rent|return)/.test(text) || /\bwhat (?:does|is).{0,30}(?:growth|income|roi)/.test(text);
  const explicitHolding = /\b(?:hold|keep)(?:ing)?\b.{0,30}\b\d+(?:\.\d+)?\s*years?\b|\b(?:sell|exit|flip)\b.{0,40}\b(?:handover|completion)\b|\blong[- ]term\s+hold\b/.test(text);
  const investmentContext = investment || explicitHolding || buyer?.useType === "investment" || ["investmentObjective", "exitHorizon", "holdingPeriod", "investmentStrategy", "handoverStrategy", "incomeRequirement"].includes(lastAskedField);
  if (!investmentContext) return facts;
  if (investment && (!factQuestion || roi)) facts.useType = "investment";
  if (roi) facts.investmentGoal = "total_return";

  // A return forecast question is not a buyer's preference for a growth strategy.
  if (!factQuestion) {
    const income = /\b(?:rent(?:al)?(?: income| yield)?|income|cash flow|cashflow)\b/.test(positive) || /دخل (?:الإيجار|الايجار)|عائد إيجاري|دخل منتظم/.test(positive);
    const growth = /\b(?:growth|capital gains?|appreciation|long[- ]term (?:gains?|value))\b/.test(positive) || /النمو|نمو رأس المال/.test(positive);
    const balancedReply = ["investmentObjective", "investmentStrategy"].includes(lastAskedField) && (/^(?:a |the )?(?:mix|both|balanced|balance)[.!?]*$/.test(text) || /^(?:مزيج|كلاهما|الاثنين)[.!؟?]*$/.test(text));
    if ((income && growth) || balancedReply) {
      Object.assign(facts, { investmentObjective: "balanced", investmentGoal: facts.investmentGoal || buyer?.investmentGoal || "balanced", incomeRequirement: "flexible", growthPriority: "medium" });
    } else if (growth) {
      Object.assign(facts, { investmentObjective: "growth", investmentGoal: facts.investmentGoal || buyer?.investmentGoal || "capital_appreciation", growthPriority: "high" });
    } else if (income) {
      Object.assign(facts, { investmentObjective: "rental_income", investmentGoal: facts.investmentGoal || buyer?.investmentGoal || "income" });
    }
  }

  const horizonText = text.replace(/\b(?:don'?t|do not|not|won'?t|will not)\s+(?:want to\s+)?(?:hold|keep)(?:ing)?\b[^,.;]*(?=[,.;]|$)/g, " ");
  const holding = horizonText.match(/\b(?:hold(?:ing)?(?: it| the property)?(?: for)?|holding period(?: of| is)?|keep(?: it| the property)?(?: for)?)\s*(\d+(?:\.\d+)?)\s*years?\b/)
    || (lastAskedField === "holdingPeriod" ? text.match(/^(\d+(?:\.\d+)?)\s*(?:years?)?[.!?]*$/) : null)
    || (lastAskedField === "exitHorizon" ? text.match(/^(\d+(?:\.\d+)?)\s*years?[.!?]*$/) : null);
  const noSell = /\b(?:don'?t|do not|not|won'?t|will not|no)\s+(?:want to\s+)?(?:sell|exit)(?:ing)?\b/.test(text);
  const handoverExit = !noSell && /\b(?:sell|exit|flip)(?:ing)?\b.{0,45}\b(?:handover|completion)\b|\b(?:handover|completion)\b.{0,20}\b(?:exit|sale)\b/.test(text);
  const horizonQuestion = ["exitHorizon", "handoverStrategy"].includes(lastAskedField);
  const shortHandover = horizonQuestion && /^(?:(?:at|around|on) )?(?:handover|completion)[.!?]*$/.test(text);
  const longHold = /\b(?:hold|keep)(?:ing)?\b.{0,35}\b(?:long(?:er|[- ]term)?|after handover|after completion)\b|\blong[- ]term\s+hold\b/.test(horizonText)
    || (horizonQuestion && /^(?:hold(?:ing)?(?: (?:it|longer|long term))?|long(?:er|[- ]term)|a few years(?: after)?)[.!?]*$/.test(text));
  if (holding || longHold) {
    Object.assign(facts, { exitHorizon: "long_term", handoverStrategy: "hold" });
    if (holding) facts.holdingPeriod = Number(holding[1]);
  } else if (!noSell && /\b(?:sell|exit|flip)\b.{0,30}\bbefore (?:handover|completion)\b/.test(text)) {
    Object.assign(facts, { exitHorizon: "before_handover", handoverStrategy: "sell" });
  } else if (handoverExit || shortHandover || /أبيع عند التسليم|البيع عند التسليم/.test(text)) {
    Object.assign(facts, { exitHorizon: "handover", handoverStrategy: "sell" });
  }
  // Timing of income is independent of whether capital appreciation also matters.
  if (/\b(?:income|rent(?:al)?(?: income)?)\b.{0,50}\b(?:from day (?:one|1)|day (?:one|1)|immediately|right away|now)\b|\b(?:immediate|day (?:one|1))\s+(?:rental )?income\b/.test(positive)) {
    facts.incomeRequirement = "immediate";
  } else if (/\b(?:income|rent(?:al)?(?: income)?)\b.{0,45}\b(?:after|from|at) (?:handover|completion)\b/.test(positive)) {
    Object.assign(facts, { incomeRequirement: "after_handover", handoverStrategy: "rent" });
  }
  if (/\b(?:no|don'?t need|do not need) (?:rental |immediate )?income\b/.test(text)) facts.incomeRequirement = "none";
  if (/\b(?:liquidity|easy to (?:sell|resell)|resale flexibility)\b/.test(positive) && !/\bnot (?:concerned|worried)\b/.test(text)) facts.liquidityPriority = "high";
  if (/\b(?:low risk|risk averse|conservative investor|minimi[sz]e risk)\b/.test(text)) facts.riskTolerance = "low";
  else if (/\b(?:comfortable with|accept|willing to take)\s+(?:more|higher|high)\s+risk\b/.test(text) && !/\b(?:not|don'?t|do not)\b.{0,25}\b(?:comfortable|accept|willing)\b/.test(text)) facts.riskTolerance = "high";
  if (/\b(?:low(?:er)?|less|minimi[sz]e|keep).{0,30}\b(?:construction[- ]period cash|cash during construction|construction cash)\b/.test(text)) facts.cashDeploymentPreference = "lower_construction";
  else if (/\b(?:low(?:er)?|less|minimi[sz]e).{0,25}\b(?:initial|upfront|down payment)\b/.test(text)) facts.cashDeploymentPreference = "lower_initial";
  else if (/\b(?:minimi[sz]e|lowest|lower|cheapest)\s+(?:total |overall )?(?:price|cost)\b/.test(text)) facts.cashDeploymentPreference = "minimize_total_price";

  if (facts.investmentObjective || facts.exitHorizon || facts.incomeRequirement) {
    facts.useType = "investment";
    facts.explorationState = false;
    const context = { ...(buyer || {}), ...facts };
    if (facts.investmentObjective && facts.investmentObjective !== buyer?.investmentObjective) {
      context.investmentStrategy = "UNDECIDED";
      if (!facts.growthPriority) context.growthPriority = null;
    }
    facts.investmentStrategy = deriveInvestmentStrategy(context);
  } else if (roi && !buyer?.investmentStrategy) facts.investmentStrategy = "UNDECIDED";
  return { ...facts, ...normalizeInvestmentProfile(facts) };
}

/** Legacy cards participate without a data migration or a forced interview. */
export function deriveInvestmentStrategy(buyer = {}) {
  if (buyer.useType === "end_use") return "UNDECIDED";
  if (buyer.incomeRequirement === "immediate") return "READY_INCOME";
  if (["handover", "before_handover"].includes(buyer.exitHorizon) && buyer.handoverStrategy !== "hold") return "HANDOVER_EXIT";
  if (buyer.exitHorizon === "long_term" || Number(buyer.holdingPeriod) > 0 || buyer.handoverStrategy === "hold") return "LONG_TERM_HOLD";
  if (buyer.incomeRequirement === "after_handover" || buyer.handoverStrategy === "rent") return "INCOME_AFTER_HANDOVER";
  if (buyer.investmentObjective === "balanced") return "BALANCED";
  if (buyer.investmentObjective === "growth" || buyer.growthPriority === "high") return "OFF_PLAN_APPRECIATION";
  if (INVESTMENT_STRATEGIES.includes(buyer.investmentStrategy)) return buyer.investmentStrategy;
  return "UNDECIDED";
}

const DIMENSION_WEIGHTS = {
  UNDECIDED: { entry: 2, area: 2, project: 2, payment: 2, supply: 2, liquidity: 2, timing: 2, income: 1, costs: 2, risk: 2 },
  OFF_PLAN_APPRECIATION: { entry: 3, area: 3, project: 2, payment: 3, supply: 3, liquidity: 3, timing: 3, income: 1, costs: 2, risk: 3 },
  HANDOVER_EXIT: { entry: 3, area: 1, project: 1, payment: 3, supply: 3, liquidity: 3, timing: 3, income: 0, costs: 2, risk: 3 },
  LONG_TERM_HOLD: { entry: 2, area: 3, project: 3, payment: 2, supply: 3, liquidity: 2, timing: 1, income: 2, costs: 3, risk: 3 },
  INCOME_AFTER_HANDOVER: { entry: 2, area: 3, project: 3, payment: 3, supply: 3, liquidity: 2, timing: 3, income: 3, costs: 3, risk: 3 },
  READY_INCOME: { entry: 2, area: 2, project: 2, payment: 1, supply: 2, liquidity: 3, timing: 3, income: 3, costs: 3, risk: 3 },
  BALANCED: { entry: 2, area: 3, project: 3, payment: 2, supply: 3, liquidity: 2, timing: 2, income: 3, costs: 3, risk: 3 }
};
const PRIORITIES = {
  UNDECIDED: ["entry_price", "project_stage", "area_maturation", "cash_deployed", "future_supply", "resale_competition"],
  OFF_PLAN_APPRECIATION: ["entry_price", "launch_stage", "area_maturation", "cash_deployed", "future_supply", "liquidity"],
  HANDOVER_EXIT: ["entry_price", "launch_stage", "later_phase_pricing", "cash_deployed", "handover_supply", "resale_competition", "liquidity"],
  LONG_TERM_HOLD: ["area_maturation", "masterplan_progression", "product_quality", "long_term_supply", "rental_fallback", "service_costs", "tenant_end_user_appeal"],
  INCOME_AFTER_HANDOVER: ["handover_timing", "rental_evidence", "service_costs", "vacancy", "tenant_appeal", "construction_cash"],
  READY_INCOME: ["rental_evidence", "service_costs", "vacancy", "transaction_evidence", "net_income", "purchase_exit_costs"],
  BALANCED: ["entry_price", "area_maturation", "product_quality", "rental_fallback", "service_costs", "future_supply"]
};

export const DEFAULT_INVESTMENT_ANALYSIS = [
  "entry_position", "project_release_stage", "area_masterplan_maturity",
  "documented_catalysts", "product_differentiation", "payment_structure",
  "cash_deployment", "handover_timing", "competing_exit_supply",
  "transaction_resale_evidence", "rental_fallback", "factual_risks"
];

/** Delegation supplies an advisory mode, never a new property or spending permission. */
export function isAdvisorLedDiscovery(buyer = {}) {
  const investor = buyer.useType === "investment" || Boolean(buyer.investmentGoal || buyer.investmentObjective);
  return Boolean(investor && Number.isFinite(buyer.budgetAed) && buyer.budgetAed > 0 &&
    (buyer.advisorLed === true || isFlexiblePreference(buyer, "investmentObjective")));
}

/** Any stated investment preference can guide discovery without location or size. */
export function isInvestmentDiscoveryReady(buyer = {}) {
  const investor = buyer.useType === "investment" || Boolean(buyer.investmentGoal || buyer.investmentObjective);
  const statedPreference = Boolean(buyer.investmentGoal || buyer.investmentObjective ||
    Object.values(normalizeInvestmentProfile(buyer)).some(value => value != null && value !== "UNDECIDED"));
  return Boolean(investor && Number.isFinite(buyer.budgetAed) && buyer.budgetAed > 0 &&
    (isAdvisorLedDiscovery(buyer) || statedPreference));
}

/** Explainable dimensions, never an investment score or forecast. */
export function buildInvestmentStrategy(buyer = {}) {
  const strategy = deriveInvestmentStrategy(buyer);
  const isInvestor = buyer.useType === "investment" || Boolean(buyer.investmentGoal || buyer.investmentObjective);
  const delegated = isInvestor && (buyer.advisorLed === true || isFlexiblePreference(buyer, "investmentObjective"));
  return {
    strategy,
    investmentGoal: buyer.investmentGoal || (isInvestor ? "total_return" : null),
    returnDrivers: ["capital_appreciation", "rental_income", "costs"],
    priorities: [...PRIORITIES[strategy]],
    analysisDimensions: [...DEFAULT_INVESTMENT_ANALYSIS],
    advisorLedDiscovery: isAdvisorLedDiscovery(buyer),
    weights: { ...DIMENSION_WEIGHTS[strategy] },
    profile: normalizeInvestmentProfile(buyer),
    unknowns: INVESTMENT_PROFILE_FIELDS.filter(field => buyer[field] == null || buyer[field] === "UNDECIDED"),
    nextQuestionField: isInvestor && !delegated && !isFlexiblePreference(buyer, "exitHorizon") &&
      strategy !== "READY_INCOME" && !buyer.exitHorizon && !buyer.holdingPeriod ? "exitHorizon" : null,
    forecastAllowed: false
  };
}
