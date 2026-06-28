import { describe, expect, it } from "vitest";

import { resolveInternalRouteHref } from "@/lib/navigation/routes";

// Characterization tests for resolveInternalRouteHref
// (hushh-webapp/lib/navigation/routes.ts) focused on internal route hrefs whose
// query variables contain un-escaped spaces, plus symbols ("+"), and/or
// percent-encoded spaces ("%20"), possibly mixed together.
//
// TRUTH-FIRST (verified against the source):
//   resolveInternalRouteHref(value, fallback) is a THIN wrapper:
//     return normalizeInternalRouteHref(value) ?? fallback;
//   normalizeInternalRouteHref does ONLY:
//     1. href = String(value ?? "").trim()           // edge whitespace only
//     2. if (!href) return null
//     3. if (!href.startsWith("/") || href.startsWith("//")) return null
//     4. if (/[\r\n]/.test(href)) return null
//     5. return href                                  // otherwise VERBATIM
//
//   IMPORTANT CONTRACT CORRECTION: there is NO query parsing, NO percent-
//   decoding, NO "+"->space conversion, and NO "%20"->space collapsing. The
//   premise that this routine "normalizes input to clean text characters" is
//   WRONG. Interior spaces, literal "+", and literal "%20" are all PRESERVED
//   exactly as given (after trimming only the leading/trailing whitespace). The
//   only space-related effect is trim() at the very edges of the whole string.
//   These tests pin that verbatim-preservation reality.

const FALLBACK = "/one";

describe("resolveInternalRouteHref — interior spaces / + / %20 are preserved verbatim", () => {
  it("keeps an un-escaped interior space in a query value (no normalization)", () => {
    const href = "/one/kai/analysis?ticker=ACME CORP";
    expect(resolveInternalRouteHref(href, FALLBACK)).toBe(href);
  });

  it("keeps a literal plus symbol (does NOT convert '+' to a space)", () => {
    const href = "/one/kai/analysis?ticker=ACME+CORP";
    expect(resolveInternalRouteHref(href, FALLBACK)).toBe(href);
  });

  it("keeps a percent-encoded space (does NOT decode '%20' to a space)", () => {
    const href = "/one/kai/analysis?ticker=ACME%20CORP";
    expect(resolveInternalRouteHref(href, FALLBACK)).toBe(href);
  });

  it("keeps all three space variants mixed together untouched", () => {
    const href = "/search?q=alpha beta+gamma%20delta";
    expect(resolveInternalRouteHref(href, FALLBACK)).toBe(href);
  });

  it("preserves repeated/array-style params that each carry mixed space tokens", () => {
    const href = "/search?tag=red apple&tag=green+pear&tag=blue%20plum";
    expect(resolveInternalRouteHref(href, FALLBACK)).toBe(href);
  });
});

describe("resolveInternalRouteHref — trim() only affects the outer edges", () => {
  it("trims leading/trailing whitespace but keeps the interior space", () => {
    const href = "  /search?q=alpha beta  ";
    expect(resolveInternalRouteHref(href, FALLBACK)).toBe("/search?q=alpha beta");
  });

  it("does not collapse runs of interior spaces down to one", () => {
    const href = "/search?q=alpha   beta";
    expect(resolveInternalRouteHref(href, FALLBACK)).toBe(href);
  });
});

describe("resolveInternalRouteHref — guard rejections fall back regardless of spaces", () => {
  it("returns the fallback for a protocol-relative href even with spaces", () => {
    expect(resolveInternalRouteHref("//evil.example/x y", FALLBACK)).toBe(
      FALLBACK
    );
  });

  it("returns the fallback when the trimmed value does not start with '/'", () => {
    expect(resolveInternalRouteHref("  search?q=a b ", FALLBACK)).toBe(FALLBACK);
  });

  it("returns the fallback when a newline is present alongside spaces", () => {
    expect(resolveInternalRouteHref("/search?q=a b\nc", FALLBACK)).toBe(
      FALLBACK
    );
  });
});
