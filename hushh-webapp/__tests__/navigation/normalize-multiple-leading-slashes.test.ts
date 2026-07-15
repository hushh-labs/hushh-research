import { describe, expect, it } from "vitest";

import {
  normalizeInternalRouteHref,
  resolveInternalRouteHref,
} from "@/lib/navigation/routes";

// Characterization tests for normalizeInternalRouteHref in
// lib/navigation/routes.ts, focused on inputs with THREE OR MORE consecutive
// leading forward slashes (e.g. "///app/dashboard").
//
// Truth-first note on the real implementation (routes.ts):
//
//   export function normalizeInternalRouteHref(value) {
//     const href = String(value ?? "").trim();
//     if (!href) return null;
//     if (!href.startsWith("/") || href.startsWith("//")) return null;
//     if (/[\r\n]/.test(href)) return null;
//     return href;
//   }
//
// The Stage-2 question — "does the validator flag 3+ leading slashes as an
// invalid protocol-relative variant, or strip it to a clean path leaf?" —
// resolves unambiguously to the FORMER. The `startsWith("//")` guard is a
// prefix check, so any run of two-or-more leading slashes (which necessarily
// includes 3, 4, 5+) is rejected with `null`. There is NO stripping /
// collapsing path: the function never rewrites "///app/dashboard" into
// "/app/dashboard".
//
// An adjacent file (normalize-multi-slash.test.ts) already documents the same
// guard from the "multi-slash" angle; this file pins the specific, named
// "///app/dashboard" documentation case and the collapse-does-not-happen
// contract, plus the resolveInternalRouteHref fallback consequence.

describe("normalizeInternalRouteHref — three or more leading slashes", () => {
  it("flags 3+ leading slashes as invalid (returns null), never verbatim", () => {
    expect(normalizeInternalRouteHref("///app/dashboard")).toBeNull();
    expect(normalizeInternalRouteHref("////app/dashboard")).toBeNull();
    expect(normalizeInternalRouteHref("/////deep/nested/leaf")).toBeNull();
  });

  it("does NOT strip/collapse the leading run into a clean single-slash leaf", () => {
    // If the validator collapsed slashes it would return "/app/dashboard".
    // It does not — the sanitized-looking path is never produced.
    expect(normalizeInternalRouteHref("///app/dashboard")).not.toBe(
      "/app/dashboard"
    );
    expect(normalizeInternalRouteHref("///app/dashboard")).toBeNull();
  });

  it("rejects 3+ leading slashes after trimming surrounding whitespace", () => {
    // trim() runs first, then the startsWith("//") guard still fires.
    expect(normalizeInternalRouteHref("   ///app/dashboard   ")).toBeNull();
    expect(normalizeInternalRouteHref("\t///app/dashboard\n")).toBeNull();
  });

  it("rejects 3+ leading slashes regardless of query or fragment payload", () => {
    expect(normalizeInternalRouteHref("///app/dashboard?tab=home")).toBeNull();
    expect(normalizeInternalRouteHref("///app/dashboard#section")).toBeNull();
  });

  it("still accepts a single leading slash with internal separators (control)", () => {
    // Only the LEADING run of slashes is guarded. A single leading slash
    // followed by ordinary path separators is preserved verbatim.
    expect(normalizeInternalRouteHref("/app/dashboard")).toBe("/app/dashboard");
    expect(normalizeInternalRouteHref("/one/kai/portfolio")).toBe(
      "/one/kai/portfolio"
    );
  });
});

describe("resolveInternalRouteHref — 3+ leading slashes fall back to base", () => {
  it("surfaces the caller-supplied fallback rather than the unsafe input", () => {
    // Because normalizeInternalRouteHref returns null, the explicit fallback
    // (base route) is used instead of the multi-slash href.
    expect(resolveInternalRouteHref("///app/dashboard", "/")).toBe("/");
    expect(resolveInternalRouteHref("////app/dashboard", "/one")).toBe("/one");
    expect(resolveInternalRouteHref("   ///app/dashboard   ", "/profile")).toBe(
      "/profile"
    );
  });
});
