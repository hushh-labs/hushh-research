import { describe, expect, it } from "vitest";

import { resolveInternalRouteHref } from "@/lib/navigation/routes";

// Characterization tests for resolveInternalRouteHref
// (hushh-webapp/lib/navigation/routes.ts) focused on query parameters that share
// a name but differ ONLY by letter casing (e.g. `userId` vs `userid`).
//
// TRUTH-FIRST — IMPORTANT CORRECTION: the premise that resolveInternalRouteHref
// "parses search parameters" or applies "case-sensitivity invariants" / an
// "override mapping" between duplicate-by-case keys is FALSE. It does NOT parse
// the query string at all. Its entire body is:
//
//   export function resolveInternalRouteHref(value, fallback): string {
//     return normalizeInternalRouteHref(value) ?? fallback;
//   }
//
// normalizeInternalRouteHref only: trims, rejects empty/non-rooted/protocol-
// relative/interior-CRLF hrefs, and otherwise returns the href VERBATIM. The
// query string is OPAQUE — every key is preserved as written, in original order,
// with no dedupe, no case-folding, and no last-wins/first-wins override. There is
// no map keyed by parameter name, so "case collision" never occurs.
//
// These tests pin that real contract: differently-cased duplicate keys are
// carried through untouched, and `fallback` is only used when the whole href is
// rejected by normalize — never as a per-parameter resolution.

const FALLBACK = "/";

describe("resolveInternalRouteHref — query key casing", () => {
  it("preserves BOTH differently-cased duplicate keys verbatim (no dedupe/override)", () => {
    expect(
      resolveInternalRouteHref("/profile?userId=123&userid=456", FALLBACK)
    ).toBe("/profile?userId=123&userid=456");
  });

  it("retains original key order for mixed-case duplicates", () => {
    expect(
      resolveInternalRouteHref("/profile?userid=456&userId=123", FALLBACK)
    ).toBe("/profile?userid=456&userId=123");
  });

  it("does NOT case-fold keys (UserID stays UserID)", () => {
    const out = resolveInternalRouteHref(
      "/profile?UserID=1&USERID=2&userid=3",
      FALLBACK
    );
    expect(out).toBe("/profile?UserID=1&USERID=2&userid=3");
    expect(out).toContain("UserID=1");
    expect(out).toContain("USERID=2");
    expect(out).toContain("userid=3");
  });

  it("treats exact same-case duplicate keys as opaque too (both kept)", () => {
    expect(
      resolveInternalRouteHref("/profile?userId=123&userId=456", FALLBACK)
    ).toBe("/profile?userId=123&userId=456");
  });

  it("returns fallback only when the whole href is invalid, not per-key", () => {
    // Protocol-relative href is rejected by normalize → fallback used.
    expect(
      resolveInternalRouteHref("//evil.com/profile?userId=1&userid=2", FALLBACK)
    ).toBe(FALLBACK);
  });

  it("returns fallback for an empty value (no query to resolve)", () => {
    expect(resolveInternalRouteHref("", FALLBACK)).toBe(FALLBACK);
  });
});
