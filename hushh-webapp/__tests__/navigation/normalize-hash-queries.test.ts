import { describe, expect, it } from "vitest";

import { normalizeInternalRouteHref } from "@/lib/navigation/routes";

// Characterization tests for normalizeInternalRouteHref
// (hushh-webapp/lib/navigation/routes.ts) focused on hrefs that place the query
// string AFTER the hash fragment (e.g. "/profile#settings?theme=dark").
//
// TRUTH-FIRST — LITERAL CONTRACT: normalizeInternalRouteHref is an OPAQUE
// allow-list guard, not a URL parser. Its full body is:
//   const href = String(value ?? "").trim();
//   if (!href) return null;
//   if (!href.startsWith("/") || href.startsWith("//")) return null;
//   if (/[\r\n]/.test(href)) return null;
//   return href;
// It has ZERO awareness of `#` or `?`. It does NOT split, reorder, re-encode, or
// canonicalize hash vs. query segments. So for any same-origin path-rooted href,
// whatever trailing `#...?...` layout is supplied is preserved BYTE-FOR-BYTE
// (after a leading/trailing whitespace trim). The only rejections are: empty,
// not starting with "/", protocol-relative "//", or containing CR/LF.

describe("normalizeInternalRouteHref — hash-then-query chains", () => {
  it("preserves a query placed after the hash byte-for-byte", () => {
    const href = "/profile#settings?theme=dark&status=active";
    expect(normalizeInternalRouteHref(href)).toBe(href);
  });

  it("does NOT reorder hash and query (no canonicalization)", () => {
    // A real URL parser would treat `?...` after `#` as part of the fragment.
    // This guard performs no such parsing — the exact string survives.
    const href = "/dashboard#tab=reports?sort=desc&page=2";
    const out = normalizeInternalRouteHref(href);
    expect(out).toBe(href);
    expect(out).toContain("#tab=reports?sort=desc");
  });

  it("preserves multiple '?' and '#' characters in the trailing chain", () => {
    const href = "/a#x?b=1?c=2#y&d=3";
    expect(normalizeInternalRouteHref(href)).toBe(href);
  });

  it("does not re-encode special characters in the hash/query chain", () => {
    const href = "/search#q=a b&list=[1,2]?flag=true%20";
    expect(normalizeInternalRouteHref(href)).toBe(href);
  });

  it("trims surrounding whitespace but keeps the inner hash/query layout intact", () => {
    const href = "  /profile#settings?theme=dark  ";
    expect(normalizeInternalRouteHref(href)).toBe("/profile#settings?theme=dark");
  });

  it("rejects protocol-relative href even when it carries a hash+query chain", () => {
    expect(
      normalizeInternalRouteHref("//evil.example#settings?theme=dark")
    ).toBeNull();
  });

  it("rejects an href with a CRLF embedded in the hash+query chain", () => {
    expect(
      normalizeInternalRouteHref("/profile#settings?theme=dark\nstatus=active")
    ).toBeNull();
  });
});
