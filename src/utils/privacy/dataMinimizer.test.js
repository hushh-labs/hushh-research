"use strict";

/**
 * Canonical unit test for src/utils/privacy/dataMinimizer.js
 *
 * Directly exercises the real production module — no mocks, no stubs.
 * Exits with code 0 on complete success; code 1 on any assertion failure.
 */

const assert = require("assert");
const { minimizePayload } = require("./dataMinimizer");

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

// ── Suite 1: Standard key stripping ───────────────────────────────────────────

console.log("\n[Suite 1] Standard key stripping — only allowed keys pass through");

runTest(
  "allowed key is included in output",
  () => {
    const result = minimizePayload({ userId: "u1", email: "a@b.com" }, ["userId"]);
    assert.ok(Object.prototype.hasOwnProperty.call(result, "userId"),
      "'userId' must be present in the minimized output");
  }
);

runTest(
  "disallowed key is stripped from output",
  () => {
    const result = minimizePayload({ userId: "u1", email: "a@b.com" }, ["userId"]);
    assert.ok(!Object.prototype.hasOwnProperty.call(result, "email"),
      "'email' must be stripped — it is not in the allowlist");
  }
);

runTest(
  "multiple allowed keys all pass through",
  () => {
    const payload = { userId: "u1", scope: "vault.owner", token: "HCT:abc", secret: "x" };
    const result = minimizePayload(payload, ["userId", "scope"]);
    assert.deepStrictEqual(result, { userId: "u1", scope: "vault.owner" });
  }
);

runTest(
  "output contains exactly the intersection of payload keys and allowlist",
  () => {
    const payload = { a: 1, b: 2, c: 3, d: 4 };
    const result = minimizePayload(payload, ["a", "c"]);
    assert.deepStrictEqual(Object.keys(result).sort(), ["a", "c"]);
  }
);

runTest(
  "allowed key not present in payload is silently omitted (not undefined-injected)",
  () => {
    const result = minimizePayload({ userId: "u1" }, ["userId", "missingKey"]);
    assert.ok(!Object.prototype.hasOwnProperty.call(result, "missingKey"),
      "Key absent from payload must not appear in output — even as undefined");
    assert.strictEqual(result.userId, "u1");
  }
);

// ── Suite 2: Case preservation ────────────────────────────────────────────────

console.log("\n[Suite 2] Case preservation — key names are matched and preserved exactly");

runTest(
  "camelCase key preserved exactly",
  () => {
    const result = minimizePayload({ userId: "u1", UserID: "u2" }, ["userId"]);
    assert.strictEqual(result.userId, "u1");
    assert.ok(!result.UserID, "'UserID' must not be included when allowlist has 'userId'");
  }
);

runTest(
  "uppercase key matched only when allowlist entry is uppercase",
  () => {
    const result = minimizePayload({ USER_ID: "u1", userId: "u2" }, ["USER_ID"]);
    assert.strictEqual(result.USER_ID, "u1");
    assert.ok(!result.userId);
  }
);

runTest(
  "value types are preserved — number, boolean, null, object",
  () => {
    const payload = { count: 42, active: false, ref: null, meta: { v: 1 } };
    const result = minimizePayload(payload, ["count", "active", "ref", "meta"]);
    assert.strictEqual(result.count, 42);
    assert.strictEqual(result.active, false);
    assert.strictEqual(result.ref, null);
    assert.deepStrictEqual(result.meta, { v: 1 });
  }
);

// ── Suite 3: Immutability — original payload is not mutated ───────────────────

console.log("\n[Suite 3] Immutability — original payload reference is not modified");

runTest(
  "output is a new object — not the same reference as input",
  () => {
    const payload = { userId: "u1", secret: "s" };
    const result = minimizePayload(payload, ["userId"]);
    assert.notStrictEqual(result, payload,
      "minimizePayload must return a new object, not the original reference");
  }
);

runTest(
  "original payload is unmodified after minimization",
  () => {
    const payload = { userId: "u1", secret: "s" };
    minimizePayload(payload, ["userId"]);
    assert.ok(Object.prototype.hasOwnProperty.call(payload, "secret"),
      "The original payload must still contain 'secret' after minimization");
  }
);

// ── Suite 4: Empty and invalid argument safety ────────────────────────────────

console.log("\n[Suite 4] Empty and invalid arguments → {} without throwing");

runTest(
  "null payloadObject → {}",
  () => assert.deepStrictEqual(minimizePayload(null, ["userId"]), {})
);

runTest(
  "undefined payloadObject → {}",
  () => assert.deepStrictEqual(minimizePayload(undefined, ["userId"]), {})
);

runTest(
  "array payloadObject → {}",
  () => assert.deepStrictEqual(minimizePayload(["a", "b"], ["0"]), {})
);

runTest(
  "string payloadObject → {}",
  () => assert.deepStrictEqual(minimizePayload("payload", ["length"]), {})
);

runTest(
  "number payloadObject → {}",
  () => assert.deepStrictEqual(minimizePayload(42, ["toString"]), {})
);

runTest(
  "null allowedKeysArray → {}",
  () => assert.deepStrictEqual(minimizePayload({ userId: "u1" }, null), {})
);

runTest(
  "undefined allowedKeysArray → {}",
  () => assert.deepStrictEqual(minimizePayload({ userId: "u1" }, undefined), {})
);

runTest(
  "empty allowedKeysArray [] → {}",
  () => assert.deepStrictEqual(minimizePayload({ userId: "u1" }, []), {})
);

runTest(
  "non-array allowedKeysArray (string) → {}",
  () => assert.deepStrictEqual(minimizePayload({ userId: "u1" }, "userId"), {})
);

runTest(
  "non-array allowedKeysArray (object) → {}",
  () => assert.deepStrictEqual(minimizePayload({ userId: "u1" }, { 0: "userId" }), {})
);

runTest(
  "both arguments null → {}",
  () => assert.deepStrictEqual(minimizePayload(null, null), {})
);

runTest(
  "empty payload {} with valid allowlist → {}",
  () => assert.deepStrictEqual(minimizePayload({}, ["userId"]), {})
);

runTest(
  "non-string entries in allowedKeysArray are skipped",
  () => {
    const result = minimizePayload(
      { userId: "u1", 0: "zero", true: "boolkey" },
      [42, null, "userId", true]
    );
    assert.deepStrictEqual(result, { userId: "u1" },
      "Non-string allowlist entries must be skipped; only 'userId' should pass");
  }
);

// ── Final result ──────────────────────────────────────────────────────────────

const divider = "─".repeat(62);
console.log(`\n${divider}`);

if (totalFailed === 0) {
  console.log(
    `[PASS] All ${totalPassed} assertions passed.` +
    ` Data minimizer contract fully verified.`
  );
  process.exit(0);
} else {
  console.error(
    `[FAIL] ${totalFailed} of ${totalPassed + totalFailed} assertions failed.`
  );
  process.exit(1);
}
