import { resolveAppEnvironment } from "@/lib/app-env";

/**
 * Hard ceiling for a usable check-in fix, mirroring the backend's
 * `NEARBY_PRESENCE_MAX_ACCURACY_METERS` and the `accuracyM <= 5000` API bound.
 *
 * This is deliberately far looser than the geofence. Co-presence is anchored to
 * the *selected place*, not to this reading, so a coarse receiver can no longer
 * smear the 500 m radius. Accuracy only has to be good enough to show that the
 * owner is plausibly standing at the place they picked. The previous 100 m
 * ceiling was unreachable for browser geolocation (wifi/IP trilateration
 * routinely reports 1-5 km), which made the entire flow -- place list included
 * -- dead on desktop web and indoors.
 */
export const ONE_LOCATION_NEARBY_MAX_ACCURACY_METERS = 5_000;

/**
 * Above this the fix still works, but it is worth telling the owner their
 * receiver is coarse so a rejected place choice is not a surprise. Advisory
 * only: it must never block capture, the place list, or check-in.
 */
export const ONE_LOCATION_NEARBY_COARSE_ACCURACY_METERS = 200;

/**
 * Radius-based nearby discovery is a local/UAT simulation until production
 * admission and abuse-prevention controls are available. The backend remains
 * authoritative; this frontend gate prevents collecting a location for a flow
 * that production will reject.
 */
export function isOneLocationNearbyCheckInAvailable(): boolean {
  return resolveAppEnvironment() !== "production";
}
