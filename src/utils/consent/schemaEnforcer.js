"use strict";

/**
 * enforceSchemaVersion(payloadObject, supportedVersionsArray)
 *
 * Validates that an incoming consent or configuration payload declares a
 * schema version that the current runtime explicitly supports.
 *
 * Strict default-deny posture:
 *   Any ambiguous, malformed, or absent input returns false so that
 *   unrecognised payloads are never silently processed.
 *
 * Decision rules:
 *   Returns TRUE only when ALL of the following hold:
 *     1. payloadObject is a non-null, non-array plain object
 *     2. supportedVersionsArray is a non-empty array
 *     3. payloadObject.version is a non-empty string
 *     4. payloadObject.version is exactly present in supportedVersionsArray
 *        (strict string equality — no coercion, no prefix matching)
 *
 *   Returns FALSE for:
 *     - null / undefined payloadObject or supportedVersionsArray
 *     - non-object payloadObject (string, number, boolean, array)
 *     - missing, null, or non-string version property
 *     - empty-string version
 *     - version not contained in supportedVersionsArray
 *     - empty supportedVersionsArray
 *
 * @param  {object}   payloadObject          — consent or config payload
 * @param  {string[]} supportedVersionsArray — allowlist of accepted version strings
 * @returns {boolean}
 */
function enforceSchemaVersion(payloadObject, supportedVersionsArray) {
  // ── Validate supportedVersionsArray ───────────────────────────────────────
  if (
    !Array.isArray(supportedVersionsArray) ||
    supportedVersionsArray.length === 0
  ) {
    return false;
  }

  // ── Validate payloadObject ────────────────────────────────────────────────
  if (
    payloadObject === null ||
    payloadObject === undefined ||
    typeof payloadObject !== "object" ||
    Array.isArray(payloadObject)
  ) {
    return false;
  }

  // ── Extract and validate version ──────────────────────────────────────────
  const version = payloadObject.version;

  if (typeof version !== "string" || version.trim() === "") {
    return false;
  }

  // ── Strict membership check ───────────────────────────────────────────────
  return supportedVersionsArray.includes(version);
}

module.exports = { enforceSchemaVersion };
