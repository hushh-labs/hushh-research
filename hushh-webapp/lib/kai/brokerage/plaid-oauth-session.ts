"use client";

import {
  getSessionItem,
  removeSessionItem,
  setSessionItem,
} from "@/lib/utils/session-storage";

const PLAID_OAUTH_SESSION_KEY = "kai_plaid_oauth_resume_v2";
// A bank login takes minutes; after half an hour the person starts again
// from Finance with a fresh link token.
const PLAID_OAUTH_SESSION_TTL_MS = 30 * 60 * 1000;

/**
 * What the web needs to finish a bank's OAuth login after the page reloads on
 * the return URL. On the web, Link leaves the page for the bank, so the
 * in-memory vault key and the pending connect call are gone when the person
 * comes back.
 *
 * Holds only the link token, which can re-open Link but grants no access to
 * any account (no access token, no public token, no vault key, no VAULT_OWNER
 * token). Tab-scoped session storage, single use, cleared on read.
 */
export interface PlaidOAuthResumeSession {
  version: 2;
  userId: string;
  linkToken: string;
  /** The https redirect URI the link token was minted with. */
  redirectUri: string;
  returnPath: string;
  startedAt: string;
  expiresAt: string;
  /** Opaque setup-attempt id; never a Plaid or vault credential. */
  onboardingAttemptId?: string;
  /** Set when the link repairs a sealed connection (update mode). */
  relinkItemId?: string;
}

function nonEmpty(value: unknown, maxLength = 2048): string | undefined {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength
    ? value
    : undefined;
}

export function savePlaidOAuthResumeSession(
  session: Omit<PlaidOAuthResumeSession, "version" | "startedAt" | "expiresAt">,
  now: Date = new Date(),
): void {
  const record: PlaidOAuthResumeSession = {
    ...session,
    version: 2,
    startedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + PLAID_OAUTH_SESSION_TTL_MS).toISOString(),
  };
  setSessionItem(PLAID_OAUTH_SESSION_KEY, JSON.stringify(record));
}

export function loadPlaidOAuthResumeSession(now: Date = new Date()): PlaidOAuthResumeSession | null {
  const raw = getSessionItem(PLAID_OAUTH_SESSION_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PlaidOAuthResumeSession>;
    const userId = nonEmpty(parsed.userId, 256);
    const linkToken = nonEmpty(parsed.linkToken, 512);
    const redirectUri = nonEmpty(parsed.redirectUri);
    const returnPath = nonEmpty(parsed.returnPath);
    const expiresAt = nonEmpty(parsed.expiresAt, 64);
    if (parsed.version !== 2 || !userId || !linkToken || !redirectUri || !returnPath || !expiresAt) {
      return null;
    }
    const expiresMs = Date.parse(expiresAt);
    if (!Number.isFinite(expiresMs) || expiresMs <= now.getTime()) {
      clearPlaidOAuthResumeSession();
      return null;
    }
    // Only an in-app path is a valid place to send the person afterwards.
    const safeReturnPath = returnPath.startsWith("/") && !returnPath.startsWith("//") ? returnPath : "/";
    return {
      version: 2,
      userId,
      linkToken,
      redirectUri,
      returnPath: safeReturnPath,
      startedAt: nonEmpty(parsed.startedAt, 64) ?? now.toISOString(),
      expiresAt,
      onboardingAttemptId: nonEmpty(parsed.onboardingAttemptId, 96),
      relinkItemId: nonEmpty(parsed.relinkItemId, 256),
    };
  } catch {
    return null;
  }
}

export function clearPlaidOAuthResumeSession(): void {
  removeSessionItem(PLAID_OAUTH_SESSION_KEY);
}
