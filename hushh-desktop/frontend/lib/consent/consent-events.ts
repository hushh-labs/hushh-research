"use client";

export const CONSENT_ACTION_COMPLETE_EVENT = "consent-action-complete";
export const CONSENT_STATE_CHANGED_EVENT = "consent-state-changed";

export function dispatchConsentStateChanged(detail?: Record<string, unknown>) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(CONSENT_STATE_CHANGED_EVENT, { detail }));
}
