"use client";

import {
  getSessionItem,
  removeSessionItem,
  setSessionItem,
} from "@/lib/utils/session-storage";

const ALPACA_OAUTH_SESSION_KEY = "kai_alpaca_oauth_resume_v1";

export interface AlpacaOAuthResumeSession {
  version: 1;
  userId: string;
  state: string;
  returnPath: string;
  startedAt: string;
}

export function saveAlpacaOAuthResumeSession(session: AlpacaOAuthResumeSession): void {
  setSessionItem(ALPACA_OAUTH_SESSION_KEY, JSON.stringify(session));
}

export function loadAlpacaOAuthResumeSession(): AlpacaOAuthResumeSession | null {
  const raw = getSessionItem(ALPACA_OAUTH_SESSION_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<AlpacaOAuthResumeSession>;
    if (parsed.version !== 1) return null;
    if (!parsed.userId || !parsed.state || !parsed.returnPath) return null;
    return {
      version: 1,
      userId: parsed.userId,
      state: parsed.state,
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

export function clearAlpacaOAuthResumeSession(): void {
  removeSessionItem(ALPACA_OAUTH_SESSION_KEY);
}

