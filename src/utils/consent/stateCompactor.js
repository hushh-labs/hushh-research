"use strict";

/**
 * Bit-position assignments for the three consent flag keys.
 *
 *   functional  → bit 2  (value 4)
 *   analytics   → bit 1  (value 2)
 *   marketing   → bit 0  (value 1)
 *
 * This ordering puts the highest-sensitivity flag in the most-significant
 * position, making the bitmask human-readable at a glance:
 *
 *   7  (111)  all granted
 *   5  (101)  functional + marketing, no analytics
 *   0  (000)  all denied  (maximum-security fallback)
 */
const BIT = Object.freeze({
  functional: 4,   // bit 2
  analytics:  2,   // bit 1
  marketing:  1,   // bit 0
});

/**
 * compactConsentFlags(flagsObject)
 *
 * Compresses a consent preference object into a single 3-bit integer for
 * efficient state transfers and compact storage.
 *
 * Bit layout:
 *   bit 2 (4) — functional
 *   bit 1 (2) — analytics
 *   bit 0 (1) — marketing
 *
 * Mapping examples:
 *   { functional: true,  analytics: true,  marketing: true  }  →  7  (0b111)
 *   { functional: true,  analytics: false, marketing: true  }  →  5  (0b101)
 *   { functional: false, analytics: true,  marketing: false }  →  2  (0b010)
 *   { functional: false, analytics: false, marketing: false }  →  0  (0b000)
 *
 * Safe-fallback rules:
 *   - null / undefined / non-plain-object input  →  0 (maximum-restriction posture)
 *   - missing key                                →  0 for that bit
 *   - non-boolean truthy/falsy value             →  treated as Boolean(value)
 *
 * @param  {object|*} flagsObject
 * @returns {number}  Integer in the range [0, 7]
 */
function compactConsentFlags(flagsObject) {
  if (
    flagsObject === null ||
    flagsObject === undefined ||
    typeof flagsObject !== "object" ||
    Array.isArray(flagsObject)
  ) {
    return 0;
  }

  let result = 0;
  for (const [key, bit] of Object.entries(BIT)) {
    if (flagsObject[key]) {
      result |= bit;
    }
  }
  return result;
}

module.exports = { compactConsentFlags, BIT };
