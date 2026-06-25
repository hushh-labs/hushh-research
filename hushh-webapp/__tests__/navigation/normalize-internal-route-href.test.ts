import { describe, expect, it } from "vitest";

import {
  normalizeInternalRouteHref,
  resolveInternalRouteHref,
} from "@/lib/navigation/routes";

// Characterization tests for normalizeInternalRouteHref / resolveInternalRouteHref
// in lib/navigation/routes.ts. These pin the *actual* implemented guards:
//   - trims surrounding whitespace
//   - returns null for empty / nullish input
//   - returns null unless the value starts with a single "/"
//   - rejects protocol-relative "//" hrefs
//   - rejects values containing CR or LF
// The function does NOT decode Unicode, normalize case, or parse "#" fragments,
// so these tests document its real (intentionally narrow) contract.

describe("normalizeInternalRouteHref", () => {
  it("returns null for nullish or empty input", () => {
    expect(normalizeInternalRouteHref(null)).toBeNull();
    expect(normalizeInternalRouteHref(undefined)).toBeNull();
    expect(normalizeInternalRouteHref("")).toBeNull();
    expect(normalizeInternalRouteHref("   ")).toBeNull();
  });

  it("trims surrounding whitespace from valid internal hrefs", () => {
    expect(normalizeInternalRouteHref("  /profile  ")).toBe("/profile");
    expect(normalizeInternalRouteHref("\t/one/kai\n")).toBe("/one/kai");
  });

  it("accepts single-slash internal paths verbatim, preserving case and query", () => {
    expect(normalizeInternalRouteHref("/profile")).toBe("/profile");
    expect(normalizeInternalRouteHref("/profile?tab=privacy")).toBe(
      "/profile?tab=privacy"
    );
    // No case normalization: uppercase segments are preserved as-is.
    expect(normalizeInternalRouteHref("/Profile/Settings")).toBe(
      "/Profile/Settings"
    );
    // No fragment parsing/decoding: "#" content passes through untouched.
    expect(normalizeInternalRouteHref("/terms#Section-A")).toBe(
      "/terms#Section-A"
    );
  });

  it("rejects non-internal or protocol-relative hrefs", () => {
    expect(normalizeInternalRouteHref("profile")).toBeNull();
    expect(normalizeInternalRouteHref("https://evil.example.com")).toBeNull();
    expect(normalizeInternalRouteHref("//evil.example.com")).toBeNull();
  });

  it("rejects hrefs containing CR or LF (header/script injection guard)", () => {
    expect(normalizeInternalRouteHref("/profile\nSet-Cookie: x=1")).toBeNull();
    expect(normalizeInternalRouteHref("/profile\rmalicious")).toBeNull();
  });
});

describe("resolveInternalRouteHref", () => {
  it("returns the normalized href when valid", () => {
    expect(resolveInternalRouteHref("/one/pkm", "/")).toBe("/one/pkm");
    expect(resolveInternalRouteHref("  /agent  ", "/")).toBe("/agent");
  });

  it("falls back when the value is invalid or empty", () => {
    expect(resolveInternalRouteHref(null, "/profile")).toBe("/profile");
    expect(resolveInternalRouteHref("https://evil.example.com", "/")).toBe("/");
    expect(resolveInternalRouteHref("//evil", "/home")).toBe("/home");
    expect(resolveInternalRouteHref("/ok\nbad", "/safe")).toBe("/safe");
  });
});
