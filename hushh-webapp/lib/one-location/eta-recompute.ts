import { haversineMeters, type LatLngLiteral } from "./marker-interpolation";

/** How often the drive/pickup ETA may be recomputed while roughly stationary. */
export const DRIVE_ETA_MIN_RECOMPUTE_INTERVAL_MS = 60_000;
/** Movement (meters) that forces an ETA recompute sooner than the interval. */
export const DRIVE_ETA_MIN_RECOMPUTE_MOVE_METERS = 250;

/**
 * Pure decision: should we recompute the ETA for a new origin? True on the
 * first call, when the origin has moved >= the move threshold, or when the
 * interval has elapsed since the last successful compute.
 */
export function shouldRecomputeEta(params: {
  lastComputedAt: number | null;
  lastOrigin: LatLngLiteral | null;
  nextOrigin: LatLngLiteral;
  now: number;
}): boolean {
  const { lastComputedAt, lastOrigin, nextOrigin, now } = params;
  if (lastComputedAt == null || lastOrigin == null) return true;
  const movedMeters = haversineMeters(lastOrigin, nextOrigin);
  const sinceMs = now - lastComputedAt;
  return (
    movedMeters >= DRIVE_ETA_MIN_RECOMPUTE_MOVE_METERS ||
    sinceMs >= DRIVE_ETA_MIN_RECOMPUTE_INTERVAL_MS
  );
}
