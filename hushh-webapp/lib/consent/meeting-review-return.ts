import { buildConsentCenterHref } from "@/lib/consent/consent-sheet-route";
import { ROUTES } from "@/lib/navigation/routes";

const KEY = "one_meeting_review_oauth_return_v1";
const MAX_AGE_MS = 15 * 60 * 1000;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,128}$/;

/**
 * The organizer's way back to one exact meeting-file request after a Google
 * authorization. It holds an opaque request id and the owner it belongs to,
 * never a credential, an OAuth value or meeting content. It lives in
 * localStorage because Google's opener policy can discard a popup's session
 * storage; the owner check, expiry and one-shot clearing keep it from
 * steering any other sign-in.
 */
export function markMeetingReviewOAuthReturn(ownerId: string, requestId: string): void {
  if (!ownerId || !REQUEST_ID.test(requestId)) return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ ownerId, requestId, savedAt: Date.now() }));
  } catch {
    /* Without storage the person returns through Back or Feed. */
  }
}

export function clearMeetingReviewOAuthReturn(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* best effort */
  }
}

/** Read without consuming; callers decide when the journey has been used. */
export function readMeetingReviewOAuthReturn(ownerId: string | null | undefined): { requestId: string } | null {
  if (!ownerId) return null;
  try {
    const value = JSON.parse(window.localStorage.getItem(KEY) || "") as {
      ownerId?: unknown; requestId?: unknown; savedAt?: unknown;
    };
    if (
      value.ownerId === ownerId && typeof value.requestId === "string" && REQUEST_ID.test(value.requestId) &&
      typeof value.savedAt === "number" && Date.now() >= value.savedAt && Date.now() - value.savedAt <= MAX_AGE_MS
    ) return { requestId: value.requestId };
  } catch {
    /* malformed or absent */
  }
  return null;
}

/** The same authorized review the Feed item opens, re-checked on arrival. */
export function meetingReviewReturnHref(requestId: string): string {
  return buildConsentCenterHref("pending", { requestId, from: ROUTES.ONE_FEED });
}
