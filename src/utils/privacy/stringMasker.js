"use strict";

// Matches a well-formed email address: local@domain.tld (no whitespace, single @)
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Matches phone numbers and generic numeric identifiers:
// optional leading +, then at least 4 characters drawn from digits / spaces / dashes / parens / dots
const NUMERIC_RE = /^\+?[\d\s\-().]{4,}$/;

/**
 * Returns a masked form of an email local part.
 *
 * - local.length > 2  →  first char + "***" + last char   ("abdulgaffar" → "a***r")
 * - local.length <= 2 →  first char + "***"               ("ab"          → "a***")
 */
function maskEmailLocal(local) {
  if (local.length <= 2) {
    return `${local[0]}***`;
  }
  return `${local[0]}***${local[local.length - 1]}`;
}

/**
 * maskUserIdentifier(input)
 *
 * Enforces data-minimisation on user identifiers before they reach logs, UI, or
 * API responses.  Returns a masked string according to the following rules:
 *
 *   Email   → mask local part, preserve first/last chars and the full domain
 *             "abdulgaffar@hushh.ai" → "a***r@hushh.ai"
 *             "ab@hushh.ai"          → "a***@hushh.ai"
 *
 *   Phone / numeric identifier → replace all but the trailing 4 digits with "*"
 *             "1234567890"  → "******7890"
 *             "+15551234567" → "*******4567"
 *
 *   Invalid / non-string input → returns "" (never throws)
 */
function maskUserIdentifier(input) {
  if (input == null || typeof input !== "string") {
    return "";
  }

  const trimmed = input.trim();
  if (!trimmed) {
    return "";
  }

  if (EMAIL_RE.test(trimmed)) {
    const atIndex = trimmed.indexOf("@");
    const local = trimmed.slice(0, atIndex);
    const domain = trimmed.slice(atIndex); // "@domain.tld" — preserves the @
    return maskEmailLocal(local) + domain;
  }

  if (NUMERIC_RE.test(trimmed)) {
    const digits = trimmed.replace(/\D/g, "");
    if (digits.length <= 4) {
      return "*".repeat(digits.length);
    }
    return "*".repeat(digits.length - 4) + digits.slice(-4);
  }

  // Unrecognised format — mask the entire value so nothing leaks
  return "*".repeat(trimmed.length);
}

module.exports = { maskUserIdentifier };
