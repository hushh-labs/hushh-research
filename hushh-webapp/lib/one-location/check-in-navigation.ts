import { ROUTES } from "@/lib/navigation/routes";

/**
 * The href Your Map opens nearby check-in with, preserving the map's own query.
 *
 * Your Map could reach check-in through the legacy `?action=check-in` redirect
 * like everyone else, but that costs two navigations for a screen we own -- a
 * push onto the map route followed by a replace off it, which on native shows
 * as a flash and leaves a history entry nobody asked for. Naming the
 * destination directly is one navigation.
 *
 * Takes anything that stringifies to a query so the caller can hand over Next's
 * read-only `useSearchParams()` value directly.
 */
export function buildCheckInHrefFromYourMap(currentQuery: {
  toString(): string;
}): string {
  const params = new URLSearchParams(currentQuery.toString());
  // The redirect exists for callers we do not own -- old links, notifications,
  // breadcrumbs. Carrying its param onto the route it redirects to would leave
  // the new screen wearing the query the redirect exists to retire.
  params.delete("action");
  const query = params.toString();
  return query
    ? `${ROUTES.ONE_LOCATION_CHECK_IN}?${query}`
    : ROUTES.ONE_LOCATION_CHECK_IN;
}
