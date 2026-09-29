"use client";

import { Capacitor } from "@capacitor/core";

import { clearCalendarSetupOAuthReturn } from "@/lib/calendar/calendar-oauth-journey";
import { HushhAuth } from "@/lib/capacitor";
import {
  consumeStoredGoogleOAuthPopupSettlement,
  createGoogleOAuthPopupAttempt,
  isGoogleOAuthPopupSettlement,
  navigateGoogleOAuthPopup,
  openGoogleOAuthPopup,
  readGoogleOAuthPopupSettlement,
} from "@/lib/google/google-oauth-popup";
import {
  clearGmailOAuthPopupAttempt,
  createGmailOAuthPopupAttempt,
  isGmailOAuthPopupSettlement,
  navigateGmailOAuthPopup,
  openGmailOAuthPopup,
  readGmailOAuthPopupSettlementFallback,
} from "@/lib/profile/gmail-oauth-popup";
import { waitForOAuthPopup } from "@/lib/profile/drive-oauth-popup";
import { GmailReceiptsService } from "@/lib/services/gmail-receipts-service";
import { GoogleCalendarService } from "@/lib/services/google-calendar-service";

/**
 * Connects a Google capability without navigating the current window, so the
 * memory-only vault key, the chat and its draft survive. Used by the chat
 * drawer and by every in-chat connect card.
 *
 * Web opens Google's consent in a popup (a new tab if the popup is refused)
 * SYNCHRONOUSLY when the start function is called, so call it directly inside
 * the click handler, before any await. The existing callback page settles to
 * this window, and the shared handler accepts only the exact origin, window
 * and attempt before expiry. That settlement is a hint: the outcome is decided
 * by an owner-authenticated status read. Native uses the platform Google
 * sign-in sheet, which never reloads the WebView.
 */
export type InPlaceConnectOutcome =
  /** The server confirms the requested permission. */
  | "connected"
  /** Cancelled, dismissed, expired, or the permission was not granted. */
  | "not_connected"
  /** Starting or completing the connection failed. */
  | "failed"
  /** The caller's lifetime ended or the owner changed; do not touch the UI. */
  | "stale";

export type InPlaceConnectStart = {
  /**
   * `window`: a consent popup or tab is open, so show a cancel control.
   * `native`: the platform sheet owns the interaction.
   * `blocked`: both popup and tab were refused; nothing was started.
   * `unsupported`: this capability cannot be granted on this platform.
   */
  surface: "window" | "native" | "blocked" | "unsupported";
  result: Promise<InPlaceConnectOutcome>;
};

export type InPlaceConnectOwner = {
  uid: string;
  getIdToken: () => Promise<string>;
  email?: string | null;
  providerData?: ReadonlyArray<{ providerId: string }>;
};

type ConnectControls = {
  /** Ends the attempt without a UI update (unmount, account switch). */
  signal?: AbortSignal;
  /** The person's explicit "Cancel sign-in"; ends quietly as not connected. */
  cancelSignal?: AbortSignal;
  /** Re-checked after every await; false makes the outcome `stale`. */
  isCurrent?: () => boolean;
};

const WINDOW_WAIT_LIMIT_MS = 10 * 60_000;

function isGoogleAuthorizeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.origin === "https://accounts.google.com" &&
      url.pathname === "/o/oauth2/v2/auth"
    );
  } catch {
    return false;
  }
}

function isCancelled(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "USER_CANCELLED"
  );
}

function started(
  surface: InPlaceConnectStart["surface"],
  run: () => Promise<InPlaceConnectOutcome>,
): InPlaceConnectStart {
  return { surface, result: run() };
}

/** Wraps one attempt so every await is fenced by lifetime and owner. */
async function fenced(
  controls: ConnectControls,
  close: () => void,
  body: (current: () => boolean) => Promise<InPlaceConnectOutcome>,
): Promise<InPlaceConnectOutcome> {
  const current = () =>
    !controls.signal?.aborted && (controls.isCurrent?.() ?? true);
  controls.signal?.addEventListener("abort", close, { once: true });
  try {
    const outcome = await body(current);
    return current() ? outcome : "stale";
  } catch (error) {
    if (!current()) return "stale";
    return isCancelled(error) ? "not_connected" : "failed";
  } finally {
    controls.signal?.removeEventListener("abort", close);
    close();
  }
}

/**
 * Gmail sending (`send`) or mailbox organisation (`modify`) on top of the
 * existing grant. Scopes and callback URI are unchanged; `modify` is web-only,
 * because the native Google sign-in plugins do not request gmail.modify.
 */
export function connectGmailInPlace(
  input: ConnectControls & {
    owner: InPlaceConnectOwner;
    purpose: "send" | "modify";
  },
): InPlaceConnectStart {
  const { owner, purpose } = input;
  const granted = (status: {
    connected?: boolean;
    send_permission_granted?: boolean;
    modify_permission_granted?: boolean;
  }) =>
    status.connected === true &&
    (purpose === "send"
      ? status.send_permission_granted === true
      : status.modify_permission_granted === true);

  if (Capacitor.isNativePlatform()) {
    if (purpose === "modify")
      return started("unsupported", async () => "not_connected");
    return started("native", () =>
      fenced(input, () => undefined, async (current) => {
        const idToken = await owner.getIdToken();
        if (!current()) return "stale";
        const before = await GmailReceiptsService.getStatus({
          idToken,
          userId: owner.uid,
          force: true,
        }).catch(() => null);
        if (!current()) return "stale";
        const start = await GmailReceiptsService.startNativeConnect({
          idToken,
          userId: owner.uid,
          purpose: "send",
        });
        if (!current()) return "stale";
        if (!start.configured) return "failed";
        let result: Awaited<ReturnType<typeof HushhAuth.connectGmail>>;
        try {
          result = await HushhAuth.connectGmail({
            serverClientId: start.server_client_id,
            purpose: start.purpose,
            preserveModify: before?.modify_permission_granted === true,
          });
        } catch (error) {
          GmailReceiptsService.recordConsentFailure(error, owner.uid);
          throw error;
        }
        if (!current()) return "stale";
        if (!result.serverAuthCode?.trim()) return "not_connected";
        const status = await GmailReceiptsService.completeNativeConnect({
          idToken,
          userId: owner.uid,
          serverAuthCode: result.serverAuthCode,
        });
        return granted(status) ? "connected" : "not_connected";
      }),
    );
  }

  // The return page only verifies `send` itself; for `modify` it records a
  // plain connection and the status read below checks the modify grant.
  const attempt = createGmailOAuthPopupAttempt(
    owner.uid,
    purpose === "send" ? "send" : "read",
  );
  const popup = openGmailOAuthPopup(attempt);
  if (!popup) return started("blocked", async () => "not_connected");
  return started("window", () =>
    fenced(input, () => popup.close(), async (current) => {
      try {
        const idToken = await owner.getIdToken();
        if (!current()) return "stale";
        const loginHint = owner.providerData?.some(
          (provider) => provider.providerId === "google.com",
        )
          ? owner.email ?? null
          : null;
        const start = await GmailReceiptsService.startConnect({
          idToken,
          userId: owner.uid,
          loginHint,
          includeGrantedScopes: true,
          purpose,
        });
        if (!current()) return "stale";
        if (!start.configured || !isGoogleAuthorizeUrl(start.authorize_url))
          return "failed";
        navigateGmailOAuthPopup(popup, start.authorize_url);
        await waitForOAuthPopup({
          popup,
          signal: input.signal ?? new AbortController().signal,
          cancelSignal: input.cancelSignal,
          expiresAt: Math.min(
            Date.parse(start.expires_at),
            attempt.startedAt + WINDOW_WAIT_LIMIT_MS,
          ),
          matches: (value) =>
            isGmailOAuthPopupSettlement(value) &&
            value.attemptId === attempt.attemptId,
          storageValue: readGmailOAuthPopupSettlementFallback,
        });
        if (!current()) return "stale";
        if (input.cancelSignal?.aborted) return "not_connected";
        const status = await GmailReceiptsService.getStatus({
          idToken: await owner.getIdToken(),
          userId: owner.uid,
          force: true,
        });
        return granted(status) ? "connected" : "not_connected";
      } finally {
        clearGmailOAuthPopupAttempt();
      }
    }),
  );
}

/** Calendar read or scheduling (`manage`) access. */
export function connectCalendarInPlace(
  input: ConnectControls & {
    owner: InPlaceConnectOwner;
    accessLevel: "read" | "manage";
  },
): InPlaceConnectStart {
  const { owner, accessLevel } = input;
  const granted = (status: {
    connected?: boolean;
    status?: string;
    access_level?: string | null;
  }) =>
    status.connected === true &&
    status.status !== "needs_reauth" &&
    (accessLevel !== "manage" || status.access_level === "manage");

  if (Capacitor.isNativePlatform()) {
    return started("native", () =>
      fenced(input, () => undefined, async (current) => {
        const idToken = await owner.getIdToken();
        if (!current()) return "stale";
        const start = await GoogleCalendarService.startNativeConnect({
          idToken,
          accessLevel,
        });
        if (!current()) return "stale";
        const result = await HushhAuth.connectCalendar({
          serverClientId: start.server_client_id,
          accessLevel: start.access_level,
        });
        if (!current()) return "stale";
        const status = await GoogleCalendarService.completeNativeConnect({
          idToken,
          userId: owner.uid,
          accessLevel,
          serverAuthCode: result.serverAuthCode,
          state: start.state,
        });
        return granted(status) ? "connected" : "not_connected";
      }),
    );
  }

  const attempt = createGoogleOAuthPopupAttempt("calendar", {
    ownerId: owner.uid,
    accessLevel,
  });
  const popup = openGoogleOAuthPopup(attempt);
  if (!popup) return started("blocked", async () => "not_connected");
  return started("window", () =>
    fenced(input, () => popup.close(), async (current) => {
      try {
        // A popup callback settles to this window; it never routes to the
        // onboarding setup page.
        clearCalendarSetupOAuthReturn();
        const idToken = await owner.getIdToken();
        if (!current()) return "stale";
        const start = await GoogleCalendarService.startConnect({
          idToken,
          userId: owner.uid,
          accessLevel,
        });
        if (!current()) return "stale";
        if (!isGoogleAuthorizeUrl(start.authorize_url)) return "failed";
        navigateGoogleOAuthPopup(popup, start.authorize_url);
        await waitForOAuthPopup({
          popup,
          signal: input.signal ?? new AbortController().signal,
          cancelSignal: input.cancelSignal,
          expiresAt: Math.min(
            Date.parse(start.expires_at),
            attempt.startedAt + WINDOW_WAIT_LIMIT_MS,
          ),
          matches: (value) =>
            isGoogleOAuthPopupSettlement(value) &&
            value.service === "calendar" &&
            value.attemptId === attempt.attemptId,
          storageValue: readGoogleOAuthPopupSettlement,
        });
        if (!current()) return "stale";
        if (input.cancelSignal?.aborted) return "not_connected";
        const status = await GoogleCalendarService.status(
          await owner.getIdToken(),
          owner.uid,
        );
        return granted(status) ? "connected" : "not_connected";
      } finally {
        consumeStoredGoogleOAuthPopupSettlement(attempt.attemptId);
      }
    }),
  );
}

export type InPlaceConnectKind = "gmail_send" | "gmail_modify" | "calendar";

/** The chat's one line of feedback for each finished in-place connect. */
export function inPlaceConnectCopy(
  kind: InPlaceConnectKind,
  outcome: "connected" | "not_connected" | "failed",
): string {
  const copy: Record<InPlaceConnectKind, Record<typeof outcome, string>> = {
    gmail_send: {
      connected: "Gmail sending enabled. Review your message, then send.",
      not_connected: "Gmail sending was not enabled.",
      failed: "Could not enable Gmail sending. Try again.",
    },
    gmail_modify: {
      connected: "Gmail changes allowed. Ask One again to organize your mailbox.",
      not_connected: "Gmail changes were not allowed.",
      failed: "Unable to request Gmail permission. Please try again.",
    },
    calendar: {
      connected: "Google Calendar connected. Ask One again to continue.",
      not_connected: "Google Calendar was not connected.",
      failed: "Unable to request Google Calendar permission.",
    },
  };
  return copy[kind][outcome];
}
