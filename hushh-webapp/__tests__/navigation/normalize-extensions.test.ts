import { describe, expect, it } from "vitest";

import { normalizeInternalRouteHref } from "@/lib/navigation/routes";

// Characterization tests for normalizeInternalRouteHref
// (hushh-webapp/lib/navigation/routes.ts) focused on route paths that end in a
// file-format extension (e.g. /api/legal/privacy.json, /api/legal/terms.txt).
//
// Real implementation:
//   export function normalizeInternalRouteHref(value) {
//     const href = String(value ?? "").trim();
//     if (!href) return null;
//     if (!href.startsWith("/") || href.startsWith("//")) return null;
//     if (/[\r\n]/.test(href)) return null;
//     return href;
//   }
//
// TRUTH-FIRST: the guard is extension-agnostic. It does NOT parse, track,
// rewrite, or special-case `.json` / `.txt` / any asset extension. There are no
// "tracking parameters." The only decisions are:
//   - trim whitespace ends
//   - reject (→ null) when empty, not "/"-prefixed, "//"-prefixed, or
//     containing \r/\n
//   - otherwise return the href VERBATIM (extension and any query/hash intact)
// These tests pin that the literal asset string is preserved exactly.

describe("normalizeInternalRouteHref — file-extension route paths", () => {
  it("preserves a .json asset path verbatim", () => {
    expect(normalizeInternalRouteHref("/api/legal/privacy.json")).toBe(
      "/api/legal/privacy.json"
    );
  });

  it("preserves a .txt asset path verbatim", () => {
    expect(normalizeInternalRouteHref("/api/legal/terms.txt")).toBe(
      "/api/legal/terms.txt"
    );
  });

  it("does not strip or rewrite the extension when a query string follows", () => {
    expect(normalizeInternalRouteHref("/files/report.csv?v=2")).toBe(
      "/files/report.csv?v=2"
    );
  });

  it("keeps an extension plus hash fragment intact", () => {
    expect(normalizeInternalRouteHref("/docs/spec.pdf#page=3")).toBe(
      "/docs/spec.pdf#page=3"
    );
  });

  it("preserves multi-dot / uppercase extensions exactly (no normalization)", () => {
    expect(normalizeInternalRouteHref("/assets/archive.TAR.GZ")).toBe(
      "/assets/archive.TAR.GZ"
    );
  });

  it("trims surrounding whitespace but keeps the extension", () => {
    expect(normalizeInternalRouteHref("  /api/legal/privacy.json  ")).toBe(
      "/api/legal/privacy.json"
    );
  });

  it("rejects a protocol-relative href even when it ends in an extension", () => {
    expect(normalizeInternalRouteHref("//cdn.example.com/app.js")).toBeNull();
  });

  it("rejects a bare (non-rooted) filename with an extension", () => {
    expect(normalizeInternalRouteHref("privacy.json")).toBeNull();
  });

  it("trims a TRAILING newline before the CR/LF guard, so the path is accepted", () => {
    // trim() runs first and removes the trailing \n, so /[\r\n]/ never matches.
    expect(normalizeInternalRouteHref("/api/legal/terms.txt\n")).toBe(
      "/api/legal/terms.txt"
    );
  });

  it("rejects an INTERIOR newline within an extension path", () => {
    expect(normalizeInternalRouteHref("/api/legal\n/terms.txt")).toBeNull();
  });
});
