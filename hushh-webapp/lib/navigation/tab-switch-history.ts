/**
 * Which tab within a top-shell tab set the person was on immediately before
 * the current one.
 *
 * `section-back-origin.ts` already tracks crossings BETWEEN destinations
 * (Location -> Connect) and deliberately ignores movement WITHIN one, on the
 * theory that a route's declared parent already climbs correctly and needs
 * no memory. That is true for a genuine hierarchy (Analysis -> Kai -> One),
 * but a tab bar is not a hierarchy: every tab's declared parent is the same
 * section root (RIA's Picks and Clients both climb to Profile; Location's
 * People and Links both climb to Now), so a person who switched Profile ->
 * Picks and pressed Back landed on Profile even though they had just come
 * from Picks a moment earlier -- reported repeatedly against RIA (#6286)
 * and, by the same mechanism, inside Location's Now/People/Links tabs.
 *
 * This fills that one gap: which SIBLING tab preceded this one, so Back can
 * undo a tab switch instead of only climbing to the shared root. Deliberately
 * not browser history, for the same reason section-back-origin.ts gives:
 * in-memory and session-only, keyed by tab SET rather than by a stack, so it
 * cannot grow unbounded and self-corrects on the very next real switch.
 */

const previousTabHrefByTabSet = new Map<string, string>();
const currentTabHrefByTabSet = new Map<string, string>();

/**
 * Note the tab set's newly-active tab. Records the outgoing href as
 * "previous" only when it is an actual switch between two tabs of the SAME
 * set -- a fresh arrival (no prior href recorded for this set) writes
 * nothing to look back to.
 */
export function recordTabSelection(tabSetId: string, nextHref: string): void {
  const current = currentTabHrefByTabSet.get(tabSetId);
  if (current && current !== nextHref) {
    previousTabHrefByTabSet.set(tabSetId, current);
  }
  currentTabHrefByTabSet.set(tabSetId, nextHref);
}

/** The sibling tab's href to retrace to, or null when none is recorded. */
export function readPreviousTabHref(tabSetId: string): string | null {
  return previousTabHrefByTabSet.get(tabSetId) ?? null;
}

/** Reset point for a sign-out or an account switch. */
export function clearTabSwitchHistory(): void {
  previousTabHrefByTabSet.clear();
  currentTabHrefByTabSet.clear();
}

/** Test seam: no production caller should read the maps directly. */
export function readTabSwitchHistoryForTest(): {
  previous: Record<string, string>;
  current: Record<string, string>;
} {
  return {
    previous: Object.fromEntries(previousTabHrefByTabSet),
    current: Object.fromEntries(currentTabHrefByTabSet),
  };
}
