import { describe, expect, it } from "vitest";

import { normalizeInternalRouteHref } from "@/lib/navigation/routes";

// Characterization tests for normalizeInternalRouteHref
// (hushh-webapp/lib/navigation/routes.ts) focused on deep multi-segment paths
// that carry saturated query strings.
//
// Real guard:
//   const href = String(value ?? "").trim();
//   if (!href) return null;
//   if (!href.startsWith("/") || href.startsWith("//")) return null;
//   if (/[\r\n]/.test(href)) return null;
//   return href;
//
// TRUTH-FIRST: the guard does NOT parse, merge, reorder, dedupe, or isolate
// query parameters, and it does NOT collapse to a root segment. It is a pure
// prefix/character gate. If the input starts with a single "/", is not "//",
// and has no CR/LF, the ENTIRE string — path + "?" + full query string — is
// returned VERBATIM. There is no "structural parameter merge" behavior to pin;
// the whole query is preserved exactly as given.

describe("normalizeInternalRouteHref — multi-segment paths with query merges", () => {
  it("preserves a deep path with multiple query params verbatim (no isolation)", () => {
    expect(
      normalizeInternalRouteHref("/api/legal/v1/doc?type=json&status=active")
    ).toBe("/api/legal/v1/doc?type=json&status=active");
  });

  it("does NOT reorder or dedupe repeated query keys", () => {
    expect(
      normalizeInternalRouteHref("/x?a=1&a=2&b=3&a=4")
    ).toBe("/x?a=1&a=2&b=3&a=4");
  });

  it("preserves an empty-value and a valueless param exactly", () => {
    expect(normalizeInternalRouteHref("/x?a=&b&c=3")).toBe("/x?a=&b&c=3");
  });

  it("keeps a trailing '?' with no params", () => {
    expect(normalizeInternalRouteHref("/x?")).toBe("/x?");
  });

  it("retains a hash fragment after the query string", () => {
    expect(normalizeInternalRouteHref("/x?a=1#frag")).toBe("/x?a=1#frag");
  });

  it("preserves percent-encoded values inside the query verbatim", () => {
    expect(
      normalizeInternalRouteHref("/search?q=hello%20world&lang=en%2Dus")
    ).toBe("/search?q=hello%20world&lang=en%2Dus");
  });

  it("trims surrounding whitespace but keeps the full query intact", () => {
    expect(
      normalizeInternalRouteHref("   /api/doc?type=json&status=active   ")
    ).toBe("/api/doc?type=json&status=active");
  });

  it("rejects a protocol-relative path even when it carries a query string", () => {
    expect(
      normalizeInternalRouteHref("//evil.com/doc?type=json")
    ).toBeNull();
  });
});
