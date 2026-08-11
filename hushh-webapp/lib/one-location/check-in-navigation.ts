import { ROUTES } from "@/lib/navigation/routes";

/**
 * Where nearby check-in came from, and therefore where dismissing it goes.
 *
 * Check-in has two openers -- Your Map and the Location hub -- and one dismiss,
 * so the destination cannot be a constant. The opener is recorded in the URL
 * rather than in state: a refresh, a resumed flow and a live navigation then all
 * dismiss to the same place, which is not true of anything held in memory. This
 * is the same `source` convention the hub's own flows already use to remember
 * who opened them.
 */
export const CHECK_IN_SOURCE_PARAM = "source";
export const YOUR_MAP_CHECK_IN_SOURCE = "map";

/**
 * Where dismissing nearby check-in lands.
 *
 * Check-in became its own route so it would stop reading as Your Map with a
 * sheet on top. Dismissing had to leave that route, and it was pointed at the
 * Location hub for everyone -- correct for the hub's own "Check in" card, but it
 * threw anyone who opened check-in from Your Map two screens back, past the map
 * they were standing on, at the moment they had just checked in.
 *
 * The hub stays the default: an absent, unknown or spoofed source means the
 * person did not come from Your Map, and the hub is where every other entry
 * point lives. The value is compared exactly for that last reason -- a stale or
 * hand-edited param must not be able to choose the destination.
 */
export function resolveCheckInDismissHref(
  source: string | null | undefined,
): string {
  return source === YOUR_MAP_CHECK_IN_SOURCE
    ? ROUTES.ONE_LOCATION_MAP
    : ROUTES.ONE_LOCATION;
}

/**
 * The href Your Map opens check-in with, preserving the map's own query.
 *
 * Takes anything that stringifies to a query so the caller can hand over
 * Next's read-only `useSearchParams()` value directly.
 */
export function buildCheckInHrefFromYourMap(currentQuery: {
  toString(): string;
}): string {
  const params = new URLSearchParams(currentQuery.toString());
  // The legacy `?action=check-in` redirect exists for callers we do not own --
  // old links, notifications, breadcrumbs. Your Map is one we do own, so it
  // names the destination directly instead of routing through the redirect.
  params.delete("action");
  params.set(CHECK_IN_SOURCE_PARAM, YOUR_MAP_CHECK_IN_SOURCE);
  return `${ROUTES.ONE_LOCATION_CHECK_IN}?${params.toString()}`;
}
