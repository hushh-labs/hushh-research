import { describe, expect, it } from "vitest";

import { normalizeInternalRouteHref } from "@/lib/navigation/routes";

// Characterization tests for normalizeInternalRouteHref
// (hushh-webapp/lib/navigation/routes.ts), focused narrowly on TRAILING SLASH
// handling.
//
// Real implemented guard:
//   const href = String(value ?? "").trim();
//   if (!href) return null;
//   if (!href.startsWith("/") || href.startsWith("//")) return null;
//   if (/[\r\n]/.test(href)) return null;
//   return href;
//
// Truth captured below: there is NO trailing-slash policy. The function does not
// enforce trailing-slash retention and does not strip trailing slashes. A valid
// internal href is returned VERBATIM (after surrounding-whitespace trim only),
// so terminal "/" characters are left un-mutated.

describe("normalizeInternalRouteHref — trailing slash handling", () => {
  it("leaves a single trailing slash un-mutated (no stripping)", () => {
    expect(normalizeInternalRouteHref("/profile/")).toBe("/profile/");
    expect(normalizeInternalRouteHref("/one/kai/")).toBe("/one/kai/");
  });

  it("leaves a path WITHOUT a trailing slash un-mutated (no enforcement)", () => {
    expect(normalizeInternalRouteHref("/profile")).toBe("/profile");
    expect(normalizeInternalRouteHref("/one/kai")).toBe("/one/kai");
  });

  it("treats with/without trailing slash as distinct outputs", () => {
    // Documents that the two forms are NOT normalized to a single canonical form.
    expect(normalizeInternalRouteHref("/agent/")).not.toBe(
      normalizeInternalRouteHref("/agent")
    );
  });

  it("preserves a query/fragment after a trailing slash verbatim", () => {
    expect(normalizeInternalRouteHref("/profile/?tab=privacy")).toBe(
      "/profile/?tab=privacy"
    );
    expect(normalizeInternalRouteHref("/terms/#Section-A")).toBe(
      "/terms/#Section-A"
    );
  });

  it("trims surrounding whitespace but keeps the terminal slash", () => {
    expect(normalizeInternalRouteHref("  /profile/  ")).toBe("/profile/");
  });

  it("returns the root '/' verbatim (single slash is valid)", () => {
    expect(normalizeInternalRouteHref("/")).toBe("/");
  });

  it("still rejects multi-slash even when it also has a trailing slash", () => {
    // The leading "//" guard fires regardless of trailing characters.
    expect(normalizeInternalRouteHref("//evil/")).toBeNull();
  });
});
