"use strict";

/**
 * Canonical unit test for src/utils/consent/ledgerValidator.js
 *
 * Directly exercises the real production module — no mocks, no stubs.
 * Exits with code 0 on complete success; code 1 on any assertion failure.
 */

const assert = require("assert");
const { validateLedgerChain } = require("./ledgerValidator");

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

// ── Shared fixtures ────────────────────────────────────────────────────────

const EVENT_A = { userId: "usr_001", action: "grant", scope: "vault.owner", ts: 1717200000 };
const EVENT_B = { userId: "usr_001", action: "revoke", scope: "vault.owner", ts: 1717286400 };
const GENESIS  = ""; // no previous hash for the first ledger entry

// ── Suite 1: Output format — valid SHA-256 hex digest ─────────────────────

console.log("\n[Suite 1] Output format — valid 64-char SHA-256 hex digest");

runTest(
  "output is a string",
  () => assert.strictEqual(typeof validateLedgerChain(EVENT_A, GENESIS), "string")
);

runTest(
  "output is exactly 64 characters (SHA-256 hex)",
  () => {
    const hash = validateLedgerChain(EVENT_A, GENESIS);
    assert.strictEqual(hash.length, 64,
      `Expected 64 chars, got ${hash.length}`);
  }
);

runTest(
  "output contains only lowercase hex characters [0-9a-f]",
  () => {
    const hash = validateLedgerChain(EVENT_A, GENESIS);
    assert.ok(/^[0-9a-f]{64}$/.test(hash),
      `Hash must match /^[0-9a-f]{64}$/, got: ${hash}`);
  }
);

// ── Suite 2: Determinism — identical inputs always produce identical output ─

console.log("\n[Suite 2] Determinism — identical inputs always produce identical hash");

runTest(
  "same event + same previousHash → identical hash on every call",
  () => {
    const h1 = validateLedgerChain(EVENT_A, GENESIS);
    const h2 = validateLedgerChain(EVENT_A, GENESIS);
    assert.strictEqual(h1, h2,
      "Identical inputs must produce identical digests");
  }
);

runTest(
  "five consecutive calls with same inputs produce identical hashes",
  () => {
    const hashes = Array.from({ length: 5 }, () =>
      validateLedgerChain(EVENT_A, "abc123prev")
    );
    const unique = new Set(hashes);
    assert.strictEqual(unique.size, 1,
      "All five hashes must be identical");
  }
);

// ── Suite 3: Payload sensitivity — any change alters the digest ───────────

console.log("\n[Suite 3] Payload sensitivity — any change alters the digest");

runTest(
  "different event objects produce different hashes",
  () => {
    const h1 = validateLedgerChain(EVENT_A, GENESIS);
    const h2 = validateLedgerChain(EVENT_B, GENESIS);
    assert.notStrictEqual(h1, h2,
      "Different events must produce different chain links");
  }
);

runTest(
  "changing a single event field alters the hash",
  () => {
    const base  = validateLedgerChain({ action: "grant", ts: 100 }, GENESIS);
    const mutated = validateLedgerChain({ action: "revoke", ts: 100 }, GENESIS);
    assert.notStrictEqual(base, mutated,
      "Mutating 'action' must produce a different digest");
  }
);

runTest(
  "adding an extra field to the event alters the hash",
  () => {
    const h1 = validateLedgerChain({ a: 1 }, GENESIS);
    const h2 = validateLedgerChain({ a: 1, b: 2 }, GENESIS);
    assert.notStrictEqual(h1, h2,
      "Adding field 'b' must alter the chain link");
  }
);

runTest(
  "different previousHash produces a different digest for the same event",
  () => {
    const h1 = validateLedgerChain(EVENT_A, "aaaaaa");
    const h2 = validateLedgerChain(EVENT_A, "bbbbbb");
    assert.notStrictEqual(h1, h2,
      "Different previousHash must alter the resulting digest");
  }
);

runTest(
  "empty-string previousHash vs non-empty previousHash differ",
  () => {
    const genesis = validateLedgerChain(EVENT_A, "");
    const linked  = validateLedgerChain(EVENT_A, "abc123");
    assert.notStrictEqual(genesis, linked,
      "Genesis hash and chained hash must differ");
  }
);

// ── Suite 4: Ledger chain simulation — multi-step chaining ────────────────

console.log("\n[Suite 4] Ledger chain simulation — multi-step chain integrity");

runTest(
  "chaining three events produces unique, non-empty digests at every step",
  () => {
    const h1 = validateLedgerChain({ seq: 1, action: "grant" },  "");
    const h2 = validateLedgerChain({ seq: 2, action: "update" }, h1);
    const h3 = validateLedgerChain({ seq: 3, action: "revoke" }, h2);

    assert.ok(h1.length === 64, "Step 1 must produce a 64-char hash");
    assert.ok(h2.length === 64, "Step 2 must produce a 64-char hash");
    assert.ok(h3.length === 64, "Step 3 must produce a 64-char hash");
    assert.notStrictEqual(h1, h2, "Each step must produce a unique hash");
    assert.notStrictEqual(h2, h3, "Each step must produce a unique hash");
    assert.notStrictEqual(h1, h3, "Non-adjacent steps must also differ");
  }
);

runTest(
  "mutating a mid-chain event breaks the next link (tamper detection)",
  () => {
    const h1honest  = validateLedgerChain({ seq: 1, action: "grant" },   "");
    const h2honest  = validateLedgerChain({ seq: 2, action: "update" },  h1honest);

    // Simulate tampering: attacker changes seq-1 event
    const h1tampered = validateLedgerChain({ seq: 1, action: "TAMPERED" }, "");
    const h2tampered = validateLedgerChain({ seq: 2, action: "update" },   h1tampered);

    assert.notStrictEqual(h2honest, h2tampered,
      "Tampering with a previous entry must break the downstream link");
  }
);

// ── Suite 5: Missing / malformed currentEvent → "" ────────────────────────

console.log("\n[Suite 5] Missing / malformed currentEvent → empty string");

runTest("null currentEvent → \"\"",
  () => assert.strictEqual(validateLedgerChain(null, GENESIS), ""));

runTest("undefined currentEvent → \"\"",
  () => assert.strictEqual(validateLedgerChain(undefined, GENESIS), ""));

runTest("array currentEvent → \"\"",
  () => assert.strictEqual(validateLedgerChain([EVENT_A], GENESIS), ""));

runTest("string currentEvent → \"\"",
  () => assert.strictEqual(validateLedgerChain("event", GENESIS), ""));

runTest("number currentEvent → \"\"",
  () => assert.strictEqual(validateLedgerChain(42, GENESIS), ""));

runTest("boolean currentEvent → \"\"",
  () => assert.strictEqual(validateLedgerChain(true, GENESIS), ""));

runTest(
  "circular-reference currentEvent → \"\" (JSON serialisation error)",
  () => {
    const circular = {};
    circular.self = circular;
    assert.strictEqual(validateLedgerChain(circular, GENESIS), "");
  }
);

// ── Suite 6: Missing / malformed previousHash → "" ────────────────────────

console.log("\n[Suite 6] Missing / malformed previousHash → empty string");

runTest("null previousHash → \"\"",
  () => assert.strictEqual(validateLedgerChain(EVENT_A, null), ""));

runTest("undefined previousHash → \"\"",
  () => assert.strictEqual(validateLedgerChain(EVENT_A, undefined), ""));

runTest("number previousHash → \"\"",
  () => assert.strictEqual(validateLedgerChain(EVENT_A, 12345), ""));

runTest("array previousHash → \"\"",
  () => assert.strictEqual(validateLedgerChain(EVENT_A, ["abc"]), ""));

runTest("object previousHash → \"\"",
  () => assert.strictEqual(validateLedgerChain(EVENT_A, { hash: "abc" }), ""));

runTest("both arguments null → \"\"",
  () => assert.strictEqual(validateLedgerChain(null, null), ""));

// ── Suite 7: Edge cases — empty string previousHash is valid (genesis) ────

console.log("\n[Suite 7] Edge cases — empty-string previousHash is a valid genesis link");

runTest(
  "empty-string previousHash produces a valid 64-char digest",
  () => {
    const hash = validateLedgerChain(EVENT_A, "");
    assert.ok(/^[0-9a-f]{64}$/.test(hash),
      `Genesis hash must be a valid 64-char hex string. Got: ${hash}`);
  }
);

runTest(
  "empty-object event {} with empty previousHash produces a valid digest",
  () => {
    const hash = validateLedgerChain({}, "");
    assert.ok(/^[0-9a-f]{64}$/.test(hash),
      `Empty-object event must still produce a valid digest. Got: ${hash}`);
  }
);

// ── Final result ──────────────────────────────────────────────────────────

const divider = "─".repeat(62);
console.log(`\n${divider}`);

if (totalFailed === 0) {
  console.log(
    `[PASS] All ${totalPassed} assertions passed.` +
    ` Ledger chain validator contract fully verified.`
  );
  process.exit(0);
} else {
  console.error(
    `[FAIL] ${totalFailed} of ${totalPassed + totalFailed} assertions failed.`
  );
  process.exit(1);
}
