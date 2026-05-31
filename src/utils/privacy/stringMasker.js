"use strict";

// RFC-5322-lite: local@domain.tld — no whitespace, no second @
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// E.164 / national formats: optional leading +, then digits/spaces/dashes/parens, 7–20 chars total
const PHONE_PATTERN = /^\+?[\d\s\-().]{7,20}$/;

function maskEmailLocal(local) {
  if (local.length === 1) return "*";
  if (local.length === 2) return `${local[0]}*`;
  return `${local[0]}***${local[local.length - 1]}`;
}

/**
 * Returns a masked representation of an email address or phone number to satisfy
 * consent-minimisation requirements (data is identifiable only to the owner).
 *
 * Examples:
 *   "abdulrashid@email.com"  →  "a***d@email.com"
 *   "+15551234567"           →  "+15***67"
 *   "5551234567"             →  "55***67"
 *
 * Throws TypeError for any non-string input or an unrecognised string format.
 */
function maskUserIdentifier(emailOrPhone) {
  if (typeof emailOrPhone !== "string") {
    throw new TypeError(
      `maskUserIdentifier requires a string; received ${typeof emailOrPhone}`
    );
  }

  const trimmed = emailOrPhone.trim();

  if (EMAIL_PATTERN.test(trimmed)) {
    const atIndex = trimmed.indexOf("@");
    const local = trimmed.slice(0, atIndex);
    const domainPart = trimmed.slice(atIndex); // preserves the "@"
    return `${maskEmailLocal(local)}${domainPart}`;
  }

  if (PHONE_PATTERN.test(trimmed)) {
    const digits = trimmed.replace(/\D/g, "");
    const prefix = trimmed.startsWith("+") ? "+" : "";
    if (digits.length < 4) {
      return `${prefix}${"*".repeat(digits.length)}`;
    }
    // Keep two leading digits and two trailing digits; mask the rest.
    const head = prefix + digits.slice(0, 2);
    const tail = digits.slice(-2);
    return `${head}***${tail}`;
  }

  throw new TypeError(
    `maskUserIdentifier received an unrecognised format; ` +
      `value must be a valid email address or phone number`
  );
}

module.exports = { maskUserIdentifier };
