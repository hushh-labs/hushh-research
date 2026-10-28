/** A cold-entry-only route is not proven by an existing signed-in session. */
export async function verifyReviewerRoute(spec, verify) {
  if (spec.requiresColdEntry) return { status: "skipped", reason: "requires-cold-entry" };
  await verify();
  return { status: "passed" };
}

/** Summarize only observations actually made in every selected viewport. */
export function summarizeReviewerRoutes(viewports, routes, observations) {
  const covered = lane => routes[lane].filter(route => viewports.every(viewport =>
    observations.some(result => result.viewport === viewport && result.lane === lane &&
      result.route === route && result.status === "passed")));
  const skipped = observations.filter(result => result.status === "skipped");
  const missing = Object.entries(routes).flatMap(([lane, names]) => names.flatMap(route =>
    viewports.filter(viewport => !observations.some(result => result.viewport === viewport &&
      result.lane === lane && result.route === route)).map(viewport => ({ viewport, lane, route }))));
  return {
    ok: viewports.length > 0 && Object.values(routes).some(names => names.length > 0) &&
      skipped.length === 0 && missing.length === 0 && observations.every(result => result.status === "passed"),
    sameSessionShellRoutesCovered: covered("sameSession"),
    directEntryRoutesCovered: covered("directEntry"),
    skippedRoutes: skipped,
    missingRoutes: missing,
  };
}
