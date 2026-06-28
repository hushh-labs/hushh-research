import { describe, expect, it } from "vitest";

import { normalizeInternalRouteHref } from "@/lib/navigation/routes";

// Characterization tests for normalizeInternalRouteHref
// (hushh-webapp/lib/navigation/routes.ts) focused on percent-encoded forward
// slashes (`%2F` / `%2f`) appearing inside path or query string parameters.
//
// Real implementation:
//   const href = String(value ?? "").trim();
//   if (!href) return null;
//   if (!href.startsWith("/") || href.startsWith("//")) return null;
//   if (/[\r\n]/.test(href)) return null;
//   return href;
//
// TRUTH-FIRST: normalizeInternalRouteHref does NOT decode, parse, split, or
// segment the path. It performs no `%2F` → `/` decoding and no "sub-segment
// isolation". `%2F` is treated as three opaque characters and survives verbatim.
// The only `/`-aware logic is the leading-character guard: the FIRST raw
// character must be a single `/` (and the string must not start with `//`).
// An encoded slash is never interpreted as a path delimiter.

describe("normalizeInternalRouteHref — percent-encoded slashes (%2F)", () => {
  it("retains %2F inside a path segment verbatim (no decode, no split)", () => {
    expect(
      normalizeInternalRouteHref("/docs/legal%2Farchive")
    ).toBe("/docs/legal%2Farchive");
  });

  it("retains lowercase %2f verbatim (no case-folding, no decode)", () => {
    expect(
      normalizeInternalRouteHref("/docs/legal%2farchive")
    ).toBe("/docs/legal%2farchive");
  });

  it("retains %2F inside a query parameter value verbatim", () => {
    expect(
      normalizeInternalRouteHref("/search?path=a%2Fb%2Fc")
    ).toBe("/search?path=a%2Fb%2Fc");
  });

  it("retains multiple encoded slashes without collapsing them", () => {
    expect(
      normalizeInternalRouteHref("/a%2F%2Fb")
    ).toBe("/a%2F%2Fb");
  });

  it("does NOT decode %2F into a leading double-slash (single real leading slash passes)", () => {
    // The literal leading char is "/", and char 2 is "%", not "/", so the
    // "//" protocol-relative guard does not trigger; the %2F stays encoded.
    expect(
      normalizeInternalRouteHref("/%2Fevil.com")
    ).toBe("/%2Fevil.com");
  });

  it("still rejects a genuine protocol-relative prefix even with encoded slashes after", () => {
    expect(
      normalizeInternalRouteHref("//host%2Fpath")
    ).toBeNull();
  });

  it("trims surrounding whitespace but keeps encoded slashes intact", () => {
    expect(
      normalizeInternalRouteHref("   /docs/legal%2Farchive   ")
    ).toBe("/docs/legal%2Farchive");
  });

  it("rejects an href whose encoded-slash content carries an INTERIOR newline", () => {
    // The CR/LF guard runs AFTER trim(), so a trailing "\n" is stripped and the
    // href passes; only a newline embedded mid-string is rejected.
    expect(
      normalizeInternalRouteHref("/docs/legal%2F\narchive")
    ).toBeNull();
  });

  it("accepts a trailing newline because trim() removes it before the CR/LF guard", () => {
    expect(
      normalizeInternalRouteHref("/docs/legal%2Farchive\n")
    ).toBe("/docs/legal%2Farchive");
  });

});
