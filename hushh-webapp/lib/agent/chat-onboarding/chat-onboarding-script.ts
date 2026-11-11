/**
 * The authored script for One's first conversation after setup.
 *
 * This is fixed product copy, not model output: the first turn must be instant
 * and deterministic, so there is no model call anywhere in this file. Every
 * turn is rendered through the ordinary assistant bubble by the workspace.
 *
 * The flow asks three questions, one per assistant turn:
 *   name  -> what should One call the person
 *   focus -> what should One help with first (leads into ONE connect action)
 *   tone  -> how should One talk
 * then, when a picked name or tone was given, one confirmation turn. A typed
 * name uses the existing semantic name writer and confirms its save separately.
 *
 * Free text is never classified here. "Something else" opens name entry;
 * the private agent interprets that answer before the questions continue.
 */
import { ROUTES } from "@/lib/navigation/routes";

export const CHAT_ONBOARDING_QUESTIONS = ["name", "focus", "tone"] as const;
export type ChatOnboardingQuestionId = (typeof CHAT_ONBOARDING_QUESTIONS)[number];
export type ChatOnboardingQuestionStatus = "pending" | "answered" | "skipped";

export const CHAT_ONBOARDING_FOCUS = [
  "location",
  "email",
  "calendar",
  "money",
  "advisor",
  "wallet",
  "consent",
  "memory",
  "messages",
] as const;
export type ChatOnboardingFocus = (typeof CHAT_ONBOARDING_FOCUS)[number];

export const CHAT_ONBOARDING_TONES = ["short_direct", "detailed", "casual"] as const;
export type ChatOnboardingTone = (typeof CHAT_ONBOARDING_TONES)[number];

/** Human label for a tone; also the chip text and the saved preference wording. */
export const CHAT_ONBOARDING_TONE_LABEL: Record<ChatOnboardingTone, string> = {
  short_direct: "Short and direct",
  detailed: "Detailed",
  casual: "Casual",
};

const FOCUS_LABEL: Record<ChatOnboardingFocus, string> = {
  email: "Mail",
  calendar: "Calendar",
  money: "Finance",
  memory: "Memory",
  location: "Location",
  advisor: "Advisor",
  wallet: "Wallet",
  consent: "Consent",
  messages: "Messages",
};

/**
 * Where "help with first" leads. Each entry reuses a flow that already exists:
 * - `connector` opens the workspace's `openConnectorSurface` (the connectors
 *   drawer for Gmail with its default read purpose; Calendar routes to the
 *   Calendar page whose setup connect is `access_level: "read"`);
 * - `route` navigates to an existing setup route.
 * No entry requests a write, send or manage scope. Those stay task-triggered.
 */
export type ChatOnboardingConnectAction =
  | { kind: "connector"; provider: "gmail" | "calendar"; label: string }
  | { kind: "route"; href: string; label: string };

export type ChatOnboardingFocusPlan = {
  focus: ChatOnboardingFocus | "chat";
  /** Short "what this lets me do" explanation, as One's reply. */
  explanation: string;
  /** Exactly one inline action; the compatibility-only chat choice has none. */
  action: ChatOnboardingConnectAction | null;
};

export const CHAT_ONBOARDING_FOCUS_PLAN: Record<ChatOnboardingFocus | "chat", ChatOnboardingFocusPlan> = {
  email: {
    focus: "email",
    explanation:
      "Once Gmail is connected, I can find the emails that need a reply and catch you up on a thread. I read first. Anything I draft stays with you, and I never send without your go-ahead.",
    action: { kind: "connector", provider: "gmail", label: "Connect Gmail" },
  },
  calendar: {
    focus: "calendar",
    explanation:
      "Once Google Calendar is connected, I can walk you through your week and find free time. I start with read-only access, and I ask before I add or change anything.",
    action: { kind: "connector", provider: "calendar", label: "Connect Calendar" },
  },
  money: {
    focus: "money",
    explanation:
      "Link a bank or import a statement, and I can answer questions about your accounts and holdings. Your financial records stay encrypted in your vault.",
    action: { kind: "route", href: ROUTES.KAI_PORTFOLIO_SOURCES, label: "Add accounts" },
  },
  memory: {
    focus: "memory",
    explanation:
      "Tell me what matters to you and I'll keep it in your encrypted memory. You can see, edit and delete everything I remember.",
    action: { kind: "route", href: ROUTES.PKM, label: "Open Memory" },
  },
  location: {
    focus: "location",
    explanation:
      "Set up location and I can help with places near you. You choose who can see where you are, and for how long.",
    action: { kind: "route", href: ROUTES.ONE_SETUP_LOCATION, label: "Set up location" },
  },
  advisor: {
    focus: "advisor",
    explanation: "Open Advisor to set up your advisor profile and review requests.",
    action: { kind: "route", href: ROUTES.RIA_ONBOARDING, label: "Open Advisor" },
  },
  wallet: {
    focus: "wallet",
    explanation: "Open Wallet to manage the items in your private vault.",
    action: { kind: "route", href: ROUTES.ONE_WALLET, label: "Open Wallet" },
  },
  consent: {
    focus: "consent",
    explanation: "Review who can access what you share. You can change or revoke access.",
    action: { kind: "route", href: ROUTES.CONSENTS, label: "Open Consent" },
  },
  messages: {
    focus: "messages",
    explanation: "Open Messages to talk with your connections and Circles.",
    action: { kind: "route", href: ROUTES.ONE_MESSAGES, label: "Open Messages" },
  },
  chat: {
    focus: "chat",
    explanation: "Sounds good. Ask me anything, whenever you like.",
    action: null,
  },
};

export type ChatOnboardingChipId =
  | "name_signin"
  | "name_other"
  | `focus_${ChatOnboardingFocus | "chat"}`
  | `tone_${ChatOnboardingTone}`
  | "skip"
  | "save"
  | "dont_save"
  | "retry_save";

export type ChatOnboardingChip = { id: ChatOnboardingChipId; label: string };

export const CHAT_ONBOARDING_SKIP_LABEL = "Skip this question";
export const CHAT_ONBOARDING_SKIP_HELP: Record<ChatOnboardingQuestionId, string> = {
  name: "Skipping keeps your current name and moves to question 2.",
  focus: "Skipping connects nothing and moves to question 3.",
  tone: "Skipping keeps the default reply style. Any answers waiting to be saved still need your approval.",
};
export const NAME_MAX_LENGTH = 40;

export const NAME_MAX_WORDS = 4;

/**
 * Format validation only (never a guess at meaning): trim, collapse
 * whitespace, drop markup characters, and require something name-shaped:
 * at least one letter, at most four words and 40 characters, no question
 * mark. Anything else is not taken as a name.
 */
export function normalizePreferredName(raw: string): string | null {
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f<>*_`#[\]\\|~]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || cleaned.length > NAME_MAX_LENGTH) return null;
  if (cleaned.includes("?")) return null;
  if (cleaned.split(" ").length > NAME_MAX_WORDS) return null;
  if (!/\p{L}/u.test(cleaned)) return null;
  return cleaned;
}

/** First name from sign-in, or null when sign-in gave nothing usable. */
export function signInFirstName(displayName: string): string | null {
  const first = displayName.trim();
  if (!first || first === "there") return null;
  return normalizePreferredName(first);
}

export function nameChips(firstName: string | null): ChatOnboardingChip[] {
  return [
    ...(firstName ? [{ id: "name_signin" as const, label: `Call me ${firstName}` }] : []),
    { id: "name_other", label: "Something else" },
    { id: "skip", label: CHAT_ONBOARDING_SKIP_LABEL },
  ];
}

export function focusChips(): ChatOnboardingChip[] {
  return [
    ...CHAT_ONBOARDING_FOCUS.map((focus) => ({
      id: `focus_${focus}` as const,
      label: FOCUS_LABEL[focus],
    })),
    { id: "skip", label: CHAT_ONBOARDING_SKIP_LABEL },
  ];
}

export function toneChips(): ChatOnboardingChip[] {
  return [
    ...CHAT_ONBOARDING_TONES.map((tone) => ({
      id: `tone_${tone}` as const,
      label: CHAT_ONBOARDING_TONE_LABEL[tone],
    })),
    { id: "skip", label: CHAT_ONBOARDING_SKIP_LABEL },
  ];
}

export function confirmChips(): ChatOnboardingChip[] {
  return [
    { id: "save", label: "Save to memory" },
    { id: "dont_save", label: "Don't save" },
  ];
}

export function focusLabel(focus: ChatOnboardingFocus | "chat"): string {
  return focus === "chat" ? "Just chat" : FOCUS_LABEL[focus];
}

// ---------------------------------------------------------------------------
// Copy. Warm, short, private-agent framing. No em dashes (house rule).
// ---------------------------------------------------------------------------

export function welcomeText(displayName: string): string {
  const greeting = displayName && displayName !== "there" ? `Welcome, ${displayName}.` : "Welcome.";
  return [
    `${greeting} I'm Agent One on Hussh. I only work with what you choose to share, and you decide who else sees it.`,
    "Three optional questions so I can help the right way. Skipping a question moves to the next one.",
    "First, what should I call you?",
  ].join("\n\n");
}

export const NAME_TYPING_HINT = "Type what I should call you below.";

export function focusQuestionText(name: string | null, nameSkipped: boolean): string {
  const lead = name ? `Nice to meet you, ${name}.` : nameSkipped ? "No problem." : "";
  return [lead, "What should I help with first?"].filter(Boolean).join(" ");
}

export function toneQuestionText(): string {
  return "How should I talk with you?";
}

export function resumeQuestionText(question: ChatOnboardingQuestionId): string {
  switch (question) {
    case "name":
      return "Picking up where we left off. What should I call you?";
    case "focus":
      return "Picking up where we left off. What should I help with first?";
    case "tone":
      return "Picking up where we left off. How should I talk with you?";
  }
}

export function confirmText(input: { name: string | null; tone: ChatOnboardingTone | null }): string {
  const lines = [
    input.name ? `- Call you **${input.name}**` : null,
    input.tone ? `- Keep my replies **${CHAT_ONBOARDING_TONE_LABEL[input.tone].toLowerCase()}**` : null,
  ].filter((line): line is string => Boolean(line));
  return [
    "Here's what I'd remember:",
    lines.join("\n"),
    "Save this to your private memory? It's encrypted, and only you can open it.",
  ].join("\n\n");
}

export const SAVED_TEXT = "Saved. You can change it anytime in Memory. What's on your mind?";
export const NOT_SAVED_TEXT = "Okay, I won't save it. You're all set. What's on your mind?";
export const SAVE_FAILED_TEXT =
  "I couldn't save that just now, so nothing was stored. Try again, or tell me later.";
export const DONE_TEXT = "You're all set. What's on your mind?";
