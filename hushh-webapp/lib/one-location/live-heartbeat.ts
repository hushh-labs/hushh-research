import { LocationBus } from "./location-bus";
import { isPublishableAge, publishPointFrom } from "./live-publish-decision";
import type { PlainLocationPoint } from "./types";

export const LIVE_LOCATION_UPDATE_INTERVAL_MS = 20_000;

/** Reuse a measured fix from this session. Restored or stale points cannot refresh a live share. */
export async function liveHeartbeatPoint(): Promise<PlainLocationPoint | null> {
  let state = LocationBus.getState();
  if (state.snapshotOrigin !== "fresh" || !isPublishableAge(state.snapshot?.capturedAt, LIVE_LOCATION_UPDATE_INTERVAL_MS)) {
    await LocationBus.ensure({ maxAgeMs: LIVE_LOCATION_UPDATE_INTERVAL_MS });
    state = LocationBus.getState();
  }
  // A failed acquisition can leave the previous fix on the bus.
  return isPublishableAge(state.snapshot?.capturedAt, LIVE_LOCATION_UPDATE_INTERVAL_MS) ? publishPointFrom(state) : null;
}
