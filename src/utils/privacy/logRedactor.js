"use strict";

/**
 * Sensitive key-name pattern — mirrors DENYLIST_KEY_REGEX in
 * hushh-webapp/lib/observability/schema.ts so both the analytics-event
 * sanitiser and this server-side log redaction boundary enforce the same
 * rules from a single agreed-upon definition.
 *
 * Matches keys whose name contains (or ends with) any of:
 *   token, secret, email, name, phone, address, uid, user/userId,
 *   symbol, ticker, amount, price, value, message, text, prompt,
 *   query, run_id, request_id, debate_session_id
 */
const SENSITIVE_KEY_REGEX =
  /(^|_)(user(id)?|uid|email|name|phone|address|token|secret|symbol|ticker|amount|price|value|message|text|prompt|query|run_id|request_id|debate_session_id)(_|$)/i;

/**
 * Email-address pattern — mirrors EMAIL_VALUE_REGEX in schema.ts.
 */
const EMAIL_PATTERN = /[^\s]+@[^\s]+\.[^\s]+/;

/**
 * Opaque-token / high-entropy value fingerprint — mirrors the
 * looksSensitiveValue() heuristic in schema.ts:
 *   24+ consecutive chars drawn from [A-Za-z0-9_-]
 */
const HIGH_ENTROPY_PATTERN = /^[A-Za-z0-9_\-]{24,}$/;

/** Sentinel written into every redacted field value. */
const REDACTED = "[REDACTED]";

/**
 * Returns true when a string value looks like an opaque token or email.
 * Implements the same heuristic as looksSensitiveValue() in schema.ts.
 *
 * @param  {*} value
 * @returns {boolean}
 */
function isSensitiveValue(value) {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (EMAIL_PATTERN.test(trimmed)) return true;
  if (HIGH_ENTROPY_PATTERN.test(trimmed)) return true;
  return false;
}

/**
 * redactLogPayload(payload)
 *
 * Sanitises an outbound log or observability payload object, replacing
 * sensitive field values with "[REDACTED]" so that the key structure is
 * preserved for debugging while no private value leaks into log storage.
 *
 * Redaction rules — aligned with lib/observability/schema.ts:
 *
 *   1. Key name matches SENSITIVE_KEY_REGEX (token, secret, email…)
 *      → value replaced with REDACTED regardless of its content
 *
 *   2. Value is a high-entropy string (24+ alphanumeric/dash/underscore
 *      chars) → replaced with REDACTED (opaque token / session ID)
 *
 *   3. Value contains an email address pattern → replaced with REDACTED
 *
 *   4. Value is non-primitive (object, array, function)
 *      → replaced with REDACTED (structural data must not reach logs)
 *
 * Safe-fallback: null, non-object, array, or string input → returns {}
 * so callers can always spread the result safely.  Never throws.
 *
 * @param  {object|*} payload — raw log / event payload
 * @returns {object}           — redacted payload safe for log storage
 */
function redactLogPayload(payload) {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return {};
  }

  const result = {};

  for (const [key, value] of Object.entries(payload)) {
    // Rule 1: Sensitive key name → always redact the value
    if (SENSITIVE_KEY_REGEX.test(key)) {
      result[key] = REDACTED;
      continue;
    }

    // Rule 4: Non-primitive value → redact to avoid structural leakage
    const type = typeof value;
    if (
      value !== null &&
      type !== "string" &&
      type !== "number" &&
      type !== "boolean"
    ) {
      result[key] = REDACTED;
      continue;
    }

    // Rules 2 & 3: Primitive value that looks sensitive → redact
    if (isSensitiveValue(value)) {
      result[key] = REDACTED;
      continue;
    }

    result[key] = value;
  }

  return result;
}

module.exports = { redactLogPayload, isSensitiveValue, REDACTED };
