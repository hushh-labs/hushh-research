import { describe, expect, it } from "vitest";

import { resolveInternalRouteHref } from "@/lib/navigation/routes";

// Characterization tests for resolveInternalRouteHref
// (hushh-webapp/lib/navigation/routes.ts) focused on internal hrefs that place a
// live "?" query delimiter AFTER a "#" anchor fragment, e.g.
// "/page#anchor?param=123".
//
// TRUTH-FIRST — IMPORTANT CORRECTION: the task premise that there is an "output
// extraction contract" which "separates the query map from the trailing hash
// string" is FALSE. resolveInternalRouteHref performs NO query parsing, NO hash
// parsing, and builds NO query map. Its entire body is:
//
//   export function resolveInternalRouteHref(value, fallback): string {
//     return normalizeInternalRouteHref(value) ?? fallback;
//   }
//
// normalizeInternalRouteHref only:
//   1. coerces to string + trims surrounding whitespace
//   2. returns null if empty
//   3. returns null unless it starts with a single "/" (rejects "//...")
//   4. returns null if it contains CR or LF
//   5. otherwise returns the href VERBATIM
//
// Therefore "/page#anchor?param=123" is returned byte-for-byte. Everything after
// the first "#" — including the embedded "?param=123" — is opaque text. There is
// no split, no query object, and no reordering. These tests pin that reality.
describe("resolveInternalRouteHref — hash-then-query (no split / no extraction)", () => {
  const FALLBACK = "/one";

  it("returns '/page#anchor?param=123' verbatim — the query is NOT split out of the hash", () => {
    expect(
      resolveInternalRouteHref("/page#anchor?param=123", FALLBACK),
    ).toBe("/page#anchor?param=123");
  });

  it("does not build a query map: the '?param=123' stays inside the fragment text", () => {
    const out = resolveInternalRouteHref("/settings#tab?x=1&y=2", FALLBACK);
    // The entire "#tab?x=1&y=2" is preserved as one opaque fragment string.
    expect(out).toBe("/settings#tab?x=1&y=2");
  });

  it("preserves a real query that precedes the hash, then a second '?' inside the hash, verbatim", () => {
    const href = "/p?a=1#frag?b=2";
    expect(resolveInternalRouteHref(href, FALLBACK)).toBe("/p?a=1#frag?b=2");
  });

  it("does not reorder or dedupe params that appear after the anchor", () => {
    const href = "/x#h?z=1&a=2&z=3";
    expect(resolveInternalRouteHref(href, FALLBACK)).toBe("/x#h?z=1&a=2&z=3");
  });

  it("keeps casing of both anchor and trailing query exactly (no normalization)", () => {
    const href = "/Page#Anchor?Param=ABC";
    expect(resolveInternalRouteHref(href, FALLBACK)).toBe("/Page#Anchor?Param=ABC");
  });

  it("trims only surrounding whitespace, leaving the interior #...? sequence intact", () => {
    expect(
      resolveInternalRouteHref("   /page#anchor?param=123   ", FALLBACK),
    ).toBe("/page#anchor?param=123");
  });

  it("returns the fallback for a protocol-relative value even with a hash-query tail", () => {
    expect(
      resolveInternalRouteHref("//evil.example/page#anchor?param=123", FALLBACK),
    ).toBe(FALLBACK);
  });

  it("returns the fallback for an absolute URL even with a hash-query tail", () => {
    expect(
      resolveInternalRouteHref("https://evil.example/page#a?b=1", FALLBACK),
    ).toBe(FALLBACK);
  });

  it("returns the fallback when a newline is injected into the hash-query tail", () => {
    expect(
      resolveInternalRouteHref("/page#anchor?param=123\ninject", FALLBACK),
    ).toBe(FALLBACK);
  });

  it("returns the fallback for a non-rooted value with a hash-query tail", () => {
    expect(
      resolveInternalRouteHref("page#anchor?param=123", FALLBACK),
    ).toBe(FALLBACK);
  });

  it("returns the fallback for nullish/empty input regardless of intended tail", () => {
    expect(resolveInternalRouteHref(null, FALLBACK)).toBe(FALLBACK);
    expect(resolveInternalRouteHref(undefined, FALLBACK)).toBe(FALLBACK);
    expect(resolveInternalRouteHref("", FALLBACK)).toBe(FALLBACK);
  });
});
