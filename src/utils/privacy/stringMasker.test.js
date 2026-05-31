"use strict";

const assert = require("assert");
const { maskUserIdentifier } = require("./stringMasker");

function runMaskingSuite() {
  console.log(
    "Running test(privacy): stringMasker consent-minimisation rules against live production code..."
  );

  // ── Email masking ──────────────────────────────────────────────────────────

  assert.strictEqual(
    maskUserIdentifier("abdulrashid@email.com"),
    "a***d@email.com",
    "Standard email: expected first-char + *** + last-char before the @."
  );

  assert.strictEqual(
    maskUserIdentifier("  jane.doe@hushh.ai  "), // leading/trailing whitespace
    "j***e@hushh.ai",
    "Email with surrounding whitespace must be trimmed before masking."
  );

  assert.strictEqual(
    maskUserIdentifier("ab@test.org"),
    "a*@test.org",
    "Two-char local part must produce a single star: first-char + *."
  );

  assert.strictEqual(
    maskUserIdentifier("a@test.org"),
    "*@test.org",
    "Single-char local part must collapse entirely to a bare *."
  );

  // ── Phone masking ──────────────────────────────────────────────────────────

  const e164Result = maskUserIdentifier("+15551234567");
  assert.ok(
    e164Result.startsWith("+1") && e164Result.includes("***") && e164Result.endsWith("67"),
    `E.164 phone masking produced unexpected result: ${e164Result}`
  );

  const nationalResult = maskUserIdentifier("5551234567");
  assert.ok(
    nationalResult.startsWith("55") && nationalResult.includes("***") && nationalResult.endsWith("67"),
    `National phone masking produced unexpected result: ${nationalResult}`
  );

  const formattedPhone = maskUserIdentifier("+44 20 7946 0123");
  assert.ok(
    formattedPhone.includes("***"),
    `Formatted phone (spaces/parens) must still be masked: ${formattedPhone}`
  );

  // ── Invalid-type guards ────────────────────────────────────────────────────

  assert.throws(
    () => maskUserIdentifier(42),
    TypeError,
    "A numeric argument must throw TypeError, not silently convert."
  );

  assert.throws(
    () => maskUserIdentifier(null),
    TypeError,
    "null must throw TypeError — not be treated as an empty string."
  );

  assert.throws(
    () => maskUserIdentifier(undefined),
    TypeError,
    "undefined must throw TypeError."
  );

  assert.throws(
    () => maskUserIdentifier({ email: "user@example.com" }),
    TypeError,
    "A plain object must throw TypeError even if it wraps a valid email."
  );

  assert.throws(
    () => maskUserIdentifier(["user@example.com"]),
    TypeError,
    "An array must throw TypeError even if its first element is a valid email."
  );

  // ── Unrecognised string format ─────────────────────────────────────────────

  assert.throws(
    () => maskUserIdentifier("not-an-email-or-phone"),
    TypeError,
    "A string that matches neither email nor phone pattern must throw TypeError."
  );

  console.log(
    "All privacy masking assertions passed — production logic enforces consent minimisation correctly."
  );
}

runMaskingSuite();

process.exit(0);
