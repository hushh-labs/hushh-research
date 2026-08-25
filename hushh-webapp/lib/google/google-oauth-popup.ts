"use client";

const ATTEMPT_KEY = "one_google_oauth_popup_attempt_v1";
const SETTLEMENT_KEY = "one_google_oauth_popup_settlement_v1";
const MAX_AGE_MS = 15 * 60 * 1000;
const POPUP_FEATURES = "popup=yes,width=520,height=720,resizable=yes,scrollbars=yes";

export type GoogleOAuthPopupService = "gmail_send" | "calendar";
export type GoogleOAuthPopupAttempt = { version: 1; attemptId: string; service: GoogleOAuthPopupService; startedAt: number };
export type GoogleOAuthPopupSettlement = { schemaVersion: 1; type: "google_oauth_settlement"; attemptId: string; service: GoogleOAuthPopupService; outcome: "succeeded" | "cancelled" | "failed"; message?: string };

function validId(value: unknown): value is string { return typeof value === "string" && /^[a-zA-Z0-9_-]{8,96}$/.test(value); }
function storage(target: Window | null | undefined): Storage | null { try { return target?.sessionStorage ?? null; } catch { return null; } }

export function createGoogleOAuthPopupAttempt(service: GoogleOAuthPopupService): GoogleOAuthPopupAttempt {
  return { version: 1, attemptId: crypto.randomUUID(), service, startedAt: Date.now() };
}

export function openGoogleOAuthPopup(attempt: GoogleOAuthPopupAttempt): Window | null {
  const popup = window.open("about:blank", "hushh-google-oauth", POPUP_FEATURES);
  if (!popup) return null;
  try { storage(popup)?.setItem(ATTEMPT_KEY, JSON.stringify(attempt)); popup.document.title = "Connecting Google"; popup.focus(); return popup; }
  catch { popup.close(); return null; }
}

export function navigateGoogleOAuthPopup(popup: Window, authorizeUrl: string): void { popup.location.replace(authorizeUrl); }

export function readGoogleOAuthPopupAttempt(): GoogleOAuthPopupAttempt | null {
  try {
    const parsed = JSON.parse(storage(window)?.getItem(ATTEMPT_KEY) || "") as Partial<GoogleOAuthPopupAttempt>;
    if (parsed.version === 1 && (parsed.service === "gmail_send" || parsed.service === "calendar") && validId(parsed.attemptId) && typeof parsed.startedAt === "number" && Date.now() - parsed.startedAt >= 0 && Date.now() - parsed.startedAt <= MAX_AGE_MS) return parsed as GoogleOAuthPopupAttempt;
  } catch { /* invalid browser state is ignored */ }
  return null;
}

export function isGoogleOAuthPopupSettlement(value: unknown): value is GoogleOAuthPopupSettlement {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<GoogleOAuthPopupSettlement>;
  return item.schemaVersion === 1 && item.type === "google_oauth_settlement" && (item.service === "gmail_send" || item.service === "calendar") && validId(item.attemptId) && ["succeeded", "cancelled", "failed"].includes(String(item.outcome));
}

export function settleGoogleOAuthPopup(attempt: GoogleOAuthPopupAttempt, outcome: GoogleOAuthPopupSettlement["outcome"], message?: string): void {
  const settlement: GoogleOAuthPopupSettlement = { schemaVersion: 1, type: "google_oauth_settlement", attemptId: attempt.attemptId, service: attempt.service, outcome, ...(message ? { message } : {}) };
  try { window.opener?.postMessage(settlement, window.location.origin); } catch { /* fallback below */ }
  try { window.localStorage.setItem(SETTLEMENT_KEY, JSON.stringify({ ...settlement, sentAt: Date.now() })); window.localStorage.removeItem(SETTLEMENT_KEY); } catch { /* best effort */ }
  window.setTimeout(() => window.close(), 0);
}

export function readGoogleOAuthPopupSettlement(event: StorageEvent): GoogleOAuthPopupSettlement | null {
  if (event.key !== SETTLEMENT_KEY || !event.newValue) return null;
  try { const value = JSON.parse(event.newValue) as unknown; return isGoogleOAuthPopupSettlement(value) ? value : null; } catch { return null; }
}
