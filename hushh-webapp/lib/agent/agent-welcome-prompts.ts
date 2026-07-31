/**
 * Curated first-turn prompts for the private-agent workspace.
 *
 * This is intentionally a finite deck rather than model-generated content:
 * it stays useful before any personal information is loaded, cannot imply an
 * unavailable capability, and does not create an analytics or PKM dependency
 * just to render an empty conversation.
 */
export type AgentWelcomePrompt = string;

export type AgentWelcomePromptContext = {
  hasPortfolioData: boolean;
};

const WELCOME_PROMPT_DECK: readonly (readonly AgentWelcomePrompt[])[] = [
  ["Review my portfolio", "Save a memory", "Explain consent flows"],
  ["Analyze a stock", "Help me organize a memory", "What can I safely share?"],
  ["Review my portfolio", "How does my vault stay private?", "Show my consent requests"],
  ["What moved in the market today?", "Save a memory", "What can One help with?"],
] as const;

const SET_UP_PORTFOLIO_PROMPT = "Set up my portfolio";

export function getWelcomePromptSetIndex(
  currentIndex: number | null,
  randomValue: number = Math.random(),
): number {
  if (WELCOME_PROMPT_DECK.length < 2 || currentIndex === null) {
    return Math.min(
      WELCOME_PROMPT_DECK.length - 1,
      Math.max(0, Math.floor(randomValue * WELCOME_PROMPT_DECK.length)),
    );
  }

  const normalizedCurrent = Math.min(
    WELCOME_PROMPT_DECK.length - 1,
    Math.max(0, currentIndex),
  );
  const candidate = Math.min(
    WELCOME_PROMPT_DECK.length - 2,
    Math.max(0, Math.floor(randomValue * (WELCOME_PROMPT_DECK.length - 1))),
  );

  return candidate >= normalizedCurrent ? candidate + 1 : candidate;
}

export function getWelcomePrompts(
  promptSetIndex: number,
  context: AgentWelcomePromptContext,
): readonly AgentWelcomePrompt[] {
  const promptSet =
    WELCOME_PROMPT_DECK[Math.min(WELCOME_PROMPT_DECK.length - 1, Math.max(0, promptSetIndex))] ??
    WELCOME_PROMPT_DECK[0]!;

  if (context.hasPortfolioData) return promptSet;

  return promptSet.map((prompt) =>
    prompt === "Review my portfolio" ? SET_UP_PORTFOLIO_PROMPT : prompt,
  );
}
