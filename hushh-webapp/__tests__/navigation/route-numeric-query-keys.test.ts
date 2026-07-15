import { describe, expect, it } from "vitest";

import { normalizeInternalRouteHref } from "@/lib/navigation/routes";

// Characterization tests for `normalizeInternalRouteHref`
// (hushh-webapp/lib/navigation/routes.ts) focused on query strings whose KEYS
// are purely numeric, e.g. "/search?123=abc&456=def".
//
// TRUTH-FIRST CORRECTION TO THE TASK PREMISE
// ------------------------------------------
// The task asked to "lock down whether the parser cleanly maps numeric string
// keys into the parameter record object or mutates their index ordering." That
// framing is FALSE against the current source. Verified in routes.ts:
//
//   export function normalizeInternalRouteHref(value): string | null {
//     const href = String(value ?? "").trim();      // 1. coerce + trim
//     if (!href) return null;                        // 2. reject empty
//     if (!href.startsWith("/") || href.startsWith("//")) return null; // 3. root guard
//     if (/[\r\n]/.test(href)) return null;          // 4. reject CR/LF
//     return href;                                   // 5. return VERBATIM
//   }
//
// There is NO parser, NO `URLSearchParams`, NO "parameter record object," and
// NO key mapping or index re-ordering. The function is a pure structural
// allow/deny gate over the *whole* string; on accept it returns the trimmed
// input byte-for-byte. Numeric keys therefore receive NO special treatment:
// they are neither coerced to integers, re-indexed, sorted, nor de-duplicated —
// the entire query is carried through exactly as written. There is no "record
// object" to inspect, so these tests characterize the STRING contract that
// actually exists.
//
// This pins: rooted numeric-key queries round-trip verbatim (including original
// key order, duplicate numeric keys, and leading-zero keys), while the same
// structural rejections (non-rooted, protocol-relative, interior CR/LF) still
// apply regardless of numeric-key content.

describe("normalizeInternalRouteHref — numeric query keys", () => {
  it("returns a rooted numeric-key query verbatim (no coercion, no record mapping)", () => {
    const href = "/search?123=abc&456=def";
    expect(normalizeInternalRouteHref(href)).toBe(href);
  });

  it("preserves the ORIGINAL key order (no numeric sort / re-indexing)", () => {
    // If the function sorted numeric keys ascending, this would come back
    // "/x?1=a&2=b&10=c". It does not — original textual order is preserved.
    const href = "/x?10=c&2=b&1=a";
    expect(normalizeInternalRouteHref(href)).toBe(href);
  });

  it("keeps DUPLICATE numeric keys verbatim (no de-dup, no last-wins collapse)", () => {
    const href = "/list?7=first&7=second";
    expect(normalizeInternalRouteHref(href)).toBe(href);
  });

  it("preserves leading-zero numeric keys exactly (no integer normalization)", () => {
    const href = "/p?007=bond&042=answer";
    expect(normalizeInternalRouteHref(href)).toBe(href);
  });

  it("preserves a bare numeric key with no value verbatim", () => {
    const href = "/q?123";
    expect(normalizeInternalRouteHref(href)).toBe(href);
  });

  it("preserves a numeric key with an empty value verbatim", () => {
    const href = "/q?123=";
    expect(normalizeInternalRouteHref(href)).toBe(href);
  });

  it("still rejects a numeric-key query that is not rooted (no leading slash)", () => {
    expect(normalizeInternalRouteHref("search?123=abc")).toBeNull();
  });

  it("still rejects a protocol-relative host before a numeric-key query", () => {
    expect(normalizeInternalRouteHref("//evil.com?123=abc")).toBeNull();
  });

  it("trims a TRAILING newline after a numeric-key query, then accepts (trim precedes CR/LF guard)", () => {
    expect(normalizeInternalRouteHref("/search?123=abc\n")).toBe(
      "/search?123=abc",
    );
  });

  it("still rejects a numeric-key query with an INTERIOR newline (CR/LF guard)", () => {
    expect(normalizeInternalRouteHref("/search?123=abc\n&456=def")).toBeNull();
  });
});
