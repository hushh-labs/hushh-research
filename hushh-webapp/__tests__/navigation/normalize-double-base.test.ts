import { describe, expect, it } from "vitest";

import { normalizeInternalRouteHref } from "@/lib/navigation/routes";

// Characterization tests for normalizeInternalRouteHref
// (hushh-webapp/lib/navigation/routes.ts) focused on accidental MID-PATH double
// forward slashes (e.g. "/app//legal/privacy").
//
// TRUTH-FIRST: normalizeInternalRouteHref does NOT collapse, clean, or "clear"
// interior double slashes. Its only slash-related guard rejects a LEADING "//"
// (the protocol-relative form). The full contract is:
//   const href = String(value ?? "").trim();
//   if (!href) return null;                                  // empty
//   if (!href.startsWith("/") || href.startsWith("//")) return null; // rooted + not //
//   if (/[\r\n]/.test(href)) return null;                    // no CR/LF
//   return href;                                             // else VERBATIM
// So a mid-path "//" is preserved exactly. Only a href that BEGINS with "//"
// (protocol-relative) is rejected. The premise that interior duplicate slashes
// are filtered/cleared is FALSE — they pass through untouched.

describe("normalizeInternalRouteHref — mid-path double slashes", () => {
  it("preserves a mid-path double slash verbatim (no collapsing)", () => {
    expect(normalizeInternalRouteHref("/app//legal/privacy")).toBe(
      "/app//legal/privacy"
    );
  });

  it("preserves multiple interior double slashes verbatim", () => {
    expect(normalizeInternalRouteHref("/a//b//c")).toBe("/a//b//c");
  });

  it("preserves a triple interior slash verbatim", () => {
    expect(normalizeInternalRouteHref("/app///legal")).toBe("/app///legal");
  });

  it("preserves a trailing double slash verbatim", () => {
    expect(normalizeInternalRouteHref("/app/legal//")).toBe("/app/legal//");
  });

  it("trims surrounding whitespace but keeps interior double slash", () => {
    expect(normalizeInternalRouteHref("  /app//legal  ")).toBe("/app//legal");
  });

  it("rejects a LEADING double slash (protocol-relative form)", () => {
    expect(normalizeInternalRouteHref("//app/legal")).toBeNull();
  });

  it("rejects a leading double slash even with deeper path segments", () => {
    expect(normalizeInternalRouteHref("//evil.com//legal")).toBeNull();
  });

  it("still requires a rooted href (non-rooted with // is rejected)", () => {
    expect(normalizeInternalRouteHref("app//legal")).toBeNull();
  });

  it("accepts a single-slash rooted path unchanged (control case)", () => {
    expect(normalizeInternalRouteHref("/app/legal/privacy")).toBe(
      "/app/legal/privacy"
    );
  });
});
