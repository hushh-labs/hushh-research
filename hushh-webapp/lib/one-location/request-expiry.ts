import type { OneLocationAccessRequest } from "@/lib/one-location/types";

function parsedTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The deadline the UI should present for this request.
 *
 * Only an explicit, valid server deadline is safe to enforce in the client.
 * `null` deliberately leaves a linked referral/public-link workflow under its
 * parent's lifetime. `undefined` or an invalid value is ambiguous during a
 * rolling deploy, so the UI relies on the server status instead of inventing a
 * deadline that could expire a linked request early.
 */
export function locationRequestExpiryMs(
  request: Pick<OneLocationAccessRequest, "expiresAt">,
): number | null {
  return parsedTimestamp(request.expiresAt);
}

/** Presentation guard only; the server independently enforces this deadline. */
export function isLocationRequestExpired(
  request: Pick<OneLocationAccessRequest, "status" | "expiresAt">,
  nowMs: number,
): boolean {
  if (request.status === "expired") return true;
  if (request.status !== "pending") return false;
  const expiresAt = locationRequestExpiryMs(request);
  return expiresAt !== null && Number.isFinite(nowMs) && nowMs >= expiresAt;
}

export function isLocationRequestPending(
  request: Pick<OneLocationAccessRequest, "status" | "expiresAt">,
  nowMs: number,
): boolean {
  return (
    request.status === "pending" && !isLocationRequestExpired(request, nowMs)
  );
}
