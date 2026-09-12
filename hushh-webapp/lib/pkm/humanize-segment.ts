/**
 * One readable name for one path segment.
 *
 * This is the only place a stored key becomes owner-facing words. It exists
 * because the repo grew twelve independent `humanize`/`titleize` functions, and
 * the same information consequently read differently in Memory, on the profile,
 * and in chat.
 *
 * The rule that matters most is the one this module CANNOT enforce: call it
 * while the original key is still in hand. Scope-path normalization lowercases,
 * deliberately and correctly, because the path is a canonical authorization
 * string. `addressDetails` becomes `addressdetails`, and no function can put
 * that space back afterwards. A previous attempt to recover word boundaries
 * downstream (`splitScopeLabel`, which promoted the last word to a title) was
 * reverted for a good reason: shortening "Employment status" to "status"
 * changes its meaning. Humanize at capture, never at render.
 *
 * Deliberately dependency-free and not a client module, so `lib/consent` can
 * import it without inheriting `"use client"` or the memory-card graph.
 */

/**
 * A readable name for one segment, given the segment as it was originally
 * written.
 *
 * Splits, in order: array indices, `_`/`-` separators, camelCase boundaries,
 * and letter-to-digit runs. Then title-cases.
 */
export function humanizeMemorySegment(segment: string): string {
  return (
    String(segment ?? "")
      .replace(/\[\d+\]/g, " ")
      .replace(/[_-]+/g, " ")
      // An acronym followed by a word: `SSNNumber` -> `SSN Number`. Runs first,
      // because the simple boundary below cannot see it.
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      // The ordinary camelCase boundary: `addressDetails` -> `address Details`.
      // This is the boundary that lowercasing destroys, which is why the caller
      // must pass the raw key rather than a normalized path segment.
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      // A key that runs letters straight into digits reads as a machine name:
      // `last4` titled itself "Last4" on the owner's Memory screen. Split the
      // boundary only when the word is long enough to be a word, so short codes
      // (w2, k1) stay intact.
      .replace(/([a-z]{3,})(\d+)/gi, "$1 $2")
      .replace(/\s+/g, " ")
      .replace(/\b\w/g, (match) => match.toUpperCase())
      .trim()
  );
}

/**
 * A readable name for a dotted path, humanizing each segment.
 *
 * Callers that hold the original segments should pass them joined by `.` so the
 * casing survives; a path that has already been normalized will simply lack the
 * boundaries this cannot recover.
 */
export function humanizeMemoryPath(path: string): string {
  return String(path ?? "")
    .split(".")
    .map((segment) => humanizeMemorySegment(segment))
    .filter(Boolean)
    .join(" ")
    .trim();
}

/** An object key that is an opaque identifier rather than a readable name. */
export function looksLikeOpaqueId(segment: string): boolean {
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
