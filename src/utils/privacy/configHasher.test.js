"use strict";

/**
 * Canonical unit test for src/utils/privacy/configHasher.js
 *
 * Directly exercises the real production module — no mocks, no stubs.
 * Exits with code 0 on complete success; code 1 on any assertion failure.
 */

const assert = require("assert");
const { hashConfigStructure } = require("./configHasher");

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

// ── Suite 1: Key-order independence — same data always same hash ───────────────

console.log("\n[Suite 1] Key-order independence — insertion order must not affect hash");

runTest(
  "{b, a} and {a, b} produce identical hashes",
  () => {
    const h1 = hashConfigStructure({ b: 2, a: 1 });
    const h2 = hashConfigStructure({ a: 1, b: 2 });
    assert.strictEqual(h1, h2,
      "Objects with the same data but different key order must hash identically");
  }
);

runTest(
  "three-key object: all six insertion permutations yield the same hash",
  () => {
    const ref = hashConfigStructure({ a: 1, b: 2, c: 3 });
    const permutations = [
      { a: 1, c: 3, b: 2 },
      { b: 2, a: 1, c: 3 },
      { b: 2, c: 3, a: 1 },
      { c: 3, a: 1, b: 2 },
      { c: 3, b: 2, a: 1 },
    ];
    for (const perm of permutations) {
      assert.strictEqual(hashConfigStructure(perm), ref,
        `Permutation ${JSON.stringify(perm)} must hash identically to the reference`);
    }
  }
);

runTest(
  "realistic consent-config object is order-independent",
  () => {
    const configA = {
      version: 2,
      scope:   "vault.owner",
      userId:  "usr_abc",
      ttl:     86400,
    };
    const configB = {
      ttl:     86400,
      userId:  "usr_abc",
      version: 2,
      scope:   "vault.owner",
    };
    assert.strictEqual(hashConfigStructure(configA), hashConfigStructure(configB),
      "Consent-config objects with identical data must produce the same hash");
  }
);

// ── Suite 2: Determinism — same input always same hash ────────────────────────

console.log("\n[Suite 2] Determinism — repeated calls always return the same digest");

runTest(
  "five consecutive calls on the same object return identical hashes",
  () => {
    const obj = { x: 10, y: 20, z: "hello" };
    const hashes = Array.from({ length: 5 }, () => hashConfigStructure(obj));
    const unique = new Set(hashes);
    assert.strictEqual(unique.size, 1,
      "All five hashes must be identical");
  }
);

// ── Suite 3: Value sensitivity — different values produce different hashes ────

console.log("\n[Suite 3] Value sensitivity — any data change alters the digest");

runTest(
  "changing a value produces a different hash",
  () => {
    const h1 = hashConfigStructure({ scope: "vault.owner", version: 1 });
    const h2 = hashConfigStructure({ scope: "vault.owner", version: 2 });
    assert.notStrictEqual(h1, h2,
      "Changing 'version' from 1 to 2 must produce a different hash");
  }
);

runTest(
  "changing a key name produces a different hash",
  () => {
    const h1 = hashConfigStructure({ scope: "read", ttl: 3600 });
    const h2 = hashConfigStructure({ level: "read", ttl: 3600 });
    assert.notStrictEqual(h1, h2,
      "Renaming 'scope' to 'level' must produce a different hash");
  }
);

runTest(
  "adding an extra key produces a different hash",
  () => {
    const h1 = hashConfigStructure({ a: 1 });
    const h2 = hashConfigStructure({ a: 1, b: 2 });
    assert.notStrictEqual(h1, h2,
      "Adding key 'b' must alter the hash");
  }
);

runTest(
  "removing a key produces a different hash",
  () => {
    const h1 = hashConfigStructure({ a: 1, b: 2 });
    const h2 = hashConfigStructure({ a: 1 });
    assert.notStrictEqual(h1, h2,
      "Removing key 'b' must alter the hash");
  }
);

runTest(
  "boolean vs numeric value produces a different hash",
  () => {
    const h1 = hashConfigStructure({ enabled: true });
    const h2 = hashConfigStructure({ enabled: 1 });
    assert.notStrictEqual(h1, h2,
      "true (boolean) and 1 (number) are distinct values and must hash differently");
  }
);

runTest(
  "null value vs missing key produces a different hash",
  () => {
    const h1 = hashConfigStructure({ a: 1, b: null });
    const h2 = hashConfigStructure({ a: 1 });
    assert.notStrictEqual(h1, h2,
      "Explicit null value and absent key must hash differently");
  }
);

// ── Suite 4: Output format verification ───────────────────────────────────────

console.log("\n[Suite 4] Output format — valid SHA-256 hex digest");

runTest(
  "output is a string of exactly 64 characters",
  () => {
    const hash = hashConfigStructure({ a: 1 });
    assert.strictEqual(typeof hash, "string");
    assert.strictEqual(hash.length, 64,
      `SHA-256 hex digest must be 64 characters. Got ${hash.length}`);
  }
);

runTest(
  "output contains only lowercase hex characters [0-9a-f]",
  () => {
    const hash = hashConfigStructure({ scope: "vault.owner", version: 3 });
    assert.ok(/^[0-9a-f]{64}$/.test(hash),
      `Hash must match /^[0-9a-f]{64}$/. Got: ${hash}`);
  }
);

runTest(
  "two distinct configs produce hashes of equal length (64 chars each)",
  () => {
    const h1 = hashConfigStructure({ x: "foo" });
    const h2 = hashConfigStructure({ y: "bar", z: 99 });
    assert.strictEqual(h1.length, 64);
    assert.strictEqual(h2.length, 64);
  }
);

// ── Suite 5: Nested-object key order is NOT normalised (top-level only) ───────

console.log("\n[Suite 5] Nested objects — top-level sort does not affect nested key order");

runTest(
  "two top-level configs with identical nested data hash identically",
  () => {
    const h1 = hashConfigStructure({ z: { x: 1, y: 2 }, a: "hello" });
    const h2 = hashConfigStructure({ a: "hello", z: { x: 1, y: 2 } });
    assert.strictEqual(h1, h2,
      "Top-level key order must be normalised; nested structure preserved");
  }
);

// ── Suite 6: Bad-input boundaries — all return "" without throwing ─────────────

console.log("\n[Suite 6] Bad-input boundaries → empty string without throwing");

runTest("null → \"\"",
  () => assert.strictEqual(hashConfigStructure(null), ""));

runTest("undefined → \"\"",
  () => assert.strictEqual(hashConfigStructure(undefined), ""));

runTest("empty object {} → \"\"",
  () => assert.strictEqual(hashConfigStructure({}), ""));

runTest("array input → \"\"",
  () => assert.strictEqual(hashConfigStructure([1, 2, 3]), ""));

runTest("string input → \"\"",
  () => assert.strictEqual(hashConfigStructure("config"), ""));

runTest("number input → \"\"",
  () => assert.strictEqual(hashConfigStructure(42), ""));

runTest("boolean input → \"\"",
  () => assert.strictEqual(hashConfigStructure(true), ""));

runTest("function input → \"\"",
  () => assert.strictEqual(hashConfigStructure(() => {}), ""));

// ── Final result ──────────────────────────────────────────────────────────────

const divider = "─".repeat(62);
console.log(`\n${divider}`);

if (totalFailed === 0) {
  console.log(
    `[PASS] All ${totalPassed} assertions passed.` +
    ` Config structure hasher contract fully verified.`
  );
  process.exit(0);
} else {
  console.error(
    `[FAIL] ${totalFailed} of ${totalPassed + totalFailed} assertions failed.`
  );
  process.exit(1);
}
