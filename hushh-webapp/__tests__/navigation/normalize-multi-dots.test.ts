import { describe, expect, it } from "vitest";

import { normalizeInternalRouteHref } from "@/lib/navigation/routes";

// Characterization tests for normalizeInternalRouteHref
// (hushh-webapp/lib/navigation/routes.ts) focused on multi-dot / explicit
// relative path segments (e.g. "/app/../legal/..", "/a/./b", "/x..y").
//
// Real guard:
//   const href = String(value ?? "").trim();
//   if (!href) return null;
//   if (!href.startsWith("/") || href.startsWith("//")) return null;
//   if (/[\r\n]/.test(href)) return null;
//   return href;
//
// TRUTH-FIRST: the guard performs NO path normalization or traversal
// resolution. It does not collapse "..", "." or repeated dots. A string that
// starts with a single "/", has no protocol-relative "//" prefix, and contains
// no CR/LF is returned VERBATIM — dot segments included. There is no "tracking
// logic isolation"; the dots are ordinary path characters that survive intact.

describe("normalizeInternalRouteHref — multi-dot / relative segments", () => {
  it("preserves '..' traversal segments verbatim (no collapse)", () => {
    expect(normalizeInternalRouteHref("/app/../legal/..")).toBe(
      "/app/../legal/.."
    );
  });

  it("preserves a single './' current-dir segment verbatim", () => {
    expect(normalizeInternalRouteHref("/a/./b")).toBe("/a/./b");
  });

  it("preserves a leading '/..' without resolving above root", () => {
    expect(normalizeInternalRouteHref("/../secret")).toBe("/../secret");
  });

  it("preserves long dot runs as literal text", () => {
    expect(normalizeInternalRouteHref("/x/..../y")).toBe("/x/..../y");
  });

  it("preserves dots embedded in a filename-like segment", () => {
    expect(normalizeInternalRouteHref("/files/archive.tar.gz")).toBe(
      "/files/archive.tar.gz"
    );
  });

  it("still rejects a protocol-relative '//' host even with dot segments", () => {
    expect(normalizeInternalRouteHref("//evil.com/../x")).toBeNull();
  });

  it("rejects a relative dot path that does not start with '/'", () => {
    expect(normalizeInternalRouteHref("../legal")).toBeNull();
    expect(normalizeInternalRouteHref("./legal")).toBeNull();
  });

  it("trims surrounding whitespace but keeps the dot segments", () => {
    expect(normalizeInternalRouteHref("   /app/../legal   ")).toBe(
      "/app/../legal"
    );
  });
});
