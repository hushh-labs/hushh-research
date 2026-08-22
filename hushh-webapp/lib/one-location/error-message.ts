/**
 * Turning an API failure into a sentence a person may read.
 *
 * Lifted verbatim out of `app/one/location/page.tsx`, where it lived as three
 * file-local functions, because Connect now owns the Circle screens and needs
 * the same judgement. Copying it there instead would have made a second copy of
 * a rule about what may cross the vault boundary -- and this repository already
 * records what that costs: `config/protected-behaviors.json` notes a people
 * search that "WAS a bare `includes(query)` filter, duplicated at six call
 * sites", and a Devanagari failure that shipped green past thirteen unit tests
 * because only some of the copies were fixed.
 *
 * One rule, one place, two callers.
 */

/**
 * Consumer UI must never surface raw backend or database internals such as SQL
 * text, driver errors, stack traces, encrypted key blobs, or table and column
 * identifiers. Those belong in logs and developer tooling only. We only let
 * short, human-readable messages through; anything that looks like an internal
 * dump is replaced with a friendly summary. This keeps the vault and PKM data
 * boundary intact and stops raw driver errors from reaching users.
 */
export const ONE_LOCATION_UNSAFE_ERROR_MARKERS = [
  "psycopg2",
  "sqlalchemy",
  "sql:",
  "select ",
  "insert into",
  "update ",
  "delete from",
  "relation ",
  "column ",
  "constraint",
  "traceback",
  "jsonb",
  "public_key",
  "encrypted_",
  "jwk",
  "background on this error",
  "undefinedcolumn",
];

/** A gateway hiccup rather than a refusal: worth retrying, not worth explaining. */
export function isTransientOneApiError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const status = (error as { status?: unknown }).status;
  return status === 502 || status === 503 || status === 504;
}

export function isSafeUserFacingMessage(message: string): boolean {
  const trimmed = message.trim();
  if (!trimmed) return false;
  // Long strings or multi-line payloads are almost always internal dumps.
  if (trimmed.length > 160) return false;
  if (/[\n\r]/.test(trimmed)) return false;
  const lower = trimmed.toLowerCase();
  return !ONE_LOCATION_UNSAFE_ERROR_MARKERS.some((marker) =>
    lower.includes(marker),
  );
}

export function oneLocationErrorMessage(
  error: unknown,
  fallback: string,
): string {
  if (isTransientOneApiError(error)) {
    return "One is still catching up. Please refresh once, then check this page before retrying.";
  }
  const raw = error instanceof Error ? error.message : "";
  return isSafeUserFacingMessage(raw) ? raw : fallback;
}
