"use strict";

/**
 * Canonical key variants to search for the Global Privacy Control header.
 * The HTTP spec is case-insensitive for header names; both common casings are
 * listed here to cover raw Node.js IncomingMessage headers (always lowercased)
 * and hand-constructed objects (mixed case).
 */
const GPC_HEADER_KEYS = ["sec-gpc", "Sec-GPC"];

/**
 * parseGpcHeader(headersObject)
 *
 * Inspects an HTTP headers object for the Global Privacy Control (GPC) signal
 * as defined by the W3C GPC specification (https://globalprivacycontrol.github.io/gpc-spec/).
 *
 * A GPC opt-out is signalled when the `Sec-GPC` header is present and its
 * value is exactly `"1"` (string) or `1` (number).  All other values — `"0"`,
 * `0`, empty string, `null`, `undefined`, or any non-numeric string — are
 * treated as "no opt-out" and return `false`.
 *
 * Lookup is case-insensitive: both `"sec-gpc"` (Node.js HTTP parser canonical
 * form) and `"Sec-GPC"` (title-case, common in hand-built header maps) are
 * checked.  If both keys happen to be present the first truthy match wins.
 *
 * This function is intentionally defensive:
 *   - A non-object `headersObject` (null, undefined, string, array …) returns
 *     `false` without throwing.
 *   - Property resolution never uses dynamic paths that could trigger
 *     prototype-pollution or unhandled runtime exceptions.
 *
 * @param  {object|null|undefined} headersObject  HTTP headers map
 * @returns {boolean}  `true` when GPC opt-out is active, `false` otherwise
 */
function parseGpcHeader(headersObject) {
  // Guard: reject anything that is not a plain, non-null, non-array object.
  if (
    headersObject === null ||
    headersObject === undefined ||
    typeof headersObject !== "object" ||
    Array.isArray(headersObject)
  ) {
    return false;
  }

  // Perform a case-insensitive scan over GPC_HEADER_KEYS first so that we
  // honour the exact key spellings authored in the caller's map, then fall
  // back to a full lowercase scan across all keys to cover any unusual casing
  // (e.g. "SEC-GPC", "Sec-Gpc").
  let rawValue;

  // Pass 1 — check the two canonical spellings directly.
  for (const key of GPC_HEADER_KEYS) {
    if (Object.prototype.hasOwnProperty.call(headersObject, key)) {
      rawValue = headersObject[key];
      break;
    }
  }

  // Pass 2 — full case-insensitive scan as a safety net.
  if (rawValue === undefined) {
    const lowerTarget = "sec-gpc";
    for (const key of Object.keys(headersObject)) {
      if (key.toLowerCase() === lowerTarget) {
        rawValue = headersObject[key];
        break;
      }
    }
  }

  // No GPC header found → not an opt-out.
  if (rawValue === undefined) return false;

  // Null / undefined value → treat as absent.
  if (rawValue === null || rawValue === undefined) return false;

  // Accept string "1" or numeric 1 as the opt-out signal.
  return rawValue === "1" || rawValue === 1;
}

module.exports = { parseGpcHeader };
