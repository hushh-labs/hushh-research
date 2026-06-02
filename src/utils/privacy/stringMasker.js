"use strict";

const EMAIL_RE   = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NUMERIC_RE = /^\+?[\d\s\-().]{4,}$/;

function maskEmailLocal(local) {
  if (local.length <= 2) return `${local[0]}***`;
  return `${local[0]}***${local[local.length - 1]}`;
}

/**
 * maskUserIdentifier(input)
 *
 * Returns a consent-minimised representation of an email address or phone
 * number, following the same data-minimisation pattern used by
 * maskPhoneNumber in hushh-webapp/lib/services/phone-mandate-service.ts.
 *
 *   Email  → "abdulgaffar@hushh.ai"  →  "a***r@hushh.ai"
 *            "ab@hushh.ai"           →  "a***@hushh.ai"
 *   Phone  → "1234567890"            →  "******7890" (all but last 4)
 *   Invalid / non-string             →  ""  (never throws)
 */
function maskUserIdentifier(input) {
  if (typeof input !== "string") return "";

  const trimmed = input.trim();
  if (!trimmed) return "";

  if (EMAIL_RE.test(trimmed)) {
    const at     = trimmed.indexOf("@");
    const local  = trimmed.slice(0, at);
    const domain = trimmed.slice(at);
    return maskEmailLocal(local) + domain;
  }

  if (NUMERIC_RE.test(trimmed)) {
    const digits = trimmed.replace(/\D/g, "");
    if (digits.length <= 4) return "*".repeat(digits.length);
    return "*".repeat(digits.length - 4) + digits.slice(-4);
  }

  return "*".repeat(trimmed.length);
}

module.exports = { maskUserIdentifier };
