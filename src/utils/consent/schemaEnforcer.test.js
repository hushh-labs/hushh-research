"use strict";

/**
 * Canonical unit test for src/utils/consent/schemaEnforcer.js
 *
 * Directly exercises the real production module — no mocks, no stubs.
 * Exits with code 0 on complete success; code 1 on any assertion failure.
 */

const assert = require("assert");
const { enforceSchemaVersion } = require("./schemaEnforcer");

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

// ── Suite 1: Positive matching — supported versions return true ───────────────

console.log("\n[Suite 1] Positive matching — version explicitly in supported array");

runTest(
  '"v2" matched against ["v1", "v2", "v3"] → true',
  () => assert.strictEqual(
    enforceSchemaVersion({ version: "v2" }, ["v1", "v2", "v3"]),
    true
  )
);

runTest(
  '"v1" matched against single-element array ["v1"] → true',
  () => assert.strictEqual(
    enforceSchemaVersion({ version: "v1" }, ["v1"]),
    true
  )
);

runTest(
  '"3.0.0" matched against semver array → true',
  () => assert.strictEqual(
    enforceSchemaVersion(
      { version: "3.0.0", userId: "usr_abc" },
      ["1.0.0", "2.0.0", "3.0.0"]
    ),
    true
  )
);

runTest(
  'latest-schema payload with extra fields → true (extra fields ignored)',
  () => assert.strictEqual(
    enforceSchemaVersion(
      { version: "v4", scope: "vault.owner", timestamp: 1234567890 },
      ["v3", "v4"]
    ),
    true
  )
);

runTest(
  '"current" matched in multi-version allowlist → true',
  () => assert.strictEqual(
    enforceSchemaVersion({ version: "current" }, ["legacy", "stable", "current"]),
    true
  )
);

// ── Suite 2: Rejected / unsupported versions return false ─────────────────────

console.log("\n[Suite 2] Unsupported / legacy versions → false (default-deny)");

runTest(
  '"v0" (legacy) not in ["v1", "v2"] → false',
  () => assert.strictEqual(
    enforceSchemaVersion({ version: "v0" }, ["v1", "v2"]),
    false
  )
);

runTest(
  '"v5" (future/unknown) not in ["v1", "v2", "v3"] → false',
  () => assert.strictEqual(
    enforceSchemaVersion({ version: "v5" }, ["v1", "v2", "v3"]),
    false
  )
);

runTest(
  '"V2" (wrong case) is NOT matched against "v2" — strict equality',
  () => assert.strictEqual(
    enforceSchemaVersion({ version: "V2" }, ["v1", "v2", "v3"]),
    false
  )
);

runTest(
  '"v2 " (trailing space) is NOT matched — strict equality, no trimming of payload',
  () => assert.strictEqual(
    enforceSchemaVersion({ version: "v2 " }, ["v1", "v2", "v3"]),
    false
  )
);

runTest(
  '"deprecated" not in supported list → false',
  () => assert.strictEqual(
    enforceSchemaVersion({ version: "deprecated" }, ["stable", "beta"]),
    false
  )
);

// ── Suite 3: Missing or malformed version property → false ────────────────────

console.log("\n[Suite 3] Missing / malformed version property → false");

runTest(
  'payload with no version key → false',
  () => assert.strictEqual(
    enforceSchemaVersion({ scope: "vault.owner" }, ["v1", "v2"]),
    false
  )
);

runTest(
  'payload with version: null → false',
  () => assert.strictEqual(
    enforceSchemaVersion({ version: null }, ["v1", "v2"]),
    false
  )
);

runTest(
  'payload with version: undefined → false',
  () => assert.strictEqual(
    enforceSchemaVersion({ version: undefined }, ["v1", "v2"]),
    false
  )
);

runTest(
  'payload with version: "" (empty string) → false',
  () => assert.strictEqual(
    enforceSchemaVersion({ version: "" }, ["v1", "v2"]),
    false
  )
);

runTest(
  'payload with version: "  " (whitespace-only) → false',
  () => assert.strictEqual(
    enforceSchemaVersion({ version: "  " }, ["v1", "v2"]),
    false
  )
);

runTest(
  'payload with version: 2 (number) → false — strict string check',
  () => assert.strictEqual(
    enforceSchemaVersion({ version: 2 }, ["v1", "v2", "2"]),
    false
  )
);

runTest(
  'payload with version: true (boolean) → false',
  () => assert.strictEqual(
    enforceSchemaVersion({ version: true }, ["true", "v1"]),
    false
  )
);

// ── Suite 4: Null / undefined / invalid payloadObject → false ─────────────────

console.log("\n[Suite 4] Null / invalid payloadObject → false (default-deny)");

runTest(
  'null payloadObject → false',
  () => assert.strictEqual(enforceSchemaVersion(null, ["v1", "v2"]), false)
);

runTest(
  'undefined payloadObject → false',
  () => assert.strictEqual(enforceSchemaVersion(undefined, ["v1", "v2"]), false)
);

runTest(
  'string payloadObject → false',
  () => assert.strictEqual(enforceSchemaVersion("v1", ["v1", "v2"]), false)
);

runTest(
  'number payloadObject → false',
  () => assert.strictEqual(enforceSchemaVersion(42, ["v1", "v2"]), false)
);

runTest(
  'array payloadObject → false',
  () => assert.strictEqual(
    enforceSchemaVersion([{ version: "v1" }], ["v1", "v2"]),
    false
  )
);

// ── Suite 5: Null / undefined / invalid supportedVersionsArray → false ────────

console.log("\n[Suite 5] Null / invalid supportedVersionsArray → false (default-deny)");

runTest(
  'null supportedVersionsArray → false',
  () => assert.strictEqual(
    enforceSchemaVersion({ version: "v1" }, null),
    false
  )
);

runTest(
  'undefined supportedVersionsArray → false',
  () => assert.strictEqual(
    enforceSchemaVersion({ version: "v1" }, undefined),
    false
  )
);

runTest(
  'empty array [] → false',
  () => assert.strictEqual(
    enforceSchemaVersion({ version: "v1" }, []),
    false
  )
);

runTest(
  'string as supportedVersionsArray → false',
  () => assert.strictEqual(
    enforceSchemaVersion({ version: "v1" }, "v1"),
    false
  )
);

runTest(
  'both arguments null → false',
  () => assert.strictEqual(enforceSchemaVersion(null, null), false)
);

// ── Final result ──────────────────────────────────────────────────────────────

const divider = "─".repeat(62);
console.log(`\n${divider}`);

if (totalFailed === 0) {
  console.log(
    `[PASS] All ${totalPassed} assertions passed.` +
    ` Schema version enforcer contract fully verified.`
  );
  process.exit(0);
} else {
  console.error(
    `[FAIL] ${totalFailed} of ${totalPassed + totalFailed} assertions failed.`
  );
  process.exit(1);
}
