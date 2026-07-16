"use client";

const STORAGE_KEY = "one_gmail_oauth_popup_attempt_v1";
// A localStorage key (not sessionStorage, which does not cross the
// popup/opener boundary) used as a fallback settlement signal. postMessage
// is the primary channel, but if the popup's `window.opener` reference is
// lost (some browsers null it out for popups, or cross-origin heuristics
// interfere), postMessage delivery silently fails. The parent also listens
// for the "storage" event on this key so it can detect settlement even when
// postMessage never arrives.
const FALLBACK_SETTLEMENT_KEY = "one_gmail_oauth_popup_settlement_v1";
const MAX_ATTEMPT_AGE_MS = 15 * 60 * 1000;
const POPUP_NAME = "hushh-gmail-oauth";
const POPUP_FEATURES = "popup=yes,width=520,height=720,resizable=yes,scrollbars=yes";

export type GmailOAuthPopupAttempt = {
  version: 1;
  attemptId: string;
  startedAt: number;
};

export type GmailOAuthPopupSettlement = {
  schemaVersion: 1;
  type: "gmail_oauth_settlement";
  attemptId: string;
  outcome: "succeeded" | "cancelled" | "failed";
  message?: string;
};

function getStorage(target?: Window | null): Storage | null {
  try {
    return target?.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function isAttemptId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 8 &&
    value.length <= 96 &&
    /^[a-zA-Z0-9_-]+$/.test(value)
  );
}

export function createGmailOAuthPopupAttempt(): GmailOAuthPopupAttempt {
  const attemptId =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `gmail_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  return {
    version: 1,
    attemptId,
    startedAt: Date.now(),
  };
}

export function persistGmailOAuthPopupAttempt(
  target: Window | null | undefined,
  attempt: GmailOAuthPopupAttempt,
): boolean {
  const targetStorage = getStorage(target);
  if (!targetStorage) return false;
  try {
    targetStorage.setItem(STORAGE_KEY, JSON.stringify(attempt));
    return true;
  } catch {
    return false;
  }
}

export function readGmailOAuthPopupAttempt(): GmailOAuthPopupAttempt | null {
  if (typeof window === "undefined") return null;
  const targetStorage = getStorage(window);
  const raw = targetStorage?.getItem(STORAGE_KEY);
  if (!targetStorage || !raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<GmailOAuthPopupAttempt>;
    if (
      parsed.version === 1 &&
      isAttemptId(parsed.attemptId) &&
      typeof parsed.startedAt === "number" &&
      Number.isFinite(parsed.startedAt) &&
      Date.now() - parsed.startedAt >= 0 &&
      Date.now() - parsed.startedAt <= MAX_ATTEMPT_AGE_MS
    ) {
      return parsed as GmailOAuthPopupAttempt;
    }
  } catch {
    // Discard malformed browser state below.
  }
  targetStorage.removeItem(STORAGE_KEY);
  return null;
}

export function clearGmailOAuthPopupAttempt(
  target?: Window | null,
): void {
  getStorage(target ?? (typeof window === "undefined" ? null : window))?.removeItem(
    STORAGE_KEY,
  );
}

/**
 * Opens before any asynchronous OAuth preparation so the popup retains the
 * browser's trusted activation. The callback remains on the existing,
 * backend-validated Gmail return URI; this placeholder never becomes an OAuth
 * redirect target.
 */
export function openGmailOAuthPopup(
  attempt: GmailOAuthPopupAttempt,
): Window | null {
  if (typeof window === "undefined") return null;
  const popup = window.open("about:blank", POPUP_NAME, POPUP_FEATURES);
  if (!popup) return null;

  if (!persistGmailOAuthPopupAttempt(popup, attempt)) {
    popup.close();
    return null;
  }

  try {
    popup.document.title = "Connecting Gmail";
    popup.focus();
  } catch {
    // The browser owns focus policy. The retained popup remains usable.
  }
  return popup;
}

/** Navigate only the retained popup to the Google authorization URL. */
export function navigateGmailOAuthPopup(
  popup: Window,
  authorizeUrl: string,
): void {
  popup.location.replace(authorizeUrl);
}

export function isGmailOAuthPopupSettlement(
  value: unknown,
): value is GmailOAuthPopupSettlement {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<GmailOAuthPopupSettlement>;
  return (
    candidate.schemaVersion === 1 &&
    candidate.type === "gmail_oauth_settlement" &&
    isAttemptId(candidate.attemptId) &&
    (candidate.outcome === "succeeded" ||
      candidate.outcome === "cancelled" ||
      candidate.outcome === "failed") &&
    (candidate.message === undefined || typeof candidate.message === "string")
  );
}

/**
 * Callback pages notify only their exact same-origin opener. The payload is a
 * redacted terminal outcome; OAuth codes, state, tokens, connector secrets,
 * vault material, and receipt content never cross this boundary.
 */
export function notifyGmailOAuthPopupOpener(
  settlement: GmailOAuthPopupSettlement,
): boolean {
  if (typeof window === "undefined") return false;
  const opener = window.opener;
  if (!opener || opener.closed) return false;
  try {
    opener.postMessage(settlement, window.location.origin);
    return true;
  } catch {
    return false;
  }
}

/**
 * Fallback settlement channel for when `window.opener` is null/inaccessible
 * (postMessage cannot be delivered). Writing to localStorage fires a
 * same-origin "storage" event on every OTHER tab/window watching this key,
 * including the original opener, even without a direct opener reference.
 * Same redacted terminal-outcome payload as postMessage; no OAuth/vault
 * material crosses this channel either.
 */
export function notifyGmailOAuthPopupOpenerFallback(
  settlement: GmailOAuthPopupSettlement,
): boolean {
  if (typeof window === "undefined") return false;
  try {
    window.localStorage.setItem(
      FALLBACK_SETTLEMENT_KEY,
      JSON.stringify({ ...settlement, sentAt: Date.now() }),
    );
    // Clear it right after so a later reload of this same tab doesn't
    // replay a stale settlement as if it just happened.
    window.localStorage.removeItem(FALLBACK_SETTLEMENT_KEY);
    return true;
  } catch {
    return false;
  }
}

export function readGmailOAuthPopupSettlementFallback(
  event: StorageEvent,
): GmailOAuthPopupSettlement | null {
  if (event.key !== FALLBACK_SETTLEMENT_KEY || !event.newValue) return null;
  try {
    const parsed = JSON.parse(event.newValue) as unknown;
    return isGmailOAuthPopupSettlement(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
