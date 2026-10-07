/** Search reuses the current route; only palette visibility is URL state. */
export const SEARCH_OPEN_QUERY_KEY = "search";

export function isKaiCommandBarOpen(
  params: { get(name: string): string | null } | null,
): boolean {
  return params?.get(SEARCH_OPEN_QUERY_KEY) === "1";
}
