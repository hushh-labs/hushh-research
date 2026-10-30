import type { HushhLocationPermissionState } from "@/lib/capacitor";
import type { PlainLocationPoint } from "@/lib/one-location/types";
import type { LocationPermissionSettlement } from "@/lib/services/one-location-onboarding-device-orchestrator";

export const ONE_LOCATION_CAPTURE_MAX_AGE_MS = 30_000;
const ONE_LOCATION_CAPTURE_MAX_FUTURE_SKEW_MS = 5_000;

export type FreshLocationRuntimeCapture = PlainLocationPoint & {
  sourcePlatform: "web" | "ios" | "android" | "native";
};

/** A queried denial is advisory until this session observes a real denial. */
export function locationPermissionPreflight(
  permission: HushhLocationPermissionState,
  observedDenial: boolean,
): LocationPermissionSettlement | null {
  if (permission.locationServicesEnabled === false) return "services_disabled";
  if (permission.state === "restricted") return "permission_restricted";
  if (permission.state === "denied" && observedDenial) {
    return "permission_denied";
  }
  return permission.state === "granted" ? "permission_granted" : null;
}

/** Validate real device evidence before retaining it in RAM for the form. */
export function parseFreshLocationRuntimeCapture(
  capture: unknown,
  nowMs = Date.now(),
): FreshLocationRuntimeCapture | null {
  if (!capture || typeof capture !== "object" || Array.isArray(capture)) {
    return null;
  }
  const source = capture as Record<string, unknown>;
  const sourcePlatform = source.sourcePlatform;
  const capturedAtMs =
    typeof source.capturedAt === "string"
      ? Date.parse(source.capturedAt)
      : Number.NaN;
  const captureAgeMs = nowMs - capturedAtMs;
  if (
    typeof source.latitude !== "number" ||
    !Number.isFinite(source.latitude) ||
    source.latitude < -90 ||
    source.latitude > 90 ||
    typeof source.longitude !== "number" ||
    !Number.isFinite(source.longitude) ||
    source.longitude < -180 ||
    source.longitude > 180 ||
    typeof source.capturedAt !== "string" ||
    !Number.isFinite(capturedAtMs) ||
    captureAgeMs > ONE_LOCATION_CAPTURE_MAX_AGE_MS ||
    captureAgeMs < -ONE_LOCATION_CAPTURE_MAX_FUTURE_SKEW_MS ||
    (sourcePlatform !== "web" &&
      sourcePlatform !== "ios" &&
      sourcePlatform !== "android" &&
      sourcePlatform !== "native")
  ) {
    return null;
  }
  const accuracyM =
    source.accuracyM === null || source.accuracyM === undefined
      ? null
      : typeof source.accuracyM === "number" &&
          Number.isFinite(source.accuracyM) &&
          source.accuracyM >= 0
        ? source.accuracyM
        : null;
  return {
    latitude: source.latitude,
    longitude: source.longitude,
    accuracyM,
    capturedAt: new Date(capturedAtMs).toISOString(),
    sourcePlatform,
  };
}
