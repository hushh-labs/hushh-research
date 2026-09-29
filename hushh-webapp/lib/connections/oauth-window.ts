"use client";

/** A consent window sized for Google's account chooser on a desktop screen. */
export const OAUTH_POPUP_FEATURES =
  "popup=yes,width=520,height=720,resizable=yes,scrollbars=yes";

/** Shown when both popup and tab are refused. Nothing navigates. */
export const OAUTH_WINDOW_BLOCKED_COPY =
  "Allow pop-ups for One, then try again. Your chat and draft stay here.";

export type OAuthWindowMode = "popup" | "tab";
export type OpenedOAuthWindow = { target: Window; mode: OAuthWindowMode };

function tryOpen(name: string, features?: string): Window | null {
  try {
    return window.open("about:blank", name, features) ?? null;
  } catch {
    return null;
  }
}

/**
 * Opens the connector consent window. Call it synchronously inside the
 * trusted click, before any awaited work, so the browser keeps the gesture.
 *
 * A sized popup is preferred. When the browser refuses it, a new tab is the
 * second choice: it is still an auxiliary window of this tab, so the
 * callback page settles through the same contract (a same-origin opener
 * postMessage, plus the same-origin storage event when Google's opener
 * policy severs the opener). Either way this window never navigates, so the
 * memory-only vault key, the chat and the open drawer survive.
 *
 * Returns null only when both are refused. Navigating this window away is
 * then the caller's explicit, last-resort decision (Drive does so only after
 * its encrypted chat-recovery capsule is saved); Connectors Mail and Calendar
 * keep the person in place instead.
 */
export function openOAuthWindow(name: string): OpenedOAuthWindow | null {
  if (typeof window === "undefined") return null;
  const popup = tryOpen(name, OAUTH_POPUP_FEATURES);
  if (popup) return { target: popup, mode: "popup" };
  const tab = tryOpen("_blank");
  return tab ? { target: tab, mode: "tab" } : null;
}
