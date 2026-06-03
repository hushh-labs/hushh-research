"use strict";

const crypto = require("node:crypto");

/**
 * hashConfigStructure(configObject)
 *
 * Generates a deterministic SHA-256 hex fingerprint of a config object by
 * normalising top-level key order before hashing.  Two objects with
 * identical key-value pairs but different insertion orders will always
 * produce the same hash, making this safe for cache invalidation, change
 * detection, and consent-state versioning.
 *
 * Normalisation:
 *   1. Top-level keys are sorted alphabetically (A-Z, case-sensitive).
 *   2. A canonical JSON string is produced from the sorted shape.
 *   3. SHA-256 is applied to the UTF-8 bytes of that string.
 *
 * Note: only the TOP-LEVEL key order is normalised.  Nested object
 * key order is preserved as-is.  If deeper determinism is needed, pass
 * a pre-sorted nested structure.
 *
 * Safe-fallback rules — all return "" without throwing:
 *   - null / undefined input
 *   - non-object input (string, number, boolean, array, function …)
 *   - empty plain object  {}
 *
 * @param  {object} configObject
 * @returns {string}  64-character lowercase hex digest, or "" on invalid input
 */
function hashConfigStructure(configObject) {
  // ── Input validation ───────────────────────────────────────────────────────
  if (
    configObject === null ||
    configObject === undefined ||
    typeof configObject !== "object" ||
    Array.isArray(configObject)
  ) {
    return "";
  }

  // Empty plain object has no structure to fingerprint
  if (Object.keys(configObject).length === 0) {
    return "";
  }

  // ── Normalise key order and serialise ──────────────────────────────────────
  const sortedKeys = Object.keys(configObject).sort();
  const canonical = {};
  for (const key of sortedKeys) {
    canonical[key] = configObject[key];
  }

  const serialised = JSON.stringify(canonical);

  // ── Hash ───────────────────────────────────────────────────────────────────
  return crypto.createHash("sha256").update(serialised, "utf8").digest("hex");
}

module.exports = { hashConfigStructure };
