import type { PlainLocationPoint } from "@/lib/one-location/types";

/**
 * Where the last onboarding screen points its camera.
 *
 * This exists because the answer used to be "whatever the save-place modal is
 * currently holding", and that is a DRAFT: both of the modal's exits -- saving
 * the place and skipping it -- clear it, which is correct for a draft and fatal
 * here. The modal runs two screens before the finale, so by the time "You're on
 * the map." rendered, the point was always null and the screen always drew its
 * stylised fallback. Nobody ever saw themselves on a real map at the end of
 * onboarding, on any platform or in any environment.
 *
 * Keeping the choice in one small pure function is what makes that regression
 * hard to reintroduce: the finale reads a named answer with its own test,
 * rather than reaching into whichever piece of state happens to be nearby.
 */

/** Web Mercator, and the map itself, stop making sense outside these. */
function isDrawableCoordinate(point: PlainLocationPoint): boolean {
  const { latitude, longitude } = point;
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180 &&
    // 0,0 is Null Island -- the shape a dropped or default-initialised fix
    // takes. Flying the finale camera into the Gulf of Guinea is worse than
    // the stylised map, which at least never claims to be anywhere.
    !(latitude === 0 && longitude === 0)
  );
}

export interface OnboardingMapPointSources {
  /**
   * The save-place modal's live working point, while that modal is open. It is
   * the freshest thing on screen -- dragging the pin edits exactly this -- so
   * it wins whenever it exists.
   */
  draft?: PlainLocationPoint | null;
  /**
   * What onboarding confirmed for this run. Deliberately outlives the modal:
   * this is the value the finale is actually for.
   */
  confirmed?: PlainLocationPoint | null;
  /**
   * What the Location workspace already knows about this device. Covers the
   * person who reached the finale without the save-place step ever running --
   * a returning account, or a workspace run where location was already granted.
   */
  workspace?: PlainLocationPoint | null;
}

/**
 * Freshest usable point first, or null when this account has genuinely never
 * produced a fix -- the one case the stylised map is for.
 */
export function resolveOnboardingMapPoint(
  sources: OnboardingMapPointSources,
): { lat: number; lng: number } | null {
  for (const point of [sources.draft, sources.confirmed, sources.workspace]) {
    if (!point || !isDrawableCoordinate(point)) continue;
    return { lat: point.latitude, lng: point.longitude };
  }
  return null;
}
