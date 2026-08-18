/**
 * The rules behind the contact picker's conditional controls, kept out of the
 * components so they can be reasoned about — and tested — on their own.
 *
 * The picker has to serve two populations from one screen: an account with
 * four contacts, where a search field and a sort menu are pure noise, and an
 * account with a hundred, where finding one person without them is hopeless.
 * Circles now hold up to 100 members (migration 158), so the second case is
 * not hypothetical.
 */

/**
 * Where "a list" becomes "too long to read".
 *
 * Ten rows at the picker's 58px row height is roughly one phone screenful, so
 * the trigger is the honest one — controls appear exactly when the list stops
 * fitting on screen — rather than a number chosen for looking round.
 */
export const CONTACT_LIST_CONTROLS_THRESHOLD = 10;

/**
 * Whether a section should be showing its search / sort controls.
 *
 * Two properties matter more than the comparison itself:
 *
 * 1. `sourceCount` must be the section's FULL list, never the filtered result.
 *    Measuring the filtered list makes the controls destroy their own reason
 *    to exist: type a query, the 40 rows become 4, the field unmounts, the
 *    query dies with it, the list returns to 40, the field remounts. That is
 *    not a hypothetical race — it is what the naive reading of "hide the
 *    controls for short lists" compiles to.
 *
 * 2. Once revealed, they stay revealed (`alreadyRevealed`). Removing people
 *    one at a time from a 12-person list would otherwise yank the search field
 *    out from under a half-typed query the moment the eleventh went. The
 *    controls come back only when the section is next mounted fresh.
 */
export function shouldRevealListControls(
  sourceCount: number,
  alreadyRevealed = false,
): boolean {
  if (alreadyRevealed) return true;
  return sourceCount > CONTACT_LIST_CONTROLS_THRESHOLD;
}

/**
 * Whether a list of this size should be handed to the virtualizer.
 *
 * Deliberately the same threshold. Below it, rows render plainly: a
 * virtualizer measuring three rows costs more than it saves, and — the
 * practical half — jsdom reports every element as 0px tall, so a virtualized
 * list renders almost nothing under test. Small fixtures stay directly
 * assertable, and the windowing that matters at 100 contacts still engages
 * exactly where the controls do.
 */
export function shouldVirtualizeList(sourceCount: number): boolean {
  return sourceCount > CONTACT_LIST_CONTROLS_THRESHOLD;
}

/**
 * Fold case and accents so "renée" is found by "renee".
 *
 * Names are the whole search corpus here, and a picker that cannot find a name
 * because of an acute accent is worse than one with no search at all — the
 * person can see the contact exists and cannot reach it.
 */
export function normalizeSearchText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .trim();
}

/** A query shorter than this filters nothing; one character narrows nothing useful. */
export const CONTACT_SEARCH_MIN_LENGTH = 1;

export function contactQueryIsActive(query: string): boolean {
  return normalizeSearchText(query).length >= CONTACT_SEARCH_MIN_LENGTH;
}

/**
 * Match every whitespace-separated term independently, in any order, against
 * any part of the haystack.
 *
 * "ankit singh" therefore finds "Ankit Kumar Singh", which a single substring
 * match would not — and which is the exact shape of a real query, because a
 * person types the first and last name they remember, not the middle one they
 * do not.
 */
export function matchesContactQuery(haystack: string, query: string): boolean {
  const needle = normalizeSearchText(query);
  if (!needle) return true;
  const hay = normalizeSearchText(haystack);
  return needle.split(/\s+/).every((term) => hay.includes(term));
}

export function filterByContactQuery<T>(
  items: readonly T[],
  query: string,
  toSearchableText: (item: T) => string,
): T[] {
  if (!contactQueryIsActive(query)) return [...items];
  return items.filter((item) => matchesContactQuery(toSearchableText(item), query));
}

/**
 * "Default" is the order the caller already put them in — for contacts that is
 * the recommendation ranking the directory computed, which is more useful than
 * the alphabet and must not be silently thrown away by offering sorting at all.
 */
export type ContactSortMode = "default" | "name-asc" | "name-desc";

export const CONTACT_SORT_MODES: ReadonlyArray<{
  value: ContactSortMode;
  label: string;
}> = [
  { value: "default", label: "Suggested" },
  { value: "name-asc", label: "A–Z" },
  { value: "name-desc", label: "Z–A" },
];

export function sortByContactMode<T>(
  items: readonly T[],
  mode: ContactSortMode,
  toName: (item: T) => string,
): T[] {
  const next = [...items];
  if (mode === "default") return next;
  // localeCompare with numeric so "Sam 2" sorts after "Sam 10" the way a person
  // reading a list expects, and with sensitivity:"base" so case and accents do
  // not split otherwise-adjacent names apart.
  const direction = mode === "name-desc" ? -1 : 1;
  return next.sort(
    (left, right) =>
      direction *
      toName(left).localeCompare(toName(right), undefined, {
        numeric: true,
        sensitivity: "base",
      }),
  );
}

/** "1 person" / "12 people" — the pill, the sheet and the toasts share one voice. */
export function peoplePillLabel(count: number): string {
  return `${count} ${count === 1 ? "person" : "people"} added`;
}
