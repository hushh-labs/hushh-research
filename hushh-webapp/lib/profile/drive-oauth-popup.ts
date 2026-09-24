"use client";

const ATTEMPT_KEY = "one_drive_popup_attempt_v1";
const SETTLEMENT_KEY = "one_drive_popup_settlement_v1";
const MAX_AGE_MS = 10 * 60_000;
export type DrivePopupAttempt = {
  connectorId: "google_drive";
  attemptId: string;
  expiresAt: number;
};
export type DrivePopupSettlement = DrivePopupAttempt & {
  type: "drive_oauth_settlement";
  outcome: "succeeded" | "cancelled" | "failed";
};

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
  const popup = window.open(
    "about:blank",
    `one-drive-${crypto.randomUUID()}`,
    "popup=yes,width=520,height=720,resizable=yes,scrollbars=yes",
  );
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
  popup.sessionStorage.setItem(ATTEMPT_KEY, JSON.stringify(attempt));
  popup.location.replace(url.href);
}

export function readDrivePopupAttempt(): DrivePopupAttempt | null {
  try {
    const value: unknown = JSON.parse(
      window.sessionStorage.getItem(ATTEMPT_KEY) || "null",
    );
    return isDrivePopupAttempt(value) ? value : null;
  } catch {
    return null;
  }
}

export function hasDrivePopupMarker(): boolean {
  try {
    return window.sessionStorage.getItem(ATTEMPT_KEY) !== null;
  } catch {
    return false;
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
    /* Fall back to a redacted hint. */
  }
  try {
    window.localStorage.setItem(SETTLEMENT_KEY, JSON.stringify(value));
    window.localStorage.removeItem(SETTLEMENT_KEY);
    window.sessionStorage.removeItem(ATTEMPT_KEY);
  } catch {
    /* Opener also reconciles after close/expiry. */
  }
}

/** Outcomes are advisory: the caller MUST refresh owner-authenticated status. */
export function waitForOAuthPopup(input: {
  popup: Window;
  expiresAt: number;
  signal: AbortSignal;
  matches: (value: unknown) => boolean;
  storageValue: (event: StorageEvent) => unknown;
}): Promise<void> {
  if (
    !Number.isFinite(input.expiresAt) ||
    input.expiresAt <= Date.now() ||
    input.expiresAt > Date.now() + MAX_AGE_MS
  ) {
    input.popup.close();
    return Promise.reject(new Error("Authorization expired. Try again."));
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearInterval(timer);
      window.removeEventListener("message", message);
      window.removeEventListener("storage", storage);
      input.signal.removeEventListener("abort", finish);
      try {
        input.popup.close();
      } catch {
        /* Browser owns popup policy. */
      }
      resolve();
    };
    const message = (event: MessageEvent<unknown>) => {
      if (
        Date.now() < input.expiresAt &&
        event.origin === window.location.origin &&
        event.source === input.popup &&
        input.matches(event.data)
      )
        finish();
    };
    const storage = (event: StorageEvent) => {
      // Storage has no source Window. It is only a hint to reconcile server
      // status, never evidence of provider success.
      if (
        event.storageArea === window.localStorage &&
        Date.now() < input.expiresAt &&
        input.matches(input.storageValue(event))
      )
        finish();
    };
    const timer = window.setInterval(() => {
      if (input.popup.closed || Date.now() >= input.expiresAt) finish();
    }, 500);
    window.addEventListener("message", message);
    window.addEventListener("storage", storage);
    input.signal.addEventListener("abort", finish, { once: true });
    if (input.signal.aborted) finish();
  });
}

export function waitForDrivePopup(
  popup: Window,
  attempt: DrivePopupAttempt,
  signal: AbortSignal,
): Promise<void> {
  return waitForOAuthPopup({
    popup,
    signal,
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
