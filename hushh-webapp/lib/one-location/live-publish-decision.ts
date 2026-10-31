/**
 * What the live-share publisher does when the device does not answer.
 *
 * The publisher is a 20-second heartbeat inside a nine-thousand-line client
 * component, which is the reason its behaviour went unexamined for so long: it
 * cannot be rendered in a test, so nobody could assert on it. Extracted here
 * for the same reason `self-preview.ts` was — a gate is a decision, decisions
 * are testable, and this one was wrong in a way the owner saw every twenty
 * seconds.
 *
 * Two questions, deliberately kept apart because they have opposite answers:
 *
 *   1. **Do we tell anyone?** Almost never. A failed refresh while we are
 *      holding a position is a failed refresh, not a location we do not have,
 *      and the owner can do nothing with that news. Only a real refusal or a
 *      total absence of position is worth their attention.
 *
 *   2. **Do we publish?** Only a fix measured this session. This is the one
 *      place in the app where degrading to a remembered position would be a
 *      lie rather than a courtesy: the recipient's screen says "live", and a
 *      restored coordinate under that label shows someone standing still
 *      somewhere they already left. Silence is the honest failure here — the
 *      recipient's own staleness threshold is what tells them the dot is old.
 */

import type { LocationBusState } from "@/lib/one-location/location-bus";
import { isLocationPermissionDeniedError } from "@/lib/one-location/location-readiness";
import type { PlainLocationPoint } from "@/lib/one-location/types";

/**
 * Should a publish failure be reported at all?
 *
 * `observedDenial` is the caller's own record of a refusal it has already
 * proven by attempting; it is trusted over the error when set, because a
 * denial observed once stays true for every tick after it.
 */
export function shouldWarnOnPublishFailure(params: {
  error: unknown;
  snapshot: { capturedAt: string } | null;
  observedDenial?: boolean;
}): boolean {
  if (params.observedDenial) return true;
  if (isLocationPermissionDeniedError(params.error)) return true;
  // No position at all is a genuine dead end and the owner should hear about
  // it. Holding one means the share is still working.
  return !params.snapshot;
}

/**
 * The point this tick may publish, or null to skip the tick.
 *
 * Null is not a failure and must not be reported as one. The movement watch
 * feeds the bus continuously, so a tick with nothing fresh to say is a tick
 * where nothing has changed — the next fix publishes on arrival.
 */
export function publishPointFrom(
  state: Pick<LocationBusState, "snapshot" | "snapshotOrigin">,
): PlainLocationPoint | null {
  if (!state.snapshot) return null;
  if (state.snapshotOrigin !== "fresh") return null;
  return {
    latitude: state.snapshot.latitude,
    longitude: state.snapshot.longitude,
    accuracyM: state.snapshot.accuracyM ?? null,
    capturedAt: state.snapshot.capturedAt,
    sourcePlatform: state.snapshot.sourcePlatform ?? "web",
  };
}

/**
 * Is a fix recent enough for this tick to reuse without re-reading the device?
 *
 * The ceiling is one heartbeat period, so a published point is never older
 * than a single tick — which is the guarantee the recipient side is already
 * written against, at three periods before it calls a share stale.
 */
export function isPublishableAge(
  capturedAt: string | null | undefined,
  maxAgeMs: number,
): boolean {
  if (!capturedAt) return false;
  const capturedMs = Date.parse(capturedAt);
  if (!Number.isFinite(capturedMs)) return false;
  const age = Date.now() - capturedMs;
  // A timestamp from the future is a clock change, not a fresh fix.
  return age >= 0 && age <= maxAgeMs;
}
