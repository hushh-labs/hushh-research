import { describe, expect, it } from "vitest";

import { resolveInternalRouteHref } from "@/lib/navigation/routes";

// Characterization tests for resolveInternalRouteHref
// (hushh-webapp/lib/navigation/routes.ts) focused on query strings whose
// parameter VALUES contain un-encoded / multi-token assignment "=" symbols
// (e.g. "/auth?token=abc=123").
//
// Implementation:
//   export function resolveInternalRouteHref(value, fallback): string {
//     return normalizeInternalRouteHref(value) ?? fallback;
//   }
// normalizeInternalRouteHref applies only whole-href structural guards
// (reject empty/whitespace-only, reject non-rooted, reject protocol-relative
// "//", reject CR/LF) and otherwise returns the trimmed string verbatim.
//
// TRUTH-FIRST: resolveInternalRouteHref does NOT parse the query string, does
// NOT split on "=", and does NOT truncate at any "parsing threshold". A value
// containing extra "=" characters is preserved exactly as-is (every "=" intact),
// because an accepted href is returned verbatim by normalize. The fallback is
// only ever returned when normalize REJECTS the input (→ null). The premise that
// it "truncates parsing thresholds" is FALSE — string structure is maintained.

const FALLBACK = "/home";

describe("resolveInternalRouteHref — embedded '=' in parameter values", () => {
  it("keeps a multi-equals token value verbatim (no truncation at the 2nd '=')", () => {
    expect(resolveInternalRouteHref("/auth?token=abc=123", FALLBACK)).toBe(
      "/auth?token=abc=123"
    );
  });

  it("preserves base64-style padding '=' in a value", () => {
    expect(
      resolveInternalRouteHref("/cb?data=YWJjZGVm==", FALLBACK)
    ).toBe("/cb?data=YWJjZGVm==");
  });

  it("preserves multiple params each containing extra '=' signs", () => {
    expect(
      resolveInternalRouteHref("/x?a=1=2&b=3=4", FALLBACK)
    ).toBe("/x?a=1=2&b=3=4");
  });

  it("keeps a leading '=' in a value verbatim", () => {
    expect(resolveInternalRouteHref("/p?q==eq", FALLBACK)).toBe("/p?q==eq");
  });

  it("returns the fallback for a non-rooted equals path (normalize rejects)", () => {
    expect(resolveInternalRouteHref("auth?token=abc=123", FALLBACK)).toBe(
      FALLBACK
    );
  });

  it("returns the fallback for a protocol-relative equals path", () => {
    expect(resolveInternalRouteHref("//evil.com?token=abc=123", FALLBACK)).toBe(
      FALLBACK
    );
  });

  it("returns the fallback for null/empty input (no value to maintain)", () => {
    expect(resolveInternalRouteHref(null, FALLBACK)).toBe(FALLBACK);
    expect(resolveInternalRouteHref("", FALLBACK)).toBe(FALLBACK);
  });

  it("trims surrounding whitespace but keeps interior '=' structure intact", () => {
    expect(resolveInternalRouteHref("  /auth?token=abc=123  ", FALLBACK)).toBe(
      "/auth?token=abc=123"
    );
  });
});
