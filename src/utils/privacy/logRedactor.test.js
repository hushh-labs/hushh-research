"use strict";

/**
 * Canonical unit test for src/utils/privacy/logRedactor.js
 *
 * Proves that redactLogPayload enforces the same sensitive-field detection
 * rules as hushh-webapp/lib/observability/schema.ts (DENYLIST_KEY_REGEX +
 * looksSensitiveValue) at the server-side log redaction boundary.
 *
 * Key contract proven: sensitive values are REPLACED with "[REDACTED]",
 * never truncated or partially preserved.
 *
 * Exits with code 0 when every assertion passes; code 1 on any failure.
 */

const assert = require("assert");
const { redactLogPayload, isSensitiveValue, REDACTED } = require("./logRedactor");

let totalPassed = 0;
let totalFailed = 0;

function runTest(label, fn) {
  try {
    fn();
    console.log(`  PASS  ${label}`);
    totalPassed++;
  } catch (err) {
    console.error(`  FAIL  ${label}`);
    console.error(`        ${err.message}`);
    totalFailed++;
  }
}

// ── Suite 1: Safe fields pass through unchanged ───────────────────────────────

console.log("\n[Suite 1] Safe observability fields pass through unchanged");

runTest(
  "standard log envelope fields are preserved verbatim",
  () => {
    const payload = {
      method:         "GET",
      route_template: "/api/consent/active",
      status_code:    200,
      duration_ms:    42.7,
      outcome_class:  "success",
      env:            "production",
      service:        "consent-protocol",
    };
    const result = redactLogPayload(payload);
    assert.strictEqual(result.method,         "GET");
    assert.strictEqual(result.route_template, "/api/consent/active");
    assert.strictEqual(result.status_code,    200);
    assert.strictEqual(result.duration_ms,    42.7);
    assert.strictEqual(result.outcome_class,  "success");
    assert.strictEqual(result.env,            "production");
    assert.strictEqual(result.service,        "consent-protocol");
  }
);

runTest(
  "boolean and numeric safe values are preserved",
  () => {
    const result = redactLogPayload({ stream: false, retry_count: 3, sampled: true });
    assert.strictEqual(result.stream,      false);
    assert.strictEqual(result.retry_count, 3);
    assert.strictEqual(result.sampled,     true);
  }
);

runTest(
  "null values on safe keys are preserved",
  () => {
    const result = redactLogPayload({ route_id: null, status_bucket: null });
    assert.strictEqual(result.route_id,     null);
    assert.strictEqual(result.status_bucket, null);
  }
);

runTest(
  "result is a new object — original payload is not mutated",
  () => {
    const original = { method: "POST", status_code: 201 };
    const result   = redactLogPayload(original);
    assert.notStrictEqual(result, original);
    assert.strictEqual(original.method, "POST"); // original unchanged
  }
);

// ── Suite 2: Sensitive key-name detection (DENYLIST_KEY_REGEX) ────────────────

console.log("\n[Suite 2] Sensitive key-name detection — mirrors DENYLIST_KEY_REGEX in schema.ts");

runTest(
  '"token" key is always redacted — prevents consent token leakage',
  () => {
    const result = redactLogPayload({ token: "hushh_consent:abc123.sig456" });
    assert.strictEqual(result.token, REDACTED);
  }
);

runTest(
  '"auth_token" key (contains "token") is redacted',
  () => {
    const result = redactLogPayload({ auth_token: "bearer_xyz_789" });
    assert.strictEqual(result.auth_token, REDACTED);
  }
);

runTest(
  '"vault_owner_token" key is redacted',
  () => {
    const result = redactLogPayload({ vault_owner_token: "hushh_consent:vault.abc" });
    assert.strictEqual(result.vault_owner_token, REDACTED);
  }
);

runTest(
  '"secret" key is always redacted',
  () => {
    const result = redactLogPayload({ secret: "APP_SIGNING_KEY_VALUE" });
    assert.strictEqual(result.secret, REDACTED);
  }
);

runTest(
  '"email" key is always redacted',
  () => {
    const result = redactLogPayload({ email: "user@hushh.ai" });
    assert.strictEqual(result.email, REDACTED);
  }
);

runTest(
  '"phone" key is always redacted',
  () => {
    const result = redactLogPayload({ phone: "+15551234567" });
    assert.strictEqual(result.phone, REDACTED);
  }
);

runTest(
  '"user_id" key is redacted (contains "user")',
  () => {
    const result = redactLogPayload({ user_id: "usr_abdulgaffar_2026" });
    assert.strictEqual(result.user_id, REDACTED);
  }
);

runTest(
  '"request_id" key is redacted — prevents correlation-id linkage',
  () => {
    const result = redactLogPayload({ request_id: "req_abc123def456" });
    assert.strictEqual(result.request_id, REDACTED);
  }
);

runTest(
  "mixed payload: safe fields preserved, sensitive key fields redacted",
  () => {
    const result = redactLogPayload({
      method:         "POST",
      route_template: "/api/consent/session-token",
      status_code:    200,
      token:          "hushh_consent:abc.sig",
      user_id:        "usr_test",
      duration_ms:    15.3,
    });
    assert.strictEqual(result.method,         "POST");
    assert.strictEqual(result.route_template, "/api/consent/session-token");
    assert.strictEqual(result.status_code,    200);
    assert.strictEqual(result.duration_ms,    15.3);
    assert.strictEqual(result.token,          REDACTED);
    assert.strictEqual(result.user_id,        REDACTED);
  }
);

// ── Suite 3: High-entropy value detection (opaque token / session-ID) ────────

console.log("\n[Suite 3] High-entropy value detection — mirrors looksSensitiveValue() in schema.ts");

runTest(
  "64-char hex string (SHA-256 token signature) on a safe key is redacted",
  () => {
    const signature = "a3f2e1b0c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1";
    const result = redactLogPayload({ signature });
    assert.strictEqual(result.signature, REDACTED,
      "64-char hex value must be detected as high-entropy and redacted");
  }
);

runTest(
  "24-char alphanumeric value on a safe key is redacted (minimum threshold)",
  () => {
    const result = redactLogPayload({ correlation: "abcdefghijklmnopqrstuvwx" }); // 24 chars
    assert.strictEqual(result.correlation, REDACTED);
  }
);

runTest(
  "23-char alphanumeric value on a safe key is NOT redacted (below threshold)",
  () => {
    const result = redactLogPayload({ trace_id: "abcdefghijklmnopqrstuvw" }); // 23 chars
    assert.strictEqual(result.trace_id, "abcdefghijklmnopqrstuvw",
      "Values shorter than 24 chars are not high-entropy and must not be redacted");
  }
);

runTest(
  "email-shaped value on a safe key is redacted",
  () => {
    const result = redactLogPayload({ actor: "user@hushh.ai" });
    assert.strictEqual(result.actor, REDACTED,
      "Email-shaped value must be detected and redacted regardless of key name");
  }
);

runTest(
  "short plain string on a safe key passes through",
  () => {
    const result = redactLogPayload({ status: "active", label: "consent.approved" });
    assert.strictEqual(result.status, "active");
    assert.strictEqual(result.label,  "consent.approved");
  }
);

// ── Suite 4: Non-primitive values → redacted ──────────────────────────────────

console.log("\n[Suite 4] Non-primitive values are redacted to prevent structural leakage");

runTest(
  "object value on any key is redacted",
  () => {
    const result = redactLogPayload({ metadata: { scope: "session", agent: "kai" } });
    assert.strictEqual(result.metadata, REDACTED);
  }
);

runTest(
  "array value is redacted",
  () => {
    const result = redactLogPayload({ scopes: ["session", "vault.owner"] });
    assert.strictEqual(result.scopes, REDACTED);
  }
);

runTest(
  "function value is redacted",
  () => {
    const result = redactLogPayload({ handler: () => {} });
    assert.strictEqual(result.handler, REDACTED);
  }
);

runTest(
  "null value on a safe key is preserved (null is a primitive)",
  () => {
    const result = redactLogPayload({ route_id: null });
    assert.strictEqual(result.route_id, null);
  }
);

// ── Suite 5: isSensitiveValue unit — mirrors looksSensitiveValue() directly ──

console.log("\n[Suite 5] isSensitiveValue — mirrors looksSensitiveValue() from schema.ts");

runTest(
  "24-char alphanumeric string is sensitive (high-entropy threshold)",
  () => assert.strictEqual(isSensitiveValue("abcdefghijklmnopqrstuvwx"), true)
);

runTest(
  "64-char hex string is sensitive",
  () => assert.strictEqual(
    isSensitiveValue("a3f2e1b0c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1"),
    true
  )
);

runTest(
  "email string is sensitive",
  () => assert.strictEqual(isSensitiveValue("user@hushh.ai"), true)
);

runTest(
  "23-char string is NOT sensitive (below threshold)",
  () => assert.strictEqual(isSensitiveValue("abcdefghijklmnopqrstuvw"), false)
);

runTest(
  "short route label is NOT sensitive",
  () => assert.strictEqual(isSensitiveValue("consent.approved"), false)
);

runTest(
  "null is NOT sensitive (non-string)",
  () => assert.strictEqual(isSensitiveValue(null), false)
);

runTest(
  "number is NOT sensitive (non-string)",
  () => assert.strictEqual(isSensitiveValue(200), false)
);

// ── Suite 6: Safe fallback — invalid inputs ───────────────────────────────────

console.log("\n[Suite 6] Safe fallback — null / non-object / invalid payload inputs");

runTest(
  "null payload → {} without throwing",
  () => assert.deepStrictEqual(redactLogPayload(null), {})
);

runTest(
  "undefined payload → {}",
  () => assert.deepStrictEqual(redactLogPayload(undefined), {})
);

runTest(
  "string payload → {}",
  () => assert.deepStrictEqual(redactLogPayload("log entry"), {})
);

runTest(
  "array payload → {}",
  () => assert.deepStrictEqual(redactLogPayload([{ key: "val" }]), {})
);

runTest(
  "number payload → {}",
  () => assert.deepStrictEqual(redactLogPayload(42), {})
);

// ── Final result ──────────────────────────────────────────────────────────────

const divider = "─".repeat(62);
console.log(`\n${divider}`);

if (totalFailed === 0) {
  console.log(
    `[PASS] All ${totalPassed} assertions passed.` +
    ` Log redaction boundary contract fully verified.`
  );
  process.exit(0);
} else {
  console.error(
    `[FAIL] ${totalFailed} of ${totalPassed + totalFailed} assertions failed.`
  );
  process.exit(1);
}
