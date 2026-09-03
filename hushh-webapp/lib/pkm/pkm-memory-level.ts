"use client";

import {
  buildPkmMemoryCardsFromNode,
  shouldSkipPkmMemoryKey,
  type PkmMemoryCard,
  type PkmPathSegment,
} from "@/lib/pkm/pkm-memory-cards";

/**
 * One immediate child of the current Memory level.
 *
 * A `group` is an object/array that still has readable memories beneath it and
 * is rendered as an iOS-style navigation row with a chevron and a count. A
 * `leaf` is a single readable value rendered as title + value; its `card`
 * carries the exact PKM path so edit / forget reuse the existing coordinator.
 */
export type PkmMemoryLevelGroup = {
  kind: "group";
  key: string;
  segment: PkmPathSegment;
  label: string;
  childCount: number;
};

export type PkmMemoryLevelLeaf = {
  kind: "leaf";
  key: string;
  card: PkmMemoryCard;
};

export type PkmMemoryLevelEntry = PkmMemoryLevelGroup | PkmMemoryLevelLeaf;

export type PkmMemoryLevelView = {
  /** Human labels from the domain down to the current level, e.g. ["Financial","Goals","Retirement"]. */
  crumbs: string[];
  /** Label of the current level (last crumb). */
  title: string;
  /** Label one level up, for the single Back control. "Memory" at the domain root. */
  parentLabel: string;
  entries: PkmMemoryLevelEntry[];
  /** The current path no longer resolves in the decrypted data (it changed under us). */
  notFound: boolean;
};

// Defensive guard for the recursive descendant count only. Traversal depth is
// unbounded by design; this stops a pathologically large blob from stalling a
// render.
const MAX_COUNT_NODE_VISITS = 50_000;

const NAME_KEYS = [
  "name",
  "title",
  "label",
  "display_name",
  "displayName",
  "nickname",
  "headline",
  "summary",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readablePrimitive(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

function clipText(value: string, maxChars: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`;
}

function humanize(segment: string): string {
  return segment
    .replace(/\[\d+\]/g, " ")
    .replace(/[_-]+/g, " ")
    // A key that runs letters straight into digits reads as a machine name:
    // `last4` titled itself "Last4" on the owner's Memory screen. Split the
    // boundary only when the word is long enough to be a word, so short codes
    // (w2, k1) stay intact.
    .replace(/([a-z]{3,})(\d+)/gi, "$1 $2")
    .replace(/\b\w/g, (match) => match.toUpperCase())
    .trim();
}

function humanizeSingular(segment: PkmPathSegment | null): string {
  if (segment === null || typeof segment === "number") return "Item";
  return humanize(segment).replace(/s$/i, "") || "Item";
}

/** An object key that is an opaque identifier rather than a readable name. */
function looksLikeOpaqueId(segment: string): boolean {
  return (
    /^(mem|ent|entity|item|entry|rec|record|obj|node|evt|event)[_-][a-z0-9][a-z0-9_-]{2,}$/i.test(
      segment,
    ) ||
    // Any `<prefix>_<uuid>` segment, whatever the prefix. The list above is a
    // guess at which prefixes a domain would choose, and it guessed wrong for
    // the wallet's `card_<uuid>` segments: they fell through to humanize() and
    // titled a saved card "Card 94d850a3 A02c 414c 9813 A48e64b0fa53" on the
    // owner's Memory screen. A uuid is opaque no matter what precedes it.
    /^[a-z][a-z0-9]*[_-][0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      segment,
    ) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i.test(segment) ||
    /^[0-9a-f]{16,}$/i.test(segment)
  );
}

function namedLabel(value: unknown): string | null {
  if (isRecord(value)) {
    for (const key of NAME_KEYS) {
      const candidate = value[key];
      if (typeof candidate === "string" && candidate.trim()) {
        return clipText(candidate, 60);
      }
    }
    return null;
  }
  const primitive = readablePrimitive(value);
  return primitive ? clipText(primitive, 60) : null;
}

/**
 * Readable label for one child, given its own segment, its value, and the
 * segment of its parent. Array items and entity-map entries are named from a
 * `name` / `title` / `label` field when present and never from a raw index or
 * an internal identifier.
 */
function childLabel(
  segment: PkmPathSegment,
  value: unknown,
  parentSegment: PkmPathSegment | null,
): string {
  const parentIsEntityMap =
    typeof parentSegment === "string" &&
    (parentSegment.toLowerCase() === "entities" || parentSegment.toLowerCase() === "_items");

  if (typeof segment === "number") {
    return (
      namedLabel(value) ?? `${humanizeSingular(parentSegment)} ${segment + 1}`
    );
  }

  if (parentIsEntityMap || looksLikeOpaqueId(segment)) {
    return namedLabel(value) ?? "Saved item";
  }

  const normalized = segment.toLowerCase();
  if (normalized === "entities" || normalized === "_items") return "Saved items";
  return humanize(segment);
}

function countLeafMemories(node: unknown, budget: { remaining: number }): number {
  if (budget.remaining <= 0) return 0;
  budget.remaining -= 1;
  if (readablePrimitive(node) !== null) return 1;
  if (Array.isArray(node)) {
    let total = 0;
    for (const item of node) {
      total += countLeafMemories(item, budget);
      if (budget.remaining <= 0) break;
    }
    return total;
  }
  if (isRecord(node)) {
    let total = 0;
    for (const [key, value] of Object.entries(node)) {
      if (shouldSkipPkmMemoryKey(key)) continue;
      total += countLeafMemories(value, budget);
      if (budget.remaining <= 0) break;
    }
    return total;
  }
  return 0;
}

function walkTo(
  data: Record<string, unknown>,
  pathStack: readonly PkmPathSegment[],
): { node: unknown; crumbLabels: string[]; missing: boolean } {
  let node: unknown = data;
  let parentSegment: PkmPathSegment | null = null;
  const crumbLabels: string[] = [];
  for (const segment of pathStack) {
    const container = node;
    let child: unknown;
    if (typeof segment === "number") {
      child = Array.isArray(container) ? container[segment] : undefined;
    } else {
      child = isRecord(container) ? container[segment] : undefined;
    }
    if (child === undefined) {
      return { node: undefined, crumbLabels, missing: true };
    }
    crumbLabels.push(childLabel(segment, child, parentSegment));
    parentSegment = segment;
    node = child;
  }
  return { node, crumbLabels, missing: false };
}

/**
 * Resolve exactly one level of nested Memory: the crumbs down to `pathStack`
 * and the immediate children at that position. Never descends past the current
 * level, never emits an empty group, and never surfaces reserved / internal
 * keys (delegated to `shouldSkipPkmMemoryKey`).
 */
export function resolvePkmMemoryLevel(params: {
  domainKey: string;
  domainTitle: string;
  data: Record<string, unknown> | null;
  pathStack: readonly PkmPathSegment[];
  sourceLabel?: string;
  updatedAt?: string | null;
}): PkmMemoryLevelView {
  const { domainKey, domainTitle, pathStack } = params;
  const baseView = (over: Partial<PkmMemoryLevelView> = {}): PkmMemoryLevelView => ({
    crumbs: [domainTitle],
    title: domainTitle,
    parentLabel: "Memory",
    entries: [],
    notFound: false,
    ...over,
  });

  if (!isRecord(params.data)) {
    return baseView({ notFound: pathStack.length > 0 });
  }

  const { node, crumbLabels, missing } = walkTo(params.data, pathStack);
  const crumbs = [domainTitle, ...crumbLabels];
  const title = crumbs[crumbs.length - 1] ?? domainTitle;
  const parentLabel = crumbs.length >= 2 ? crumbs[crumbs.length - 2]! : "Memory";

  if (missing) {
    return { crumbs, title, parentLabel, entries: [], notFound: true };
  }

  const parentSegment = pathStack.length > 0 ? pathStack[pathStack.length - 1]! : null;
  const rawChildren: Array<[PkmPathSegment, unknown]> = Array.isArray(node)
    ? node.map((value, index) => [index, value] as [PkmPathSegment, unknown])
    : isRecord(node)
      ? Object.entries(node).filter(([key]) => !shouldSkipPkmMemoryKey(key))
      : [];

  const entries: PkmMemoryLevelEntry[] = [];
  for (const [segment, value] of rawChildren) {
    const childPath: PkmPathSegment[] = [...pathStack, segment];

    if (readablePrimitive(value) !== null) {
      const [card] = buildPkmMemoryCardsFromNode({
        domain: domainKey,
        domainTitle,
        value,
        sourceLabel: params.sourceLabel || "Saved memory",
        updatedAt: params.updatedAt ?? null,
        pathSegments: childPath,
      });
      if (card) entries.push({ kind: "leaf", key: String(segment), card });
      continue;
    }

    const childCount = countLeafMemories(value, { remaining: MAX_COUNT_NODE_VISITS });
    if (childCount === 0) continue;
    entries.push({
      kind: "group",
      key: String(segment),
      segment,
      label: childLabel(segment, value, parentSegment),
      childCount,
    });
  }

  return { crumbs, title, parentLabel, entries, notFound: false };
}

/**
 * Human-readable ancestry for a memory, e.g. `Financial › Goals › Retirement`,
 * used to orient a deep search hit. Drops the leaf segment, array indices, and
 * entity-map identifiers so it never leaks a raw path or internal id.
 */
export function pkmMemoryCardBreadcrumb(card: PkmMemoryCard): string {
  const parts: string[] = [card.domainTitle];
  const ancestry = card.pathSegments.slice(0, -1);
  let skipNext = false;
  for (const segment of ancestry) {
    if (typeof segment === "number") continue;
    const normalized = segment.toLowerCase();
    if (normalized === "entities" || normalized === "_items") {
      skipNext = true;
      continue;
    }
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (shouldSkipPkmMemoryKey(segment)) continue;
    parts.push(humanize(segment));
  }
  return parts.join(" › ");
}
