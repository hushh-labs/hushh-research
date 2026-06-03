"use strict";

/**
 * Neutral User-Agent string returned when the input is missing, null,
 * undefined, empty, or not a string.
 *
 * Structurally valid, contains zero fingerprinting signal.
 */
const GENERIC_UA = "Mozilla/5.0 (compatible; Generic Browser)";

/**
 * Three-pass masking strategy (applied in order):
 *
 *  Pass 1 — 4-segment versions  X.Y.Z.W  →  X.0
 *            Targets precise build IDs such as Chrome/121.0.6167.85
 *            and Edg/121.0.2277.128.
 *
 *  Pass 2 — 3-segment versions  X.Y.Z    →  X.0
 *            Catches OPR/105.0.4970 and similar 3-part tokens after
 *            Pass 1 has already handled the 4-part ones.
 *
 *  Pass 3 — Known variable 2-segment browser names  X.Y  →  X.0
 *            Normalises Firefox/123.5, FxiOS/28.2, CriOS/109.0 etc.
 *            Deliberately excludes static constant tokens such as
 *            AppleWebKit/537.36, Gecko/20100101, and Safari/537.36
 *            — those carry no per-user entropy and are left unchanged.
 */
const _PASS1 = /\/(\d+)\.\d+\.\d+\.\d+/g;         // 4-segment  → X.0
const _PASS2 = /\/(\d+)\.\d+\.\d+/g;               // 3-segment  → X.0
const _PASS3 =
  /\b(Chrome|Firefox|Edg|Edge|OPR|Opera|FxiOS|CriOS|SamsungBrowser|YaBrowser)\/(\d+)\.\d+\b/g;

/**
 * maskUserAgent(userAgentString)
 *
 * Converts a granular, version-specific User-Agent string into a generic,
 * high-level browser identifier to protect clients against browser
 * fingerprinting.
 *
 * Masking rules:
 *   - 4-part versions  (X.Y.Z.W)  stripped to  X.0
 *   - 3-part versions  (X.Y.Z)    stripped to  X.0
 *   - Known browser 2-part versions  (X.Y)  normalised to  X.0
 *   - Static constant tokens (AppleWebKit/537.36, Gecko/20100101,
 *     Safari/537.36) are left exactly as they are.
 *
 * Safe-fallback: null / undefined / non-string / empty → GENERIC_UA
 *
 * @param  {string} userAgentString
 * @returns {string}  masked UA string
 */
function maskUserAgent(userAgentString) {
  if (
    userAgentString === null ||
    userAgentString === undefined ||
    typeof userAgentString !== "string" ||
    userAgentString.trim() === ""
  ) {
    return GENERIC_UA;
  }

  // Reset regex lastIndex state (global flag safety)
  _PASS1.lastIndex = 0;
  _PASS2.lastIndex = 0;
  _PASS3.lastIndex = 0;

  return userAgentString
    .trim()
    .replace(_PASS1, "/$1.0")
    .replace(_PASS2, "/$1.0")
    .replace(_PASS3, "$1/$2.0");
}

module.exports = { maskUserAgent, GENERIC_UA };
