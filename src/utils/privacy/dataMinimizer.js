"use strict";

/**
 * minimizePayload(payloadObject, allowedKeysArray)
 *
 * Enforces data-minimization protocol: returns a shallow copy of
 * payloadObject that contains ONLY the keys listed in allowedKeysArray.
 * Any key not in the allowlist is silently dropped from the output.
 *
 * This is the canonical data-minimization boundary before any consent
 * payload, session object, or API response leaves the service layer.
 *
 * Safe-fallback rules — all return {} without throwing:
 *   - payloadObject is null / undefined / not a plain object
 *   - allowedKeysArray is null / undefined / not an array / empty array
 *   - allowedKeysArray contains non-string entries (they are skipped)
 *
 * @param  {object}   payloadObject    — source object to be filtered
 * @param  {string[]} allowedKeysArray — whitelist of permitted keys
 * @returns {object}                   — minimized shallow copy
 */
function minimizePayload(payloadObject, allowedKeysArray) {
  // Guard: payloadObject must be a plain, non-null, non-array object
  if (
    payloadObject === null ||
    payloadObject === undefined ||
    typeof payloadObject !== "object" ||
    Array.isArray(payloadObject)
  ) {
    return {};
  }

  // Guard: allowedKeysArray must be a non-empty array
  if (
    !Array.isArray(allowedKeysArray) ||
    allowedKeysArray.length === 0
  ) {
    return {};
  }

  const result = {};
  for (const key of allowedKeysArray) {
    // Skip non-string entries in the whitelist
    if (typeof key !== "string") continue;

    if (Object.prototype.hasOwnProperty.call(payloadObject, key)) {
      result[key] = payloadObject[key];
    }
  }
  return result;
}

module.exports = { minimizePayload };
