import { describe, expect, it } from "vitest";

import { normalizeInternalRouteHref } from "@/lib/navigation/routes";

// Characterization tests for normalizeInternalRouteHref
// (hushh-webapp/lib/navigation/routes.ts) for route strings carrying
// percent-encoded control characters / line endings, e.g. "%0D" (CR) and
// "%0A" (LF), versus their raw counterparts.
//
// TRUTH-FIRST — CURRENT CONTRACT (verified against source):
//
//   normalizeInternalRouteHref(value):
//     1. href = String(value ?? "").trim()
//     2. if (!href) return null
//     3. if (!href.startsWith("/") || href.startsWith("//")) return null
//     4. if (/[\r\n]/.test(href)) return null   // RAW CR/LF only
//     5. return href                            // verbatim, otherwise
//
//   The control-character guard uses the regex /[\r\n]/, which matches ONLY
//   literal carriage-return (U+000D) and line-feed (U+000A) characters. The
//   function does NOT call decodeURIComponent or otherwise decode percent
//   escapes. Therefore the *encoded* tokens "%0D" and "%0A" are just ordinary
//   ASCII characters ("%", "0", "D"/"A") to this guard and pass through
//   VERBATIM, while *raw* CR/LF are rejected (→ null).
//
// CORRECTION TO THE TASK PREMISE: the path guard does NOT filter out
// percent-encoded control tokens; it leaves them verbatim. It filters only raw
// (decoded) CR/LF. These tests pin that distinction.

describe("normalizeInternalRouteHref — percent-encoded control tokens pass through verbatim; only raw CR/LF rejected", () => {
  it("leaves a percent-encoded CR (%0D) verbatim", () => {
    expect(normalizeInternalRouteHref("/path%0Dvalue")).toBe("/path%0Dvalue");
  });

  it("leaves a percent-encoded LF (%0A) verbatim", () => {
    expect(normalizeInternalRouteHref("/path%0Avalue")).toBe("/path%0Avalue");
  });

  it("leaves a percent-encoded CRLF (%0D%0A) sequence verbatim", () => {
    expect(normalizeInternalRouteHref("/inject%0D%0ASet-Cookie=evil")).toBe(
      "/inject%0D%0ASet-Cookie=evil",
    );
  });

  it("leaves lowercase percent-encoded control tokens (%0d/%0a) verbatim (no case-folding/decoding)", () => {
    expect(normalizeInternalRouteHref("/p%0d%0aq")).toBe("/p%0d%0aq");
  });

  it("leaves other percent-encoded control tokens (e.g. %09 tab, %00 NUL) verbatim", () => {
    expect(normalizeInternalRouteHref("/a%09b%00c")).toBe("/a%09b%00c");
  });

  it("REJECTS a raw carriage return (decoded CR) → null", () => {
    expect(normalizeInternalRouteHref("/path\rvalue")).toBeNull();
  });

  it("REJECTS a raw line feed (decoded LF) → null", () => {
    expect(normalizeInternalRouteHref("/path\nvalue")).toBeNull();
  });

  it("REJECTS a raw CRLF sequence → null", () => {
    expect(normalizeInternalRouteHref("/inject\r\nSet-Cookie=evil")).toBeNull();
  });

  it("still applies the other guards alongside encoded tokens (protocol-relative → null, trim preserved)", () => {
    expect(normalizeInternalRouteHref("//evil%0D%0A/x")).toBeNull();
    expect(normalizeInternalRouteHref("   /ok%0Dvalue   ")).toBe("/ok%0Dvalue");
  });
});
