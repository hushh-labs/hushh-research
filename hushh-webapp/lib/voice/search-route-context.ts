import routeIndex from "@/contracts/kai/one-route-orchestration-index.v1.json";
import gateway from "@/contracts/kai/kai-action-gateway.vnext.json";

/** Resolve public route defaults from authored contracts, without another search catalog. */
export function searchTargetMatchesCurrentRoute(target: string, currentHref: string): boolean {
  const current = new URL(currentHref, "https://search.invalid");
  const destination = new URL(target, "https://search.invalid");
  if (current.pathname !== destination.pathname) return false;
  const routeActions = gateway.actions.filter(action =>
    action.reachability.routes.some(route => route.split("?")[0] === current.pathname),
  );
  const surfaceIds = new Set(routeActions.map(action => action.surface_id));
  const contextKeys = new Set<string>();
  for (const action of routeActions) {
    if (action.execution_target.status !== "wired" || action.execution_target.path !== "route") continue;
    const url = new URL(action.execution_target.target, "https://search.invalid");
    if (url.pathname === current.pathname) for (const key of url.searchParams.keys()) contextKeys.add(key);
  }
  const defaults: Record<string, string> = {};
  for (const surface of gateway.surfaces) {
    if (!surfaceIds.has(surface.surface_id)) continue;
    const search = surface.search as { query_defaults?: Record<string, string> };
    Object.assign(defaults, search?.query_defaults || {});
  }
  // A partial target changes only its declared dimensions: source and category are independent.
  if (destination.searchParams.size) {
    return [...destination.searchParams].every(([key, value]) =>
      !value.includes("{") && value === (current.searchParams.get(key) ?? defaults[key]),
    );
  }
  return [...current.searchParams].filter(([key]) => contextKeys.has(key)).every(([key, value]) => defaults[key] === value);
}

/** Resolve Search's screen from the generated route contract rather than a hand-maintained switch. */
export function resolveSearchScreen(currentHref: string, fallback: string | null): string | null {
  if (!currentHref) return fallback;
  const current = new URL(currentHref, "https://search.invalid");
  const candidates = routeIndex.routes.filter(route => {
    const target = new URL(route.route_pattern, "https://search.invalid");
    const segments = target.pathname.split("/");
    const pattern = segments.map(segment => {
      if (/^\[\[\.\.\..+\]\]$/.test(segment)) return ".*";
      if (/^\[\.\.\..+\]$/.test(segment)) return ".+";
      if (/^\[.+\]$/.test(segment)) return "[^/]+";
      return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }).join("/");
    return new RegExp("^" + pattern + "$").test(current.pathname) &&
      [...target.searchParams].every(([key, value]) => current.searchParams.get(key) === value);
  }).sort((a, b) => {
    const score = (value: string) => value.includes("?") ? 10000 + value.length : value.replace(/\[[^\]]+\]/g, "").length;
    return score(b.route_pattern) - score(a.route_pattern);
  });
  return candidates[0]?.canonical_screen || fallback;
}
