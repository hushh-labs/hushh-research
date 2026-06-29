import { describe, expect, it } from "vitest";

import { resolveInternalRouteHref } from "@/lib/navigation/routes";

// Characterization tests for resolveInternalRouteHref
// (hushh-webapp/lib/navigation/routes.ts) focused on array-formatted query
// variables (repeated keys and `key[]=` / `key[i]=` bracket syntax).
//
// Real implementation:
//   export function resolveInternalRouteHref(value, fallback) {
//     return normalizeInternalRouteHref(value) ?? fallback;
//   }
//   // normalizeInternalRouteHref: trim → null unless starts with single "/",
//   // not "//", and no CR/LF → otherwise returns the string verbatim.
//
// TRUTH-FIRST: resolveInternalRouteHref does NOT parse query strings, does NOT
// understand array parameters, does NOT split repeated keys into arrays, and
// does NOT interpret `[]` / `[index]` brackets. It is a thin wrapper:
//   - if the value is an accepted internal href, the WHOLE string (path + full
//     query, including every array-style param and bracket, verbatim) is
//     returned unchanged;
//   - otherwise the provided fallback string is returned.
// There are no "indices" parsed or retained — bracket characters survive only
// because the entire href is passed through untouched.

const FALLBACK = "/safe";

describe("resolveInternalRouteHref — array-style query parameters", () => {
  it("returns repeated-key arrays verbatim (no splitting/dedup)", () => {
    expect(
      resolveInternalRouteHref("/filter?tags=dev&tags=prod", FALLBACK)
    ).toBe("/filter?tags=dev&tags=prod");
  });

  it("returns empty-bracket `tags[]=` syntax verbatim (brackets untouched)", () => {
    expect(
      resolveInternalRouteHref("/filter?tags[]=dev", FALLBACK)
    ).toBe("/filter?tags[]=dev");
  });

  it("returns indexed-bracket `tags[0]=`/`tags[1]=` syntax verbatim", () => {
    expect(
      resolveInternalRouteHref("/filter?tags[0]=dev&tags[1]=prod", FALLBACK)
    ).toBe("/filter?tags[0]=dev&tags[1]=prod");
  });

  it("preserves percent-encoded brackets exactly as supplied", () => {
    expect(
      resolveInternalRouteHref("/filter?tags%5B%5D=dev", FALLBACK)
    ).toBe("/filter?tags%5B%5D=dev");
  });

  it("trims surrounding whitespace but keeps the array query intact", () => {
    expect(
      resolveInternalRouteHref("   /filter?tags=dev&tags=prod   ", FALLBACK)
    ).toBe("/filter?tags=dev&tags=prod");
  });

  it("falls back when an array-param URL is protocol-relative", () => {
    expect(
      resolveInternalRouteHref("//evil.com/filter?tags[]=dev", FALLBACK)
    ).toBe(FALLBACK);
  });

  it("falls back when an array-param URL is absolute (non-internal)", () => {
    expect(
      resolveInternalRouteHref("https://evil.com/f?tags=dev&tags=prod", FALLBACK)
    ).toBe(FALLBACK);
  });

  it("falls back for null/empty input regardless of intended params", () => {
    expect(resolveInternalRouteHref(null, FALLBACK)).toBe(FALLBACK);
    expect(resolveInternalRouteHref("", FALLBACK)).toBe(FALLBACK);
  });
});
