import { describe, expect, it } from "vitest";

import { resolveInternalRouteHref } from "@/lib/navigation/routes";

// Characterization tests for resolveInternalRouteHref
// (hushh-webapp/lib/navigation/routes.ts), focused narrowly on URL HASH /
// FRAGMENT retention (e.g. "/settings#security").
//
// Real implementation:
//   resolveInternalRouteHref(value, fallback) =
//     normalizeInternalRouteHref(value) ?? fallback
//   normalizeInternalRouteHref trims, rejects empty / non-internal / "//" /
//   CR|LF, and otherwise returns the (trimmed) string VERBATIM.
//
// Truth captured below: there is NO fragment parsing. The "#fragment" portion is
// not split off, decoded, lowercased, or stripped — for a valid internal href it
// rides along byte-for-byte. Fragment casing and encoding survive exactly.

describe("resolveInternalRouteHref — hash fragment retention", () => {
  it("preserves a simple trailing hash fragment verbatim", () => {
    expect(resolveInternalRouteHref("/settings#security", "/")).toBe(
      "/settings#security"
    );
  });

  it("preserves fragment casing exactly (no normalization)", () => {
    expect(resolveInternalRouteHref("/settings#Security-Tab", "/")).toBe(
      "/settings#Security-Tab"
    );
  });

  it("preserves both a query string and a fragment together", () => {
    expect(
      resolveInternalRouteHref("/settings?tab=privacy#security", "/")
    ).toBe("/settings?tab=privacy#security");
  });

  it("preserves an empty trailing hash ('#') verbatim", () => {
    expect(resolveInternalRouteHref("/settings#", "/")).toBe("/settings#");
  });

  it("preserves percent-encoding inside the fragment without re-encoding", () => {
    expect(
      resolveInternalRouteHref("/docs#a%20b", "/")
    ).toBe("/docs#a%20b");
  });

  it("trims surrounding whitespace but keeps the fragment intact", () => {
    expect(resolveInternalRouteHref("  /settings#security  ", "/")).toBe(
      "/settings#security"
    );
  });

  it("treats the bare root with a fragment as a valid internal href", () => {
    expect(resolveInternalRouteHref("/#top", "/")).toBe("/#top");
  });

  it("falls back when the route is external/invalid, ignoring its fragment", () => {
    expect(
      resolveInternalRouteHref("https://evil.example.com/#security", "/safe")
    ).toBe("/safe");
    expect(resolveInternalRouteHref("//evil#security", "/safe")).toBe("/safe");
  });
});
