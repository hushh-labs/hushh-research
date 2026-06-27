import { describe, expect, it } from "vitest";

import { resolveInternalRouteHref } from "@/lib/navigation/routes";

// Characterization tests for resolveInternalRouteHref
// (hushh-webapp/lib/navigation/routes.ts).
//
// TRUTH-FIRST PREMISE CORRECTION:
//   The task asked to verify that resolveInternalRouteHref "appends multiple
//   query keys" and preserves "lexicographical or raw declaration order"
//   throughout "resolution limits". Reading the source corrected that premise.
//   resolveInternalRouteHref does NO query construction, parsing, sorting, or
//   reordering. Its entire body is:
//
//     export function resolveInternalRouteHref(value, fallback) {
//       return normalizeInternalRouteHref(value) ?? fallback;
//     }
//
//   So it only: trims, rejects empty / non-"/"-leading / protocol-relative
//   ("//") / CR-LF inputs, and otherwise returns the input string VERBATIM;
//   on rejection it returns the provided fallback.
//
//   (Query KEY ORDERING in this module is the concern of the private withQuery
//   helper, which uses URLSearchParams and emits keys in INSERTION order — but
//   resolveInternalRouteHref never calls withQuery.)
//
//   These tests therefore pin the REAL contract: a pre-formed multi-key query
//   string is passed through with its exact raw order preserved, with zero
//   normalization, and invalid inputs fall back.

describe("resolveInternalRouteHref — multi-param raw order pass-through", () => {
  it("preserves the exact raw order of multiple query keys verbatim", () => {
    const href = "/search?b=2&a=1&c=3";
    expect(resolveInternalRouteHref(href, "/fallback")).toBe(href);
  });

  it("does NOT sort query keys lexicographically", () => {
    const href = "/search?z=1&a=2";
    const out = resolveInternalRouteHref(href, "/fallback");
    expect(out).toBe("/search?z=1&a=2");
    expect(out).not.toBe("/search?a=2&z=1");
  });

  it("preserves duplicate keys in their original positions", () => {
    const href = "/list?tag=red&tag=blue&tag=green";
    expect(resolveInternalRouteHref(href, "/fallback")).toBe(href);
  });

  it("preserves an empty-value key and bare key exactly as written", () => {
    const href = "/p?a=&b&c=3";
    expect(resolveInternalRouteHref(href, "/fallback")).toBe(href);
  });

  it("does not re-encode already percent-encoded query values", () => {
    const href = "/search?q=a%20b&next=%2Fhome";
    expect(resolveInternalRouteHref(href, "/fallback")).toBe(href);
  });

  it("returns the fallback when the value is null/undefined/empty", () => {
    expect(resolveInternalRouteHref(null, "/fallback")).toBe("/fallback");
    expect(resolveInternalRouteHref(undefined, "/fallback")).toBe("/fallback");
    expect(resolveInternalRouteHref("   ", "/fallback")).toBe("/fallback");
  });

  it("returns the fallback for a protocol-relative or external multi-param URL", () => {
    expect(
      resolveInternalRouteHref("//evil.com/x?a=1&b=2", "/fallback")
    ).toBe("/fallback");
    expect(
      resolveInternalRouteHref("https://evil.com/x?a=1&b=2", "/fallback")
    ).toBe("/fallback");
  });

  it("trims surrounding whitespace but keeps interior query order intact", () => {
    expect(resolveInternalRouteHref("  /go?x=1&y=2  ", "/fallback")).toBe(
      "/go?x=1&y=2"
    );
  });
});
