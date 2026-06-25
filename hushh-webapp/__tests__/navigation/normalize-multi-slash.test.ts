import { describe, expect, it } from "vitest";

import {
  normalizeInternalRouteHref,
  resolveInternalRouteHref,
} from "@/lib/navigation/routes";

// Characterization tests for normalizeInternalRouteHref / resolveInternalRouteHref
// in lib/navigation/routes.ts, focused narrowly on inputs with MULTIPLE
// consecutive leading slashes (e.g. "///route", "////a/b").
//
// Existing coverage in normalize-internal-route-href.test.ts already pins the
// two-slash protocol-relative case ("//evil"). These tests document the
// adjacent, previously-uncharacterized boundary: 3+ leading slashes.
//
// Real implemented guard (routes.ts):
//   if (!href.startsWith("/") || href.startsWith("//")) return null;
//
// Consequence captured below:
//   - normalizeInternalRouteHref does NOT return multi-slash input verbatim.
//   - normalizeInternalRouteHref does NOT itself substitute a base route; it
//     returns null. The base-route fallback lives only in the caller-supplied
//     `fallback` argument of resolveInternalRouteHref.

describe("normalizeInternalRouteHref — multiple consecutive leading slashes", () => {
  it("rejects three or more leading slashes by returning null (not verbatim)", () => {
    expect(normalizeInternalRouteHref("///route")).toBeNull();
    expect(normalizeInternalRouteHref("////a/b")).toBeNull();
    expect(normalizeInternalRouteHref("/////")).toBeNull();
  });

  it("rejects multi-slash even after trimming surrounding whitespace", () => {
    // Trim happens first, then the startsWith("//") guard still fires.
    expect(normalizeInternalRouteHref("   ///route   ")).toBeNull();
    expect(normalizeInternalRouteHref("\t//\n")).toBeNull();
  });

  it("rejects multi-slash regardless of query/fragment payload", () => {
    expect(normalizeInternalRouteHref("///route?tab=privacy")).toBeNull();
    expect(normalizeInternalRouteHref("///route#frag")).toBeNull();
  });

  it("still accepts a single leading slash with internal sub-slashes", () => {
    // Control case: only the *leading* run of slashes matters. A single
    // leading slash followed by normal path separators is preserved verbatim.
    expect(normalizeInternalRouteHref("/one/kai/portfolio")).toBe(
      "/one/kai/portfolio"
    );
  });
});

describe("resolveInternalRouteHref — multi-slash falls back to base route", () => {
  it("returns the caller-supplied fallback for multi-slash input", () => {
    // Because normalizeInternalRouteHref returns null, resolveInternalRouteHref
    // surfaces the explicit base/fallback route rather than the unsafe input.
    expect(resolveInternalRouteHref("///route", "/")).toBe("/");
    expect(resolveInternalRouteHref("////a/b", "/one")).toBe("/one");
    expect(resolveInternalRouteHref("   ///x   ", "/profile")).toBe("/profile");
  });
});
