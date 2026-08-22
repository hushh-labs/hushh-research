/**
 * Deterministically resolve one or more spoken names from a single voice
 * utterance against a list of candidates -- the shared decision behind every
 * "do X to the person(s) named Y" voice action across Location and Circles.
 *
 * Names are split out of the RAW utterance ("," / "&" / ";" / the word
 * "and") BEFORE any normalization, because normalizeSpokenName() strips
 * exactly those characters -- splitting after normalizing would destroy the
 * delimiters this needs. Each resulting name is then matched independently,
 * first by substring, then -- only when substring finds nothing -- by a
 * bounded fuzzy fallback for the kind of one- or two-letter slip speech
 * transcription actually makes ("Nilesh" heard for "Neelesh"). Fuzzy never
 * runs when substring already matched something, so it can only turn a
 * "not found" into a match; it never second-guesses or widens a match that
 * already succeeded.
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

/**
 * Levenshtein edit distance: the fewest single-character insertions,
 * deletions, or substitutions to turn `a` into `b`. Pure string distance,
 * with no idea what a "name" is -- the safety guard lives in
 * `isFuzzyMatch`'s threshold, not here.
 */
function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let previousRow = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const currentRow = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
      currentRow.push(
        Math.min(
          currentRow[j - 1]! + 1, // insertion
          previousRow[j]! + 1, // deletion
          previousRow[j - 1]! + substitutionCost, // substitution
        ),
      );
    }
    previousRow = currentRow;
  }
  return previousRow[b.length]!;
}

/**
 * How many character edits a word may be off by and still count as a fuzzy
 * match, scaled to its length. Under 4 letters is never fuzzy-matched at
 * all: a one-edit slip on "Al" or "Amy" reaches too many unrelated short
 * names to be safe here, where a wrong match means a location shared with,
 * or a request sent to, the wrong person. Longer names get a little more
 * room, since a mis-heard syllable ("Nilesh" for "Neelesh", "Ankeet" for
 * "Ankit") is a couple of letters, not a fraction of the word.
 */
function fuzzyMatchThreshold(wordLength: number): number {
  if (wordLength < 4) return 0;
  if (wordLength <= 5) return 1;
  return 2;
}

/**
 * True when `target` is a close spoken variant of `candidateWord` -- judged
 * by the LONGER side's length, not the shorter. An insertion/deletion pair
 * like "Ankit" (5) vs "Ankeet" (6) already spends one edit purely on the
 * length gap; judging it by the shorter word's threshold would refuse a
 * mishearing that adds or drops a single letter on top of a real edit.
 */
function isFuzzyMatch(target: string, candidateWord: string): boolean {
  const threshold = fuzzyMatchThreshold(
    Math.max(target.length, candidateWord.length),
  );
  if (threshold === 0) return false;
  return levenshteinDistance(target, candidateWord) <= threshold;
}

/** A spoken name that did NOT resolve to exactly one candidate. A name that
 * resolved cleanly is not represented here -- it goes straight into
 * `MultiNameResolution.resolved` instead. */
export type UnresolvedPersonName<T> =
  | { spokenText: string; kind: "ambiguous"; matches: T[] }
  | { spokenText: string; kind: "not_found" };

export type MultiNameResolution<T> = {
  /** Every candidate that matched exactly one name unambiguously. */
  resolved: T[];
  /** Every spoken name that did not resolve cleanly, in the order spoken. */
  unresolved: UnresolvedPersonName<T>[];
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
  const unresolved: UnresolvedPersonName<T>[] = [];
  for (const spokenText of splitSpokenNames(raw)) {
    const target = normalizeSpokenName(spokenText);
    if (!target) continue;
    let matches = candidates.filter((item) =>
      normalizeSpokenName(String(searchText(item) || "")).includes(target),
    );
    if (matches.length === 0) {
      matches = candidates.filter((item) => {
        const normalized = normalizeSpokenName(String(searchText(item) || ""));
        return (
          isFuzzyMatch(target, normalized) ||
          normalized.split(" ").some((word) => isFuzzyMatch(target, word))
        );
      });
    }
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

/** Join names the way a person would say them out loud: "Alice", "Alice and
 * Bob", "Alice, Bob and Sarah" -- never an Oxford comma before "and", since
 * this is read as speech, not written prose. */
export function joinNamesForSpeech(names: readonly string[]): string {
  const clean = names.map((name) => name.trim()).filter(Boolean);
  if (clean.length <= 1) return clean[0] ?? "";
  if (clean.length === 2) return `${clean[0]} and ${clean[1]}`;
  return `${clean.slice(0, -1).join(", ")} and ${clean[clean.length - 1]}`;
}
