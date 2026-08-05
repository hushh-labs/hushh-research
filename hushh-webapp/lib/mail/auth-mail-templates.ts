/**
 * One's transactional auth mail.
 *
 * Three moments, three mails, one design family with the `invitation` template
 * that `hushh-mail-api` already sends:
 *
 *   welcome        first sign-in — the account now exists
 *   welcome_back   a later sign-in — also the "was this you?" signal
 *   phone_conflict the number entered on the phone step is verified on a
 *                  different account, which the person has usually forgotten
 *
 * Copy rules: one headline, at most one supporting line, one action. Anything
 * the panel already states is not repeated in prose.
 */

import {
  buildEmailShell,
  ONE_APP_URL,
  type DetailRow,
  type RenderedEmail,
} from "@/lib/mail/email-shell";

export type AuthMailEvent = "welcome" | "welcome_back" | "phone_conflict";

export interface BuiltAuthMail extends RenderedEmail {
  subject: string;
}

/** First name only. A full legal name in a greeting reads like a form letter. */
export function firstNameOf(displayName?: string | null): string {
  const first = String(displayName ?? "")
    .trim()
    .split(/\s+/)[0];
  // Reject anything that is not a plain name: emails, handles, single letters.
  if (!first || first.length < 2 || /[@<>"]/.test(first)) return "";
  return first;
}

/**
 * `ankit.singh@gmail.com` → `an•••@gmail.com`.
 *
 * The other account's address is a recovery hint, never a disclosure: enough to
 * recognise an inbox you own, not enough to learn one you do not.
 */
export function maskEmail(email?: string | null): string {
  const raw = String(email ?? "").trim();
  const at = raw.lastIndexOf("@");
  if (at <= 0) return "";
  const local = raw.slice(0, at);
  const domain = raw.slice(at + 1);
  if (!domain) return "";
  const head = local.slice(0, local.length > 2 ? 2 : 1);
  return `${head}•••@${domain}`;
}

/** Unambiguous across time zones, which a local-time string would not be. */
export function formatSignInMoment(at: Date): string {
  return `${new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  }).format(at)} UTC`;
}

export interface AuthMailContext {
  displayName?: string | null;
}

export function buildWelcomeMail(context: AuthMailContext): BuiltAuthMail {
  const name = firstNameOf(context.displayName);
  return {
    subject: "Welcome to One",
    ...buildEmailShell({
      previewText: "Your One account is ready.",
      eyebrow: "Welcome",
      heading: name ? `${name}, you're in.` : "You're in.",
      paragraphs: ["One is your private agent. Your data stays yours."],
      cta: { label: "Open One", url: ONE_APP_URL },
      footNote: "You received this because a Hussh account was just created with this address.",
    }),
  };
}

export interface WelcomeBackContext extends AuthMailContext {
  signedInAt: Date;
}

export function buildWelcomeBackMail(context: WelcomeBackContext): BuiltAuthMail {
  const name = firstNameOf(context.displayName);
  return {
    subject: "Welcome back to One",
    ...buildEmailShell({
      previewText: "You just signed in to One.",
      eyebrow: "Sign-in",
      heading: name ? `Welcome back, ${name}.` : "Welcome back.",
      paragraphs: ["Good to see you again."],
      details: [{ label: "Signed in", value: formatSignInMoment(context.signedInAt) }],
      cta: { label: "Open One", url: ONE_APP_URL },
      footNote: "Not you? Reply to this email and we will secure the account.",
    }),
  };
}

export interface PhoneConflictContext extends AuthMailContext {
  /**
   * The number that was entered, in E.164. Shown in full: the recipient typed
   * it a moment ago on their own screen, so masking it hides nothing from them
   * and only makes the mail harder to act on. The account that holds it is a
   * different matter and stays masked.
   */
  attemptedPhoneNumber: string;
  /** Address on the account that already holds the number. Masked before use. */
  linkedAccountEmail?: string | null;
}

export function buildPhoneConflictMail(context: PhoneConflictContext): BuiltAuthMail {
  const name = firstNameOf(context.displayName);
  const phoneNumber = String(context.attemptedPhoneNumber ?? "").trim();
  const maskedEmail = maskEmail(context.linkedAccountEmail);

  const details: DetailRow[] = [];
  if (phoneNumber) details.push({ label: "Number", value: phoneNumber });
  if (maskedEmail) details.push({ label: "Account", value: maskedEmail });

  return {
    subject: "That number is on another account",
    ...buildEmailShell({
      previewText: "The number you entered is verified on a different account.",
      eyebrow: "Account check",
      heading: name ? `${name}, that number is taken.` : "That number is taken.",
      paragraphs: [
        maskedEmail
          ? "It is already verified on another Hussh account — often one you made earlier and forgot."
          : "It is already verified on another Hussh account.",
      ],
      details,
      cta: { label: "Sign in to that account", url: `${ONE_APP_URL}/login` },
      footNote: "Didn't try this? Ignore this email — nothing changed.",
    }),
  };
}
