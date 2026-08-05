/**
 * Decides which auth mail to send, and whether to send one at all.
 *
 * The route handler stays thin; the judgement lives here so it is testable
 * without a request.
 *
 * Not sending twice
 * -----------------
 * The client fires one call per real sign-in, so there is normally exactly one
 * request per mail. Three backstops sit under that:
 *
 *   - `lastSignInTime` keys the idempotency. Firebase advances it on a sign-in
 *     and not on a token refresh, so every retry inside one sign-in collapses
 *     onto the same key.
 *   - `hushhWelcomeMailAt`, a custom claim, makes the welcome mail
 *     once-per-account for good. It is the only durable store this service has
 *     — the Firebase project has no Firestore — and it survives instance
 *     recycling, which an in-memory guard does not.
 *   - the mail service's own `idempotencyKey`, which is per-instance and
 *     therefore a backstop rather than a guarantee.
 */

import "server-only";

import type { auth as adminAuth } from "firebase-admin";

import {
  buildPhoneConflictMail,
  buildWelcomeBackMail,
  buildWelcomeMail,
  type BuiltAuthMail,
} from "@/lib/mail/auth-mail-templates";
import { sendMail, type SendMailResult } from "@/lib/mail/mail-client";

/** A first sign-in lands within a second or two of account creation. */
const FIRST_SIGN_IN_TOLERANCE_MS = 60_000;

export const WELCOME_MAIL_CLAIM = "hushhWelcomeMailAt";

type AuthMailKind = "welcome" | "welcome_back" | "phone_conflict";

export type AuthMailOutcome =
  | { status: "sent"; kind: AuthMailKind; messageId: string | null }
  | { status: "skipped"; reason: string }
  | { status: "not_configured" }
  | { status: "failed"; reason: string };

type UserRecord = adminAuth.UserRecord;

function parseTime(value: string | undefined | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * True when this sign-in is the one that created the account. Firebase sets
 * both timestamps in the same operation, so they agree within a second; the
 * tolerance only absorbs clock jitter between the two writes.
 */
export function isFirstSignIn(record: {
  creationTime?: string;
  lastSignInTime?: string;
}): boolean {
  const created = parseTime(record.creationTime);
  const lastSignIn = parseTime(record.lastSignInTime);
  if (!created) return false;
  if (!lastSignIn) return true;
  return lastSignIn.getTime() - created.getTime() <= FIRST_SIGN_IN_TOLERANCE_MS;
}

function toOutcome(kind: AuthMailKind, sent: SendMailResult): AuthMailOutcome {
  if (sent.status === "sent") return { status: "sent", kind, messageId: sent.messageId };
  if (sent.status === "not_configured") return { status: "not_configured" };
  return { status: "failed", reason: sent.reason };
}

async function deliver(
  kind: AuthMailKind,
  to: string,
  mail: BuiltAuthMail,
  idempotencyKey: string,
): Promise<AuthMailOutcome> {
  const sent = await sendMail({
    to,
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
    idempotencyKey,
  });
  return toOutcome(kind, sent);
}

export interface SignInMailDeps {
  /** Marks the welcome mail as sent, durably. Failures must not resend. */
  markWelcomeSent: (uid: string, atEpochSeconds: number) => Promise<void>;
}

/**
 * Welcome on the first sign-in, welcome back on every later one.
 */
export async function sendSignInMail(
  user: UserRecord,
  context: { appUrl: string },
  deps: SignInMailDeps,
): Promise<AuthMailOutcome> {
  const to = String(user.email ?? "").trim();
  if (!to) return { status: "skipped", reason: "no_email" };

  const lastSignInTime = user.metadata?.lastSignInTime;
  const signedInAt = parseTime(lastSignInTime) ?? new Date();
  const signInStamp = String(signedInAt.getTime());

  if (isFirstSignIn(user.metadata ?? {})) {
    const alreadySent = Number(
      (user.customClaims as Record<string, unknown> | undefined)?.[WELCOME_MAIL_CLAIM] ?? 0,
    );
    if (alreadySent > 0) {
      // The account exists and was already welcomed — a repeat here means a
      // retry, not a second signup.
      return { status: "skipped", reason: "welcome_already_sent" };
    }

    const outcome = await deliver(
      "welcome",
      to,
      buildWelcomeMail({ appUrl: context.appUrl, displayName: user.displayName }),
      `one-welcome:${user.uid}`,
    );
    if (outcome.status === "sent") {
      // The mail is already delivered at this point. A claim-write failure must
      // not be reported as a failed send — the caller would read that as "no
      // mail went out", which is the opposite of what happened. `isFirstSignIn`
      // stops being true once the next real sign-in advances lastSignInTime, so
      // a lost marker risks at most one repeat, not an unbounded loop.
      try {
        await deps.markWelcomeSent(user.uid, Math.floor(Date.now() / 1000));
      } catch (error) {
        console.warn("[AuthMail] Welcome mail sent but its marker did not persist:", error);
      }
    }
    return outcome;
  }

  return deliver(
    "welcome_back",
    to,
    buildWelcomeBackMail({
      appUrl: context.appUrl,
      displayName: user.displayName,
      signedInAt,
    }),
    `one-signin:${user.uid}:${signInStamp}`,
  );
}

/**
 * The number entered on the phone step is verified on a different account.
 *
 * The mail goes to the signed-in person's own verified address and names the
 * other account only as a masked hint, so it helps someone recover an account
 * they forgot without telling anyone who owns a number.
 */
export async function sendPhoneConflictMail(
  user: UserRecord,
  context: {
    appUrl: string;
    attemptedPhoneNumber: string;
    linkedAccountEmail: string | null;
  },
): Promise<AuthMailOutcome> {
  const to = String(user.email ?? "").trim();
  if (!to) return { status: "skipped", reason: "no_email" };

  const digits = context.attemptedPhoneNumber.replace(/\D/g, "");
  if (digits.length < 5) return { status: "skipped", reason: "invalid_phone" };

  return deliver(
    "phone_conflict",
    to,
    buildPhoneConflictMail({
      appUrl: context.appUrl,
      displayName: user.displayName,
      attemptedPhoneNumber: context.attemptedPhoneNumber,
      linkedAccountEmail: context.linkedAccountEmail,
      signInUrl: `${context.appUrl}/login`,
    }),
    // One mail per person per number: a repeated attempt on the same number is
    // the same fact, and re-sending it would be noise.
    `one-phone-conflict:${user.uid}:${digits}`,
  );
}
