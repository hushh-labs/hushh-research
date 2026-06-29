import { describe, expect, it } from "vitest";

import { normalizeInternalRouteHref } from "@/lib/navigation/routes";

// Characterization tests for normalizeInternalRouteHref
// (hushh-webapp/lib/navigation/routes.ts) for route paths built from
// parent-directory ".." (double-dot) traversal segments, e.g.
// "/api/legal/../v1/privacy/../../terms".
//
// This complements normalize-dot-chains.test.ts (which pins SINGLE-dot "."
// segments) by pinning the distinct DOUBLE-dot ".." parent-traversal case.
//
// TRUTH-FIRST — LITERAL CONTRACT (verified against source):
//
//   export function normalizeInternalRouteHref(value): string | null {
//     const href = String(value ?? "").trim();
//     if (!href) return null;
//     if (!href.startsWith("/") || href.startsWith("//")) return null;
//     if (/[\r\n]/.test(href)) return null;
//     return href;
//   }
//
// CORRECTION TO THE TASK PREMISE: the guard does NOT "resolve and collapse
// directory tiers". There is NO path resolution of any kind. ".." is treated
// as ordinary path text, exactly like any other character. As long as the
// value starts with a single "/" (not "//") and contains no CR/LF, the ".."
// chain is returned BYTE-FOR-BYTE VERBATIM. So
// "/api/legal/../v1/privacy/../../terms" is NOT reduced to "/api/terms" (or any
// canonical form) — it is recorded literally. The function is a pure allow/deny
// string gate, not a filesystem-style relative-path resolver.

describe("normalizeInternalRouteHref — parent-directory '..' segments are literal, not resolved", () => {
  it("returns a multi-tier '..' path verbatim (no collapse to a canonical form)", () => {
    const out = normalizeInternalRouteHref(
      "/api/legal/../v1/privacy/../../terms",
    );
    expect(out).toBe("/api/legal/../v1/privacy/../../terms");
  });

  it("does NOT canonicalize '..' tiers away", () => {
    const out = normalizeInternalRouteHref(
      "/api/legal/../v1/privacy/../../terms",
    );
    expect(out).not.toBe("/api/terms");
    expect(out).not.toBe("/terms");
    expect(out).toContain("/../");
  });

  it("preserves a single trailing '..' exactly", () => {
    expect(normalizeInternalRouteHref("/profile/..")).toBe("/profile/..");
  });

  it("preserves a leading '/../' prefix verbatim (does NOT escape the root)", () => {
    expect(normalizeInternalRouteHref("/../secret")).toBe("/../secret");
  });

  it("preserves consecutive '..' markers without dedupe or resolution", () => {
    expect(normalizeInternalRouteHref("/../../../x")).toBe("/../../../x");
  });

  it("accepts a bare rooted '/..' verbatim (starts with one slash)", () => {
    expect(normalizeInternalRouteHref("/..")).toBe("/..");
  });

  it("rejects a '../'-leading value because it does not start with '/'", () => {
    expect(normalizeInternalRouteHref("../api/terms")).toBeNull();
  });

  it("trims outer whitespace but keeps interior '..' segments intact", () => {
    expect(normalizeInternalRouteHref("  /api/../terms  ")).toBe(
      "/api/../terms",
    );
  });

  it("still rejects a protocol-relative '//' even with '..' segments", () => {
    expect(normalizeInternalRouteHref("//../etc/passwd")).toBeNull();
  });

  it("still rejects CR/LF injection alongside '..' segments", () => {
    expect(normalizeInternalRouteHref("/api/..\n/terms")).toBeNull();
    expect(normalizeInternalRouteHref("/api/..\r/terms")).toBeNull();
  });

  it("does not decode percent-encoded '..' (%2e%2e) — kept as literal text", () => {
    expect(normalizeInternalRouteHref("/api/%2e%2e/terms")).toBe(
      "/api/%2e%2e/terms",
    );
  });
});
