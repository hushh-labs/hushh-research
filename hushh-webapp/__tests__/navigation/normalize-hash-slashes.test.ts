import { describe, expect, it } from "vitest";

import { normalizeInternalRouteHref } from "@/lib/navigation/routes";

// Characterization tests for normalizeInternalRouteHref
// (hushh-webapp/lib/navigation/routes.ts) focused on hrefs that pack SLASH
// delimiters INSIDE the trailing hash/anchor fragment,
// e.g. "/legal#/privacy/terms/v1".
//
// TRUTH-FIRST — LITERAL CONTRACT (verified against the source):
//   export function normalizeInternalRouteHref(value): string | null {
//     const href = String(value ?? "").trim();
//     if (!href) return null;
//     if (!href.startsWith("/") || href.startsWith("//")) return null;
//     if (/[\r\n]/.test(href)) return null;
//     return href;
//   }
//
// PREMISE CORRECTION: there is NO URL/hash parser here. normalizeInternalRouteHref
// does NOT split on "#", does NOT inspect or validate the anchor fragment, does
// NOT collapse the slashes inside the fragment, and does NOT decode anything. The
// "//" rejection is anchored to the START of the whole string only (it guards
// protocol-relative roots). Slashes living inside the fragment — even "#//" — are
// therefore irrelevant to the guard and the ENTIRE string is returned verbatim
// for any valid internal href.

describe("normalizeInternalRouteHref — slashes inside the hash fragment are kept verbatim", () => {
  it("returns the href verbatim when the fragment carries nested slashes", () => {
    expect(normalizeInternalRouteHref("/legal#/privacy/terms/v1")).toBe(
      "/legal#/privacy/terms/v1"
    );
  });

  it("does NOT collapse repeated slashes that live inside the fragment", () => {
    expect(normalizeInternalRouteHref("/legal#//privacy///terms")).toBe(
      "/legal#//privacy///terms"
    );
  });

  it("preserves a fragment that itself looks like a rooted path", () => {
    expect(normalizeInternalRouteHref("/docs#/a/b/c")).toBe("/docs#/a/b/c");
  });

  it("preserves a trailing slash inside the fragment", () => {
    expect(normalizeInternalRouteHref("/legal#/privacy/")).toBe(
      "/legal#/privacy/"
    );
  });

  it("preserves multiple '#' plus slashes verbatim (no first-hash isolation)", () => {
    expect(normalizeInternalRouteHref("/legal#/a#/b/c")).toBe("/legal#/a#/b/c");
  });

  it("preserves a fragment-only-after-root href with slashes", () => {
    expect(normalizeInternalRouteHref("/#/privacy/terms")).toBe(
      "/#/privacy/terms"
    );
  });

  it("trims surrounding whitespace but keeps the fragment slashes intact", () => {
    expect(normalizeInternalRouteHref("  /legal#/privacy/terms/v1  ")).toBe(
      "/legal#/privacy/terms/v1"
    );
  });
});

describe("normalizeInternalRouteHref — start-anchored guards still apply", () => {
  it("returns null for a protocol-relative root even if a slashed fragment follows", () => {
    expect(normalizeInternalRouteHref("//legal#/privacy/terms")).toBeNull();
  });

  it("returns null for an absolute URL whose path/fragment contains slashes", () => {
    expect(
      normalizeInternalRouteHref("https://evil.example/legal#/privacy/terms")
    ).toBeNull();
  });

  it("returns null for a fragment-only candidate that does not start with '/'", () => {
    expect(normalizeInternalRouteHref("#/privacy/terms")).toBeNull();
  });

  it("returns null when a newline rides along with the slashed fragment", () => {
    expect(normalizeInternalRouteHref("/legal#/privacy\n/terms")).toBeNull();
  });

  it("returns null for null/undefined/empty regardless of intended fragment", () => {
    expect(normalizeInternalRouteHref(null)).toBeNull();
    expect(normalizeInternalRouteHref(undefined)).toBeNull();
    expect(normalizeInternalRouteHref("   ")).toBeNull();
  });
});
