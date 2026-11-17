/**
 * Hushh's own questions about risk comfort, cash needs and withdrawal timing.
 * The scoring is descriptive. It does not use a published instrument's norms.
 */
export const detailedPersonaQuestions = [
  {
    prompt: "How much variation would you accept to pursue a long-term goal?",
    choices: [
      "I value a steadier path",
      "I can accept some setbacks",
      "I can accept large swings over time",
    ],
  },
  {
    prompt:
      "A diversified investment falls sharply and your goal is still years away. What feels right?",
    choices: [
      "I'd prefer a lower-risk mix",
      "I'd review why it fell before deciding",
      "I'd be comfortable keeping the same risk",
    ],
  },
  {
    prompt:
      "Two plans could reach the same goal. Which trade-off would you choose?",
    choices: [
      "Save more each month for less uncertainty",
      "Split the difference",
      "Accept more uncertainty in how much the plan earns",
    ],
  },
  {
    prompt:
      "How would you feel about trailing a broad market index for several years?",
    choices: [
      "I'd want fewer surprises versus the index",
      "Some differences are fine if I understand them",
      "I'd accept a wide gap if the plan still fits my goal",
    ],
  },
  {
    prompt:
      "What would give you the most confidence when markets are unsettled?",
    choices: [
      "A mix that changes little in value",
      "A written plan with limits on risk",
      "Knowing my long-term plan can tolerate big moves",
    ],
  },
  {
    prompt:
      "How much would uncertainty about the range of possible outcomes affect your choice?",
    choices: [
      "I'd choose the more predictable investment",
      "I'd accept some uncertainty after comparing outcomes",
      "I'm comfortable with a wide range of outcomes",
    ],
  },
  {
    prompt:
      "How much of your long-term savings would you be comfortable seeing fluctuate?",
    choices: ["A small share", "A meaningful share", "Most of it"],
  },
  {
    prompt: "What if a steadier approach meant less opportunity for growth?",
    choices: [
      "I'd still favor stability",
      "I'd balance both goals",
      "I'd accept larger swings for more opportunity",
    ],
  },
  {
    prompt:
      "If your income stopped temporarily, how would you cover regular bills?",
    choices: [
      "I'd need to draw from these investments",
      "I could cover bills but would postpone other plans",
      "I have separate funds to cover the gap",
    ],
  },
  {
    prompt:
      "If an essential expense came up while markets were down, what would you use?",
    choices: [
      "I'd need to sell from this portfolio",
      "I'd rearrange other planned spending",
      "I'd use money set aside outside this portfolio",
    ],
  },
  {
    prompt:
      "If this portfolio stayed below its current value, what could you put off?",
    choices: [
      "Very little before essential spending is affected",
      "A planned purchase or other optional goal",
      "I can wait without changing current plans",
    ],
  },
  {
    prompt:
      "When are you planning your first meaningful withdrawal from this portfolio?",
    choices: [
      "Within three years",
      "In three to seven years",
      "More than seven years away",
    ],
  },
  {
    prompt:
      "What is the earliest you might need a meaningful part of this portfolio?",
    choices: [
      "Within three years",
      "In three to seven years",
      "After seven years",
    ],
  },
] as const;

export type DetailedPersonaAnswer = 0 | 1 | 2 | null;
export type DetailedPersonaAnswers = DetailedPersonaAnswer[];

export function normalizeDetailedPersona(
  value: unknown,
): DetailedPersonaAnswers | null {
  if (!Array.isArray(value) || value.length !== detailedPersonaQuestions.length)
    return null;
  if (
    !value.every(
      (item) => item === null || item === 0 || item === 1 || item === 2,
    )
  )
    return null;
  return value;
}

export function detailedPersonaSignals(answers: DetailedPersonaAnswers) {
  const comfort = answers.slice(0, 8).filter((value) => value !== null);
  const capacity = answers.slice(8, 11).filter((value) => value !== null);
  const timing = answers.slice(11).filter((value) => value !== null);
  const average =
    comfort.reduce<number>((total, value) => total + value, 0) / comfort.length;
  const mixed =
    comfort.filter((value) => value === 0).length >= 2 &&
    comfort.filter((value) => value === 2).length >= 2;
  const kind =
    comfort.length < 6
      ? "exploring"
      : mixed
        ? "mixed"
        : average <= 0.6
          ? "careful"
          : average >= 1.4
            ? "growth"
            : "balanced";
  return {
    kind,
    lossCapacity: capacity.length
      ? (["essentials", "delay_goal", "flexible"] as const)[
          Math.min(...capacity)
        ]
      : null,
    horizon: timing.length
      ? (["short_term", "medium_term", "long_term"] as const)[
          Math.min(...timing)
        ]
      : null,
  } as const;
}
