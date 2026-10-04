"use client";

import { openOAuthWindow } from "@/lib/connections/oauth-window";

// Keep this opaque marker in same-origin localStorage. Google's desktop COOP
// can replace the popup browsing-context group during sign-in, which clears
// popup sessionStorage before the provider returns to this callback page.
const ATTEMPT_KEY = "one_drive_popup_attempt_v1";
const SETTLEMENT_KEY = "one_drive_popup_settlement_v1";
const MAX_AGE_MS = 10 * 60_000;
// OAuth start itself has a 30-second deadline. Leave that much room inside
// the server's ten-minute attempt lifetime without comparing device clocks.
const POPUP_WAIT_MS = MAX_AGE_MS - 30_000;
const SETTLEMENT_TTL_MS = 3_000;
export type DrivePopupAttempt = {
  connectorId: "google_drive";
  attemptId: string;
  expiresAt: number;
};
export type DrivePopupSettlement = DrivePopupAttempt & {
  type: "drive_oauth_settlement";
  outcome: "succeeded" | "cancelled" | "failed";
};

export function createDrivePopupAttempt(attemptId: string): DrivePopupAttempt {
  // This is only a local correlation deadline. The server checks the real
  // attempt expiry when it completes OAuth. A server timestamp is unsafe to
  // compare with Date.now() on a device whose clock may be behind.
  const attempt: DrivePopupAttempt = {
    connectorId: "google_drive",
    attemptId,
    expiresAt: Date.now() + POPUP_WAIT_MS,
  };
  if (!isDrivePopupAttempt(attempt))
    throw new Error("Authorization could not start. Try again.");
  return attempt;
}

export function isDrivePopupAttempt(
  value: unknown,
): value is DrivePopupAttempt {
  if (!value || typeof value !== "object") return false;
  const a = value as DrivePopupAttempt;
  return (
    a.connectorId === "google_drive" &&
    typeof a.attemptId === "string" &&
    /^[A-Za-z0-9_-]{16,128}$/.test(a.attemptId) &&
    Number.isFinite(a.expiresAt) &&
    a.expiresAt > Date.now() &&
    a.expiresAt <= Date.now() + MAX_AGE_MS
  );
}

export function isDrivePopupSettlement(
  value: unknown,
): value is DrivePopupSettlement {
  if (!isDrivePopupAttempt(value)) return false;
  const result = value as DrivePopupSettlement;
  return (
    result.type === "drive_oauth_settlement" &&
    ["succeeded", "cancelled", "failed"].includes(result.outcome) &&
    Object.keys(result).every((key) =>
      ["type", "connectorId", "attemptId", "expiresAt", "outcome"].includes(
        key,
      ),
    )
  );
}

/** Must be called directly in the trusted click, before fetching a start URL. */
export function openDriveOAuthPopup(): Window | null {
  // A refused popup falls back to a new tab with the same settlement contract.
  const popup = openOAuthWindow(`one-drive-${crypto.randomUUID()}`)?.target ?? null;
  if (popup) {
    popup.document.title = "Connecting Drive";
    popup.document.body.textContent = "Opening secure Google sign-in…";
  }
  return popup;
}

export function navigateDriveOAuthPopup(
  popup: Window,
  attempt: DrivePopupAttempt,
  authorizeUrl: string,
): void {
  const url = new URL(authorizeUrl);
  if (
    url.origin !== "https://accounts.google.com" ||
    url.pathname !== "/o/oauth2/v2/auth" ||
    !isDrivePopupAttempt(attempt) ||
    popup.closed
  ) {
    throw new Error("Authorization could not start. Try again.");
  }
  // Only a redacted correlation marker crosses the popup boundary. Never copy
  // the opener's owner token, drafts, Google credentials or signed OAuth state.
  // Write it from the opener so it remains available after a desktop browser
  // resets the popup session during Google's COOP navigation.
  window.localStorage.setItem(ATTEMPT_KEY, JSON.stringify(attempt));
  popup.location.replace(url.href);
}

export function readDrivePopupAttempt(): DrivePopupAttempt | null {
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
    const attempt = isDrivePopupAttempt(value) ? value : null;
    if (!attempt) window.localStorage.removeItem(ATTEMPT_KEY);
    return attempt;
  } catch {
    return null;
  }
}

export function hasDrivePopupMarker(): boolean {
  return readDrivePopupAttempt() !== null;
}

/** The state prefix is an untrusted routing hint; the server verifies its HMAC. */
export function isDrivePopupReturn(state: string | null): boolean {
  const attempt = readDrivePopupAttempt();
  if (!attempt || !state) return false;
  const [returnedAttemptId, signature, extra] = state.split(".");
  return (
    returnedAttemptId === attempt.attemptId &&
    /^[a-f0-9]{64}$/.test(signature ?? "") &&
    extra === undefined
  );
}

/** Remove only this attempt; another tab may have started a newer one. */
export function clearDrivePopupAttempt(attempt: DrivePopupAttempt): void {
  try {
    const raw = window.localStorage.getItem(ATTEMPT_KEY);
    if (!raw) return;
    const stored = JSON.parse(raw) as Partial<DrivePopupAttempt> | null;
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

export function notifyDrivePopup(
  attempt: DrivePopupAttempt,
  outcome: DrivePopupSettlement["outcome"],
): void {
  const value: DrivePopupSettlement = {
    type: "drive_oauth_settlement",
    connectorId: "google_drive",
    attemptId: attempt.attemptId,
    expiresAt: attempt.expiresAt,
    outcome,
  };
  if (!isDrivePopupSettlement(value)) return;
  try {
    window.opener?.postMessage(value, window.location.origin);
  } catch {
    /* Fall back to the same-origin storage event below. */
  }
  try {
    const serialized = JSON.stringify(value);
    // Keep the redacted settlement long enough for the opener to receive its
    // storage event after Google's COOP has severed WindowProxy access.
    window.localStorage.setItem(SETTLEMENT_KEY, serialized);
    window.setTimeout(() => {
      try {
        if (window.localStorage.getItem(SETTLEMENT_KEY) === serialized)
          window.localStorage.removeItem(SETTLEMENT_KEY);
      } catch {
        // Browser storage failures cannot block callback cleanup.
      }
    }, SETTLEMENT_TTL_MS);
    clearDrivePopupAttempt(attempt);
  } catch {
    /* Opener also reconciles after close/expiry. */
  }
}

/** Outcomes are advisory: the caller MUST refresh owner-authenticated status. */
export function waitForOAuthPopup(input: {
  popup: Window;
  expiresAt: number;
  signal: AbortSignal;
  cancelSignal?: AbortSignal;
  matches: (value: unknown) => boolean;
  storageValue: (event: StorageEvent) => unknown;
  onFinish?: (reason: "settled" | "closed" | "expired" | "aborted") => void;
}): Promise<void> {
  if (
    !Number.isFinite(input.expiresAt) ||
    input.expiresAt <= Date.now() ||
    input.expiresAt > Date.now() + MAX_AGE_MS
  ) {
    input.popup.close();
    input.onFinish?.("expired");
    return Promise.reject(new Error("Authorization expired. Try again."));
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (
      reason: "settled" | "closed" | "expired" | "aborted",
    ) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      window.removeEventListener("message", message);
      window.removeEventListener("storage", storage);
      input.signal.removeEventListener("abort", abort);
      input.cancelSignal?.removeEventListener("abort", abort);
      try {
        input.popup.close();
      } catch {
        /* Browser owns popup policy. */
      }
      input.onFinish?.(reason);
      resolve();
    };
    const abort = () => finish("aborted");
    const message = (event: MessageEvent<unknown>) => {
      if (
        Date.now() < input.expiresAt &&
        event.origin === window.location.origin &&
        event.source === input.popup &&
        input.matches(event.data)
      )
        finish("settled");
    };
    const storage = (event: StorageEvent) => {
      // Storage has no source Window. It is only a hint to reconcile server
      // status, never evidence of provider success.
      if (
        (!event.storageArea || event.storageArea === window.localStorage) &&
        Date.now() < input.expiresAt &&
        input.matches(input.storageValue(event))
      )
        finish("settled");
    };
    // Google's COOP can sever the popup's WindowProxy while authorization is
    // open: reading `popup.closed` can warn or appear true for a live popup.
    // The callback's redacted message/storage event, explicit cancellation,
    // owner-session abort, or bounded expiry are the only completion signals.
    const timer = window.setTimeout(() => finish("expired"), Math.max(0, input.expiresAt - Date.now()));
    window.addEventListener("message", message);
    window.addEventListener("storage", storage);
    input.signal.addEventListener("abort", abort, { once: true });
    input.cancelSignal?.addEventListener("abort", abort, { once: true });
    if (input.signal.aborted || input.cancelSignal?.aborted) abort();
  });
}

export function waitForDrivePopup(
  popup: Window,
  attempt: DrivePopupAttempt,
  signal: AbortSignal,
  cancelSignal?: AbortSignal,
): Promise<void> {
  return waitForOAuthPopup({
    popup,
    signal,
    cancelSignal,
    expiresAt: attempt.expiresAt,
    matches: (value) =>
      isDrivePopupSettlement(value) &&
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
