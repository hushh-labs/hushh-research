/**
 * Decide whether to run the owner's standalone self-preview location watch.
 *
 * The self-preview streams the owner's own position (Device readiness) once they
 * tap "Show my location", so they can confirm live tracking works before any
 * share exists. It runs only when:
 *  - the user opted in (streaming), AND
 *  - there is no active share — when a share IS active the publish watch already
 *    streams and updates the preview, so a second watch would be redundant, AND
 *  - location permission is not blocked (denied/restricted/unavailable).
 *
 * `prompt`/unknown states are allowed through so the watch itself surfaces the
 * real permission error rather than silently doing nothing.
 */
export function shouldStreamSelfPreview(params: {
  streaming: boolean;
  activeGrantCount: number;
  permissionState: string | null | undefined;
}): boolean {
  if (!params.streaming) return false;
  if (params.activeGrantCount > 0) return false;
  if (
    params.permissionState === "denied" ||
    params.permissionState === "restricted" ||
    params.permissionState === "unavailable"
  ) {
    return false;
  }
  return true;
}
