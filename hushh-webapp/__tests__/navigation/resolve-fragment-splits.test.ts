import { describe, expect, it } from "vitest";

import { resolveInternalRouteHref } from "@/lib/navigation/routes";

// Characterization tests for resolveInternalRouteHref
// (hushh-webapp/lib/navigation/routes.ts) when an internal route value carries
// a query string whose value payload itself contains multiple nested hash
// symbols, e.g. "/search?q=tags#react#node".
//
// TRUTH-FIRST — CURRENT CONTRACT (verified against source):
//
//   resolveInternalRouteHref(value, fallback) is literally:
//       normalizeInternalRouteHref(value) ?? fallback
//
//   and normalizeInternalRouteHref only:
//     1. coerces to string and trims,
//     2. returns null if empty,
//     3. returns null if it does NOT start with "/" OR starts with "//",
//     4. returns null if it contains a CR or LF,
//     5. otherwise returns the trimmed string VERBATIM.
//
//   There is NO query parser, NO URL/URLSearchParams parsing, and NO splitting
//   on "?" or "#". The "?", the query value, and every "#...#..." anchor
//   segment are preserved as one opaque string.
//
// CORRECTION TO THE TASK PREMISE: there is no "parsing matrix" that isolates
// the active query block from trailing anchor parameters. A valid internal
// href is returned exactly as given (after trim), hashes and all. These tests
// pin that pass-through-verbatim contract.

const FALLBACK = "/fallback";

describe("resolveInternalRouteHref — multi-hash query payloads pass through verbatim (no parsing/isolation)", () => {
  it("returns '/search?q=tags#react#node' unchanged — query + multiple anchors preserved as one string", () => {
    expect(resolveInternalRouteHref("/search?q=tags#react#node", FALLBACK)).toBe(
      "/search?q=tags#react#node",
    );
  });

  it("does not strip, reorder, or split anchors off the query value", () => {
    const out = resolveInternalRouteHref("/search?q=tags#react#node", FALLBACK);
    // Everything after "?" is retained, including both "#" segments.
    expect(out).toContain("?q=tags");
    expect(out).toContain("#react#node");
    // No isolation: the result is NOT reduced to just the query block.
    expect(out).not.toBe("/search?q=tags");
    expect(out).not.toBe("/search");
  });

  it("preserves a leading '#' immediately after the query and additional '#' delimiters", () => {
    expect(
      resolveInternalRouteHref("/list?tab=open#a#b#c", FALLBACK),
    ).toBe("/list?tab=open#a#b#c");
  });

  it("trims surrounding whitespace but keeps the inner query+hash payload intact", () => {
    expect(
      resolveInternalRouteHref("   /search?q=tags#react#node   ", FALLBACK),
    ).toBe("/search?q=tags#react#node");
  });

  it("returns the fallback for protocol-relative input even when it carries multi-hash payloads", () => {
    expect(
      resolveInternalRouteHref("//evil.example.com/search?q=tags#react#node", FALLBACK),
    ).toBe(FALLBACK);
  });

  it("returns the fallback when a CR/LF is injected into the multi-hash payload", () => {
    expect(
      resolveInternalRouteHref("/search?q=tags#react\n#node", FALLBACK),
    ).toBe(FALLBACK);
  });

  it("returns the fallback for null/empty, and verbatim for a bare hash-only query", () => {
    expect(resolveInternalRouteHref(null, FALLBACK)).toBe(FALLBACK);
    expect(resolveInternalRouteHref("", FALLBACK)).toBe(FALLBACK);
    expect(resolveInternalRouteHref("/p?x=#", FALLBACK)).toBe("/p?x=#");
  });
});
