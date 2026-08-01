import { readOneLocationControlState } from "@/lib/one-location/location-control-state";
import { OneLocationService } from "@/lib/one-location/service";

export const LOCATION_ACTION_PAUSED_MESSAGE =
  "Location is paused on this device. Resume it before sharing.";

export function assertLocationActionNotPaused(userId: string): void {
  if (readOneLocationControlState(userId).paused) {
    throw new Error(LOCATION_ACTION_PAUSED_MESSAGE);
  }
}
/** Re-read OS authorization after capture and immediately before mutation. */
export async function assertPreciseLocationActionAllowed(
  userId: string,
): Promise<void> {
  assertLocationActionNotPaused(userId);
  const permission = await OneLocationService.getPermissionState();
  assertLocationActionNotPaused(userId);
  // Browsers expose whether geolocation is granted, but not the native
  // reduced/full-accuracy tier. Fail only on an explicit reduced-accuracy
  // signal; `null` is the expected web value after a successful capture.
  if (permission.state !== "granted" || permission.precise === false) {
    throw new Error(
      "Turn on Precise Location in device settings before sharing an exact location.",
    );
  }
}
