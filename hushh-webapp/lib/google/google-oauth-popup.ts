"use client";

import { assertOAuthReturnOrigin, openOAuthWindow } from "@/lib/connections/oauth-window";
import { validCalendarMeetingReturn, type CalendarMeetingReturnContext } from "@/lib/calendar/calendar-oauth-journey";
import type { GoogleCalendarStatus } from "@/lib/services/google-calendar-service";

const ATTEMPT_KEY = "one_google_oauth_popup_attempt_v1";
const FALLBACK_ATTEMPT_KEY = "one_google_oauth_popup_attempt_fallback_v1";
const SETTLEMENT_KEY = "one_google_oauth_popup_settlement_v1";
const ACK_KEY = "one_google_oauth_popup_ack_v1";
const MAX_AGE_MS = 15 * 60 * 1000;
const MEETING_SCOPES = [
  "https://www.googleapis.com/auth/meetings.space.readonly",
  "https://www.googleapis.com/auth/drive.meet.readonly",
  "https://www.googleapis.com/auth/drive.metadata.readonly",
];

export function hasCalendarMeetingFileGrant(status: GoogleCalendarStatus, accountId: string, expectedSubjectSha256?: string, priorGrantGeneration?: string): boolean {
  const account = status.accounts?.find(item => item.account_id === accountId);
  if (!account?.connected || account.status !== "connected" ||
      (expectedSubjectSha256 && account.provider_subject_sha256 !== expectedSubjectSha256) ||
      (priorGrantGeneration !== undefined && (!account.grant_generation || account.grant_generation === priorGrantGeneration))) return false;
  const granted = new Set((account.scope_csv || "").replaceAll(",", " ").split(/\s+/));
  return MEETING_SCOPES.every(scope => granted.has(scope));
}

export type GoogleOAuthPopupService = "gmail_send" | "gmail_read" | "calendar";
export type GoogleOAuthPopupAttempt = {
  version: 1;
  attemptId: string;
  service: GoogleOAuthPopupService;
  startedAt: number;
  ownerId: string;
  returnMode?: "popup" | "same_window";
  accessLevel?: "read" | "manage";
  calendarAdditional?: boolean;
  meetingFiles?: true;
  targetAccountId?: string;
  expectedSubjectSha256?: string;
  priorGrantGeneration?: string;
  meetingReturn?: CalendarMeetingReturnContext;
};
export type GoogleOAuthPopupSettlement = {
  schemaVersion: 1;
  type: "google_oauth_settlement";
  attemptId: string;
  service: GoogleOAuthPopupService;
  outcome: "succeeded" | "cancelled" | "failed";
  message?: string;
};

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{8,96}$/.test(value);
}

export function persistGoogleOAuthSameWindowAttempt(
  attempt: GoogleOAuthPopupAttempt,
): boolean {
  try {
    const currentStorage = storage(window);
    if (!currentStorage) return false;
    const value = JSON.stringify({ ...attempt, returnMode: "same_window" });
    currentStorage.setItem(ATTEMPT_KEY, value);
    return currentStorage.getItem(ATTEMPT_KEY) === value;
  } catch {
    return false;
  }
}

export function clearGoogleOAuthAttempt(attemptId?: string): void {
  try {
    const stores: [Storage | null, string][] = [
      [storage(window), ATTEMPT_KEY],
      [window.localStorage, FALLBACK_ATTEMPT_KEY],
    ];
    for (const [store, key] of stores) {
      try {
        const raw = store?.getItem(key);
        if (!attemptId || (raw && JSON.parse(raw).attemptId === attemptId)) {
          store?.removeItem(key);
        }
      } catch {
        // One corrupt marker must not prevent cleanup of the other store.
      }
    }
  } catch {
    /* stale browser state is best-effort cleanup */
  }
}
function storage(target: Window | null | undefined): Storage | null {
  try {
    return target?.sessionStorage ?? null;
  } catch {
    return null;
  }
}

export function createGoogleOAuthPopupAttempt(
  service: GoogleOAuthPopupService,
  options: { ownerId: string; accessLevel?: "read" | "manage"; calendarAdditional?: boolean;
    meetingFiles?: boolean; targetAccountId?: string; expectedSubjectSha256?: string; priorGrantGeneration?: string;
    meetingReturn?: CalendarMeetingReturnContext },
): GoogleOAuthPopupAttempt {
  return {
    version: 1,
    attemptId: crypto.randomUUID(),
    service,
    startedAt: Date.now(),
    ownerId: options.ownerId,
    ...(options.accessLevel ? { accessLevel: options.accessLevel } : {}),
    ...(options.calendarAdditional ? { calendarAdditional: true } : {}),
    ...(options.meetingFiles ? { meetingFiles: true } : {}),
    ...(options.targetAccountId ? { targetAccountId: options.targetAccountId } : {}),
    ...(options.expectedSubjectSha256 ? { expectedSubjectSha256: options.expectedSubjectSha256 } : {}),
    ...(options.priorGrantGeneration ? { priorGrantGeneration: options.priorGrantGeneration } : {}),
    ...(options.meetingReturn ? { meetingReturn: options.meetingReturn } : {}),
  };
}

export function openGoogleOAuthPopup(
  attempt: GoogleOAuthPopupAttempt,
): Window | null {
  // A refused popup falls back to a new tab with the same settlement contract.
  const popup = openOAuthWindow("hushh-google-oauth")?.target ?? null;
  if (!popup) return null;
  try {
    const popupStorage = storage(popup);
    if (!popupStorage) {
      popup.close();
      return null;
    }
    popupStorage.setItem(ATTEMPT_KEY, JSON.stringify(attempt));
    if (popupStorage.getItem(ATTEMPT_KEY) !== JSON.stringify(attempt)) {
      popup.close();
      return null;
    }
    // Google COOP can discard the popup's sessionStorage and opener. Only
    // bounded correlation metadata survives in the originating site's store.
    const fallback = JSON.stringify(attempt);
    window.localStorage.setItem(FALLBACK_ATTEMPT_KEY, fallback);
    if (window.localStorage.getItem(FALLBACK_ATTEMPT_KEY) !== fallback) {
      popup.close();
      return null;
    }
    popup.document.title = "Connecting Google";
    popup.focus();
    return popup;
  } catch {
    popup.close();
    return null;
  }
}

export function navigateGoogleOAuthPopup(
  popup: Window,
  authorizeUrl: string,
): void {
  assertOAuthReturnOrigin(authorizeUrl);
  popup.location.replace(authorizeUrl);
}

export function readGoogleOAuthPopupAttempt(): GoogleOAuthPopupAttempt | null {
  try {
    const parsed = JSON.parse(
      storage(window)?.getItem(ATTEMPT_KEY) ||
      window.localStorage.getItem(FALLBACK_ATTEMPT_KEY) || "",
    ) as Partial<GoogleOAuthPopupAttempt>;
    if (
      parsed.version === 1 &&
      (parsed.service === "gmail_send" || parsed.service === "gmail_read" ||
        parsed.service === "calendar") &&
      validId(parsed.attemptId) &&
      typeof parsed.ownerId === "string" &&
      parsed.ownerId.length > 0 &&
      parsed.ownerId.length <= 256 &&
      typeof parsed.startedAt === "number" &&
      (parsed.returnMode === undefined ||
        parsed.returnMode === "popup" ||
        parsed.returnMode === "same_window") &&
      (parsed.accessLevel === undefined ||
        parsed.accessLevel === "read" ||
        parsed.accessLevel === "manage") &&
      (parsed.calendarAdditional === undefined ||
        parsed.calendarAdditional === true) &&
      (parsed.meetingFiles === undefined || parsed.meetingFiles === true) &&
      (parsed.targetAccountId === undefined || /^[A-Za-z0-9_-]{1,128}$/.test(parsed.targetAccountId)) &&
      (parsed.expectedSubjectSha256 === undefined || /^[a-f0-9]{64}$/.test(parsed.expectedSubjectSha256)) &&
      (parsed.priorGrantGeneration === undefined || typeof parsed.priorGrantGeneration === "string" && parsed.priorGrantGeneration.length <= 128) &&
      (parsed.meetingReturn === undefined || validCalendarMeetingReturn(parsed.meetingReturn)) &&
      (!parsed.meetingFiles || (parsed.service === "calendar" &&
        (parsed.targetAccountId === undefined
          ? parsed.meetingReturn === undefined
          : parsed.targetAccountId === parsed.meetingReturn?.accountId))) &&
      Date.now() - parsed.startedAt >= 0 &&
      Date.now() - parsed.startedAt <= MAX_AGE_MS
    )
      return parsed as GoogleOAuthPopupAttempt;
  } catch {
    /* invalid browser state is ignored */
  }
  return null;
}

export function isGoogleOAuthPopupSettlement(
  value: unknown,
): value is GoogleOAuthPopupSettlement {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<GoogleOAuthPopupSettlement>;
  return (
    item.schemaVersion === 1 &&
    item.type === "google_oauth_settlement" &&
    (item.service === "gmail_send" || item.service === "gmail_read" ||
      item.service === "calendar") &&
    validId(item.attemptId) &&
    ["succeeded", "cancelled", "failed"].includes(String(item.outcome))
  );
}

export function settleGoogleOAuthPopup(
  attempt: GoogleOAuthPopupAttempt,
  outcome: GoogleOAuthPopupSettlement["outcome"],
  message?: string,
): void {
  const settlement: GoogleOAuthPopupSettlement = {
    schemaVersion: 1,
    type: "google_oauth_settlement",
    attemptId: attempt.attemptId,
    service: attempt.service,
    outcome,
    ...(message ? { message } : {}),
  };
  try {
    window.opener?.postMessage(settlement, window.location.origin);
  } catch {
    /* fallback below */
  }
  try {
    window.localStorage.setItem(
      SETTLEMENT_KEY,
      JSON.stringify({ ...settlement, sentAt: Date.now() }),
    );
  } catch {
    /* best effort */
  }
  clearGoogleOAuthAttempt(attempt.attemptId);
  try {
    // Best effort: browsers only honour this for a reachable opener. When
    // Google's opener policy severed it, the original page focuses itself.
    window.opener?.focus();
  } catch {
    /* focus is a courtesy, never a requirement */
  }
  window.setTimeout(() => window.close(), 0);
}

export type GoogleOAuthSettlementAck = {
  schemaVersion: 1;
  type: "google_oauth_settlement_ack";
  attemptId: string;
};

function isSettlementAck(value: unknown, attemptId: string): value is GoogleOAuthSettlementAck {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<GoogleOAuthSettlementAck>;
  return item.schemaVersion === 1 && item.type === "google_oauth_settlement_ack" &&
    validId(item.attemptId) && item.attemptId === attemptId;
}

/**
 * The original One page calls this after it has accepted a correlated
 * settlement and applied it, so a popup that cannot close itself can say so
 * truthfully. It is advisory: it carries no permission and no content.
 */
export function acknowledgeGoogleOAuthSettlement(attemptId: string, popup?: Window | null): void {
  if (!validId(attemptId)) return;
  const ack: GoogleOAuthSettlementAck = { schemaVersion: 1, type: "google_oauth_settlement_ack", attemptId };
  try {
    popup?.postMessage(ack, window.location.origin);
  } catch {
    /* the popup may be closed or severed; storage below still reaches it */
  }
  try {
    window.localStorage.setItem(ACK_KEY, JSON.stringify({ ...ack, sentAt: Date.now() }));
  } catch {
    /* best effort */
  }
  try {
    window.focus();
  } catch {
    /* best effort */
  }
}

/** Calls back once the original page acknowledges this exact attempt. Returns an unsubscribe. */
export function watchGoogleOAuthSettlementAck(attemptId: string, onAck: () => void): () => void {
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    window.removeEventListener("message", onMessage);
    window.removeEventListener("storage", onStorage);
    try {
      const raw = window.localStorage.getItem(ACK_KEY);
      if (raw && isSettlementAck(JSON.parse(raw), attemptId)) window.localStorage.removeItem(ACK_KEY);
    } catch {
      /* stale acknowledgements are harmless: they only match one attempt id */
    }
    onAck();
  };
  const onMessage = (event: MessageEvent) => {
    if (event.origin === window.location.origin && isSettlementAck(event.data, attemptId)) finish();
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key !== ACK_KEY || !event.newValue) return;
    try {
      if (isSettlementAck(JSON.parse(event.newValue), attemptId)) finish();
    } catch {
      /* ignore malformed storage */
    }
  };
  window.addEventListener("message", onMessage);
  window.addEventListener("storage", onStorage);
  // The acknowledgement may land before this popup starts listening.
  try {
    const raw = window.localStorage.getItem(ACK_KEY);
    if (raw && isSettlementAck(JSON.parse(raw), attemptId)) finish();
  } catch {
    /* fall through to the live listeners */
  }
  return () => {
    done = true;
    window.removeEventListener("message", onMessage);
    window.removeEventListener("storage", onStorage);
  };
}

export function consumeStoredGoogleOAuthPopupSettlement(
  attemptId: string,
): GoogleOAuthPopupSettlement | null {
  try {
    const raw = window.localStorage.getItem(SETTLEMENT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as GoogleOAuthPopupSettlement & {
      sentAt?: number;
    };
    if (
      !isGoogleOAuthPopupSettlement(parsed) ||
      parsed.attemptId !== attemptId ||
      typeof parsed.sentAt !== "number" ||
      Date.now() - parsed.sentAt < 0 ||
      Date.now() - parsed.sentAt > MAX_AGE_MS
    ) {
      return null;
    }
    window.localStorage.removeItem(SETTLEMENT_KEY);
    return parsed;
  } catch {
    return null;
  }
}

export function readGoogleOAuthPopupSettlement(
  event: StorageEvent,
): GoogleOAuthPopupSettlement | null {
  if (event.key !== SETTLEMENT_KEY || !event.newValue) return null;
  try {
    const value = JSON.parse(event.newValue) as unknown;
    return isGoogleOAuthPopupSettlement(value) ? value : null;
  } catch {
    return null;
  }
}
