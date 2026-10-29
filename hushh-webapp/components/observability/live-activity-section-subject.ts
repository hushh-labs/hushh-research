import { getAgentsRootSection, resolveAgentSectionForPath } from "@/lib/navigation/agent-sections";
import { resolveRouteId, type RouteId } from "@/lib/observability/route-map";
import { recordLiveActivity } from "@/lib/pkm/live-activity/live-activity-journal";
import { LIVE_ACTIVITY_COALESCE_WINDOW_MS } from "@/lib/pkm/live-activity/live-activity-types";

/** Screens outside the agent sections that still count as an opened section. */
const LIVE_ACTIVITY_ROUTE_SUBJECTS: Partial<Record<RouteId, string>> = {
  connect: "connect",
  connect_settings: "connect",
  profile_world_model: "profile_world_model",
  one_documents: "one_documents",
};

/**
 * An allowlisted section id for the live activity journal; never the path
 * itself. The One home is the hub between sections, not a section the owner
 * used, so it is never journaled.
 */
export function liveActivitySectionSubject(pathname: string): string | null {
  const section = resolveAgentSectionForPath(pathname);
  if (section) return section.id === getAgentsRootSection().id ? null : section.id.replace(/-/g, "_");
  return LIVE_ACTIVITY_ROUTE_SUBJECTS[resolveRouteId(pathname)] ?? null;
}

/** The visit the route observer is on, once the journal stored it; null after a route outside the sections. */
let currentVisit: { userId: string; subject: string; at: number } | null = null;

/**
 * The route observer calls this on every visit change; a null subject (the One
 * home, any route outside the sections) ends the visit. Each section visit is
 * recorded, so Location, home, Location counts twice. A visit counts as stored
 * only when the journal stored it, so one dropped before attach is caught up.
 */
export function recordSectionVisit(userId: string, subject: string | null): void {
  currentVisit = null;
  if (subject && recordLiveActivity({ kind: "section_opened", subject })) currentVisit = { userId, subject, at: Date.now() };
}

/** The attach-time catch-up: records the open section unless the observer already stored this same visit. */
export function recordCurrentSectionVisit(userId: string, subject: string): void {
  const visit = currentVisit;
  if (visit && visit.userId === userId && visit.subject === subject && Date.now() - visit.at < LIVE_ACTIVITY_COALESCE_WINDOW_MS) return;
  recordSectionVisit(userId, subject);
}
