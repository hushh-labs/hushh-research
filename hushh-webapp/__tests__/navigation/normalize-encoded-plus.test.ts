import { describe, expect, it } from "vitest";

import { normalizeInternalRouteHref } from "@/lib/navigation/routes";

// Characterization tests for normalizeInternalRouteHref
// (hushh-webapp/lib/navigation/routes.ts) focused on percent-encoded plus signs
// (`%2B`) embedded directly inside standard route segments.
//
// TRUTH-FIRST (verified against the source):
//   normalizeInternalRouteHref performs ONLY these steps:
//     1. String(value ?? "").trim()
//     2. reject empty
//     3. reject if it does not start with "/" OR starts with "//"
//     4. reject if it contains a raw CR or LF (/[\r\n]/)
//     5. otherwise return the href verbatim
//   There is NO percent-decoding, NO decodeURIComponent, NO segment parsing.
//   Therefore a `%2B` token is treated as an opaque, un-evaluated character
//   sequence: it is neither decoded to "+" nor re-encoded — the literal three
//   characters "%2B" are preserved exactly as written. These tests pin that.

describe("normalizeInternalRouteHref — percent-encoded plus signs are preserved verbatim", () => {
  it("preserves %2B inside a single route segment exactly (no decoding)", () => {
    expect(normalizeInternalRouteHref("/blog/tags/react%2Btypescript")).toBe(
      "/blog/tags/react%2Btypescript"
    );
  });

  it("does NOT decode %2B into a literal plus sign", () => {
    const out = normalizeInternalRouteHref("/blog/tags/react%2Btypescript");
    expect(out).not.toBe("/blog/tags/react+typescript");
    expect(out).toContain("%2B");
    expect(out).not.toContain("+");
  });

  it("preserves multiple %2B tokens across multiple segments", () => {
    expect(
      normalizeInternalRouteHref("/a%2Bb/c%2Bd/e%2Bf")
    ).toBe("/a%2Bb/c%2Bd/e%2Bf");
  });

  it("preserves lowercase %2b without case-normalizing the hex digits", () => {
    expect(normalizeInternalRouteHref("/blog/tags/react%2btypescript")).toBe(
      "/blog/tags/react%2btypescript"
    );
  });

  it("preserves a %2B that appears inside the query string portion", () => {
    expect(normalizeInternalRouteHref("/search?q=a%2Bb")).toBe(
      "/search?q=a%2Bb"
    );
  });

  it("keeps a literal raw '+' untouched too (no encoding is applied)", () => {
    expect(normalizeInternalRouteHref("/blog/tags/react+typescript")).toBe(
      "/blog/tags/react+typescript"
    );
  });
});

describe("normalizeInternalRouteHref — guard rails still apply around %2B tokens", () => {
  it("returns null for a protocol-relative href even when it carries %2B", () => {
    expect(normalizeInternalRouteHref("//evil.example/a%2Bb")).toBeNull();
  });

  it("returns null for a non-rooted href that contains %2B", () => {
    expect(normalizeInternalRouteHref("blog/tags/react%2Bts")).toBeNull();
  });

  it("trims surrounding whitespace but keeps the inner %2B intact", () => {
    expect(normalizeInternalRouteHref("  /tags/a%2Bb  ")).toBe("/tags/a%2Bb");
  });
});
