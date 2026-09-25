/**
 * The Gmail entry point queues this exactly as an ordinary first user message.
 * It starts a real Agent Chat turn; the delivery card remains the only explicit
 * owner action that can send the generated email.
 */
export const EMAIL_DRAFTING_FORMAT_RULES = [
  "STRUCTURE (fixed order, always):",
  '1. Greeting line: "Hi [Name]," if recipient name is known, else "Hi," — never use "Dear," "Hello," or any variant.',
  "2. Blank line.",
  "3. Opening sentence: state the purpose of the email in 1 sentence.",
  "4. Blank line.",
  "5. Body: 2–3 paragraphs max, each 2–4 sentences, each separated by a blank line. Never merge into a single block paragraph.",
  "6. Blank line.",
  "7. Closing sentence: a single clear next step, ask, or CTA.",
  "8. Blank line.",
  '9. Sign-off: always "Best," followed by the sender\'s name on the next line. Never use "Warm regards," "Thanks," "Sincerely," or any variant.',
  "",
  "LISTS:",
  '- Use a Markdown bullet list ("- ") only when there are 3 or more discrete items.',
  "- Under 3 items: write inline as part of a sentence, never as bullets.",
  '- Never mix "-" and "*" bullet styles — always "-".',
  "- Each bullet must be on its own line with a preceding blank line before the list starts.",
  "",
  "EMPHASIS:",
  "- Bold (**text**) only around 1–2 key terms total (e.g. date, amount, deadline) — never bold full sentences.",
  "- No ALL CAPS, no exclamation marks for emphasis.",
  "",
  "LENGTH:",
  "- Target 100–160 words unless the instruction explicitly requires more detail.",
  "",
  "DO NOT:",
  "- Do not vary greeting or sign-off wording between generations.",
  '- Do not output raw literal Markdown symbols beyond "**" for bold and "- " for bullets.',
].join("\n");

export function buildEmailAgentIntroPrompt(recipient: string): string {
  const normalizedRecipient = recipient.trim();
  return `Can you send a mail to '${normalizedRecipient}', In the mail explain features of the mail agent.\n\nStrictly follow these email output formatting rules:\n${EMAIL_DRAFTING_FORMAT_RULES}`;
}

// ---------------------------------------------------------------------------
// One-time intro gate
// ---------------------------------------------------------------------------
// The intro prompt above is a demonstration: it asks One to compose a sample
// email explaining the agent. It is worth showing once, and only once — every
// later visit should open an empty composer waiting for a real instruction.
//
// The handoff id cannot carry that memory: each open mints a new
// `email-agent-prompt-${Date.now()}` id, so the consumed-handoff ref in the
// chat workspace only ever de-dupes a single handoff against itself. The
// "already introduced" fact has to outlive the page, so it is persisted per
// user, matching how one-location persists its seen-notification set.

const EMAIL_AGENT_INTRO_KEY_PREFIX = "one_email_agent_intro_seen_v1";

function safeLocalStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    // Private browser settings can deny storage entirely.
    return null;
  }
}

function emailAgentIntroStorageKey(userId: string): string {
  return `${EMAIL_AGENT_INTRO_KEY_PREFIX}:${userId}`;
}

/**
 * True once this user has been shown the sample-email introduction.
 *
 * Keyed by user so a second account on the same device still gets its own
 * introduction. When storage is unavailable this reports false and the intro
 * runs again — a repeated demonstration is a far smaller failure than
 * suppressing it for someone who has never seen it.
 */
export function hasSeenEmailAgentIntro(
  userId: string | null | undefined,
): boolean {
  const normalizedUserId = String(userId || "").trim();
  if (!normalizedUserId) return false;
  const storage = safeLocalStorage();
  if (!storage) return false;
  try {
    return storage.getItem(emailAgentIntroStorageKey(normalizedUserId)) === "1";
  } catch {
    return false;
  }
}

/** Record that the introduction has been shown. */
export function markEmailAgentIntroSeen(
  userId: string | null | undefined,
): void {
  const normalizedUserId = String(userId || "").trim();
  if (!normalizedUserId) return;
  const storage = safeLocalStorage();
  if (!storage) return;
  try {
    storage.setItem(emailAgentIntroStorageKey(normalizedUserId), "1");
  } catch {
    // Never let a storage failure block entry into the agent.
  }
}
