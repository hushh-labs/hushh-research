/**
 * The Gmail entry point queues this exactly as an ordinary first user message.
 * It starts a real Agent Chat turn; the delivery card remains the only explicit
 * owner action that can send the generated email.
 */
export function buildEmailAgentIntroPrompt(recipient: string): string {
  const normalizedRecipient = recipient.trim();
  return `Can you send an email to '${normalizedRecipient}', In the email explain features of the email agent.`;
}

/** Gmail's workspace opens One with a guided, owner-addressed draft request. */
export function buildGmailAgentHandoffPrompt(recipient: string): string {
  const normalizedRecipient = recipient.trim();
  if (!normalizedRecipient) {
    return "Help me prepare an email explaining the Gmail agent's features in detail. I want to review the draft before anything is sent.";
  }
  return `Send an email to '${normalizedRecipient}' explaining all the features of the Gmail agent in detail. Prepare the draft for my review and do not send it without my explicit approval.`;
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
