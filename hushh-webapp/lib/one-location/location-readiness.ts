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

/**
 * Short status text for the Location header.
 *
 * `compact` drops the leading "Location", for the phone layout where the switch
 * sits under a 28px title that already says Location. Two reasons, both
 * measured rather than assumed: the word is pure repetition of the screen
 * title, and at 320-390px the longer string is wide enough to push "Location
 * Agent" onto a second line. The precedence lives here once so the two forms
 * can never disagree about which state wins.
 */
export function locationStatusLabel(params: {
  readiness: LocationReadiness;
  previewOn: boolean;
  paused: boolean;
  accuracyLimited: boolean;
  compact?: boolean;
}): string {
  const prefix = params.compact ? "" : "Location ";
  const word = (compact: string, full: string) =>
    params.compact ? compact : `${prefix}${full}`;
  if (params.paused) return word("Paused", "paused");
  if (params.readiness === "blocked") return word("Blocked", "blocked");
  if (!params.previewOn) return word("Off", "off");
  if (params.accuracyLimited) return word("Limited", "limited");
  return word("On", "on");
}

/**
 * How old a position may be and still be offered as "where you are".
 *
 * An hour, matching the budget the nearby drawer already chose for a restored
 * fix. Long, deliberately: the alternative on a device that has stopped
 * answering is not a fresher position, it is no position at all.
 */
export const USABLE_FIX_MAX_AGE_MS = 60 * 60 * 1_000;

/** Below this a position needs no "last known" qualifier. */
export const FRESH_FIX_MAX_AGE_MS = 2 * 60 * 1_000;

/** What went wrong, in the only three kinds a surface has to tell apart. */
export type LocationFailure =
  /** The platform refused, proven by attempting. Settings is the way out. */
  | "denied"
  /** The device or its policy forbids an attempt. Settings, or nothing. */
  | "blocked"
  /** Nothing refused us; we simply have no position. Retry is the way out. */
  | "no-fix";

/**
 * Should this failure be put in front of the owner?
 *
 * One rule, applied everywhere: **an error is shown only when the app has no
 * usable position AND the owner can do something about it.**
 *
 * What that replaces is a surface that toasted on every capture failure,
 * including the ones where a perfectly good position was already on screen. A
 * failed refresh is not a location we do not have, and the two used to look
 * identical — which is how "turn on location" ended up in front of people
 * whose location was working.
 *
 * `blocksUserIntent` is the difference between a tap and a warm-up. A person
 * who pressed Send and did not get a message needs to know why. A screen that
 * quietly refreshed a position in the background does not get to interrupt
 * them about it.
 */
export function shouldSurfaceLocationError(params: {
  hasUsableFix: boolean;
  observedDenial: boolean;
  blockReason: LocationBlockReason | null;
  blocksUserIntent: boolean;
}): boolean {
  // Actionable regardless of what we are holding: the owner is cut off from
  // every future fix until they change a setting, and only saying so gets them
  // there.
  if (params.observedDenial) return true;
  if (params.blockReason) return true;
  if (params.hasUsableFix) return false;
  return params.blocksUserIntent;
}

/** Is this position recent enough to present as where the owner is? */
export function isUsableFixAge(
  capturedAt: string | null | undefined,
  maxAgeMs: number = USABLE_FIX_MAX_AGE_MS,
): boolean {
  if (!capturedAt) return false;
  const capturedMs = Date.parse(capturedAt);
  if (!Number.isFinite(capturedMs)) return false;
  const age = Date.now() - capturedMs;
  // A timestamp from the future is a clock change, not a fresh fix.
  return age >= 0 && age <= maxAgeMs;
}

/**
 * " · 20 min ago", or "" for a position recent enough to need no qualifier.
 *
 * A position the app is unsure about should say so in three words, not be
 * replaced by an error. Empty for a fresh fix so the common case stays silent.
 */
export function fixAgeLabel(capturedAt: string | null | undefined): string {
  if (!capturedAt) return "";
  const capturedMs = Date.parse(capturedAt);
  if (!Number.isFinite(capturedMs)) return "";
  const ageMs = Date.now() - capturedMs;
  if (ageMs < 0 || ageMs <= FRESH_FIX_MAX_AGE_MS) return "";
  const minutes = Math.round(ageMs / 60_000);
  if (minutes < 60) return ` · ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? " · 1 hr ago" : ` · ${hours} hr ago`;
}

/**
 * The one location vocabulary.
 *
 * There were four — the web plugin, the bus, the Location page, and the
 * nearby sheet each had their own — so the same failure reached the owner in
 * four different sentences depending on which button they had pressed. These
 * are short on purpose: the recovery card already carries the instructions,
 * and a message that repeats them is a message people stop reading.
 */
export const LOCATION_COPY = {
  /** The only message that earns a Settings button. */
  denied: "Location is off for Hussh.",
  /** Nothing refused us; there is simply no fix yet. */
  noFix: "Couldn't find you. Try again.",
  finding: "Finding you…",
  lastKnown: (age: string) => `Last known${age}.`,
} as const;
