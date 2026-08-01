import type {
  LocationSharingMode,
  OneLocationAccessRequest,
  OneLocationEncryptedEnvelope,
  OneLocationGrant,
  PlainLocationPoint,
} from "@/lib/one-location/types";

export const APPROXIMATE_AREA_GRID_METERS = 1_000;
export const APPROXIMATE_AREA_MIN_RADIUS_M = 1_000;
export const APPROXIMATE_AREA_MAX_RADIUS_M = 20_000;
export const APPROXIMATE_AREA_RADIUS_STEP_M = 250;
export const APPROXIMATE_AREA_UPDATE_INTERVAL_MS = 5 * 60_000;

const EARTH_RADIUS_M = 6_378_137;
const MAX_WEB_MERCATOR_LATITUDE = 85.05112878;
const WORLD_WIDTH_M = 2 * Math.PI * EARTH_RADIUS_M;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizeLongitude(longitude: number): number {
  const normalized = ((((longitude + 180) % 360) + 360) % 360) - 180;
  return normalized === -180 && longitude > 0 ? 180 : normalized;
}

function projectToWebMercator(point: { latitude: number; longitude: number }): {
  x: number;
  y: number;
} {
  const latitude = clamp(
    point.latitude,
    -MAX_WEB_MERCATOR_LATITUDE,
    MAX_WEB_MERCATOR_LATITUDE,
  );
  const longitude = normalizeLongitude(point.longitude);
  const latitudeRadians = (latitude * Math.PI) / 180;
  return {
    x: EARTH_RADIUS_M * ((longitude * Math.PI) / 180),
    y: EARTH_RADIUS_M * Math.log(Math.tan(Math.PI / 4 + latitudeRadians / 2)),
  };
}

function unprojectFromWebMercator(point: { x: number; y: number }): {
  latitude: number;
  longitude: number;
} {
  const longitude = normalizeLongitude(
    (point.x / EARTH_RADIUS_M) * (180 / Math.PI),
  );
  const latitude = clamp(
    (2 * Math.atan(Math.exp(point.y / EARTH_RADIUS_M)) - Math.PI / 2) *
      (180 / Math.PI),
    -MAX_WEB_MERCATOR_LATITUDE,
    MAX_WEB_MERCATOR_LATITUDE,
  );
  return { latitude, longitude };
}

function gridCenter(value: number): number {
  return (
    Math.floor((value + WORLD_WIDTH_M / 2) / APPROXIMATE_AREA_GRID_METERS) *
      APPROXIMATE_AREA_GRID_METERS +
    APPROXIMATE_AREA_GRID_METERS / 2 -
    WORLD_WIDTH_M / 2
  );
}

export function approximateAreaCenter(point: {
  latitude: number;
  longitude: number;
}): { latitude: number; longitude: number } {
  const projected = projectToWebMercator(point);
  return unprojectFromWebMercator({
    x: gridCenter(projected.x),
    y: gridCenter(projected.y),
  });
}

export function approximateAreaRadiusM(
  accuracyM: number | null | undefined,
): number {
  const sourceAccuracy =
    typeof accuracyM === "number" && Number.isFinite(accuracyM) && accuracyM > 0
      ? accuracyM
      : 0;
  // A point can be roughly 707 m from the centre of its 1 km square. Add that
  // displacement to the device uncertainty, then round up to a stable public
  // radius so the displayed region never promises more precision than we have.
  const requiredRadius = Math.max(
    APPROXIMATE_AREA_MIN_RADIUS_M,
    sourceAccuracy + Math.SQRT2 * (APPROXIMATE_AREA_GRID_METERS / 2),
  );
  return clamp(
    Math.ceil(requiredRadius / APPROXIMATE_AREA_RADIUS_STEP_M) *
      APPROXIMATE_AREA_RADIUS_STEP_M,
    APPROXIMATE_AREA_MIN_RADIUS_M,
    APPROXIMATE_AREA_MAX_RADIUS_M,
  );
}

function requiredApproximateAreaRadiusM(
  accuracyM: number | null | undefined,
): number {
  const sourceAccuracy =
    typeof accuracyM === "number" && Number.isFinite(accuracyM) && accuracyM > 0
      ? accuracyM
      : 0;
  return Math.max(
    APPROXIMATE_AREA_MIN_RADIUS_M,
    Math.ceil(
      (sourceAccuracy + Math.SQRT2 * (APPROXIMATE_AREA_GRID_METERS / 2)) /
        APPROXIMATE_AREA_RADIUS_STEP_M,
    ) * APPROXIMATE_AREA_RADIUS_STEP_M,
  );
}

function assertApproximateAreaCanRepresent(
  accuracyM: number | null | undefined,
): void {
  if (
    requiredApproximateAreaRadiusM(accuracyM) > APPROXIMATE_AREA_MAX_RADIUS_M
  ) {
    throw new Error(
      "Location accuracy is too limited for an approximate-area share.",
    );
  }
}

export function prepareLocationPointForSharing(
  point: PlainLocationPoint,
  mode: LocationSharingMode,
): PlainLocationPoint {
  if (mode === "precise") {
    return {
      ...point,
      locationMode: "precise",
      approximateRadiusM: null,
    };
  }
  assertApproximateAreaCanRepresent(point.accuracyM);
  const center = approximateAreaCenter(point);
  const radius = approximateAreaRadiusM(point.accuracyM);
  return {
    ...point,
    latitude: center.latitude,
    longitude: center.longitude,
    accuracyM: radius,
    locationMode: "approximate",
    approximateRadiusM: radius,
  };
}

export function grantLocationMode(
  grant: Pick<OneLocationGrant, "locationMode">,
): LocationSharingMode {
  return grant.locationMode === "approximate" ? "approximate" : "precise";
}

/**
 * Validate a newly-created grant without applying the legacy "missing means
 * precise" compatibility fallback. A rolling deployment must never let an old
 * API silently turn an explicitly reviewed approximate share into a precise
 * background publisher on its next update.
 */
export function grantStrictlyMatchesLocationMode(params: {
  grant: Pick<OneLocationGrant, "locationMode" | "approximateRadiusM">;
  locationMode: LocationSharingMode;
  approximateRadiusM?: number | null;
}): boolean {
  if (params.grant.locationMode !== params.locationMode) return false;
  if (params.locationMode === "precise") {
    return params.grant.approximateRadiusM == null;
  }
  return (
    Number(params.grant.approximateRadiusM) ===
    Number(params.approximateRadiusM)
  );
}

/** Verify that an atomic direct-share response linked its first envelope. */
export function locationCommitStrictlyMatches(params: {
  grant:
    | Pick<
        OneLocationGrant,
        "id" | "latestEnvelopeId" | "locationMode" | "approximateRadiusM"
      >
    | null
    | undefined;
  envelope: Pick<OneLocationEncryptedEnvelope, "id"> | null | undefined;
  locationMode: LocationSharingMode;
  approximateRadiusM?: number | null;
}): boolean {
  if (!params.grant || !params.envelope) return false;
  const envelopeId = String(params.envelope.id || "");
  return (
    Boolean(envelopeId) &&
    params.grant.latestEnvelopeId === envelopeId &&
    grantStrictlyMatchesLocationMode({
      grant: params.grant,
      locationMode: params.locationMode,
      approximateRadiusM: params.approximateRadiusM,
    })
  );
}

/**
 * Verify the fail-closed approval response before treating a share as active.
 * A mode match alone is insufficient during a rolling deploy: an older backend
 * could return a grant without atomically storing the reviewed first point.
 */
export function approvedLocationCommitStrictlyMatches(params: {
  requestId: string;
  request:
    | Pick<OneLocationAccessRequest, "id" | "status" | "approvedGrantId">
    | null
    | undefined;
  grant:
    | Pick<
        OneLocationGrant,
        "id" | "latestEnvelopeId" | "locationMode" | "approximateRadiusM"
      >
    | null
    | undefined;
  envelope: Pick<OneLocationEncryptedEnvelope, "id"> | null | undefined;
  locationMode: LocationSharingMode;
  approximateRadiusM?: number | null;
}): boolean {
  if (!params.request || !params.grant || !params.envelope) return false;
  return (
    params.request.id === params.requestId &&
    params.request.status === "approved" &&
    params.request.approvedGrantId === params.grant.id &&
    locationCommitStrictlyMatches({
      grant: params.grant,
      envelope: params.envelope,
      locationMode: params.locationMode,
      approximateRadiusM: params.approximateRadiusM,
    })
  );
}

export function prepareLocationPointForGrant(
  point: PlainLocationPoint,
  grant: Pick<OneLocationGrant, "locationMode" | "approximateRadiusM">,
): PlainLocationPoint {
  const mode = grantLocationMode(grant);
  if (mode === "precise") return prepareLocationPointForSharing(point, mode);
  const grantedRadius = Number(grant.approximateRadiusM);
  const requiredRadius = requiredApproximateAreaRadiusM(point.accuracyM);
  if (
    !Number.isFinite(grantedRadius) ||
    grantedRadius < requiredRadius ||
    grantedRadius > APPROXIMATE_AREA_MAX_RADIUS_M ||
    grantedRadius % APPROXIMATE_AREA_RADIUS_STEP_M !== 0
  ) {
    throw new Error(
      "Location accuracy is too limited for this approximate-area share.",
    );
  }
  const center = approximateAreaCenter(point);
  return {
    ...point,
    latitude: center.latitude,
    longitude: center.longitude,
    accuracyM: grantedRadius,
    locationMode: "approximate",
    approximateRadiusM: grantedRadius,
  };
}

export function validateLocationPointForGrant(params: {
  point: PlainLocationPoint;
  grant: Pick<OneLocationGrant, "locationMode" | "approximateRadiusM">;
}): PlainLocationPoint {
  const mode = grantLocationMode(params.grant);
  if (mode === "precise") {
    if (params.point.locationMode === "approximate") {
      throw new Error("The shared location mode does not match this grant.");
    }
    return {
      ...params.point,
      locationMode: "precise",
      approximateRadiusM: null,
    };
  }

  const expectedRadius = Number(params.grant.approximateRadiusM);
  const pointRadius = Number(params.point.approximateRadiusM);
  if (
    params.point.locationMode !== "approximate" ||
    !Number.isFinite(expectedRadius) ||
    expectedRadius < APPROXIMATE_AREA_MIN_RADIUS_M ||
    expectedRadius > APPROXIMATE_AREA_MAX_RADIUS_M ||
    expectedRadius % APPROXIMATE_AREA_RADIUS_STEP_M !== 0 ||
    !Number.isFinite(pointRadius) ||
    pointRadius !== expectedRadius
  ) {
    throw new Error("This approximate-area update failed its privacy check.");
  }
  const expectedCenter = approximateAreaCenter(params.point);
  if (
    Math.abs(expectedCenter.latitude - params.point.latitude) > 1e-7 ||
    Math.abs(expectedCenter.longitude - params.point.longitude) > 1e-7
  ) {
    throw new Error("This approximate-area update failed its privacy check.");
  }
  return params.point;
}

export function approximateAreaCellKey(point: PlainLocationPoint): string {
  const center = approximateAreaCenter(point);
  return `${center.latitude.toFixed(7)},${center.longitude.toFixed(7)}`;
}
