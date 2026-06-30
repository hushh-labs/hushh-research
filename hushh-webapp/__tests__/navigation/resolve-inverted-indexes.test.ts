import { describe, expect, it } from "vitest";

import { resolveInternalRouteHref } from "@/lib/navigation/routes";

// Characterization tests for resolveInternalRouteHref
// (hushh-webapp/lib/navigation/routes.ts) when a query string supplies
// explicit bracketed array indices OUT OF ORDER, e.g.
//   "/api/v1?items[1]=b&items[0]=a"
//
// TRUTH-FIRST — CURRENT CONTRACT (verified against source):
//
//   resolveInternalRouteHref(value, fallback) =
//     normalizeInternalRouteHref(value) ?? fallback
//
//   normalizeInternalRouteHref only:
//     1. coerces to string and trims,
//     2. returns null if empty,
//     3. returns null unless it starts with "/" (and not "//"),
//     4. returns null if it contains CR or LF,
//     5. otherwise returns the href UNCHANGED.
//
// CORRECTION TO THE TASK PREMISE: there is NO query parser, "extraction
// engine," array aggregation, or index ordering here. resolveInternalRouteHref
// does not decode, reorder, deduplicate, or restructure bracketed indices.
// A valid same-origin path is returned byte-for-byte verbatim, so inverted
// indices like items[1] before items[0] survive in their original literal
// order. These tests pin that verbatim passthrough.

const FALLBACK = "/fallback";

describe("resolveInternalRouteHref — bracketed array indices are passed through verbatim (no reordering)", () => {
  it("returns inverted bracketed indices in their original literal order", () => {
    const href = "/api/v1?items[1]=b&items[0]=a";
    expect(resolveInternalRouteHref(href, FALLBACK)).toBe(href);
  });

  it("does not sort or aggregate indices into a compiled structure", () => {
    const href = "/list?x[2]=c&x[0]=a&x[1]=b";
    const out = resolveInternalRouteHref(href, FALLBACK);
    // Order is preserved exactly: 2, then 0, then 1.
    expect(out).toBe(href);
    expect(out.indexOf("x[2]")).toBeLessThan(out.indexOf("x[0]"));
    expect(out.indexOf("x[0]")).toBeLessThan(out.indexOf("x[1]"));
  });

  it("preserves duplicate indices without deduplication", () => {
    const href = "/q?a[0]=first&a[0]=second";
    expect(resolveInternalRouteHref(href, FALLBACK)).toBe(href);
  });

  it("does not URL-decode the bracket characters", () => {
    const href = "/q?items%5B1%5D=b&items%5B0%5D=a";
    const out = resolveInternalRouteHref(href, FALLBACK);
    // Percent-encoded brackets remain encoded; no decoding pass occurs.
    expect(out).toBe(href);
    expect(out).toContain("%5B1%5D");
    expect(out).toContain("%5B0%5D");
  });

  it("keeps non-numeric / nested bracket keys verbatim", () => {
    const href = "/q?obj[b]=2&obj[a]=1&obj[a][0]=z";
    expect(resolveInternalRouteHref(href, FALLBACK)).toBe(href);
  });

  it("trims surrounding whitespace but otherwise leaves the indexed query intact", () => {
    const href = "  /api/v1?items[1]=b&items[0]=a  ";
    expect(resolveInternalRouteHref(href, FALLBACK)).toBe(
      "/api/v1?items[1]=b&items[0]=a",
    );
  });

  it("falls back when the indexed-query value is not a same-origin path", () => {
    // Protocol-relative and absolute URLs are rejected regardless of indices.
    expect(
      resolveInternalRouteHref("//evil.example.com?items[1]=b&items[0]=a", FALLBACK),
    ).toBe(FALLBACK);
    expect(
      resolveInternalRouteHref("https://x.example?items[1]=b", FALLBACK),
    ).toBe(FALLBACK);
  });

  it("falls back when a CRLF is injected around the indexed query", () => {
    expect(
      resolveInternalRouteHref("/api/v1?items[1]=b\n&items[0]=a", FALLBACK),
    ).toBe(FALLBACK);
  });
});
