/**
 * One answer to "can we ask this device for a location right now?".
 *
 * The rule this module exists to enforce: **a permission query is a hint, an
 * attempt is the truth.** Only the platform can say whether it will prompt, and
 * on the web the only way to find out is to call `getCurrentPosition()` — the
 * browser shows its prompt there and nowhere else. Refusing beforehand because
 * a query said "denied" guarantees the prompt never appears, which is how a
 * user whose state is stale or unreadable ends up permanently stuck behind
 * "Allow location permission before sharing" with no in-app way out.
 *
 * Safari makes that failure mode the default rather than an edge case: WebKit
 * does not support the `geolocation` name in the Permissions API, so the query
 * rejects and the app learns nothing. Nothing is a reason to ask, not a reason
 * to refuse.
 *
 * So exactly two conditions block before an attempt, and both are things the
 * app genuinely cannot resolve by asking:
 *   - the OS location service is switched off (`locationServicesEnabled: false`)
 *   - iOS reports `restricted` (parental controls / MDM — no prompt exists)
 *
 * Everything else attempts, and the resulting error is what decides.
 */

import type { HushhLocationPermissionState } from "@/lib/capacitor";

export type LocationBlockReason =
  /** The device has no geolocation capability at all. */
  | "unsupported"
  /** OS-level Location Services are switched off. */
  | "services-off"
  /** iOS parental controls or MDM. No prompt can be shown. */
  | "restricted";

/** Copy for the one thing the user can actually do about each block. */
export const LOCATION_BLOCK_MESSAGE: Record<LocationBlockReason, string> = {
  unsupported: "This device or browser cannot share location.",
  "services-off": "Turn on Location for your device, then try again.",
  restricted: "Location is restricted on this device by its settings policy.",
};

/**
 * Why an attempt cannot even be made, or null when one should be attempted.
 *
 * `denied` is deliberately absent. A denial we merely *read* is not a denial we
 * *observed*: browsers re-prompt after a reset, Android re-prompts unless the
 * user chose "don't ask again", and Safari cannot report the value at all. We
 * find out by asking.
 */
export function locationBlockReason(
  permission: HushhLocationPermissionState | null,
): LocationBlockReason | null {
  if (!permission) return null;
  if (permission.state === "unavailable" && permission.locationServicesEnabled === false) {
    return "services-off";
  }
  if (permission.state === "unavailable") return "unsupported";
  if (permission.locationServicesEnabled === false) return "services-off";
  if (permission.state === "restricted") return "restricted";
  return null;
}

/** True when a capture attempt is worth making on a user gesture. */
export function canAttemptLocation(
  permission: HushhLocationPermissionState | null,
): boolean {
  return locationBlockReason(permission) === null;
}

/**
 * True when the platform can still surface its own permission prompt.
 *
 * Used to choose between "we will ask you" and "we have to send you to
 * Settings". An unknown state counts as promptable: assuming we cannot ask is
 * what created the dead end in the first place.
 */
export function canPromptForLocation(
  permission: HushhLocationPermissionState | null,
): boolean {
  if (!canAttemptLocation(permission)) return false;
  return permission?.state !== "denied";
}

/**
 * Did this capture failure actually come from a refused permission?
 *
 * The three platforms report the same fact three ways, and only this one
 * distinguishes "you said no" from "the fix timed out" — which is the
 * difference between sending someone to Settings and telling them to retry.
 *
 *   web     `Error` named `LocationPermissionDeniedError` (location-web.ts)
 *   iOS     rejects with "Location permission was not granted."
 *   Android rejects with the same string
 *
 * Matching on message text is unpleasant, but it is the contract the native
 * plugins already publish; the alternative is to let a timeout masquerade as a
 * denial and strand the user in Settings for no reason.
 */
export function isLocationPermissionDeniedError(error: unknown): boolean {
  if (!error) return false;
  if (typeof error === "object" && error !== null) {
    const named = error as { name?: unknown; code?: unknown };
    if (named.name === "LocationPermissionDeniedError") return true;
    // Raw GeolocationPositionError.PERMISSION_DENIED, if one ever reaches here
    // unwrapped.
    if (named.code === 1) return true;
  }
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  return /permission (was not granted|is blocked|denied)|denied geolocation/i.test(
    message,
  );
}

export type LocationReadiness =
  /** A usable fix is in hand. */
  | "ready"
  /** Nothing blocks an attempt; the platform may prompt. */
  | "askable"
  /** Observed denial — recoverable only through device settings. */
  | "blocked";

/**
 * What the UI should claim about location right now.
 *
 * `hasFix` is the authority: a device that just produced a coordinate is
 * working, whatever any permission API claims about it. This is what keeps the
 * status honest on Safari, where the permission value is unreadable.
 */
export function locationReadiness(params: {
  permission: HushhLocationPermissionState | null;
  hasFix: boolean;
  /** Set once a capture attempt has failed with a real PERMISSION_DENIED. */
  observedDenial?: boolean;
}): LocationReadiness {
  if (params.hasFix) return "ready";
  if (params.observedDenial) return "blocked";
  if (!canAttemptLocation(params.permission)) return "blocked";
  return "askable";
}

/** Short status text for the Location header. */
export function locationStatusLabel(params: {
  readiness: LocationReadiness;
  previewOn: boolean;
  paused: boolean;
  accuracyLimited: boolean;
}): string {
  if (params.paused) return "Location paused";
  if (params.readiness === "blocked") return "Location blocked";
  if (!params.previewOn) return "Location off";
  if (params.accuracyLimited) return "Location limited";
  return "Location on";
}
