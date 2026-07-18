import { describe, expect, it } from "vitest";

import { normalizeInternalRouteHref } from "@/lib/navigation/routes";

/**
 * Characterization tests for normalizeInternalRouteHref
 * (hushh-webapp/lib/navigation/routes.ts) when a query string is positioned
 * BEFORE what look like routing directories
 * (e.g. /search?q=open/legal/privacy).
 *
 * TRUTH-FIRST (verified against the source):
 *   normalizeInternalRouteHref is a pure allow/deny gate over the trimmed
 *   string:
 *     const href = String(value ?? "").trim();
 *     if (!href) return null;
 *     if (!href.startsWith("/") || href.startsWith("//")) return null;
 *     if (/[\r\n]/.test(href)) return null;
 *     return href;
 *   It does NOT parse query strings, does NOT split on "?", does NOT segment on
 *   "/", and does NOT reorder/escape anything. A "?" and any "/" after it are
 *   ordinary characters inside the opaque path string. Consequences pinned:
 *     - A rooted href whose query precedes directory-looking text is returned
 *       BYTE-FOR-BYTE (no query/segment separation, no breaking into markers).
 *     - The slashes after "?" are NOT treated as distinct segment markers;
 *       the whole tail is retained as one literal string.
 *     - Deny rules are unaffected by query content: missing leading slash and
 *       protocol-relative "//" still return null; CRLF still returns null.
 *     - The ONLY mutation is outer trim().
 */

describe("normalizeInternalRouteHref — query strings clashing with directory markers", () => {
  it("returns a query-before-directories href byte-for-byte", () => {
    expect(normalizeInternalRouteHref("/search?q=open/legal/privacy")).toBe(
      "/search?q=open/legal/privacy"
    );
  });

  it("does not split the tail into segments after the question mark", () => {
    const out = normalizeInternalRouteHref("/search?q=a/b/c/d");
    expect(out).toBe("/search?q=a/b/c/d");
    // No segmentation occurred: the post-"?" slashes are still literal.
    expect(out).toContain("?q=a/b/c/d");
  });

  it("retains multiple question marks and slashes verbatim", () => {
    expect(
      normalizeInternalRouteHref("/search?q=open/legal?ref=x/y/privacy")
    ).toBe("/search?q=open/legal?ref=x/y/privacy");
  });

  it("preserves a query that itself contains an encoded slash and a raw slash", () => {
    expect(
      normalizeInternalRouteHref("/search?path=%2Fdeep/legal/privacy")
    ).toBe("/search?path=%2Fdeep/legal/privacy");
  });

  it("trims surrounding whitespace but keeps the inner query/path intact", () => {
    expect(
      normalizeInternalRouteHref("  /search?q=open/legal/privacy  ")
    ).toBe("/search?q=open/legal/privacy");
  });

  it("rejects a query-leading href with no leading slash", () => {
    expect(normalizeInternalRouteHref("search?q=open/legal/privacy")).toBeNull();
  });

  it("rejects a protocol-relative href even when a query follows", () => {
    expect(
      normalizeInternalRouteHref("//host/search?q=open/legal/privacy")
    ).toBeNull();
  });

  it("rejects an embedded newline inside the query tail", () => {
    expect(
      normalizeInternalRouteHref("/search?q=open\n/legal/privacy")
    ).toBeNull();
  });
});
