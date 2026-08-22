/**
 * Deterministically resolve one or more spoken names from a single voice
 * utterance against a list of candidates -- the shared decision behind every
 * "do X to the person(s) named Y" voice action across Location and Circles.
 *
 * Names are split out of the RAW utterance ("," / "&" / ";" / the word
 * "and") BEFORE any normalization, because normalizeSpokenName() strips
 * exactly those characters -- splitting after normalizing would destroy the
 * delimiters this needs. Each resulting name is then matched independently,
 * by substring, never exact: a person says "Sarah", not "Sarah Chen".
 *
 * A person can name several people in one turn ("share with Alice and
 * Bob"), and each name resolves on its own: some may match cleanly, one may
 * be ambiguous, another may not be found -- all in the same call, so the
 * caller can apply everything that resolved and report the rest back in one
 * turn instead of failing the whole request over one bad name.
 */

/** Normalize a spoken or stored name: no case, no accents, no punctuation. */
export function normalizeSpokenName(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    // Punctuation out so "Mum & Dad" and "Mum and Dad" are not two different
    // circles to a speaker. Unicode classes, not [a-z0-9]: a circle named in
    // Hindi or Arabic must stay matchable rather than normalizing to nothing.
    // \p{M} is load-bearing -- Devanagari vowel signs are marks, not letters,
    // so without it "परिवार" shreds into "पर व र" and never matches itself.
    .replace(/[^\p{L}\p{N}\p{M}\s]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

// Matches ",", "&", ";", or the standalone word "and" (case-insensitive,
// word-bounded so it never fires inside a name like "Anderson"). Applied to
// the RAW utterance, before normalizeSpokenName would erase all of these.
const NAME_DELIMITER_PATTERN = /\s*(?:,|&|;|\band\b)\s*/giu;

/** Split one spoken utterance into candidate names. A single name with no
 * delimiter returns a 1-element array, so every existing single-name call
 * site is a strict subset of this behavior. */
export function splitSpokenNames(raw: string): string[] {
  return raw
    .split(NAME_DELIMITER_PATTERN)
    .map((part) => part.trim())
    .filter(Boolean);
}

export type PersonResolution<T> =
  | { spokenText: string; kind: "resolved"; match: T }
  | { spokenText: string; kind: "ambiguous"; matches: T[] }
  | { spokenText: string; kind: "not_found" };

export type MultiNameResolution<T> = {
  /** Every candidate that matched exactly one name unambiguously. */
  resolved: T[];
  /** Every spoken name that did not resolve cleanly, in the order spoken. */
  unresolved: PersonResolution<T>[];
};

export function resolveSpokenNames<T>(
  candidates: readonly T[],
  raw: string,
  displayName: (item: T) => string | null | undefined,
  /**
   * What each spoken name is actually matched against, when it differs from
   * the clean display name -- e.g. connections search across name + masked
   * phone, but only the name belongs in a spoken disambiguation prompt.
   * Defaults to `displayName` so most callers only ever pass one function.
   */
  searchText: (item: T) => string | null | undefined = displayName,
): MultiNameResolution<T> {
  const resolved: T[] = [];
  const unresolved: PersonResolution<T>[] = [];
  for (const spokenText of splitSpokenNames(raw)) {
    const target = normalizeSpokenName(spokenText);
    if (!target) continue;
    const matches = candidates.filter((item) =>
      normalizeSpokenName(String(searchText(item) || "")).includes(target),
    );
    if (matches.length === 0) {
      unresolved.push({ spokenText, kind: "not_found" });
    } else if (matches.length === 1) {
      resolved.push(matches[0]!);
    } else {
      unresolved.push({ spokenText, kind: "ambiguous", matches });
    }
  }
  return { resolved, unresolved };
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
