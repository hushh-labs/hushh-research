/**
 * Consent purpose validator — request-boundary allowlist enforcement.
 *
 * Imported directly by the consent approval route handler so that every
 * inbound approval is checked against this allowlist before any backend call
 * fires. Lives in lib/consent/ so unit tests can exercise it in isolation
 * without spinning up the full HTTP stack.
 */

/** Exhaustive list of consent purposes accepted at the approval boundary. */
export const APPROVED_PURPOSES = [
  "essential",
  "analytics",
  "marketing",
  "personalization",
  "research",
] as const;

export type ApprovedPurpose = (typeof APPROVED_PURPOSES)[number];

/**
 * isPurposeValid(purpose, allowedPurposes?)
 *
 * Returns true only when `purpose` is a non-empty string that is an exact
 * member of `allowedPurposes` (defaults to APPROVED_PURPOSES).
 *
 * Every other value — null, undefined, empty string, whitespace-only,
 * unrecognised string, or non-string type — returns false (default-deny).
 * Lookup uses Array.prototype.includes(), which applies SameValueZero
 * equality: "ANALYTICS" does NOT match "analytics".
 */
export function isPurposeValid(
  purpose: unknown,
  allowedPurposes: readonly string[] = APPROVED_PURPOSES,
): boolean {
  if (
    purpose === null ||
    purpose === undefined ||
    typeof purpose !== "string" ||
    purpose.trim() === ""
  ) {
    return false;
  }
  return (allowedPurposes as string[]).includes(purpose);
}
