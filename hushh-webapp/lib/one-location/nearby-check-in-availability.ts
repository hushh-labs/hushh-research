import { resolveAppEnvironment } from "@/lib/app-env";
import { isNativeUiTestSession } from "@/lib/testing/native-test";

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
 * Every lane except local development has to opt in. The check-in point is
 * client-supplied and cannot be attested: the backend bounds a roaming attack
 * through its continuity guard but cannot prove any single check-in is honest,
 * and `docs/reference/architecture/one-location-agent.md` is explicit that this
 * is "a visibly labelled local/UAT simulation" which needs organizer admission
 * proof, replay resistance, shared abuse limits and bidirectional Block/Report
 * before trusted attendance or spoof resistance may be claimed.
 *
 * The gate used to be an environment comparison against production, which
 * offered the flow to every public App Store and Play Store install. Those
 * binaries are stamped `NEXT_PUBLIC_APP_ENV=uat` because they ship against the
 * UAT backend (`release-ios-appstore.yml`, `ship-android-playstore-v1.yml`), so
 * an environment-shaped gate reads a store install as non-production and hands
 * a real person a presence feature we do not yet claim is spoof-resistant —
 * and against the UAT backend it does not fail closed either. Distribution and
 * backend environment are separate facts, exactly as in
 * `lib/testing/location-map-demo.ts`.
 *
 * The deployed web lanes are unaffected: both already pass
 * `_ONE_LOCATION_NEARBY_CHECK_IN` through `deploy/frontend.cloudbuild.yaml`.
 * The store lanes simply never set it, which is the point.
 *
 * The backend remains authoritative and admits callers by cohort. This gate
 * only avoids collecting a location for a flow that would then be refused, so
 * it stays the looser of the two — a build with the flag on still gets a 404
 * unless that account is admitted.
 */
export function isOneLocationNearbyCheckInAvailable(): boolean {
  // XCUITest / Espresso automation, which is launch-arg gated and unreachable
  // for a real store user. Native UI tests build from `.env.uat.local` and are
  // therefore UAT-stamped like a store binary; without this a nearby test added
  // later would fail for a reason that has nothing to do with the feature.
  if (isNativeUiTestSession()) return true;
  if (resolveAppEnvironment() === "development") return true;
  return (
    String(process.env.NEXT_PUBLIC_ONE_LOCATION_NEARBY_CHECK_IN ?? "")
      .trim()
      .toLowerCase() === "true"
  );
}
