/**
 * Device-side coarsening for "approximate" sharing.
 *
 * Positions are recipient-encrypted before they leave the device, so the
 * server can only store a preference and refuse an envelope whose plaintext
 * `metadata.precision` tag disagrees with it. The coarsening itself must
 * happen HERE, before encryption.
 *
 * Approximate is a deterministic snap to a 0.01° grid (about 1.1 km at the
 * equator, less east-west at higher latitudes). Deliberately NO jitter: a
 * random offset re-drawn on every publish lets a patient recipient average
 * repeated points and random-walk back toward the true position. A fixed
 * grid gives the same cell every time the owner stands in the same place,
 * and that is the whole privacy guarantee.
 *
 * Save My Soul is always precise. An emergency responder needs the real
 * coordinate, and the server exempts the SOS lane from the preference check.
 */

import type { PlainLocationPoint } from "@/lib/one-location/types";

export type LocationPublishPrecision = "precise" | "approximate";

/** Grid pitch in degrees (~1.1 km of latitude). */
export const APPROXIMATE_GRID_DEGREES = 0.01;

/** Reported accuracy floor so an approximate point never claims to be exact. */
export const APPROXIMATE_MIN_ACCURACY_M = 1000;

/**
 * Decimal places kept after a snap. Six is well below a metre and, more
 * importantly, makes the snap idempotent: a snapped value divided by the
 * grid is an integer plus float noise, and rounding the result to a fixed
 * scale removes that noise so snapping twice yields the same number.
 */
const SNAP_SCALE = 1e6;

/** Snap one coordinate axis to the nearest grid line. Pure and idempotent. */
export function snapToGrid(
  value: number,
  gridDegrees: number = APPROXIMATE_GRID_DEGREES,
): number {
  if (!Number.isFinite(value)) return value;
  const snapped = Math.round(value / gridDegrees) * gridDegrees;
  return Math.round(snapped * SNAP_SCALE) / SNAP_SCALE;
}

/**
 * The precision an envelope must carry for a given share.
 *
 * SOS forces precise. A `precision_override` from a client step is honoured
 * (the server only issues one when the tool decided it), otherwise the
 * owner's stored preference applies.
 */
export function resolvePublishPrecision(params: {
  preference: LocationPublishPrecision | null | undefined;
  override?: LocationPublishPrecision | null;
  sos?: boolean;
  purpose?: string | null;
}): LocationPublishPrecision {
  if (params.sos || params.purpose === "sos") return "precise";
  if (params.override === "precise" || params.override === "approximate") {
    return params.override;
  }
  return params.preference === "approximate" ? "approximate" : "precise";
}

/**
 * Coarsen a point according to the resolved precision and tag it.
 *
 * Precise returns the point unchanged apart from the tag. Approximate snaps
 * both axes to the grid, floors the accuracy at 1 km, and drops the Drive-To
 * payload (a destination plus a live ETA would leak the exact route). A
 * Check-In note is authored text and is kept.
 */
export function coarsenPoint(
  point: PlainLocationPoint,
  precision: LocationPublishPrecision,
  options?: { sos?: boolean },
): PlainLocationPoint {
  const effective: LocationPublishPrecision = options?.sos
    ? "precise"
    : precision;
  if (effective === "precise") {
    return { ...point, precision: "precise" };
  }
  return {
    ...point,
    latitude: snapToGrid(point.latitude),
    longitude: snapToGrid(point.longitude),
    accuracyM: Math.max(
      Number.isFinite(point.accuracyM ?? NaN) ? (point.accuracyM as number) : 0,
      APPROXIMATE_MIN_ACCURACY_M,
    ),
    drive: null,
    precision: "approximate",
  };
}

/** True when the point already carries the tag a share requires. */
export function pointMatchesPrecision(
  point: PlainLocationPoint,
  precision: LocationPublishPrecision,
): boolean {
  return (point.precision ?? "precise") === precision;
}
