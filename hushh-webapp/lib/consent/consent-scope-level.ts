/**
 * One level of a nested list of things someone can ask you for.
 *
 * This is the consent-side twin of `resolvePkmMemoryLevel`, and it deliberately
 * mirrors that contract: one view object per level, the same group/leaf
 * discriminated union, the same "crumbs, title, parentLabel" shape, and the
 * same rule that only the CURRENT level's immediate children are ever returned.
 * A person browsing what an agent wants to know should move through it exactly
 * the way they move through their own Memory, because it is the same
 * information seen from the other side.
 *
 * The difference is the source. Memory walks a decrypted JSON blob, where depth
 * is the shape of the object. A consent catalogue is a flat LIST of dotted
 * paths (`attr.financial.holdings.equities`), so a level here is resolved by
 * PREFIX-FILTERING that list. No tree is ever materialised. That is not a
 * shortcut: a scope list changes as grants change, and a tree built once is a
 * tree that goes stale, while a prefix filter is always a function of the
 * current list.
 *
 * The rule that matters for taps
 * ------------------------------
 * A child is a LEAF when nothing in the catalogue goes deeper through it, and a
 * GROUP when something does. `attr.financial.holdings` is therefore one tap
 * from the Financial level, not two. The naive rule (leaf only when the path
 * ends exactly here) would wrap every ordinary two-segment scope in a folder
 * containing exactly one row, which is worse than the flat list it replaced.
 *
 * When a path is BOTH -- `attr.financial.holdings` exists and so does
 * `attr.financial.holdings.equities` -- the segment renders as a group, and the
 * broader scope reappears as a leaf inside it. A grant on the parent is a
 * different, wider decision than a grant on one child, so it must stay
 * reachable and must never be silently folded into its own subtree.
 */

import { humanizeMemorySegment } from "@/lib/pkm/humanize-segment";

import type { ConsentScopeItem } from "./consent-scope-items";

/** A branch: something to open, with a count of what it ultimately holds. */
export type ConsentScopeLevelGroup = {
  kind: "group";
  key: string;
  segment: string;
  label: string;
  /** Recursive count of the things underneath, not the immediate child count. */
  childCount: number;
};

/** An end of the line: one thing that can actually be asked for. */
export type ConsentScopeLevelLeaf = {
  kind: "leaf";
  key: string;
  item: ConsentScopeItem;
};

export type ConsentScopeLevelEntry = ConsentScopeLevelGroup | ConsentScopeLevelLeaf;

export type ConsentScopeLevelView = {
  /** Human labels from the top down to here, e.g. ["Financial", "Holdings"]. */
  crumbs: string[];
  title: string;
  /** Label one level up, for the single back control. `rootLabel` at the top. */
  parentLabel: string;
  entries: ConsentScopeLevelEntry[];
  /** True when the path no longer exists, e.g. a grant was revoked under you. */
  notFound: boolean;
  /** Every leaf at or below here. Lets a caller act on a whole branch at once. */
  descendantItems: ConsentScopeItem[];
};

/** Domain first, then everything below it. The full address of one scope. */
function fullPath(item: ConsentScopeItem): string[] {
  return [item.domainKey || "other", ...item.pathSegments];
}

function startsWith(path: readonly string[], prefix: readonly string[]): boolean {
  if (prefix.length > path.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (path[index] !== prefix[index]) return false;
  }
  return true;
}

/**
 * A wildcard segment is the scope saying "and everything under here".
 *
 * Humanising it as "*" would print our grammar at a person, so it borrows the
 * authored label instead, and only falls back to plain words.
 */
function segmentLabel(segment: string, item: ConsentScopeItem | null): string {
  if (segment === "*") return item?.label || "Everything here";
  return humanizeMemorySegment(segment);
}

/**
 * Resolve exactly one level.
 *
 * `pathStack` is the position: `[]` is the top (one row per domain),
 * `["financial"]` is inside Financial, and so on to any depth. Depth is
 * unbounded by design -- it is whatever the catalogue contains.
 */
export function resolveConsentScopeLevel(params: {
  items: readonly ConsentScopeItem[];
  pathStack: readonly string[];
  /** What the back control says at the top level. */
  rootLabel?: string;
}): ConsentScopeLevelView {
  const { items, pathStack } = params;
  const rootLabel = params.rootLabel || "All";
  const depth = pathStack.length;

  const matching = items.filter((item) => startsWith(fullPath(item), pathStack));

  // Labels for the crumbs are taken from the matching items rather than
  // humanised blind, so an authored domain label ("Saved Places") wins over a
  // derived one, exactly as it does everywhere else.
  const crumbLabels: string[] = [];
  for (let index = 0; index < depth; index += 1) {
    const sample = matching[0];
    const segment = pathStack[index]!;
    if (index === 0 && sample) {
      crumbLabels.push(sample.domainLabel || humanizeMemorySegment(segment));
      continue;
    }
    crumbLabels.push(
      segmentLabel(
        segment,
        matching.find((item) => fullPath(item).length === index + 1) || null,
      ),
    );
  }

  const crumbs = crumbLabels;
  const title = crumbs[crumbs.length - 1] ?? rootLabel;
  const parentLabel = crumbs.length >= 2 ? crumbs[crumbs.length - 2]! : rootLabel;

  if (depth > 0 && matching.length === 0) {
    return {
      crumbs,
      title,
      parentLabel,
      entries: [],
      notFound: true,
      descendantItems: [],
    };
  }

  // A scope whose path ENDS exactly at this level is the broad grant on this
  // branch. It is shown here, above the children it contains.
  const terminal = matching.filter((item) => fullPath(item).length === depth);

  const buckets = new Map<string, ConsentScopeItem[]>();
  for (const item of matching) {
    const path = fullPath(item);
    if (path.length <= depth) continue;
    const segment = path[depth]!;
    const bucket = buckets.get(segment);
    if (bucket) bucket.push(item);
    else buckets.set(segment, [item]);
  }

  const entries: ConsentScopeLevelEntry[] = [];

  for (const item of terminal) {
    entries.push({ kind: "leaf", key: item.id, item });
  }

  for (const [segment, bucket] of buckets) {
    const goesDeeper = bucket.some((item) => fullPath(item).length > depth + 1);

    if (!goesDeeper) {
      // Exactly one scope lives here and nothing extends it. A folder holding a
      // single row costs a tap and hides nothing, so render the row itself.
      const item = bucket[0]!;
      entries.push({ kind: "leaf", key: item.id, item });
      continue;
    }

    entries.push({
      kind: "group",
      key: segment,
      segment,
      label: segmentLabel(
        segment,
        bucket.find((item) => fullPath(item).length === depth + 1) || null,
      ),
      childCount: bucket.length,
    });
  }

  return { crumbs, title, parentLabel, entries, notFound: false, descendantItems: matching };
}

/**
 * Every leaf under a position, for a caller that wants to act on a whole branch.
 *
 * Selecting "Financial" should be able to mean every scope inside it. Without
 * this, a person browsing a deep catalogue would have to open every branch and
 * tick every row to say a thing they meant in one gesture.
 */
export function consentScopeItemsUnder(
  items: readonly ConsentScopeItem[],
  pathStack: readonly string[],
): ConsentScopeItem[] {
  return items.filter((item) => startsWith(fullPath(item), pathStack));
}
