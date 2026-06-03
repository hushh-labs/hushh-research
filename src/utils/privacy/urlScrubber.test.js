"use strict";

/**
 * Canonical unit test for src/utils/privacy/urlScrubber.js
 *
 * Directly exercises the real production module — no mocks, no stubs.
 * Exits with code 0 on complete success; code 1 on any assertion failure.
 */

const assert = require("assert");
const { scrubTrackingParams } = require("./urlScrubber");

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

// ── Suite 1: Tracking parameters are stripped ─────────────────────────────────

console.log("\n[Suite 1] Tracking parameters are stripped from the URL");

runTest(
  "gclid (Google Ads) is removed from absolute URL",
  () => {
    const result = scrubTrackingParams("https://example.com/page?gclid=abc123");
    assert.ok(!result.includes("gclid"),
      `gclid must be stripped. Got: ${result}`);
    assert.ok(result.startsWith("https://example.com"),
      `Origin must be preserved. Got: ${result}`);
  }
);

runTest(
  "fbclid (Facebook) is removed from absolute URL",
  () => {
    const result = scrubTrackingParams("https://example.com/page?fbclid=xyz789");
    assert.ok(!result.includes("fbclid"),
      `fbclid must be stripped. Got: ${result}`);
  }
);

runTest(
  "utm_source is removed",
  () => {
    const result = scrubTrackingParams("https://example.com/?utm_source=newsletter");
    assert.ok(!result.includes("utm_source"),
      `utm_source must be stripped. Got: ${result}`);
  }
);

runTest(
  "all utm_* parameters are removed in a single pass",
  () => {
    const url = "https://example.com/landing"
      + "?utm_source=google&utm_medium=cpc&utm_campaign=spring"
      + "&utm_content=banner&utm_term=shoes";
    const result = scrubTrackingParams(url);
    assert.ok(!result.includes("utm_"),
      `All utm_ params must be stripped. Got: ${result}`);
    assert.ok(result.startsWith("https://example.com/landing"),
      `Path must be preserved. Got: ${result}`);
  }
);

runTest(
  "msclkid (Microsoft Ads) is removed",
  () => {
    const result = scrubTrackingParams("https://example.com/?msclkid=ms456");
    assert.ok(!result.includes("msclkid"),
      `msclkid must be stripped. Got: ${result}`);
  }
);

runTest(
  "ttclid (TikTok Ads) is removed",
  () => {
    const result = scrubTrackingParams("https://example.com/?ttclid=tt789");
    assert.ok(!result.includes("ttclid"),
      `ttclid must be stripped. Got: ${result}`);
  }
);

runTest(
  "mc_cid and mc_eid (Mailchimp) are both removed",
  () => {
    const result = scrubTrackingParams("https://example.com/?mc_cid=abc&mc_eid=def");
    assert.ok(!result.includes("mc_cid"),
      `mc_cid must be stripped. Got: ${result}`);
    assert.ok(!result.includes("mc_eid"),
      `mc_eid must be stripped. Got: ${result}`);
  }
);

// ── Suite 2: Functional parameters are preserved ──────────────────────────────

console.log("\n[Suite 2] Functional (non-tracking) parameters survive scrubbing");

runTest(
  "standard search param 'q' is preserved alongside stripped gclid",
  () => {
    const result = scrubTrackingParams("https://example.com/search?q=privacy&gclid=abc");
    assert.ok(result.includes("q=privacy"),
      `'q' param must survive. Got: ${result}`);
    assert.ok(!result.includes("gclid"),
      `gclid must be stripped. Got: ${result}`);
  }
);

runTest(
  "'id', 'page', and 'sort' all survive when utm_ is stripped",
  () => {
    const result = scrubTrackingParams(
      "https://example.com/items?id=42&page=3&sort=asc&utm_source=google"
    );
    assert.ok(result.includes("id=42"),    `'id' must survive. Got: ${result}`);
    assert.ok(result.includes("page=3"),   `'page' must survive. Got: ${result}`);
    assert.ok(result.includes("sort=asc"), `'sort' must survive. Got: ${result}`);
    assert.ok(!result.includes("utm_"),    `utm_ must be stripped. Got: ${result}`);
  }
);

runTest(
  "URL with no tracking params is returned byte-for-byte unchanged",
  () => {
    const clean = "https://example.com/dashboard?user=alice&tab=settings";
    assert.strictEqual(scrubTrackingParams(clean), clean,
      "A URL without tracking params must be returned identical");
  }
);

runTest(
  "URL with no query string at all is returned unchanged",
  () => {
    const clean = "https://example.com/about";
    assert.strictEqual(scrubTrackingParams(clean), clean,
      "A URL with no query string must not be mutated");
  }
);

runTest(
  "URL fragment (#anchor) is preserved after tracking param is stripped",
  () => {
    const result = scrubTrackingParams(
      "https://example.com/docs?gclid=abc#section-2"
    );
    assert.ok(result.includes("#section-2"),
      `Fragment must be preserved. Got: ${result}`);
    assert.ok(!result.includes("gclid"),
      `gclid must be stripped. Got: ${result}`);
  }
);

// ── Suite 3: Relative URL handling ────────────────────────────────────────────

console.log("\n[Suite 3] Relative URLs are scrubbed correctly");

runTest(
  "relative path: tracking param stripped, functional param preserved, path intact",
  () => {
    const result = scrubTrackingParams("/page?gclid=abc123&q=test");
    assert.ok(!result.includes("gclid"),   `gclid must be stripped. Got: ${result}`);
    assert.ok(result.includes("q=test"),   `'q' must survive. Got: ${result}`);
    assert.ok(result.startsWith("/page"),  `path must be preserved. Got: ${result}`);
  }
);

runTest(
  "relative path with only tracking params → bare path, no trailing '?'",
  () => {
    const result = scrubTrackingParams("/landing?utm_source=email&utm_medium=cpc");
    assert.ok(!result.includes("utm_"),  `utm_ must be stripped. Got: ${result}`);
    assert.ok(!result.includes("?"),     `trailing '?' must be dropped. Got: ${result}`);
    assert.strictEqual(result, "/landing");
  }
);

runTest(
  "relative path with fragment: tracking stripped, fragment preserved",
  () => {
    const result = scrubTrackingParams("/docs?fbclid=xyz#intro");
    assert.ok(!result.includes("fbclid"), `fbclid must be stripped. Got: ${result}`);
    assert.ok(result.includes("#intro"),  `fragment must survive. Got: ${result}`);
  }
);

// ── Suite 4: Mixed tracking + functional parameters ───────────────────────────

console.log("\n[Suite 4] Mixed params — tracking stripped, routing params preserved");

runTest(
  "tracking param first, functional param second",
  () => {
    const result = scrubTrackingParams("https://example.com/?gclid=abc&ref=homepage");
    assert.ok(!result.includes("gclid"),        `gclid must be stripped. Got: ${result}`);
    assert.ok(result.includes("ref=homepage"),  `'ref' must survive. Got: ${result}`);
  }
);

runTest(
  "functional param first, tracking param last",
  () => {
    const result = scrubTrackingParams("https://example.com/?ref=homepage&fbclid=xyz");
    assert.ok(!result.includes("fbclid"),       `fbclid must be stripped. Got: ${result}`);
    assert.ok(result.includes("ref=homepage"),  `'ref' must survive. Got: ${result}`);
  }
);

runTest(
  "interleaved tracking and functional params — only tracking removed",
  () => {
    const result = scrubTrackingParams(
      "https://example.com/?a=1&utm_source=x&b=2&gclid=y&c=3"
    );
    assert.ok(result.includes("a=1"),          `'a' must survive. Got: ${result}`);
    assert.ok(result.includes("b=2"),          `'b' must survive. Got: ${result}`);
    assert.ok(result.includes("c=3"),          `'c' must survive. Got: ${result}`);
    assert.ok(!result.includes("utm_source"),  `utm_source must be stripped. Got: ${result}`);
    assert.ok(!result.includes("gclid"),       `gclid must be stripped. Got: ${result}`);
  }
);

// ── Suite 5: Bad-input boundary handling ─────────────────────────────────────

console.log("\n[Suite 5] Bad-input boundaries → safe return without throwing");

runTest("null → empty string",
  () => assert.strictEqual(scrubTrackingParams(null), ""));

runTest("undefined → empty string",
  () => assert.strictEqual(scrubTrackingParams(undefined), ""));

runTest("empty string → empty string",
  () => assert.strictEqual(scrubTrackingParams(""), ""));

runTest("whitespace-only string → empty string",
  () => assert.strictEqual(scrubTrackingParams("   "), ""));

runTest("number input → empty string",
  () => assert.strictEqual(scrubTrackingParams(42), ""));

runTest("boolean input → empty string",
  () => assert.strictEqual(scrubTrackingParams(true), ""));

runTest("array input → empty string",
  () => assert.strictEqual(scrubTrackingParams(["https://example.com"]), ""));

runTest(
  "unparseable plain string → raw input returned unchanged (not URL-encoded)",
  () => {
    const junk = "not a url at all !!!";
    assert.strictEqual(scrubTrackingParams(junk), junk,
      "Unparseable strings must be returned raw — not empty, not mutated");
  }
);

// ── Final result ──────────────────────────────────────────────────────────────

const divider = "─".repeat(62);
console.log(`\n${divider}`);

if (totalFailed === 0) {
  console.log(
    `[PASS] All ${totalPassed} assertions passed.` +
    ` URL tracking-param scrubber contract fully verified.`
  );
  process.exit(0);
} else {
  console.error(
    `[FAIL] ${totalFailed} of ${totalPassed + totalFailed} assertions failed.`
  );
  process.exit(1);
}
