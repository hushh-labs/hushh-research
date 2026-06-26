import { describe, expect, it } from "vitest";

import { normalizeInternalRouteHref } from "@/lib/navigation/routes";

// Characterization tests for normalizeInternalRouteHref
// (hushh-webapp/lib/navigation/routes.ts) for route paths built from
// consecutive relative single-dot navigation markers, e.g.
// "/./legal/./privacy/./".
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
// CORRECTION TO THE TASK PREMISE: the path guard does NOT normalize, collapse,
// resolve, or canonicalize "." (single-dot) segments. There is no path
// resolution at all. It is a pure allow/deny gate that treats "." like any
// other ordinary character. As long as the value starts with a single "/"
// (not "//") and contains no CR/LF, the dot-chain is returned BYTE-FOR-BYTE
// VERBATIM — "/./legal/./privacy/./" stays exactly as written; it is NOT
// reduced to "/legal/privacy". The data is validated as a standard string
// fragment, never resolved as filesystem-style relative navigation.

describe("normalizeInternalRouteHref — relative single-dot segment chains are literal, not resolved", () => {
  it("returns a dot-chain path verbatim (no collapse to /legal/privacy)", () => {
    const out = normalizeInternalRouteHref("/./legal/./privacy/./");
    expect(out).toBe("/./legal/./privacy/./");
  });

  it("does NOT canonicalize away the single-dot segments", () => {
    const out = normalizeInternalRouteHref("/./legal/./privacy/./");
    expect(out).not.toBe("/legal/privacy");
    expect(out).not.toBe("/legal/privacy/");
    expect(out).toContain("/./");
  });

  it("preserves a leading /./ prefix exactly", () => {
    expect(normalizeInternalRouteHref("/./profile")).toBe("/./profile");
  });

  it("preserves a trailing /. exactly", () => {
    expect(normalizeInternalRouteHref("/profile/.")).toBe("/profile/.");
  });

  it("preserves consecutive dot markers without dedupe", () => {
    expect(normalizeInternalRouteHref("/./././x")).toBe("/./././x");
  });

  it("accepts a single '/.' rooted value verbatim (starts with one slash)", () => {
    expect(normalizeInternalRouteHref("/.")).toBe("/.");
  });

  it("rejects a './'-leading value because it does not start with '/'", () => {
    expect(normalizeInternalRouteHref("./legal/privacy")).toBeNull();
  });

  it("trims outer whitespace but keeps interior dot segments intact", () => {
    expect(normalizeInternalRouteHref("  /./legal/.  ")).toBe("/./legal/.");
  });

  it("still rejects a protocol-relative '//' even with dot segments", () => {
    expect(normalizeInternalRouteHref("//./legal")).toBeNull();
  });

  it("still rejects CR/LF injection alongside dot segments", () => {
    expect(normalizeInternalRouteHref("/./legal\n./privacy")).toBeNull();
    expect(normalizeInternalRouteHref("/./legal\r./privacy")).toBeNull();
  });
});
