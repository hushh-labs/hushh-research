/**
 * POST /api/auth/mail
 *
 * The one place One asks `hushh-mail-api` for a lifecycle mail.
 *
 *   { "event": "signed_in" }
 *     Welcome on the first sign-in, welcome back on every later one.
 *
 *   { "event": "phone_conflict", "phoneNumber": "+9198…" }
 *     Sent when the phone step reports that the number is verified on another
 *     account. The mail names that account only as a masked address, and only
 *     to the signed-in person's own verified inbox.
 *
 * A mail failure never fails the caller: the response reports the outcome and
 * the sign-in continues either way.
 */

import { NextRequest, NextResponse } from "next/server";

import { validateFirebaseToken } from "@/lib/auth/validate";
import {
  sendPhoneConflictMail,
  sendSignInMail,
  WELCOME_MAIL_CLAIM,
} from "@/lib/mail/auth-mail-service";
import { resolveRuntimeFrontendUrl } from "@/lib/runtime/settings";

export const dynamic = "force-dynamic";

const E164_PATTERN = /^\+[1-9]\d{6,14}$/;

/**
 * Guards against a client loop turning into a mail loop. This is per instance
 * and therefore a backstop, not a quota — the durable guarantees live in
 * auth-mail-service.
 */
const RECENT_REQUESTS = new Map<string, number>();
const RECENT_WINDOW_MS = 60_000;
const RECENT_MAX_ENTRIES = 5_000;

function seenRecently(key: string): boolean {
  const now = Date.now();
  const previous = RECENT_REQUESTS.get(key);
  if (previous !== undefined && now - previous < RECENT_WINDOW_MS) return true;
  if (RECENT_REQUESTS.size >= RECENT_MAX_ENTRIES) RECENT_REQUESTS.clear();
  RECENT_REQUESTS.set(key, now);
  return false;
}

/**
 * Per-account ceiling on conflict mail.
 *
 * The client only asks for this after a real Firebase conflict, but the route
 * is reachable directly by anyone signed in, and it will happily look up any
 * number. Two things follow from that and both are capped here: the mail names
 * a masked address, so an unbounded caller could walk numbers to learn which
 * ones are registered; and every send spends from a Workspace daily quota
 * shared with the welcome mail, so a loop could starve real signups.
 *
 * Per instance, so the true ceiling is this times the instance count. That is
 * a backstop against a runaway or casual prober, not a strict global quota —
 * an exact one needs shared state the frontend does not have today.
 */
const CONFLICT_SENDS = new Map<string, number[]>();
const CONFLICT_WINDOW_MS = 60 * 60_000;
const CONFLICT_MAX_PER_WINDOW = 3;

function conflictQuotaExhausted(uid: string): boolean {
  const now = Date.now();
  const recent = (CONFLICT_SENDS.get(uid) ?? []).filter(
    (at) => now - at < CONFLICT_WINDOW_MS,
  );
  if (recent.length >= CONFLICT_MAX_PER_WINDOW) {
    CONFLICT_SENDS.set(uid, recent);
    return true;
  }
  recent.push(now);
  if (CONFLICT_SENDS.size >= RECENT_MAX_ENTRIES) CONFLICT_SENDS.clear();
  CONFLICT_SENDS.set(uid, recent);
  return false;
}

export async function POST(request: NextRequest) {
  const identity = await validateFirebaseToken(request.headers.get("Authorization"));
  if (!identity.valid || !identity.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    event?: string;
    phoneNumber?: string;
  };
  const event = String(body.event ?? "").trim();
  if (event !== "signed_in" && event !== "phone_conflict") {
    return NextResponse.json({ error: "Unsupported event" }, { status: 400 });
  }

  const appUrl = resolveRuntimeFrontendUrl() || new URL(request.url).origin;

  try {
    const { auth } = await import("@/lib/firebase/admin");
    const user = await auth.getUser(identity.userId);

    if (event === "signed_in") {
      const signInStamp = user.metadata?.lastSignInTime ?? "";
      if (seenRecently(`signed_in:${user.uid}:${signInStamp}`)) {
        return NextResponse.json({ status: "skipped", reason: "duplicate_request" });
      }

      const outcome = await sendSignInMail(user, { appUrl }, {
        markWelcomeSent: async (uid, atEpochSeconds) => {
          // Merge: replacing the claim set would drop anything another feature
          // adds later.
          await auth.setCustomUserClaims(uid, {
            ...(user.customClaims ?? {}),
            [WELCOME_MAIL_CLAIM]: atEpochSeconds,
          });
        },
      });
      return NextResponse.json(outcome);
    }

    const phoneNumber = String(body.phoneNumber ?? "").trim();
    if (!E164_PATTERN.test(phoneNumber)) {
      return NextResponse.json({ error: "Invalid phone number" }, { status: 400 });
    }
    if (seenRecently(`phone_conflict:${user.uid}:${phoneNumber}`)) {
      return NextResponse.json({ status: "skipped", reason: "duplicate_request" });
    }

    // Only mail when a different account genuinely holds the number. Sending
    // otherwise would be both wrong — "that number is taken" when it is not —
    // and an invitation to walk the number space. The owner may legitimately
    // have no email of its own (a phone-only account), which is a real
    // conflict with no hint to offer, so absence of an owner and absence of an
    // address are kept apart.
    const owner = await auth.getUserByPhoneNumber(phoneNumber).catch(() => null);
    if (!owner || owner.uid === user.uid) {
      return NextResponse.json({ status: "skipped", reason: "no_conflicting_account" });
    }

    if (conflictQuotaExhausted(user.uid)) {
      return NextResponse.json({ status: "skipped", reason: "rate_limited" });
    }

    const outcome = await sendPhoneConflictMail(user, {
      appUrl,
      attemptedPhoneNumber: phoneNumber,
      linkedAccountEmail: owner.email ?? null,
    });
    return NextResponse.json(outcome);
  } catch (error) {
    console.warn("[API] Auth mail dispatch failed:", error);
    return NextResponse.json({ status: "failed", reason: "dispatch_error" });
  }
}
