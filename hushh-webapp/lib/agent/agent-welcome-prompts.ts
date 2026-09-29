/**
 * Curated first-turn prompts for the private-agent workspace.
 *
 * This is intentionally a finite deck rather than model-generated content:
 * it stays useful before any personal information is loaded, cannot imply an
 * unavailable capability, and does not create an analytics or PKM dependency
 * just to render an empty conversation.
 *
 * Every starter is grounded in a One chat tool that works end to end in a
 * typed turn with the vault unlocked, and each one that needs a connector
 * degrades to that connector's existing in-chat connect affordance:
 * - calendar week      -> `calendar_summary` (`calendar.connect` card when not connected)
 * - emails to reply to -> `ask_email_agent` (receipt with "Connect Gmail")
 * - who has access     -> `list_active_grants` + `list_pending_information_requests`
 * - free time          -> `calendar_free_slots`
 * - thank-you draft    -> `open_gmail_email_draft` (draft always opens; sending needs Gmail)
 * - what you remember  -> One's memory packet
 *
 * Deliberately absent until a tool backs them: Drive reads (never-connected
 * copy is wrong), bank spending (no Plaid tool), portfolio performance (the
 * finance lane has no tools and would invent numbers), stock analysis (leaves
 * chat), outbound sharing (consent is request-and-approve) and location
 * sharing (needs setup and a circle). Connect and setup actions for those
 * live in One's chat onboarding ("What should I help with first?") and the
 * connectors drawer instead.
 */
export type AgentWelcomePrompt = string;

const WELCOME_PROMPT_DECK: readonly (readonly AgentWelcomePrompt[])[] = [
  [
    "What's on my calendar this week?",
    "Which emails need a reply?",
    "Who has access to my information?",
  ],
  [
    "Find 30 free minutes tomorrow afternoon",
    "Draft a thank-you email",
    "What do you remember about me?",
  ],
] as const;

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

export function getWelcomePrompts(promptSetIndex: number): readonly AgentWelcomePrompt[] {
  return (
    WELCOME_PROMPT_DECK[Math.min(WELCOME_PROMPT_DECK.length - 1, Math.max(0, promptSetIndex))] ??
    WELCOME_PROMPT_DECK[0]!
  );
}

/** Every curated starter, for contract tests and docs. */
export const ALL_WELCOME_PROMPTS: readonly AgentWelcomePrompt[] = WELCOME_PROMPT_DECK.flat();
