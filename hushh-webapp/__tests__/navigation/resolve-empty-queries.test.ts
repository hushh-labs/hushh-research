import { describe, expect, it } from "vitest";

import { resolveInternalRouteHref } from "@/lib/navigation/routes";

// Characterization tests for resolveInternalRouteHref
// (hushh-webapp/lib/navigation/routes.ts) focused on trailing / empty query
// tokens (e.g. "/search?q=").
//
// TRUTH-FIRST: resolveInternalRouteHref does NO query parsing. Its body is
// `normalizeInternalRouteHref(value) ?? fallback`, which trims, rejects empty /
// non-"/"-leading / protocol-relative ("//") / CR-LF inputs, and otherwise
// returns the input string VERBATIM. There is therefore no "parsing collapse"
// to guard against — an empty query token like "?q=" is preserved exactly
// because the string is never decomposed.

describe("resolveInternalRouteHref — empty / trailing query tokens", () => {
  it("preserves a single trailing empty query value verbatim", () => {
    expect(resolveInternalRouteHref("/search?q=", "/fallback")).toBe(
      "/search?q="
    );
  });

  it("preserves a bare '?' with no key", () => {
    expect(resolveInternalRouteHref("/search?", "/fallback")).toBe("/search?");
  });

  it("preserves a bare key with no '=' (no collapse to '?key=')", () => {
    expect(resolveInternalRouteHref("/search?q", "/fallback")).toBe("/search?q");
  });

  it("preserves multiple empty values in original order", () => {
    expect(resolveInternalRouteHref("/p?a=&b=&c=", "/fallback")).toBe(
      "/p?a=&b=&c="
    );
  });

  it("preserves a mix of empty and populated values exactly", () => {
    expect(resolveInternalRouteHref("/p?a=&b=2&c=", "/fallback")).toBe(
      "/p?a=&b=2&c="
    );
  });

  it("preserves a trailing '&' after an empty value", () => {
    expect(resolveInternalRouteHref("/p?a=&", "/fallback")).toBe("/p?a=&");
  });

  it("trims surrounding whitespace but keeps the empty query token", () => {
    expect(resolveInternalRouteHref("   /search?q=   ", "/fallback")).toBe(
      "/search?q="
    );
  });

  it("returns the fallback for an external URL even with an empty query", () => {
    expect(
      resolveInternalRouteHref("https://evil.com/search?q=", "/fallback")
    ).toBe("/fallback");
    expect(
      resolveInternalRouteHref("//evil.com/search?q=", "/fallback")
    ).toBe("/fallback");
  });
});
