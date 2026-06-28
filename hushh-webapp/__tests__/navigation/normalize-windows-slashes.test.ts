import { describe, expect, it } from "vitest";

import { normalizeInternalRouteHref } from "@/lib/navigation/routes";

// Characterization tests for normalizeInternalRouteHref
// (hushh-webapp/lib/navigation/routes.ts) for path sequences that resemble
// Windows file delimiters / backslashes, e.g. "/app\\legal\\privacy".
//
// TRUTH-FIRST — LITERAL CONTRACT:
//
//   export function normalizeInternalRouteHref(value): string | null {
//     const href = String(value ?? "").trim();
//     if (!href) return null;
//     if (!href.startsWith("/") || href.startsWith("//")) return null;
//     if (/[\r\n]/.test(href)) return null;
//     return href;
//   }
//
// CORRECTION TO THE TASK PREMISE: there is NO slash normalization. The utility
// does NOT convert backslashes to forward slashes and does NOT split on path
// delimiters. It is a pure allow/deny gate. A backslash is just an ordinary
// character to every check:
//   - `trim()` only strips outer ASCII whitespace (backslash is untouched)
//   - `startsWith("/")` / `startsWith("//")` look ONLY at the first 1-2 chars
//   - the reject regex matches ONLY CR/LF, NOT backslash
// Therefore any rooted (single leading "/") href containing backslashes is
// returned BYTE-FOR-BYTE VERBATIM — backslashes preserved as literal chars.
// The routing engine treats them as literal characters; it never normalizes
// them into web forward slashes.

describe("normalizeInternalRouteHref — Windows-style backslashes are literal, not normalized", () => {
  it("returns a backslash path verbatim (no conversion to forward slashes)", () => {
    expect(normalizeInternalRouteHref("/app\\legal\\privacy")).toBe(
      "/app\\legal\\privacy",
    );
  });

  it("does NOT convert backslashes into forward slashes", () => {
    const out = normalizeInternalRouteHref("/app\\legal\\privacy");
    expect(out).not.toBe("/app/legal/privacy");
    expect(out).toContain("\\");
  });

  it("preserves mixed forward/backslash separators exactly as given", () => {
    expect(normalizeInternalRouteHref("/app/legal\\privacy")).toBe(
      "/app/legal\\privacy",
    );
  });

  it("preserves a single leading forward slash followed by a backslash segment", () => {
    expect(normalizeInternalRouteHref("/\\legal")).toBe("/\\legal");
  });

  it("rejects a leading backslash (does not start with '/')", () => {
    expect(normalizeInternalRouteHref("\\app\\legal")).toBeNull();
  });

  it("rejects a backslash-prefixed value even when whitespace-padded", () => {
    expect(normalizeInternalRouteHref("  \\app\\legal  ")).toBeNull();
  });

  it("trims outer whitespace but keeps interior backslashes intact", () => {
    expect(normalizeInternalRouteHref("  /app\\legal  ")).toBe("/app\\legal");
  });

  it("preserves a trailing backslash verbatim", () => {
    expect(normalizeInternalRouteHref("/app\\")).toBe("/app\\");
  });

  it("preserves consecutive backslashes (UNC-style) after the leading slash", () => {
    expect(normalizeInternalRouteHref("/\\\\server\\share")).toBe(
      "/\\\\server\\share",
    );
  });

  it("still rejects protocol-relative '//' even with trailing backslashes", () => {
    expect(normalizeInternalRouteHref("//host\\path")).toBeNull();
  });

  it("still rejects CR/LF injection alongside backslashes", () => {
    expect(normalizeInternalRouteHref("/app\\legal\ninject")).toBeNull();
    expect(normalizeInternalRouteHref("/app\\legal\rinject")).toBeNull();
  });
});
