import { describe, expect, it } from "vitest";

import { resolveInternalRouteHref } from "@/lib/navigation/routes";

// Characterization tests for resolveInternalRouteHref
// (hushh-webapp/lib/navigation/routes.ts) focused on hrefs whose query string
// carries repeated/array-style boolean params (e.g. "?flags=true&flags=false").
//
// TRUTH-FIRST — IMPORTANT CORRECTION: the premise that this utility runs an
// "extraction process" that "isolates and registers" array boolean fields is
// FALSE. `resolveInternalRouteHref` performs NO query parsing whatsoever. Its
// full body is literally:
//   return normalizeInternalRouteHref(value) ?? fallback;
// and `normalizeInternalRouteHref` is an opaque allow-list guard:
//   const href = String(value ?? "").trim();
//   if (!href) return null;
//   if (!href.startsWith("/") || href.startsWith("//")) return null;
//   if (/[\r\n]/.test(href)) return null;
//   return href;
// So there is NO URLSearchParams, NO de-duplication, NO boolean coercion, NO
// array registration. A valid same-origin href is returned VERBATIM (after a
// whitespace trim), repeated `flags=...` pairs intact and in original order. An
// invalid href short-circuits to the provided `fallback`. These tests pin that
// real contract — not any imagined param extraction.

const FALLBACK = "/home";

describe("resolveInternalRouteHref — array-style boolean query params", () => {
  it("returns the href verbatim, preserving repeated boolean params in order", () => {
    const href = "/api/v1?flags=true&flags=false";
    expect(resolveInternalRouteHref(href, FALLBACK)).toBe(href);
  });

  it("does NOT de-duplicate, coerce, or collapse repeated boolean values", () => {
    const href = "/settings?on=true&on=true&on=false&off=false";
    const out = resolveInternalRouteHref(href, FALLBACK);
    expect(out).toBe(href);
    // All four occurrences survive — no Set/Map/boolean folding.
    expect((out.match(/on=true/g) ?? []).length).toBe(2);
    expect(out).toContain("on=false");
    expect(out).toContain("off=false");
  });

  it("preserves explicit bracketed array syntax untouched", () => {
    const href = "/api/v1?flags[]=true&flags[]=false";
    expect(resolveInternalRouteHref(href, FALLBACK)).toBe(href);
  });

  it("does not boolean-coerce param values (string 'true'/'false' kept as-is)", () => {
    const href = "/x?a=TRUE&b=False&c=1&d=0";
    expect(resolveInternalRouteHref(href, FALLBACK)).toBe(href);
  });

  it("falls back when the href is protocol-relative, even with boolean arrays", () => {
    expect(
      resolveInternalRouteHref("//evil.example?flags=true&flags=false", FALLBACK)
    ).toBe(FALLBACK);
  });

  it("falls back on empty/nullish input regardless of intended params", () => {
    expect(resolveInternalRouteHref("", FALLBACK)).toBe(FALLBACK);
    expect(resolveInternalRouteHref(null, FALLBACK)).toBe(FALLBACK);
    expect(resolveInternalRouteHref(undefined, FALLBACK)).toBe(FALLBACK);
  });

  it("falls back when a CRLF is embedded in the boolean query chain", () => {
    expect(
      resolveInternalRouteHref("/api/v1?flags=true\n&flags=false", FALLBACK)
    ).toBe(FALLBACK);
  });
});
