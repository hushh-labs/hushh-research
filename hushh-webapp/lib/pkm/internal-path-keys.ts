/**
 * Which stored keys are plumbing, and must never become shareable information.
 *
 * The TypeScript half of `contracts/pkm/internal-path-keys.v1.json`. The Python
 * half is `consent-protocol/hushh_mcp/consent/internal_path_keys.py`, and the
 * contract exists because two implementations that must agree will otherwise
 * drift -- the same reason `segment-humanization.v1.json` exists.
 *
 * Read side versus write side, and why both need this
 * --------------------------------------------------
 * Filtering the catalogue stops a person being OFFERED their own onboarding
 * checkpoints. It does not stop those checkpoints being written into the
 * personal knowledge model in the first place, and a store that holds them is
 * already wrong even if nothing renders them: the PKM's whole claim is that it
 * holds what is true about someone. Whether a wizard finished is true about the
 * app.
 *
 * So this runs at the manifest walk, where a stored key first becomes a
 * declared, requestable path.
 *
 * Deliberately dependency-free and NOT a client module, so both `lib/consent`
 * and the manifest builder can import it without inheriting `"use client"` or
 * the memory-card graph. Same precedent as `humanize-segment.ts`.
 */

import contract from "@/contracts/pkm/internal-path-keys.v1.json";

const INTERNAL_KEYS: ReadonlySet<string> = new Set(
  (contract.internal_keys as string[]).map((key) => key.trim().toLowerCase()),
);

const INTERNAL_BRANCHES: ReadonlySet<string> = new Set(
  (contract.internal_branches as string[]).map((key) =>
    key.trim().toLowerCase(),
  ),
);

const INTERNAL_SUFFIXES: readonly string[] = (
  contract.internal_key_suffixes as string[]
).map((key) => key.trim().toLowerCase());

/** Mirrors SECRET_KEY_PATTERN in pkm-memory-cards.ts and the Python twin. */
const SECRET_KEY_PATTERN =
  /(?:^|[_-])(secret|secrets|password|passphrase|token|api[_-]?key|private[_-]?key|encryption[_-]?key|recovery[_-]?key|vault[_-]?key|credential|credentials|authorization|mnemonic)(?:$|[_-])/i;

/** The one `_id` that names a person rather than a record. */
const PERSONAL_ID_KEYS: ReadonlySet<string> = new Set(["student_id"]);

/** True when one path segment is plumbing rather than a person's record. */
export function isInternalPathSegment(segment: string): boolean {
  const raw = String(segment ?? "").trim();
  // Checked on the RAW segment: normalisation strips underscores, so the very
  // step meant to clean a key would unmask a deliberately private one.
  if (raw.startsWith("_")) return true;

  const normalized = raw.toLowerCase();
  if (!normalized) return true;
  if (INTERNAL_KEYS.has(normalized) || INTERNAL_BRANCHES.has(normalized))
    return true;
  if (SECRET_KEY_PATTERN.test(normalized)) return true;
  if (normalized.endsWith("_id") && !PERSONAL_ID_KEYS.has(normalized))
    return true;
  if (normalized.includes("cipher") || normalized.includes("token"))
    return true;
  return INTERNAL_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

/**
 * True when ANY segment of a dotted path is plumbing.
 *
 * Any segment, at any depth. That is the correction: the catalogue filter this
 * pairs with only ever read the first segment, so nesting a structural key one
 * level down was enough to publish it.
 */
export function isInternalManifestPath(path: string): boolean {
  const segments = String(path ?? "")
    .split(".")
    .map((segment) => segment.trim().toLowerCase());
  return segments.some((segment, index) => {
    if (contract.schema_collection_segments.includes(segment)) {
      return (
        index === 0 ||
        (segment === "_entities" &&
          (index === segments.length - 1 || segments[index - 1] !== "entities"))
      );
    }
    return isInternalPathSegment(segment);
  });
}

const SECRET_WORDS: ReadonlySet<string> = new Set([
  "authorization", "cipher", "credential", "mnemonic", "passphrase", "password", "secret", "token",
]);
const SECRET_KEY_QUALIFIERS: ReadonlySet<string> = new Set([
  "access", "api", "encryption", "private", "recovery", "vault",
]);

/**
 * True when one key reads as credential material. The TypeScript half of
 * `is_secret_shaped_key` in `internal_path_keys.py`: word-based and
 * plural-tolerant, so `passwords` and `api keys` are caught where the anchored
 * pattern above misses them. Used by the field-level sensitivity rule.
 */
export function isSecretShapedKey(segment: string): boolean {
  const normalized = String(segment ?? "").trim().toLowerCase();
  if (!normalized) return false;
  if (SECRET_KEY_PATTERN.test(normalized)) return true;
  const words = normalized.split(/[^a-z0-9]+/).filter(Boolean);
  const singular = words.map((word) => word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word);
  if (singular.some((word) => SECRET_WORDS.has(word))) return true;
  if (normalized.includes("cipher") || normalized.includes("token")) return true;
  return singular.some((word, index) => index > 0 && word === "key" && SECRET_KEY_QUALIFIERS.has(singular[index - 1]!));
}
