/**
 * Fuzzy-match a spoken name against a list of candidates (active shares,
 * pending requests, connections, ...), the shared decision behind every
 * "do X to the person named Y" voice action in Location.
 *
 * Substring match, never exact: a person says "Sarah", not "Sarah Chen".
 * Two or more matches is deliberately never picked between -- "which Sarah?"
 * is only answerable if the person hears both names, and guessing wrong on
 * an already-live share or a pending decision is not always recoverable.
 */
export type SpokenNameMatch<T> =
  | { kind: "none" }
  | { kind: "one"; match: T }
  | { kind: "many"; matches: T[] };

export function resolveBySpokenName<T>(
  candidates: readonly T[],
  spokenName: string,
  displayName: (item: T) => string | null | undefined,
): SpokenNameMatch<T> {
  const spoken = spokenName.trim().toLowerCase();
  if (!spoken) return { kind: "none" };
  const matches = candidates.filter((item) =>
    (displayName(item) || "").toLowerCase().includes(spoken),
  );
  if (matches.length === 0) return { kind: "none" };
  if (matches.length === 1) return { kind: "one", match: matches[0]! };
  return { kind: "many", matches };
}

/** Bounded, comma-joined names for a "which one did you mean?" summary. */
export function ambiguousMatchNames<T>(
  matches: readonly T[],
  displayName: (item: T) => string | null | undefined,
  limit = 4,
): string {
  return matches
    .slice(0, limit)
    .map((item) => (displayName(item) || "").trim())
    .filter(Boolean)
    .join(", ");
}
