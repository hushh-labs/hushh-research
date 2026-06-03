"use strict";

/**
 * Canonical unit test for src/utils/privacy/agentMasker.js
 *
 * Directly exercises the real production module — no mocks, no stubs.
 * Exits with code 0 on complete success; code 1 on any assertion failure.
 */

const assert = require("assert");
const { maskUserAgent, GENERIC_UA } = require("./agentMasker");

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

// ── Real-world User-Agent fixtures ────────────────────────────────────────────

const CHROME_WIN =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.6167.85 Safari/537.36";

const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.234 Safari/537.36";

const EDGE_WIN =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 " +
  "Safari/537.36 Edg/121.0.2277.128";

const FIREFOX_WIN =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) " +
  "Gecko/20100101 Firefox/123.0";

const OPERA_WIN =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 " +
  "Safari/537.36 OPR/105.0.4970.48";

const SAMSUNG_MOBILE =
  "Mozilla/5.0 (Linux; Android 13; SM-S908B) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.5615.136 " +
  "Mobile Safari/537.36 SamsungBrowser/21.0.1.1";

const FIREFOX_IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) " +
  "AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/114.1 Mobile/15E148";

const CHROME_IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) " +
  "AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/114.0.5735.99 " +
  "Mobile/15E148 Safari/604.1";

// ── Suite 1: Chrome — 4-segment build ID stripped ─────────────────────────────

console.log("\n[Suite 1] Chrome — precise build version stripped to major.0");

runTest(
  "Chrome Windows UA: build ID .6167.85 is removed",
  () => {
    const result = maskUserAgent(CHROME_WIN);
    assert.ok(!result.includes("121.0.6167"),
      `Specific build must be stripped. Got: ${result}`);
    assert.ok(result.includes("Chrome/121.0"),
      `Major.0 token must be present. Got: ${result}`);
  }
);

runTest(
  "Chrome macOS UA: .6099.234 build stripped to Chrome/120.0",
  () => {
    const result = maskUserAgent(CHROME_MAC);
    assert.ok(!result.includes("120.0.6099"),
      `Specific build must be stripped. Got: ${result}`);
    assert.ok(result.includes("Chrome/120.0"),
      `Chrome/120.0 must be present. Got: ${result}`);
  }
);

runTest(
  "Chrome UA: AppleWebKit/537.36 constant is preserved unchanged",
  () => {
    const result = maskUserAgent(CHROME_WIN);
    assert.ok(result.includes("AppleWebKit/537.36"),
      `Static AppleWebKit token must be preserved. Got: ${result}`);
  }
);

runTest(
  "Chrome UA: trailing Safari/537.36 constant is preserved unchanged",
  () => {
    const result = maskUserAgent(CHROME_WIN);
    assert.ok(result.includes("Safari/537.36"),
      `Static Safari compatibility token must be preserved. Got: ${result}`);
  }
);

runTest(
  "Chrome UA: Mozilla/5.0 prefix is preserved",
  () => {
    const result = maskUserAgent(CHROME_WIN);
    assert.ok(result.startsWith("Mozilla/5.0"),
      `Mozilla/5.0 prefix must be preserved. Got: ${result}`);
  }
);

// ── Suite 2: Edge — 4-segment build ID stripped ───────────────────────────────

console.log("\n[Suite 2] Edge — precise build version stripped");

runTest(
  "Edge UA: Edg/121.0.2277.128 stripped to Edg/121.0",
  () => {
    const result = maskUserAgent(EDGE_WIN);
    assert.ok(!result.includes("2277"),
      `Edge minor build must be stripped. Got: ${result}`);
    assert.ok(result.includes("Edg/121.0"),
      `Edg/121.0 must remain. Got: ${result}`);
  }
);

runTest(
  "Edge UA: Chrome/121.0.0.0 in Edge UA is also masked to Chrome/121.0",
  () => {
    const result = maskUserAgent(EDGE_WIN);
    assert.ok(result.includes("Chrome/121.0"),
      `Embedded Chrome token must be stripped too. Got: ${result}`);
  }
);

// ── Suite 3: Firefox — 2-segment normalisation ────────────────────────────────

console.log("\n[Suite 3] Firefox — 2-segment version handled correctly");

runTest(
  "Firefox/123.0 (standard release) remains Firefox/123.0",
  () => {
    const result = maskUserAgent(FIREFOX_WIN);
    assert.ok(result.includes("Firefox/123.0"),
      `Firefox major.0 must be present. Got: ${result}`);
  }
);

runTest(
  "Firefox UA: Gecko/20100101 constant is preserved unchanged",
  () => {
    const result = maskUserAgent(FIREFOX_WIN);
    assert.ok(result.includes("Gecko/20100101"),
      `Static Gecko token must be preserved. Got: ${result}`);
  }
);

runTest(
  "Hypothetical Firefox/123.5 minor version stripped to 123.0",
  () => {
    const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.5) Gecko/20100101 Firefox/123.5";
    const result = maskUserAgent(ua);
    assert.ok(!result.includes("Firefox/123.5"),
      `Firefox/123.5 must be masked. Got: ${result}`);
    assert.ok(result.includes("Firefox/123.0"),
      `Firefox/123.0 must appear. Got: ${result}`);
  }
);

// ── Suite 4: Opera — 3/4-segment stripping ────────────────────────────────────

console.log("\n[Suite 4] Opera / OPR — 4-segment build stripped");

runTest(
  "OPR/105.0.4970.48 stripped to OPR/105.0",
  () => {
    const result = maskUserAgent(OPERA_WIN);
    assert.ok(!result.includes("4970"),
      `OPR build number must be stripped. Got: ${result}`);
    assert.ok(result.includes("OPR/105.0"),
      `OPR/105.0 must remain. Got: ${result}`);
  }
);

// ── Suite 5: Mobile browsers ──────────────────────────────────────────────────

console.log("\n[Suite 5] Mobile browsers — version tokens stripped correctly");

runTest(
  "SamsungBrowser/21.0.1.1 stripped to SamsungBrowser/21.0",
  () => {
    const result = maskUserAgent(SAMSUNG_MOBILE);
    assert.ok(!result.includes("21.0.1.1"),
      `SamsungBrowser build must be stripped. Got: ${result}`);
    assert.ok(result.includes("SamsungBrowser/21.0"),
      `SamsungBrowser/21.0 must remain. Got: ${result}`);
  }
);

runTest(
  "FxiOS/114.1 (Firefox for iOS) normalised to FxiOS/114.0",
  () => {
    const result = maskUserAgent(FIREFOX_IOS);
    assert.ok(result.includes("FxiOS/114.0"),
      `FxiOS must be normalised. Got: ${result}`);
  }
);

runTest(
  "CriOS/114.0.5735.99 (Chrome for iOS) stripped to CriOS/114.0",
  () => {
    const result = maskUserAgent(CHROME_IOS);
    assert.ok(!result.includes("5735"),
      `CriOS build must be stripped. Got: ${result}`);
    assert.ok(result.includes("CriOS/114.0"),
      `CriOS/114.0 must remain. Got: ${result}`);
  }
);

// ── Suite 6: Output contains no specific patch or build numbers ───────────────

console.log("\n[Suite 6] Masked output contains zero fingerprinting build tokens");

runTest(
  "Masked Chrome UA has no 3-or-more-segment version anywhere",
  () => {
    const result = maskUserAgent(CHROME_WIN);
    const threeSegment = /\/\d+\.\d+\.\d+/.test(result);
    assert.ok(!threeSegment,
      `Masked output must not contain X.Y.Z version tokens. Got: ${result}`);
  }
);

runTest(
  "Masked Edge UA has no 3-or-more-segment version anywhere",
  () => {
    const result = maskUserAgent(EDGE_WIN);
    const threeSegment = /\/\d+\.\d+\.\d+/.test(result);
    assert.ok(!threeSegment,
      `Masked output must not contain X.Y.Z version tokens. Got: ${result}`);
  }
);

runTest(
  "Masked Opera UA has no 3-or-more-segment version anywhere",
  () => {
    const result = maskUserAgent(OPERA_WIN);
    const threeSegment = /\/\d+\.\d+\.\d+/.test(result);
    assert.ok(!threeSegment,
      `Masked output must not contain X.Y.Z version tokens. Got: ${result}`);
  }
);

// ── Suite 7: Bad-input boundary handling ─────────────────────────────────────

console.log("\n[Suite 7] Bad-input boundaries → GENERIC_UA fallback without throwing");

runTest(
  "null → GENERIC_UA",
  () => assert.strictEqual(maskUserAgent(null), GENERIC_UA)
);

runTest(
  "undefined → GENERIC_UA",
  () => assert.strictEqual(maskUserAgent(undefined), GENERIC_UA)
);

runTest(
  "empty string → GENERIC_UA",
  () => assert.strictEqual(maskUserAgent(""), GENERIC_UA)
);

runTest(
  "whitespace-only string → GENERIC_UA",
  () => assert.strictEqual(maskUserAgent("   "), GENERIC_UA)
);

runTest(
  "number input → GENERIC_UA",
  () => assert.strictEqual(maskUserAgent(42), GENERIC_UA)
);

runTest(
  "boolean input → GENERIC_UA",
  () => assert.strictEqual(maskUserAgent(true), GENERIC_UA)
);

runTest(
  "array input → GENERIC_UA",
  () => assert.strictEqual(maskUserAgent(["Mozilla/5.0"]), GENERIC_UA)
);

runTest(
  "object input → GENERIC_UA",
  () => assert.strictEqual(maskUserAgent({ ua: "Mozilla" }), GENERIC_UA)
);

runTest(
  "GENERIC_UA constant is a non-empty string starting with Mozilla/5.0",
  () => {
    assert.ok(typeof GENERIC_UA === "string" && GENERIC_UA.length > 0,
      "GENERIC_UA must be a non-empty string");
    assert.ok(GENERIC_UA.startsWith("Mozilla/5.0"),
      "GENERIC_UA must start with Mozilla/5.0 for structural validity");
  }
);

// ── Final result ──────────────────────────────────────────────────────────────

const divider = "─".repeat(62);
console.log(`\n${divider}`);

if (totalFailed === 0) {
  console.log(
    `[PASS] All ${totalPassed} assertions passed.` +
    ` User-Agent masker contract fully verified.`
  );
  process.exit(0);
} else {
  console.error(
    `[FAIL] ${totalFailed} of ${totalPassed + totalFailed} assertions failed.`
  );
  process.exit(1);
}
