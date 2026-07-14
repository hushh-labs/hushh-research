/**
 * `/one` is a retained application shell. Rendering a generic page skeleton
 * here replaces a usable screen during every nested route transition, even
 * when the destination's own cache and guard can resolve synchronously.
 *
 * Cold auth, vault, onboarding, and capability reads retain their explicit
 * route-local feedback. Same-session navigation keeps the previous surface
 * visible while Next resolves the next segment.
 */
export default function OneLoading() {
  return null;
}
