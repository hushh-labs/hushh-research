"use client";

import { openOAuthWindow } from "@/lib/connections/oauth-window";
import { waitForOAuthPopup } from "@/lib/profile/drive-oauth-popup";

// The in-session sign-in contract for operator-curated MCP connectors (Notion,
// HubSpot, Attio, ...). It mirrors Drive's popup contract with its own storage
// keys: this window never navigates, so the memory-only vault key survives, and
// the popup finishes the exchange with the Firebase identity alone. The marker
// stays in same-origin localStorage because a provider's opener policy can
// replace the popup browsing-context group and clear its sessionStorage.
const ATTEMPT_KEY = "one_curated_popup_attempt_v1";
const SETTLEMENT_KEY = "one_curated_popup_settlement_v1";
const MAX_AGE_MS = 10 * 60_000;
// OAuth start has a 30-second deadline. Leave that much room inside the
// server's ten-minute attempt lifetime without comparing device clocks.
const POPUP_WAIT_MS = MAX_AGE_MS - 30_000;
const SETTLEMENT_TTL_MS = 3_000;
// Google connectors and customer-owned MCP servers have their own contracts.
const CURATED_ID = /^[a-z][a-z0-9_]{1,63}$/;
export type CuratedPopupAttempt = {
  connectorId: string;
  attemptId: string;
  expiresAt: number;
};
export type CuratedPopupSettlement = CuratedPopupAttempt & {
  type: "curated_oauth_settlement";
  outcome: "succeeded" | "cancelled" | "failed";
};

export function isCuratedConnectorId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    CURATED_ID.test(value) &&
    !value.startsWith("google_") &&
    !value.startsWith("custom_")
  );
}

export function createCuratedPopupAttempt(
  connectorId: string,
  attemptId: string,
): CuratedPopupAttempt {
  // Only a local correlation deadline. The server checks the real attempt
  // expiry on completion, and its timestamp is unsafe to compare with the
  // clock of a device that may be behind.
  const attempt: CuratedPopupAttempt = {
    connectorId,
    attemptId,
    expiresAt: Date.now() + POPUP_WAIT_MS,
  };
  if (!isCuratedPopupAttempt(attempt))
    throw new Error("Authorization could not start. Try again.");
  return attempt;
}

export function isCuratedPopupAttempt(
  value: unknown,
): value is CuratedPopupAttempt {
  if (!value || typeof value !== "object") return false;
  const a = value as CuratedPopupAttempt;
  return (
    isCuratedConnectorId(a.connectorId) &&
    typeof a.attemptId === "string" &&
    /^[A-Za-z0-9_-]{16,128}$/.test(a.attemptId) &&
    Number.isFinite(a.expiresAt) &&
    a.expiresAt > Date.now() &&
    a.expiresAt <= Date.now() + MAX_AGE_MS
  );
}

export function isCuratedPopupSettlement(
  value: unknown,
): value is CuratedPopupSettlement {
  if (!isCuratedPopupAttempt(value)) return false;
  const result = value as CuratedPopupSettlement;
  return (
    result.type === "curated_oauth_settlement" &&
    ["succeeded", "cancelled", "failed"].includes(result.outcome) &&
    Object.keys(result).every((key) =>
      ["type", "connectorId", "attemptId", "expiresAt", "outcome"].includes(
        key,
      ),
    )
  );
}

/** Must be called directly in the trusted click, before fetching a start URL. */
export function openCuratedOAuthPopup(): Window | null {
  // A refused popup falls back to a new tab with the same settlement contract.
  const popup =
    openOAuthWindow(`one-curated-${crypto.randomUUID()}`)?.target ?? null;
  if (popup) {
    // A provider's sign-in pages are not ours, and none of them is known to send
    // an opener policy. Sever the popup's reference back to this window while it
    // is still same-origin (about:blank), so a page in the provider's flow can
    // never navigate this window and drop the memory-only vault key. Settlement
    // reaches this window through the same-origin storage event and the marker
    // it wrote itself, never through window.opener.
    try {
      popup.opener = null;
    } catch {
      /* Best effort: the settlement contract does not depend on it. */
    }
    try {
      popup.document.title = "Connecting";
      popup.document.body.textContent = "Opening secure sign-in…";
    } catch {
      /* The placeholder is cosmetic. */
    }
  }
  return popup;
}

export function navigateCuratedOAuthPopup(
  popup: Window,
  attempt: CuratedPopupAttempt,
  authorizeUrl: string,
): void {
  const url = new URL(authorizeUrl);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.origin === window.location.origin ||
    !isCuratedPopupAttempt(attempt) ||
    popup.closed
  ) {
    throw new Error("Authorization could not start. Try again.");
  }
  // Only a redacted correlation marker crosses the popup boundary. Never copy
  // the opener's owner token, drafts, provider credentials or signed state.
  // Write it from the opener so it survives a provider's opener-policy reset.
  window.localStorage.setItem(ATTEMPT_KEY, JSON.stringify(attempt));
  popup.location.replace(url.href);
}

export function readCuratedPopupAttempt(): CuratedPopupAttempt | null {
  try {
    const raw = window.localStorage.getItem(ATTEMPT_KEY);
    if (!raw) return null;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      window.localStorage.removeItem(ATTEMPT_KEY);
      return null;
    }
    const attempt = isCuratedPopupAttempt(value) ? value : null;
    if (!attempt) window.localStorage.removeItem(ATTEMPT_KEY);
    return attempt;
  } catch {
    return null;
  }
}

/** The state prefix is an untrusted routing hint; the server verifies its HMAC. */
export function isCuratedPopupReturn(state: string | null): boolean {
  const attempt = readCuratedPopupAttempt();
  if (!attempt || !state) return false;
  const [returnedAttemptId, signature, extra] = state.split(".");
  return (
    returnedAttemptId === attempt.attemptId &&
    /^[a-f0-9]{64}$/.test(signature ?? "") &&
    extra === undefined
  );
}

/** Remove only this attempt; another tab may have started a newer one. */
export function clearCuratedPopupAttempt(attempt: CuratedPopupAttempt): void {
  try {
    const raw = window.localStorage.getItem(ATTEMPT_KEY);
    if (!raw) return;
    const stored = JSON.parse(raw) as Partial<CuratedPopupAttempt> | null;
    if (
      stored?.connectorId === attempt.connectorId &&
      stored.attemptId === attempt.attemptId &&
      stored.expiresAt === attempt.expiresAt
    ) {
      window.localStorage.removeItem(ATTEMPT_KEY);
    }
  } catch {
    // Storage failure cannot prevent popup cleanup.
  }
}

export function notifyCuratedPopup(
  attempt: CuratedPopupAttempt,
  outcome: CuratedPopupSettlement["outcome"],
): void {
  const value: CuratedPopupSettlement = {
    type: "curated_oauth_settlement",
    connectorId: attempt.connectorId,
    attemptId: attempt.attemptId,
    expiresAt: attempt.expiresAt,
    outcome,
  };
  if (!isCuratedPopupSettlement(value)) return;
  try {
    window.opener?.postMessage(value, window.location.origin);
  } catch {
    /* Fall back to the same-origin storage event below. */
  }
  try {
    const serialized = JSON.stringify(value);
    // Keep the redacted settlement long enough for the opener's storage event
    // after the provider's opener policy has severed WindowProxy access.
    window.localStorage.setItem(SETTLEMENT_KEY, serialized);
    window.setTimeout(() => {
      try {
        if (window.localStorage.getItem(SETTLEMENT_KEY) === serialized)
          window.localStorage.removeItem(SETTLEMENT_KEY);
      } catch {
        // Browser storage failures cannot block callback cleanup.
      }
    }, SETTLEMENT_TTL_MS);
    clearCuratedPopupAttempt(attempt);
  } catch {
    /* Opener also reconciles after close/expiry. */
  }
}

/** Outcomes are advisory: the caller MUST refresh owner-authenticated status. */
export function waitForCuratedPopup(
  popup: Window,
  attempt: CuratedPopupAttempt,
  signal: AbortSignal,
  cancelSignal?: AbortSignal,
): Promise<void> {
  return waitForOAuthPopup({
    popup,
    signal,
    cancelSignal,
    observeClose: true,
    expiresAt: attempt.expiresAt,
    matches: (value) =>
      isCuratedPopupSettlement(value) &&
      value.connectorId === attempt.connectorId &&
      value.attemptId === attempt.attemptId &&
      value.expiresAt === attempt.expiresAt,
    storageValue: (event) => {
      if (event.key !== SETTLEMENT_KEY || !event.newValue) return null;
      try {
        return JSON.parse(event.newValue) as unknown;
      } catch {
        return null;
      }
    },
  });
}
