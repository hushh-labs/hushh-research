import { describe, expect, it } from "vitest";

import { resolveInternalRouteHref } from "@/lib/navigation/routes";

// Characterization tests for resolveInternalRouteHref
// (hushh-webapp/lib/navigation/routes.ts) for query strings that carry repeated
// array-style parameters with consecutive empty-string values, e.g.
// `/api/v1?filters=&filters=&filters=active`.
//
// TRUTH-FIRST — LITERAL CONTRACT:
//
//   export function resolveInternalRouteHref(value, fallback): string {
//     return normalizeInternalRouteHref(value) ?? fallback;
//   }
//
// and normalizeInternalRouteHref:
//
//   const href = String(value ?? "").trim();
//   if (!href) return null;
//   if (!href.startsWith("/") || href.startsWith("//")) return null;
//   if (/[\r\n]/.test(href)) return null;
//   return href;
//
// CORRECTION TO THE TASK PREMISE: there is NO query parsing, NO array
// extraction, and NO "construction/retention of blank positions". The function
// is a pure allow/deny gate over the trimmed string. If the href passes the
// three guards it is returned VERBATIM (query block untouched, every empty
// `filters=` preserved exactly in place). If it fails a guard, the FALLBACK is
// returned unchanged. These tests pin that real contract.

const FALLBACK = "/fallback";

describe("resolveInternalRouteHref — array params with consecutive empty strings", () => {
  it("returns the href verbatim, preserving every empty array position", () => {
    expect(
      resolveInternalRouteHref("/api/v1?filters=&filters=&filters=active", FALLBACK),
    ).toBe("/api/v1?filters=&filters=&filters=active");
  });

  it("does not collapse, dedupe, or reorder the repeated empty params", () => {
    const out = resolveInternalRouteHref(
      "/api/v1?filters=&filters=&filters=active",
      FALLBACK,
    );
    // Three `filters=` occurrences are all retained.
    expect(out.match(/filters=/g)?.length).toBe(3);
  });

  it("preserves a fully-empty array (all positions blank) verbatim", () => {
    expect(
      resolveInternalRouteHref("/api/v1?filters=&filters=&filters=", FALLBACK),
    ).toBe("/api/v1?filters=&filters=&filters=");
  });

  it("preserves a leading empty position before a value", () => {
    expect(resolveInternalRouteHref("/x?a=&a=1", FALLBACK)).toBe("/x?a=&a=1");
  });

  it("preserves bracketed array syntax with empty values verbatim", () => {
    expect(
      resolveInternalRouteHref("/x?a[]=&a[]=&a[]=z", FALLBACK),
    ).toBe("/x?a[]=&a[]=&a[]=z");
  });

  it("trims outer whitespace but keeps the empty array positions intact", () => {
    expect(
      resolveInternalRouteHref("  /api/v1?filters=&filters=  ", FALLBACK),
    ).toBe("/api/v1?filters=&filters=");
  });

  it("falls back when the array-bearing href is protocol-relative (//)", () => {
    expect(
      resolveInternalRouteHref("//evil.example/api?filters=&filters=", FALLBACK),
    ).toBe(FALLBACK);
  });

  it("falls back when the array-bearing href is not rooted", () => {
    expect(
      resolveInternalRouteHref("api/v1?filters=&filters=", FALLBACK),
    ).toBe(FALLBACK);
  });

  it("falls back when the array-bearing href contains a newline", () => {
    expect(
      resolveInternalRouteHref("/api/v1?filters=&filters=\ninject", FALLBACK),
    ).toBe(FALLBACK);
  });

  it("falls back for null/empty input (no query to parse)", () => {
    expect(resolveInternalRouteHref(null, FALLBACK)).toBe(FALLBACK);
    expect(resolveInternalRouteHref("", FALLBACK)).toBe(FALLBACK);
  });
});
