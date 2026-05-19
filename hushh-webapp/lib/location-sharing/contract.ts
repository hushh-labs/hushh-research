import type {
  LocationAccessRequestStatus,
  LocationContactTier,
  LocationLatestPoint,
  LocationShareStatus,
  LocationSourcePlatform,
  PublicLocationShareState,
} from "./types";

const CONTACT_TIERS = new Set<LocationContactTier>(["family", "friend"]);
const SHARE_STATUSES = new Set<LocationShareStatus>([
  "active",
  "expired",
  "deactivated",
  "revoked",
]);
const ACCESS_REQUEST_STATUSES = new Set<LocationAccessRequestStatus>([
  "pending",
  "approved",
  "denied",
  "auto_approved",
]);
const PUBLIC_STATES = new Set<PublicLocationShareState>([
  "active",
  "expired",
  "deactivated",
  "revoked",
  "invalid",
]);
const SOURCE_PLATFORMS = new Set<LocationSourcePlatform>([
  "web",
  "ios",
  "android",
  "native",
  "unknown",
]);

export function isLocationContactTier(value: unknown): value is LocationContactTier {
  return CONTACT_TIERS.has(value as LocationContactTier);
}

export function isLocationShareStatus(value: unknown): value is LocationShareStatus {
  return SHARE_STATUSES.has(value as LocationShareStatus);
}

export function isLocationAccessRequestStatus(
  value: unknown
): value is LocationAccessRequestStatus {
  return ACCESS_REQUEST_STATUSES.has(value as LocationAccessRequestStatus);
}

export function isPublicLocationShareState(value: unknown): value is PublicLocationShareState {
  return PUBLIC_STATES.has(value as PublicLocationShareState);
}

export function isLocationSourcePlatform(value: unknown): value is LocationSourcePlatform {
  return SOURCE_PLATFORMS.has(value as LocationSourcePlatform);
}

export function isValidLocationPoint(value: unknown): value is LocationLatestPoint {
  if (!value || typeof value !== "object") return false;
  const point = value as Partial<LocationLatestPoint>;
  return (
    typeof point.latitude === "number" &&
    Number.isFinite(point.latitude) &&
    point.latitude >= -90 &&
    point.latitude <= 90 &&
    typeof point.longitude === "number" &&
    Number.isFinite(point.longitude) &&
    point.longitude >= -180 &&
    point.longitude <= 180 &&
    typeof point.capturedAt === "string" &&
    isLocationSourcePlatform(point.sourcePlatform)
  );
}

export function normalizeLocationSourcePlatform(value: unknown): LocationSourcePlatform {
  return isLocationSourcePlatform(value) ? value : "unknown";
}

export function createLocationPointFromPosition(
  position: GeolocationPosition,
  sourcePlatform: LocationSourcePlatform = "web"
): LocationLatestPoint {
  return {
    latitude: position.coords.latitude,
    longitude: position.coords.longitude,
    accuracyM: Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : null,
    headingDeg:
      typeof position.coords.heading === "number" && Number.isFinite(position.coords.heading)
        ? position.coords.heading
        : null,
    speedMps:
      typeof position.coords.speed === "number" && Number.isFinite(position.coords.speed)
        ? position.coords.speed
        : null,
    capturedAt: new Date(position.timestamp || Date.now()).toISOString(),
    sourcePlatform,
  };
}

export function hasCoordinatesInMetadata(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const forbidden = new Set([
    "lat",
    "latitude",
    "lng",
    "lon",
    "long",
    "longitude",
    "accuracy",
    "accuracy_m",
    "heading",
    "speed",
    "coordinates",
    "location",
  ]);
  if (Array.isArray(value)) {
    return value.some((item) => hasCoordinatesInMetadata(item));
  }
  return Object.entries(value as Record<string, unknown>).some(([key, item]) => {
    if (forbidden.has(key.trim().toLowerCase())) return true;
    return hasCoordinatesInMetadata(item);
  });
}
