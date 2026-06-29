import { describe, expect, it } from "vitest";

import { resolveInternalRouteHref } from "@/lib/navigation/routes";

// Characterization tests for resolveInternalRouteHref
// (hushh-webapp/lib/navigation/routes.ts) focused on hrefs whose query strings
// contain "null" / empty parameter values (e.g. /dashboard?filter=null&mode=).
//
// Real implementation:
//   export function resolveInternalRouteHref(value, fallback) {
//     return normalizeInternalRouteHref(value) ?? fallback;
//   }
//   normalizeInternalRouteHref: trims; null if empty, not "/"-prefixed,
//   "//"-prefixed, or containing \r/\n; otherwise returns the href verbatim.
//
// TRUTH-FIRST: resolveInternalRouteHref does NOT parse, decode, map, or strip
// query parameters. There is no per-field handling. A query string is opaque
// text inside the href. So "filter=null" and "mode=" are preserved EXACTLY as
// written — `null` stays the literal 4-char string "null", and an empty value
// (`mode=`) keeps its trailing `=`. The only decision is whole-href accept
// (returned verbatim) vs. reject (replaced wholesale by `fallback`). The
// premise of "mapping fields" or "stripping them seamlessly" is FALSE at this
// layer; these tests pin the verbatim-or-fallback contract.

const FALLBACK = "/home";

describe("resolveInternalRouteHref — null/empty query parameters", () => {
  it("preserves a literal `filter=null` and empty `mode=` verbatim (no field mapping/stripping)", () => {
    expect(
      resolveInternalRouteHref("/dashboard?filter=null&mode=", FALLBACK)
    ).toBe("/dashboard?filter=null&mode=");
  });

  it("keeps the trailing `=` of an empty-valued param (does not strip it)", () => {
    expect(resolveInternalRouteHref("/x?a=", FALLBACK)).toBe("/x?a=");
  });

  it("keeps a bare key with no `=` verbatim", () => {
    expect(resolveInternalRouteHref("/x?flag", FALLBACK)).toBe("/x?flag");
  });

  it("does not coalesce the literal string 'null' to anything else", () => {
    const out = resolveInternalRouteHref("/p?v=null", FALLBACK);
    expect(out).toBe("/p?v=null");
    expect(out).toContain("null");
  });

  it("preserves multiple empty params and their `&` separators", () => {
    expect(resolveInternalRouteHref("/p?a=&b=&c=", FALLBACK)).toBe("/p?a=&b=&c=");
  });

  it("returns the fallback when the VALUE itself is null (not the params)", () => {
    expect(resolveInternalRouteHref(null, FALLBACK)).toBe(FALLBACK);
  });

  it("returns the fallback for an empty string value", () => {
    expect(resolveInternalRouteHref("", FALLBACK)).toBe(FALLBACK);
  });

  it("returns the fallback for a protocol-relative href even with null params", () => {
    expect(
      resolveInternalRouteHref("//evil.com?filter=null", FALLBACK)
    ).toBe(FALLBACK);
  });

  it("trims surrounding whitespace but keeps the query (incl. empty values) intact", () => {
    expect(
      resolveInternalRouteHref("  /dashboard?filter=null&mode=  ", FALLBACK)
    ).toBe("/dashboard?filter=null&mode=");
  });
});
