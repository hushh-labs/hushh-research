import { describe, expect, it } from "vitest";

import { resolveInternalRouteHref } from "@/lib/navigation/routes";

// Characterization tests for resolveInternalRouteHref
// (hushh-webapp/lib/navigation/routes.ts) focused on hrefs that use SEMICOLONS as
// parameter separators (e.g. `/api;session=xyz;mode=dark` or
// `/p?session=xyz;mode=dark`) instead of ampersands.
//
// TRUTH-FIRST — IMPORTANT CORRECTION: the premise that resolveInternalRouteHref
// "parses parameters", supports "semicolons as standard parameter separators", or
// performs any "parsing step" / "tracking & extraction parameter mapping" is
// FALSE. It does NOT parse the query string at all. Its entire body is:
//
//   export function resolveInternalRouteHref(value, fallback): string {
//     return normalizeInternalRouteHref(value) ?? fallback;
//   }
//
// normalizeInternalRouteHref only: trims, rejects empty/non-rooted/protocol-
// relative/interior-CRLF hrefs, and otherwise returns the href VERBATIM. There is
// no ampersand parsing AND no semicolon parsing — the entire path+query+matrix
// segment is OPAQUE. Semicolons are not treated as separators, not split, not
// decoded, and not mapped to any key/value structure. The function skips parsing
// entirely; it either returns the input string unchanged or returns `fallback`
// when the whole href is rejected.
//
// These tests pin that real contract: semicolon-delimited segments pass through
// untouched, and `fallback` is used only on whole-href rejection.

const FALLBACK = "/";

describe("resolveInternalRouteHref — semicolon parameter separators", () => {
  it("passes a matrix-style semicolon path through verbatim (no parsing/split)", () => {
    expect(
      resolveInternalRouteHref("/api;session=xyz;mode=dark", FALLBACK)
    ).toBe("/api;session=xyz;mode=dark");
  });

  it("does NOT split a semicolon-delimited query into key/value pairs", () => {
    expect(
      resolveInternalRouteHref("/profile?session=xyz;mode=dark", FALLBACK)
    ).toBe("/profile?session=xyz;mode=dark");
  });

  it("preserves a mix of ampersand and semicolon separators exactly as written", () => {
    expect(
      resolveInternalRouteHref("/p?a=1&b=2;c=3&d=4", FALLBACK)
    ).toBe("/p?a=1&b=2;c=3&d=4");
  });

  it("does not decode encoded semicolons (%3B stays %3B)", () => {
    expect(
      resolveInternalRouteHref("/p?token=a%3Bb%3Bc", FALLBACK)
    ).toBe("/p?token=a%3Bb%3Bc");
  });

  it("returns fallback only when the whole href is invalid, not per-segment", () => {
    expect(
      resolveInternalRouteHref("//evil.com/api;session=xyz", FALLBACK)
    ).toBe(FALLBACK);
  });

  it("returns fallback for an empty value (nothing to resolve)", () => {
    expect(resolveInternalRouteHref("", FALLBACK)).toBe(FALLBACK);
  });
});
