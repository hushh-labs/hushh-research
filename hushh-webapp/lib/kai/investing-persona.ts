import { detailedPersonaSignals } from "./detailed-persona";
import type { KaiPreferences } from "@/lib/services/kai-profile-service";

export type LossCapacity = "essentials" | "delay_goal" | "flexible";

export type PersonaPreferences = Pick<
  KaiPreferences,
  | "investment_horizon"
  | "drawdown_response"
  | "volatility_preference"
  | "loss_capacity"
  | "detailed_assessment_v1"
>;

export function normalizeLossCapacity(value: unknown): LossCapacity | null {
  return value === "essentials" ||
    value === "delay_goal" ||
    value === "flexible"
    ? value
    : null;
}

const personas = {
  exploring: {
    label: "Still exploring",
    description:
      "One can explain your portfolio while you decide how much risk feels right.",
  },
  mixed: {
    label: "Mixed preferences",
    description:
      "Your answers point in different directions. One will show the trade-offs before judging fit.",
  },
  careful: {
    label: "Careful",
    description:
      "You prefer smaller swings, even if that means giving up some growth potential.",
  },
  balanced: {
    label: "Balanced",
    description:
      "You’re comfortable with some ups and downs in pursuit of growth.",
  },
  growth: {
    label: "Growth-oriented",
    description:
      "You’re comfortable with larger swings for more long-term growth potential.",
  },
} as const;

/** An initial preference label. Horizon and capacity constrain guidance separately. */
export function getInvestingPersona(preferences: PersonaPreferences) {
  if (preferences.detailed_assessment_v1) {
    const { kind } = detailedPersonaSignals(preferences.detailed_assessment_v1);
    return { kind, ...personas[kind] };
  }
  const reaction = preferences.drawdown_response;
  const comfort = preferences.volatility_preference;
  let kind: keyof typeof personas = "exploring";
  if (reaction && comfort) {
    const response = { reduce: 0, stay: 1, buy_more: 2 }[reaction];
    const preference = { small: 0, moderate: 1, large: 2 }[comfort];
    kind =
      Math.abs(response - preference) === 2
        ? "mixed"
        : (["careful", "balanced", "growth"] as const)[
            Math.min(response, preference)
          ]!;
  }
  return { kind, ...personas[kind] };
}

export function portfolioPlanningSignals(preferences: PersonaPreferences) {
  const assessment = preferences.detailed_assessment_v1;
  const detailed = assessment ? detailedPersonaSignals(assessment) : null;
  return {
    horizon: detailed?.horizon ?? preferences.investment_horizon,
    lossCapacity: detailed?.lossCapacity ?? preferences.loss_capacity ?? null,
  };
}

export function personaPlanningNote(preferences: PersonaPreferences): string {
  const { horizon, lossCapacity } = portfolioPlanningSignals(preferences);
  if (lossCapacity === "essentials" || horizon === "short_term") {
    return "One will look first at the money you may need soon.";
  }
  if (lossCapacity === "delay_goal") {
    return "One will highlight risks that could delay your goal.";
  }
  if (!horizon || !lossCapacity) {
    return "One may ask when you’ll need the money or what losses you can afford.";
  }
  return "One will consider your withdrawal timing and ability to absorb losses.";
}
