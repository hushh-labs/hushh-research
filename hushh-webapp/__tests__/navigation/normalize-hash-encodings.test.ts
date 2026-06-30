import { describe, expect, it } from "vitest";

import { normalizeInternalRouteHref } from "@/lib/navigation/routes";

// Characterization tests for normalizeInternalRouteHref
// (hushh-webapp/lib/navigation/routes.ts) pinning its EXACT behavior when an
// internal href combines raw spaces with percent-encoded tokens across multiple
// "#" hash boundaries. Test-only; no production change.
//
// TRUTH-FIRST — LITERAL CONTRACT: normalizeInternalRouteHref is a BOUNDARY
// GUARD, not a content normalizer. Its entire body is:
//   const href = String(value ?? "").trim();
//   if (!href) return null;
//   if (!href.startsWith("/") || href.startsWith("//")) return null;
//   if (/[\r\n]/.test(href)) return null;
//   return href;
// So it ONLY: (1) coerces to string, (2) trims OUTER whitespace, (3) rejects
// empty, (4) rejects hrefs that don't start with a single "/", (5) rejects
// protocol-relative "//" hrefs, (6) rejects CR/LF. If the value passes, it is
// returned BYTE-FOR-BYTE UNCHANGED.
//
// TRUTH-FIRST CORRECTION TO THE TASK PREMISE: the task asks whether the utility
// "normalizes the trailing segment tokens cohesively" across mixed hash
// encodings. It does NOT. There is NO hash parsing, NO percent-decoding, NO
// space encoding, NO segment re-joining, and NO "#" handling whatsoever. Raw
// interior spaces and multiple "#" markers are PRESERVED VERBATIM. "Normalize"
// here means outer-trim + reject, never canonicalize the fragment.

describe("normalizeInternalRouteHref — mixed hash encodings are passed through verbatim", () => {
  it("preserves the example with raw spaces and a percent-encoded fragment across two '#'", () => {
    const input = "/legal#privacy%20policy#terms of use";
    // No fragment normalization: returned exactly as given (already starts "/",
    // no CRLF, no leading "//").
    expect(normalizeInternalRouteHref(input)).toBe(input);
  });

  it("does NOT percent-decode %20 inside the fragment", () => {
    const out = normalizeInternalRouteHref("/docs#a%20b");
    expect(out).toBe("/docs#a%20b");
    expect(out).not.toBe("/docs#a b");
  });

  it("does NOT percent-encode raw interior spaces inside the fragment", () => {
    const out = normalizeInternalRouteHref("/docs#a b");
    expect(out).toBe("/docs#a b");
    expect(out).not.toBe("/docs#a%20b");
  });

  it("retains every '#' marker in a multi-hash href (no collapsing/joining)", () => {
    const input = "/a#one#two#three";
    expect(normalizeInternalRouteHref(input)).toBe(input);
  });

  it("trims only OUTER whitespace while preserving interior fragment spaces", () => {
    expect(normalizeInternalRouteHref("   /legal#privacy policy   ")).toBe(
      "/legal#privacy policy",
    );
  });

  it("keeps a fragment that itself begins with a space after the '#'", () => {
    const input = "/legal# spaced";
    expect(normalizeInternalRouteHref(input)).toBe(input);
  });

  it("returns null when a CR/LF appears anywhere, even inside the fragment", () => {
    expect(normalizeInternalRouteHref("/legal#a\nb")).toBeNull();
    expect(normalizeInternalRouteHref("/legal#a\rb")).toBeNull();
  });

  it("still rejects protocol-relative hrefs even when they carry mixed hashes", () => {
    expect(
      normalizeInternalRouteHref("//evil.example#privacy%20policy#terms"),
    ).toBeNull();
  });

  it("rejects a bare fragment that does not start with '/'", () => {
    expect(normalizeInternalRouteHref("#privacy%20policy#terms")).toBeNull();
  });

  it("preserves a fragment containing both encoded and raw '+' and '%' tokens", () => {
    const input = "/legal#a+b %2B c%20d";
    expect(normalizeInternalRouteHref(input)).toBe(input);
  });
});
