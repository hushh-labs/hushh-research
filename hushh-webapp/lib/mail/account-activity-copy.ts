/**
 * One source of words for account activity.
 *
 * The screen and the inbox describe the same event, so they say the same thing.
 * When someone reads "That number is on another account" in a toast and then
 * opens a mail that calls it something else, they reasonably wonder whether two
 * different things happened.
 *
 * Deliberately free of imports so both sides can use it: the templates render
 * it server-side, the client surfaces render it in the browser.
 */

/** Capability titles, mirrored from the `ONE_CAPABILITIES` catalog. */
const CAPABILITY_TITLES: Record<string, string> = {
  finance: "Finance",
  ria: "RIA",
  gmail: "Gmail",
  email: "KYC",
  location: "Location",
  pkm: "Memory",
  consent: "Consent",
  marketplace: "Information Marketplace",
  "connected-systems": "CRM",
};

/**
 * The set a link mail may be sent for. An id outside this list is ignored
 * rather than mailed under its raw slug — a caller-supplied id must never
 * become the subject line.
 */
export const MAILABLE_CAPABILITY_IDS = Object.keys(CAPABILITY_TITLES);

export function capabilityTitle(id: string): string {
  return CAPABILITY_TITLES[String(id ?? "").trim()] ?? "";
}

export const PHONE_CONFLICT_COPY = {
  /** Shown in-app when Firebase reports the number is on another account. */
  inApp:
    "That number is on another Hussh account. Check your email — we sent you which one.",
  subject: "That number is on another account",
  heading: (firstName: string) =>
    firstName ? `${firstName}, that number is taken.` : "That number is taken.",
  withAccount:
    "It is already verified on another Hussh account — often one you made earlier and forgot.",
  withoutAccount: "It is already verified on another Hussh account.",
  action: "Sign in to that account",
  footNote: "Didn't try this? Ignore this email — nothing changed.",
} as const;

export const SIGNED_OUT_COPY = {
  subject: "You signed out of One",
  heading: (firstName: string) =>
    firstName ? `Signed out, ${firstName}.` : "Signed out.",
  body: "Your session on this device is closed.",
  action: "Sign back in",
  footNote: "Not you? Reply to this email and we will secure the account.",
} as const;

export const CAPABILITY_LINKED_COPY = {
  subject: (title: string) => `${title} is connected to One`,
  heading: (title: string) => `${title} is connected.`,
  body: (title: string) =>
    `${title} is now linked to your account. You can disconnect it any time.`,
  action: "Review connections",
  footNote: "Didn't connect this? Reply to this email and we will secure the account.",
} as const;
