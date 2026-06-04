"use strict";

/**
 * Canonical unit test for src/utils/privacy/ipAnonymizer.js
 *
 * Directly exercises the real production module — no mocks, no stubs.
 * Exits with code 0 on complete success; code 1 on any assertion failure.
 */

const assert = require("assert");
const { anonymizeIP } = require("./ipAnonymizer");

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

// ── Suite 1: IPv4 — host octet zeroed ────────────────────────────────────────

console.log("\n[Suite 1] IPv4 — final octet zeroed to 0");

runTest(
  '"192.168.1.45" → "192.168.1.0"',
  () => assert.strictEqual(anonymizeIP("192.168.1.45"), "192.168.1.0")
);

runTest(
  '"10.0.0.1" → "10.0.0.0"',
  () => assert.strictEqual(anonymizeIP("10.0.0.1"), "10.0.0.0")
);

runTest(
  '"255.255.255.128" → "255.255.255.0"',
  () => assert.strictEqual(anonymizeIP("255.255.255.128"), "255.255.255.0")
);

runTest(
  '"8.8.8.8" (Google DNS) → "8.8.8.0"',
  () => assert.strictEqual(anonymizeIP("8.8.8.8"), "8.8.8.0")
);

runTest(
  '"127.0.0.1" (loopback) → "127.0.0.0"',
  () => assert.strictEqual(anonymizeIP("127.0.0.1"), "127.0.0.0")
);

runTest(
  '"0.0.0.0" → "0.0.0.0" (already anonymous, host byte was 0)',
  () => assert.strictEqual(anonymizeIP("0.0.0.0"), "0.0.0.0")
);

runTest(
  '"172.16.254.1" → "172.16.254.0" — private range preserved',
  () => assert.strictEqual(anonymizeIP("172.16.254.1"), "172.16.254.0")
);

runTest(
  '"1.2.3.4" → "1.2.3.0"',
  () => assert.strictEqual(anonymizeIP("1.2.3.4"), "1.2.3.0")
);

// ── Suite 2: IPv4 with surrounding whitespace ─────────────────────────────────

console.log("\n[Suite 2] IPv4 with surrounding whitespace — trimmed then anonymised");

runTest(
  '"  192.168.1.99  " → "192.168.1.0"',
  () => assert.strictEqual(anonymizeIP("  192.168.1.99  "), "192.168.1.0")
);

// ── Suite 3: IPv6 — last four groups zeroed ───────────────────────────────────

console.log("\n[Suite 3] IPv6 — last four groups (host identifier) zeroed");

runTest(
  '"2001:db8:85a3::8a2e:370:7334" → "2001:db8:85a3:0::"',
  () => assert.strictEqual(
    anonymizeIP("2001:db8:85a3::8a2e:370:7334"),
    "2001:db8:85a3:0::"
  )
);

runTest(
  '"2001:0db8:0000:0000:0000:0000:0000:0001" (full form) → "2001:db8:0:0::"',
  () => assert.strictEqual(
    anonymizeIP("2001:0db8:0000:0000:0000:0000:0000:0001"),
    "2001:db8:0:0::"
  )
);

runTest(
  '"fe80::1" (link-local) → "fe80:0:0:0::"',
  () => assert.strictEqual(anonymizeIP("fe80::1"), "fe80:0:0:0::")
);

runTest(
  '"::1" (IPv6 loopback) → "0:0:0:0::"',
  () => assert.strictEqual(anonymizeIP("::1"), "0:0:0:0::")
);

runTest(
  '"::" (all-zeros) → "0:0:0:0::"',
  () => assert.strictEqual(anonymizeIP("::"), "0:0:0:0::")
);

runTest(
  '"2001:db8::" → "2001:db8:0:0::"',
  () => assert.strictEqual(anonymizeIP("2001:db8::"), "2001:db8:0:0::")
);

runTest(
  '"fdaa:bbcc:ddee:ff00:1122:3344:5566:7788" → "fdaa:bbcc:ddee:ff00::"',
  () => assert.strictEqual(
    anonymizeIP("fdaa:bbcc:ddee:ff00:1122:3344:5566:7788"),
    "fdaa:bbcc:ddee:ff00::"
  )
);

// ── Suite 4: Output structure guarantees ─────────────────────────────────────

console.log("\n[Suite 4] Output structure guarantees");

runTest(
  "IPv4 output has exactly 4 dot-separated segments",
  () => {
    const result = anonymizeIP("203.0.113.195");
    assert.strictEqual(result.split(".").length, 4,
      `Expected 4 segments, got: ${result}`);
  }
);

runTest(
  "IPv4 anonymised last segment is always '0'",
  () => {
    const result = anonymizeIP("203.0.113.195");
    assert.strictEqual(result.split(".")[3], "0",
      `Last segment must be '0', got: ${result}`);
  }
);

runTest(
  "IPv6 output ends with '::'",
  () => {
    const result = anonymizeIP("2001:db8::cafe:1");
    assert.ok(result.endsWith("::"),
      `IPv6 result must end with '::', got: ${result}`);
  }
);

runTest(
  "IPv6 output prefix has exactly 4 colon-separated groups before '::'",
  () => {
    const result = anonymizeIP("2001:db8:1234:5678::cafe");
    // Remove trailing "::" and split
    const prefix = result.replace(/::$/, "");
    assert.strictEqual(prefix.split(":").length, 4,
      `Prefix must have 4 groups, got: ${result}`);
  }
);

// ── Suite 5: Fallback on malformed / invalid IPv4 strings ────────────────────

console.log("\n[Suite 5] Malformed IPv4 strings → fallback \"0.0.0.0\"");

runTest(
  '"256.1.1.1" (octet out of range) → "0.0.0.0"',
  () => assert.strictEqual(anonymizeIP("256.1.1.1"), "0.0.0.0")
);

runTest(
  '"192.168.1" (only 3 octets) → "0.0.0.0"',
  () => assert.strictEqual(anonymizeIP("192.168.1"), "0.0.0.0")
);

runTest(
  '"192.168.1.1.1" (5 octets) → "0.0.0.0"',
  () => assert.strictEqual(anonymizeIP("192.168.1.1.1"), "0.0.0.0")
);

runTest(
  '"192.168.01.1" (leading zero in octet) → "0.0.0.0"',
  () => assert.strictEqual(anonymizeIP("192.168.01.1"), "0.0.0.0")
);

runTest(
  '"not.an.ip.addr" (non-numeric) → "0.0.0.0"',
  () => assert.strictEqual(anonymizeIP("not.an.ip.addr"), "0.0.0.0")
);

runTest(
  '"192.168.-1.1" (negative octet) → "0.0.0.0"',
  () => assert.strictEqual(anonymizeIP("192.168.-1.1"), "0.0.0.0")
);

// ── Suite 6: Fallback on malformed / invalid IPv6 strings ────────────────────

console.log("\n[Suite 6] Malformed IPv6 strings → fallback \"0.0.0.0\"");

runTest(
  '"2001:db8:::1" (triple colon — empty group fails hex validation) → "0.0.0.0"',
  () => assert.strictEqual(anonymizeIP("2001:db8:::1"), "0.0.0.0")
);

runTest(
  '"gggg::1" (invalid hex group) → "0.0.0.0"',
  () => assert.strictEqual(anonymizeIP("gggg::1"), "0.0.0.0")
);

runTest(
  '"2001:db8:1:2:3:4:5:6:7" (9 groups, too many) → "0.0.0.0"',
  () => assert.strictEqual(anonymizeIP("2001:db8:1:2:3:4:5:6:7"), "0.0.0.0")
);

// ── Suite 7: Fallback on null / undefined / non-string / empty inputs ─────────

console.log("\n[Suite 7] Null / undefined / non-string / empty input → \"0.0.0.0\"");

runTest(
  "null → \"0.0.0.0\"",
  () => assert.strictEqual(anonymizeIP(null), "0.0.0.0")
);

runTest(
  "undefined → \"0.0.0.0\"",
  () => assert.strictEqual(anonymizeIP(undefined), "0.0.0.0")
);

runTest(
  "empty string \"\" → \"0.0.0.0\"",
  () => assert.strictEqual(anonymizeIP(""), "0.0.0.0")
);

runTest(
  "whitespace-only \"   \" → \"0.0.0.0\"",
  () => assert.strictEqual(anonymizeIP("   "), "0.0.0.0")
);

runTest(
  "number 42 → \"0.0.0.0\"",
  () => assert.strictEqual(anonymizeIP(42), "0.0.0.0")
);

runTest(
  "boolean true → \"0.0.0.0\"",
  () => assert.strictEqual(anonymizeIP(true), "0.0.0.0")
);

runTest(
  "object {} → \"0.0.0.0\"",
  () => assert.strictEqual(anonymizeIP({}), "0.0.0.0")
);

runTest(
  "array [\"192.168.1.1\"] → \"0.0.0.0\"",
  () => assert.strictEqual(anonymizeIP(["192.168.1.1"]), "0.0.0.0")
);

runTest(
  "arbitrary string \"hostname\" → \"0.0.0.0\"",
  () => assert.strictEqual(anonymizeIP("hostname"), "0.0.0.0")
);

// ── Final result ──────────────────────────────────────────────────────────────

const divider = "─".repeat(62);
console.log(`\n${divider}`);

if (totalFailed === 0) {
  console.log(
    `[PASS] All ${totalPassed} assertions passed.` +
    ` IP anonymizer contract fully verified.`
  );
  process.exit(0);
} else {
  console.error(
    `[FAIL] ${totalFailed} of ${totalPassed + totalFailed} assertions failed.`
  );
  process.exit(1);
}
