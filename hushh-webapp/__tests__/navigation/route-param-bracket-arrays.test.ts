import { describe, expect, it } from "vitest";

import { normalizeInternalRouteHref } from "@/lib/navigation/routes";

/**
 * Characterization tests for `normalizeInternalRouteHref` from
 * `hushh-webapp/lib/navigation/routes.ts`.
 *
 * Scope: pin down the exact contract when an internal href carries PHP/Rails
 * style bracket-array query notation, e.g. `/search?ids[]=10&ids[]=20`.
 *
 * Truth-first note (premise correction): this routine is NOT a query-string
 * parser. Reading the implementation, it performs only:
 *   1. `String(value ?? "").trim()`
 *   2. reject empty
 *   3. reject if it does not start with "/" OR starts with "//"
 *   4. reject if it contains CR/LF
 *   5. otherwise return the href VERBATIM
 *
 * Therefore it does NOT "map brackets as keys" and it does NOT "condense them
 * into a native string array". Bracket-array notation is never interpreted at
 * all — the entire query block (including `[]`, `&`, repeated keys, and any
 * pre-encoded `%5B%5D`) is preserved byte-for-byte in the returned string.
 * These tests document that real pass-through contract, not an aspirational
 * parsing one.
 */
describe("normalizeInternalRouteHref — bracket-array query notation", () => {
  it("returns repeated bracket-array params verbatim without parsing into an array", () => {
    const href = "/search?ids[]=10&ids[]=20";

    const out = normalizeInternalRouteHref(href);

    // Verbatim string, not a parsed structure.
    expect(out).toBe(href);
    expect(typeof out).toBe("string");
    // Repeated key is preserved (no de-duplication / condensing).
    expect(out?.match(/ids\[\]=/g)?.length).toBe(2);
    // Literal bracket tokens survive; they are not turned into an array key.
    expect(out).toContain("ids[]=10");
    expect(out).toContain("ids[]=20");
  });

  it("preserves indexed bracket notation (ids[0], ids[1]) as literal characters", () => {
    const href = "/search?ids[0]=10&ids[1]=20";

    expect(normalizeInternalRouteHref(href)).toBe(href);
  });

  it("preserves nested/associative bracket notation (filter[status]) verbatim", () => {
    const href = "/search?filter[status]=active&filter[tag]=x";

    expect(normalizeInternalRouteHref(href)).toBe(href);
  });

  it("does not decode pre-encoded brackets (%5B%5D) — no query-level decoding", () => {
    const href = "/search?ids%5B%5D=10&ids%5B%5D=20";

    const out = normalizeInternalRouteHref(href);

    expect(out).toBe(href);
    expect(out).toContain("%5B%5D");
    expect(out).not.toContain("[]");
  });

  it("trims surrounding whitespace but leaves the bracket query block intact", () => {
    const href = "   /search?ids[]=10&ids[]=20   ";

    expect(normalizeInternalRouteHref(href)).toBe("/search?ids[]=10&ids[]=20");
  });

  it("still rejects protocol-relative hrefs even when they carry bracket arrays", () => {
    expect(normalizeInternalRouteHref("//evil.example?ids[]=10")).toBeNull();
  });

  it("rejects CRLF-injected bracket-array hrefs (returns null, not a sanitized string)", () => {
    expect(normalizeInternalRouteHref("/search?ids[]=10\n&ids[]=20")).toBeNull();
  });
});
