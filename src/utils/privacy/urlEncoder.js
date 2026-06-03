"use strict";

/**
 * toUrlSafeBase64(inputString)
 *
 * Converts a plain string to a URL-safe Base64 representation following
 * RFC 4648 §5 ("Base 64 Encoding with URL and Filename Safe Alphabet"):
 *
 *   +  →  -
 *   /  →  _
 *   =  →  (stripped — no padding)
 *
 * Used for encoding opaque consent tokens, anonymised identifiers, and
 * session payloads that must survive URL path / query-string transport
 * without percent-encoding.
 *
 * @param  {string} inputString
 * @returns {string}  URL-safe Base64 string, or "" for invalid input
 */
function toUrlSafeBase64(inputString) {
  if (typeof inputString !== "string" || inputString.length === 0) {
    return "";
  }

  return Buffer.from(inputString, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

module.exports = { toUrlSafeBase64 };
