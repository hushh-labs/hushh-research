import type { PlainLocationPoint } from "./types";

const REVIEWED_POINT_MAX_AGE_MS = 60_000;
const REVIEWED_POINT_FUTURE_SKEW_MS = 30_000;

export function createPrivateCheckInOperationId(): string {
  if (
    typeof globalThis.crypto !== "undefined" &&
    typeof globalThis.crypto.randomUUID === "function"
  ) {
    return globalThis.crypto.randomUUID();
  }
  return `checkin-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 14)}`;
}

export function isFreshReviewedPoint(
  point: PlainLocationPoint | null,
  nowMs: number,
): point is PlainLocationPoint {
  if (!point) return false;
  const capturedAtMs = Date.parse(point.capturedAt);
  if (!Number.isFinite(capturedAtMs)) return false;
  const ageMs = nowMs - capturedAtMs;
  return (
    ageMs >= -REVIEWED_POINT_FUTURE_SKEW_MS &&
    ageMs <= REVIEWED_POINT_MAX_AGE_MS
  );
}
