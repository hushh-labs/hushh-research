import { describe, expect, it } from "vitest";

import { resolveInternalRouteHref } from "@/lib/navigation/routes";

// Characterization tests for resolveInternalRouteHref
// (hushh-webapp/lib/navigation/routes.ts) focused on percent-encoded symbol
// keys (%26 '&', %3D '=', %3F '?') inside search query values.
//
// TRUTH-FIRST: resolveInternalRouteHref is a thin wrapper —
//   resolveInternalRouteHref(value, fallback)
//     = normalizeInternalRouteHref(value) ?? fallback
// It does NOT parse the query string, NOT decode percent-encodings, and NOT
// distinguish encoded "%26/%3D/%3F" from LIVE structural delimiters "&/=/?".
// An accepted href is returned VERBATIM (only surrounding whitespace trimmed);
// the fallback is returned ONLY when normalize rejects the whole href
// (empty/whitespace-only, non-rooted, protocol-relative "//", interior CR/LF).
// So encoded symbols are preserved exactly as written — they are neither decoded
// into delimiters nor re-encoded.

const FALLBACK = "/home";

describe("resolveInternalRouteHref — percent-encoded query symbols", () => {
  it("keeps %26 verbatim (not decoded to a live '&' delimiter)", () => {
    expect(resolveInternalRouteHref("/s?q=a%26b", FALLBACK)).toBe(
      "/s?q=a%26b"
    );
  });

  it("keeps %3D verbatim (not decoded to a live '=' delimiter)", () => {
    expect(resolveInternalRouteHref("/s?q=a%3Db", FALLBACK)).toBe(
      "/s?q=a%3Db"
    );
  });

  it("keeps %3F verbatim (not decoded to a live '?' delimiter)", () => {
    expect(resolveInternalRouteHref("/s?q=a%3Fb", FALLBACK)).toBe(
      "/s?q=a%3Fb"
    );
  });

  it("preserves a mix of encoded and live delimiters side by side", () => {
    expect(resolveInternalRouteHref("/s?a=1%26&b=2%3D", FALLBACK)).toBe(
      "/s?a=1%26&b=2%3D"
    );
  });

  it("does not lowercase/normalize encoded hex casing (%2f stays %2f)", () => {
    expect(resolveInternalRouteHref("/s?q=a%2fb", FALLBACK)).toBe(
      "/s?q=a%2fb"
    );
  });

  it("trims surrounding whitespace but keeps interior encodings intact", () => {
    expect(resolveInternalRouteHref("  /s?q=a%26b  ", FALLBACK)).toBe(
      "/s?q=a%26b"
    );
  });

  it("returns the fallback for a non-rooted encoded-symbol href", () => {
    expect(resolveInternalRouteHref("s?q=a%26b", FALLBACK)).toBe(FALLBACK);
  });

  it("returns the fallback for a protocol-relative encoded-symbol href", () => {
    expect(resolveInternalRouteHref("//evil.com?q=a%26b", FALLBACK)).toBe(
      FALLBACK
    );
  });

  it("returns the fallback for null/empty input (no value to resolve)", () => {
    expect(resolveInternalRouteHref(null, FALLBACK)).toBe(FALLBACK);
    expect(resolveInternalRouteHref("", FALLBACK)).toBe(FALLBACK);
  });
});
