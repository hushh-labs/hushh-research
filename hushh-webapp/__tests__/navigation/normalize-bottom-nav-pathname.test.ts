import { describe, expect, it } from "vitest";

import { normalizeBottomNavPathname } from "@/lib/navigation/app-bottom-nav";

/**
 * Characterization tests for normalizeBottomNavPathname.
 *
 * Implementation boundary (app-bottom-nav.ts):
 *
 *   export function normalizeBottomNavPathname(
 *     pathname: string | null | undefined,
 *   ): string {
 *     const base = pathname?.split(/[?#]/, 1)[0]?.replace(/\/$/, "") || "";
 *     return base === "" && pathname === "/" ? "/" : base;
 *   }
 *
 * Why behavior is guaranteed:
 * - `pathname?.split(/[?#]/, 1)[0]` — optional chaining means null/undefined
 *   short-circuits to undefined before split is called; split(/[?#]/, 1)
 *   keeps only the segment before the first `?` or `#`.
 * - `.replace(/\/$/, "")` — strips exactly one trailing slash.
 * - `|| ""` — falsy coalescing: empty string, undefined → "".
 * - Special case: `base === "" && pathname === "/"` restores the root slash
 *   that was consumed by replace (since `"/" → replace → ""` without it).
 */
describe("normalizeBottomNavPathname", () => {
  describe("query string stripping", () => {
    it("strips a single query parameter", () => {
      // split(/[?#]/, 1)[0] on "/one/kai?tab=market" → "/one/kai"
      expect(normalizeBottomNavPathname("/one/kai?tab=market")).toBe("/one/kai");
    });

    it("strips multiple query parameters", () => {
      expect(
        normalizeBottomNavPathname("/profile?panel=account&detail=appearance"),
      ).toBe("/profile");
    });

    it("strips a query string that begins immediately after the root slash", () => {
      expect(normalizeBottomNavPathname("/?foo=bar")).toBe("");
      // "/" → split → ["/"] → replace trailing slash → "" → || "" → ""
      // base==="" but pathname!=="/" so returns ""
    });
  });

  describe("hash fragment stripping", () => {
    it("strips a hash anchor", () => {
      // split(/[?#]/, 1)[0] on "/path#anchor" → "/path"
      expect(normalizeBottomNavPathname("/path#anchor")).toBe("/path");
    });

    it("strips a hash that appears after a query string (first delimiter wins)", () => {
      // split keeps only the segment before the FIRST of ? or #
      expect(normalizeBottomNavPathname("/path?foo=bar#anchor")).toBe("/path");
    });
  });

  describe("trailing slash stripping", () => {
    it("strips one trailing slash from a pathname", () => {
      // replace(/\/$/, "") on "/profile/" → "/profile"
      expect(normalizeBottomNavPathname("/profile/")).toBe("/profile");
    });

    it("strips the trailing slash that appears before a query string", () => {
      // split gives "/one/", then replace gives "/one"
      expect(normalizeBottomNavPathname("/one/?foo=bar")).toBe("/one");
    });
  });

  describe("root path special case", () => {
    it("preserves '/' because split+replace collapses it to empty string and the guard restores it", () => {
      // "/" → split → ["/"] → replace(/\/$/, "") → "" → || "" → ""
      // guard: base==="" && pathname==="/" → return "/"
      expect(normalizeBottomNavPathname("/")).toBe("/");
    });
  });

  describe("null and undefined inputs", () => {
    it("returns empty string for null (optional chain short-circuits)", () => {
      // null?.split → undefined, undefined?.replace → undefined, undefined || "" → ""
      expect(normalizeBottomNavPathname(null)).toBe("");
    });

    it("returns empty string for undefined (optional chain short-circuits)", () => {
      expect(normalizeBottomNavPathname(undefined)).toBe("");
    });

    it("returns empty string for an empty string input", () => {
      // "".split(/[?#]/, 1) → [""], [0] → "", replace → "", || "" → ""
      // base==="" but pathname!=="/", so returns ""
      expect(normalizeBottomNavPathname("")).toBe("");
    });
  });

  describe("clean pathnames pass through unchanged", () => {
    it("returns a deep pathname with no query or hash unchanged", () => {
      expect(normalizeBottomNavPathname("/one/kai/analysis")).toBe(
        "/one/kai/analysis",
      );
    });

    it("returns a single-segment pathname unchanged", () => {
      expect(normalizeBottomNavPathname("/profile")).toBe("/profile");
    });

    it("returns a two-segment pathname unchanged", () => {
      expect(normalizeBottomNavPathname("/ria/clients")).toBe("/ria/clients");
    });
  });
});