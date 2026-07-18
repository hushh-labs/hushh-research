import { describe, expect, it } from "vitest";

import { normalizeInternalRouteHref } from "@/lib/navigation/routes";

// Characterization tests for normalizeInternalRouteHref
// (hushh-webapp/lib/navigation/routes.ts) for percent-encoded question marks
// (`%3F`) embedded as raw literal text inside the path, NOT as a query marker.
//
// TRUTH-FIRST — LITERAL CONTRACT:
//
//   const href = String(value ?? "").trim();
//   if (!href) return null;
//   if (!href.startsWith("/") || href.startsWith("//")) return null;
//   if (/[\r\n]/.test(href)) return null;
//   return href;
//
// The guard performs NO percent-decoding, NO query/`?` splitting, and NO
// re-encoding. It only checks: non-empty, single leading slash, and absence of
// CR/LF. Therefore a literal `%3F` token inside the path text is preserved
// byte-for-byte — `normalizeInternalRouteHref` is an identity function for any
// internal href that passes the three guards.

describe("normalizeInternalRouteHref — percent-encoded question marks (%3F)", () => {
  it("preserves a literal %3F embedded in the path text exactly", () => {
    expect(normalizeInternalRouteHref("/legal/faq%3Fpage")).toBe(
      "/legal/faq%3Fpage",
    );
  });

  it("does not decode %3F into a real '?' query marker", () => {
    const out = normalizeInternalRouteHref("/legal/faq%3Fpage");
    expect(out).not.toBeNull();
    expect(out).not.toContain("?");
    expect(out).toContain("%3F");
  });

  it("preserves lowercase %3f exactly (no case normalization)", () => {
    expect(normalizeInternalRouteHref("/legal/faq%3fpage")).toBe(
      "/legal/faq%3fpage",
    );
  });

  it("preserves multiple %3F tokens in the path", () => {
    expect(normalizeInternalRouteHref("/a%3Fb%3Fc")).toBe("/a%3Fb%3Fc");
  });

  it("keeps a %3F token AND a real query string verbatim (no merging/splitting)", () => {
    expect(normalizeInternalRouteHref("/legal/faq%3Fpage?tab=1")).toBe(
      "/legal/faq%3Fpage?tab=1",
    );
  });

  it("trims surrounding whitespace but keeps the inner %3F literal", () => {
    expect(normalizeInternalRouteHref("  /legal/faq%3Fpage  ")).toBe(
      "/legal/faq%3Fpage",
    );
  });

  it("still rejects protocol-relative hrefs even when they carry a %3F", () => {
    expect(normalizeInternalRouteHref("//evil.example/faq%3Fpage")).toBeNull();
  });

  it("still rejects non-rooted hrefs even when they carry a %3F", () => {
    expect(normalizeInternalRouteHref("legal/faq%3Fpage")).toBeNull();
  });

  it("rejects a %3F-bearing href that contains a newline (CR/LF guard)", () => {
    expect(normalizeInternalRouteHref("/legal/faq%3Fpage\npayload")).toBeNull();
  });
});
