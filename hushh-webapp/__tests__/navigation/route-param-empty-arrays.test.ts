import { describe, expect, it } from "vitest";

import { normalizeInternalRouteHref } from "@/lib/navigation/routes";

// Characterization tests for normalizeInternalRouteHref
// (hushh-webapp/lib/navigation/routes.ts) focused on query-string components
// that resolve to empty strings or multi-comma blanks within search
// dimensions, e.g. `/search?tags=,,&category=`.
//
// TRUTH-FIRST — LITERAL CONTRACT:
//
//   export function normalizeInternalRouteHref(value): string | null {
//     const href = String(value ?? "").trim();
//     if (!href) return null;
//     if (!href.startsWith("/") || href.startsWith("//")) return null;
//     if (/[\r\n]/.test(href)) return null;
//     return href;
//   }
//
// CORRECTION TO THE TASK PREMISE: this routine is NOT a query-string
// extractor. It performs NO parsing, NO array element extraction, NO dropping
// of empty positions, and NO construction of blank literal array strings. It
// is a pure allow/deny gate over the trimmed string:
//   - Passes -> the href (including its entire query block) is returned
//     VERBATIM, so every `,,` and every dangling `=` survives byte-for-byte.
//   - Fails a guard (empty, not rooted, protocol-relative `//`, or containing
//     CR/LF) -> `null` is returned.
// These tests pin that real contract for the empty/comma-blank query surface.

describe("normalizeInternalRouteHref — empty-string & multi-comma query params", () => {
  it("returns the href verbatim, preserving multi-comma blanks and a dangling empty value", () => {
    expect(normalizeInternalRouteHref("/search?tags=,,&category=")).toBe(
      "/search?tags=,,&category=",
    );
  });

  it("does not drop or compress the empty comma positions inside a single param", () => {
    const out = normalizeInternalRouteHref("/search?tags=,,");
    // The two commas (three empty positions) are retained exactly.
    expect(out).toBe("/search?tags=,,");
    expect(out?.match(/,/g)?.length).toBe(2);
  });

  it("preserves a param whose value is an empty string (`category=`)", () => {
    expect(normalizeInternalRouteHref("/search?category=")).toBe(
      "/search?category=",
    );
  });

  it("preserves repeated empty-string params without deduping or reordering", () => {
    expect(normalizeInternalRouteHref("/search?tags=&tags=&tags=")).toBe(
      "/search?tags=&tags=&tags=",
    );
  });

  it("preserves a leading empty position before a real value", () => {
    expect(normalizeInternalRouteHref("/search?tags=,,active")).toBe(
      "/search?tags=,,active",
    );
  });

  it("preserves bracketed empty array syntax verbatim", () => {
    expect(normalizeInternalRouteHref("/search?tags[]=&tags[]=&tags[]=z")).toBe(
      "/search?tags[]=&tags[]=&tags[]=z",
    );
  });

  it("trims outer whitespace but keeps the blank comma/empty query intact", () => {
    expect(normalizeInternalRouteHref("  /search?tags=,,&category=  ")).toBe(
      "/search?tags=,,&category=",
    );
  });

  it("preserves a lone `?` with an all-blank multi-comma value", () => {
    expect(normalizeInternalRouteHref("/search?=,,")).toBe("/search?=,,");
  });

  it("returns null for a protocol-relative host even when carrying blank params", () => {
    expect(
      normalizeInternalRouteHref("//evil.example/search?tags=,,&category="),
    ).toBeNull();
  });

  it("returns null for a non-rooted href even when carrying blank params", () => {
    expect(normalizeInternalRouteHref("search?tags=,,&category=")).toBeNull();
  });

  it("returns null when a newline is injected after the blank params", () => {
    expect(
      normalizeInternalRouteHref("/search?tags=,,&category=\ninject"),
    ).toBeNull();
  });

  it("returns null for null/undefined/empty input (no query to inspect)", () => {
    expect(normalizeInternalRouteHref(null)).toBeNull();
    expect(normalizeInternalRouteHref(undefined)).toBeNull();
    expect(normalizeInternalRouteHref("")).toBeNull();
    expect(normalizeInternalRouteHref("   ")).toBeNull();
  });
});
