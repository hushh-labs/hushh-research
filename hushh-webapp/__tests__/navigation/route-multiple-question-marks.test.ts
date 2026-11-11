import { describe, expect, it } from "vitest";

import { normalizeInternalRouteHref } from "@/lib/navigation/routes";

// Characterization tests for `normalizeInternalRouteHref`
// (hushh-webapp/lib/navigation/routes.ts) focused specifically on REDIRECT-CHAIN
// hrefs whose parameter VALUES carry a secondary, nested "?" — the shape that
// appears when an internal path smuggles a full OAuth callback URL inside a
// `redirect`/`next`/`returnTo` query value, e.g.
//   /dashboard?redirect=/callback?code=123&state=abc
//
// TRUTH-FIRST CORRECTION TO THE TASK PREMISE
// ------------------------------------------
// The task framed this function as a "route splitter" and asked whether the
// second "?" is "compressed into the key string or acts as an internal text
// separator," and how "parameter arrays slice incoming value tokens." That whole
// framing is FALSE against the current source. Verified against routes.ts:
//
//   export function normalizeInternalRouteHref(value): string | null {
//     const href = String(value ?? "").trim();      // 1. coerce + trim
//     if (!href) return null;                        // 2. reject empty
//     if (!href.startsWith("/") || href.startsWith("//")) return null; // 3. root guard
//     if (/[\r\n]/.test(href)) return null;          // 4. reject CR/LF
//     return href;                                   // 5. return VERBATIM
//   }
//
// There is NO splitter, NO query parser, NO `URLSearchParams`, and NO token
// "slicing." The "?" character is never special-cased. The function is a pure
// structural allow/deny gate over the *whole* string; on accept it returns the
// trimmed input byte-for-byte. Therefore a secondary "?" is neither "compressed
// into a key" nor treated as a "separator" — it is simply carried through
// untouched. There are no "parameter arrays" to characterize.
//
// These tests pin the REAL contract: nested-"?" redirect chains pass the guards
// and round-trip verbatim, while the same structural rejections (non-rooted,
// protocol-relative, interior CR/LF) still apply regardless of how many "?" the
// value contains. This complements the existing double-question spec
// (normalize-double-questions.test.ts) with distinct redirect-chain fixtures.

describe("normalizeInternalRouteHref — nested '?' inside redirect-chain values", () => {
  it("returns a redirect value containing a full callback URL verbatim", () => {
    const href = "/dashboard?redirect=/callback?code=123&state=abc";
    expect(normalizeInternalRouteHref(href)).toBe(href);
  });

  it("preserves a 'next=' value whose own query carries a second '?'", () => {
    const href = "/login?next=/settings?tab=billing&ref=email";
    expect(normalizeInternalRouteHref(href)).toBe(href);
  });

  it("preserves multiple stacked '?' across a doubly-nested redirect chain", () => {
    const href = "/a?to=/b?to=/c?code=1";
    expect(normalizeInternalRouteHref(href)).toBe(href);
  });

  it("does not decode, re-order, or collapse '&' pairs following a nested '?'", () => {
    // No key/value parsing happens, so '&state=abc' stays glued to the value
    // exactly as written; nothing is normalized or de-duplicated.
    const href = "/dashboard?redirect=/callback?a=1&a=2&b=3";
    expect(normalizeInternalRouteHref(href)).toBe(href);
  });

  it("keeps a bare trailing nested '?' with an empty second query verbatim", () => {
    const href = "/dashboard?redirect=/callback?";
    expect(normalizeInternalRouteHref(href)).toBe(href);
  });

  it("still rejects a nested-'?' redirect chain that is not rooted (no leading slash)", () => {
    expect(
      normalizeInternalRouteHref("dashboard?redirect=/callback?code=123"),
    ).toBeNull();
  });

  it("still rejects a protocol-relative host smuggled before the nested '?'", () => {
    expect(
      normalizeInternalRouteHref("//evil.com?redirect=/callback?code=123"),
    ).toBeNull();
  });

  it("trims a TRAILING newline after a nested-'?' chain, then accepts (trim precedes CR/LF guard)", () => {
    expect(
      normalizeInternalRouteHref("/dashboard?redirect=/callback?code=1\n"),
    ).toBe("/dashboard?redirect=/callback?code=1");
  });

  it("still rejects a nested-'?' chain with an INTERIOR newline (CR/LF guard)", () => {
    expect(
      normalizeInternalRouteHref("/dashboard?redirect=/callback?code=1\n&state=2"),
    ).toBeNull();
  });
});
