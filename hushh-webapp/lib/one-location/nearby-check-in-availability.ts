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
 * Whether to offer nearby check-in in this build.
 *
 * Outside production the flow is always on. Production is off unless the build
 * opts in, because the check-in point is client-supplied and cannot be
 * attested: the backend bounds a roaming attack through its continuity guard
 * but cannot prove any single check-in is honest.
 *
 * The backend remains authoritative and admits production callers by cohort.
 * This gate only avoids collecting a location for a flow that would then be
 * refused, so it is deliberately the looser of the two — a build with the flag
 * on still gets a 404 from the backend unless that account is admitted.
 */
export function isOneLocationNearbyCheckInAvailable(): boolean {
  if (resolveAppEnvironment() !== "production") return true;
  return (
    String(process.env.NEXT_PUBLIC_ONE_LOCATION_NEARBY_CHECK_IN ?? "")
      .trim()
      .toLowerCase() === "true"
  );
}
