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
  if (permission.state !== "granted" || permission.precise !== true) {
    throw new Error(
      "Turn on Precise Location in device settings before sharing an exact location.",
    );
  }
}
