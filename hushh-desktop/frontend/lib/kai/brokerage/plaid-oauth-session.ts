"use client";

import {
  getSessionItem,
  removeSessionItem,
  setSessionItem,
} from "@/lib/utils/session-storage";

const PLAID_OAUTH_SESSION_KEY = "kai_plaid_oauth_resume_v1";

export interface PlaidOAuthResumeSession {
  version: 1;
  flowKind?: "investments" | "funding";
  userId: string;
  resumeSessionId: string;
  returnPath: string;
  startedAt: string;
}

// This stores only an opaque resume session id and return route. No vault key,
// VAULT_OWNER token, or Plaid token is persisted in browser storage.
export function savePlaidOAuthResumeSession(session: PlaidOAuthResumeSession): void {
  setSessionItem(PLAID_OAUTH_SESSION_KEY, JSON.stringify(session));
}

export function loadPlaidOAuthResumeSession(): PlaidOAuthResumeSession | null {
  const raw = getSessionItem(PLAID_OAUTH_SESSION_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PlaidOAuthResumeSession>;
    if (parsed.version !== 1) return null;
    if (!parsed.userId || !parsed.resumeSessionId || !parsed.returnPath) return null;
    return {
      version: 1,
      flowKind: parsed.flowKind === "funding" ? "funding" : "investments",
      userId: parsed.userId,
      resumeSessionId: parsed.resumeSessionId,
      returnPath: parsed.returnPath,
      startedAt:
        typeof parsed.startedAt === "string" && parsed.startedAt.trim().length > 0
          ? parsed.startedAt
          : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export function clearPlaidOAuthResumeSession(): void {
  removeSessionItem(PLAID_OAUTH_SESSION_KEY);
}
