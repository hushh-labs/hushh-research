import { describe, expect, it } from "vitest";

import { normalizeInternalRouteHref } from "@/lib/navigation/routes";

// Characterization tests for normalizeInternalRouteHref
// (hushh-webapp/lib/navigation/routes.ts) focused on links that pile up
// MULTIPLE CONSECUTIVE trailing "#" delimiters that "merge" across routes
// (e.g. "/dashboard/settings####profile").
//
// TRUTH-FIRST — LITERAL CONTRACT: normalizeInternalRouteHref is a same-origin
// BOUNDARY GUARD, not a URL/fragment normalizer. Its full body is:
//
//   export function normalizeInternalRouteHref(value): string | null {
//     const href = String(value ?? "").trim();
//     if (!href) return null;                  // empty after trim -> null
//     if (!href.startsWith("/")) return null;  // must be rooted
//     if (href.startsWith("//")) return null;  // protocol-relative -> null
//     if (/[\r\n]/.test(href)) return null;    // CR/LF injection guard
//     return href;                             // otherwise VERBATIM
//   }
//
// Consequence pinned below: the guard does NOT parse, split, decode, or
// COLLAPSE the "#" run. A chained-hash href that survives the structural
// guards is returned byte-for-byte (the literal string structure is
// PRESERVED, never merged/de-duplicated into a single "#").

describe("normalizeInternalRouteHref — chained trailing hash delimiter merges", () => {
  it("preserves a quadruple-hash chain verbatim (does NOT collapse #### into #)", () => {
    const input = "/dashboard/settings####profile";
    const out = normalizeInternalRouteHref(input);
    expect(out).toBe(input);
    // Explicitly document the non-collapsing contract.
    expect(out).not.toBe("/dashboard/settings#profile");
  });

  it("does NOT de-duplicate the consecutive '#' run", () => {
    const out = normalizeInternalRouteHref("/dashboard/settings####profile");
    // The literal "####" survives intact.
    expect(out).toContain("####");
    // Count of '#' characters is preserved (4), not reduced to 1.
    expect((out ?? "").split("#").length - 1).toBe(4);
  });

  it("preserves a bare run of trailing hashes with no fragment text", () => {
    expect(normalizeInternalRouteHref("/dashboard/settings####")).toBe(
      "/dashboard/settings####"
    );
  });

  it("preserves a double-hash chain verbatim", () => {
    expect(normalizeInternalRouteHref("/profile##settings")).toBe(
      "/profile##settings"
    );
  });

  it("preserves a triple-hash chain verbatim", () => {
    expect(normalizeInternalRouteHref("/a###b")).toBe("/a###b");
  });

  it("preserves multiple separated hash groups across route-like segments", () => {
    const input = "/dashboard##settings####profile##tab";
    expect(normalizeInternalRouteHref(input)).toBe(input);
  });

  it("trims only OUTER whitespace while keeping the interior hash run intact", () => {
    expect(normalizeInternalRouteHref("   /dashboard/settings####profile   ")).toBe(
      "/dashboard/settings####profile"
    );
  });

  it("keeps a hash chain that immediately follows the root slash", () => {
    expect(normalizeInternalRouteHref("/####top")).toBe("/####top");
  });

  it("still rejects a non-rooted href even with a chained hash run", () => {
    expect(normalizeInternalRouteHref("dashboard/settings####profile")).toBeNull();
  });

  it("still rejects a protocol-relative href with a chained hash run", () => {
    expect(normalizeInternalRouteHref("//evil.example####profile")).toBeNull();
  });

  it("still rejects a bare fragment-only value (no leading slash)", () => {
    expect(normalizeInternalRouteHref("####profile")).toBeNull();
  });

  it("returns null when a CR/LF appears inside the chained hash run", () => {
    expect(normalizeInternalRouteHref("/dashboard####\nprofile")).toBeNull();
    expect(normalizeInternalRouteHref("/dashboard####\rprofile")).toBeNull();
  });

  it("trims a trailing newline after the hash run (trim runs before the CR/LF guard)", () => {
    expect(normalizeInternalRouteHref("/dashboard/settings####profile\n")).toBe(
      "/dashboard/settings####profile"
    );
  });
});
