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

import { MAILABLE_CAPABILITY_IDS } from "@/lib/mail/account-activity-copy";
import {
  buildCapabilityLinkedMail,
  buildPhoneConflictMail,
  buildSignedOutMail,
  buildWelcomeBackMail,
  buildWelcomeMail,
  type BuiltAuthMail,
} from "@/lib/mail/auth-mail-templates";
import { sendMail, type SendMailResult } from "@/lib/mail/mail-client";

/** A first sign-in lands within a second or two of account creation. */
const FIRST_SIGN_IN_TOLERANCE_MS = 60_000;

export const WELCOME_MAIL_CLAIM = "hushhWelcomeMailAt";

type AuthMailKind =
  | "welcome"
  | "welcome_back"
  | "phone_conflict"
  | "signed_out"
  | "capability_linked";

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
 * The end of a session. Keyed on the sign-in it closes, so one session produces
 * exactly one sign-in mail and one sign-out mail however many times the client
 * retries either.
 */
export async function sendSignedOutMail(user: UserRecord): Promise<AuthMailOutcome> {
  const to = String(user.email ?? "").trim();
  if (!to) return { status: "skipped", reason: "no_email" };

  const sessionStamp = String(
    (parseTime(user.metadata?.lastSignInTime) ?? new Date()).getTime(),
  );

  return deliver(
    "signed_out",
    to,
    buildSignedOutMail({ displayName: user.displayName, signedOutAt: new Date() }),
    `one-signout:${user.uid}:${sessionStamp}`,
  );
}

export const LINKED_MAIL_CLAIM = "hushhLinkedMailed";

/**
 * Capabilities whose state has ever been *resolved* for this account.
 *
 * Separate from LINKED_MAIL_CLAIM because "not connected" and "not resolvable"
 * are different facts, and conflating them mails the wrong thing. The `/one`
 * dashboard resolves without OAuth enrichment, so Gmail reads `unknown` there
 * rather than connected. Seeding from that view alone would omit Gmail, and the
 * first `/one/setup` visit — which does enrich — would then look like a fresh
 * connection and mail somebody about a link they made months ago.
 */
export const LINKED_SEEN_CLAIM = "hushhLinkedSeen";

/**
 * Cap per request so a first report, or a burst of linking, cannot turn into a
 * wall of mail. Anything over the cap is left unmarked and picked up by the
 * next report rather than dropped.
 */
const LINKED_MAIL_MAX_PER_REQUEST = 3;

export interface CapabilityLinkMailDeps {
  /** Persists both durable sets in one write. */
  markCapabilities: (
    uid: string,
    next: { mailed: string[]; seen: string[] },
  ) => Promise<void>;
}

export interface CapabilityLinkResult {
  status: "sent" | "seeded" | "skipped" | "not_configured" | "failed";
  mailed: string[];
  reason?: string;
}

function readClaimList(user: UserRecord, claim: string): string[] {
  const raw = (user.customClaims as Record<string, unknown> | undefined)?.[claim];
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => String(entry)).filter(Boolean);
}

export interface CapabilityReport {
  /** Ids whose state was determinable in this pass. */
  observed: string[];
  /** The subset of `observed` that is connected. */
  connected: string[];
}

/**
 * Mail the capabilities that have newly become connected.
 *
 * The client reports the whole connected set rather than firing an event per
 * link. There are nine ways to connect something — Gmail OAuth return, Plaid
 * return, a location grant, KYC, and so on — and hooking each one means the one
 * that gets added next year is silently missed. Diffing a reported set against
 * a durable record covers every path, including a link made on another device.
 *
 * The first report for an account **seeds without mailing**. Somebody who
 * connected Gmail months ago should not receive "Gmail is connected" the first
 * time this ships.
 */
export async function sendCapabilityLinkedMail(
  user: UserRecord,
  report: CapabilityReport,
  deps: CapabilityLinkMailDeps,
): Promise<CapabilityLinkResult> {
  const to = String(user.email ?? "").trim();
  if (!to) return { status: "skipped", mailed: [], reason: "no_email" };

  const clean = (ids: string[]) => [
    ...new Set(
      ids
        .map((id) => String(id ?? "").trim())
        .filter((id) => MAILABLE_CAPABILITY_IDS.includes(id)),
    ),
  ].sort();

  const observed = clean(report.observed);
  // Connected is meaningless for something this pass could not resolve.
  const connected = clean(report.connected).filter((id) => observed.includes(id));

  const alreadyMailed = readClaimList(user, LINKED_MAIL_CLAIM);
  const alreadySeen = readClaimList(user, LINKED_SEEN_CLAIM);

  // First sighting of a capability tells us nothing about when it was
  // connected, so it is recorded and left alone. Only a capability we have
  // previously seen — and seen as not connected — can be called new.
  const firstSighting = observed.filter((id) => !alreadySeen.includes(id));
  const seedFromFirstSighting = firstSighting.filter((id) => connected.includes(id));

  const fresh = connected.filter(
    (id) => alreadySeen.includes(id) && !alreadyMailed.includes(id),
  );

  const nextSeen = [...new Set([...alreadySeen, ...observed])].sort();

  if (fresh.length === 0) {
    // Nothing to announce, but the sighting itself is worth remembering.
    if (seedFromFirstSighting.length > 0 || nextSeen.length !== alreadySeen.length) {
      await deps.markCapabilities(user.uid, {
        mailed: [...new Set([...alreadyMailed, ...seedFromFirstSighting])].sort(),
        seen: nextSeen,
      });
      return {
        status: seedFromFirstSighting.length > 0 ? "seeded" : "skipped",
        mailed: [],
        reason: seedFromFirstSighting.length > 0 ? undefined : "nothing_new",
      };
    }
    return { status: "skipped", mailed: [], reason: "nothing_new" };
  }

  const batch = fresh.slice(0, LINKED_MAIL_MAX_PER_REQUEST);
  const linkedAt = new Date();
  const mailed: string[] = [];
  let lastFailure = "";

  for (const capabilityId of batch) {
    const mail = buildCapabilityLinkedMail({
      displayName: user.displayName,
      capabilityId,
      linkedAt,
    });
    if (!mail) continue;

    const outcome = await deliver(
      "capability_linked",
      to,
      mail,
      `one-linked:${user.uid}:${capabilityId}`,
    );
    if (outcome.status === "sent") {
      mailed.push(capabilityId);
      continue;
    }
    if (outcome.status === "not_configured") {
      return { status: "not_configured", mailed: [] };
    }
    lastFailure = outcome.status === "failed" ? outcome.reason : "";
    // Stop on the first failure: the rest stay unmarked and are retried by the
    // next report rather than being marked as mailed when they were not.
    break;
  }

  // Record only what actually went out, so a failure retries instead of being
  // silently swallowed. The sighting set advances regardless: we did resolve
  // those states, whether or not the mail for them succeeded.
  await deps.markCapabilities(user.uid, {
    mailed: [...new Set([...alreadyMailed, ...seedFromFirstSighting, ...mailed])].sort(),
    seen: nextSeen,
  });

  if (mailed.length === 0) {
    return { status: "failed", mailed: [], reason: lastFailure || "send_failed" };
  }
  return { status: "sent", mailed };
}

/**
 * Welcome on the first sign-in, welcome back on every later one.
 */
export async function sendSignInMail(
  user: UserRecord,
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
      buildWelcomeMail({ displayName: user.displayName }),
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
      displayName: user.displayName,
      attemptedPhoneNumber: context.attemptedPhoneNumber,
      linkedAccountEmail: context.linkedAccountEmail,
    }),
    // One mail per person per number: a repeated attempt on the same number is
    // the same fact, and re-sending it would be noise.
    `one-phone-conflict:${user.uid}:${digits}`,
  );
}
