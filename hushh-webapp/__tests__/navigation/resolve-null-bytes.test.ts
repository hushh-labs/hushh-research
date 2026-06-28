import { describe, expect, it } from "vitest";

import { resolveInternalRouteHref } from "@/lib/navigation/routes";

// Characterization tests for resolveInternalRouteHref
// (hushh-webapp/lib/navigation/routes.ts) focused on percent-encoded null bytes
// (`%00`) appearing inside query parameter values.
//
// TRUTH-FIRST (verified against the source):
//   resolveInternalRouteHref(value, fallback) === normalizeInternalRouteHref(value) ?? fallback
//   normalizeInternalRouteHref only:
//     1. String(value ?? "").trim()
//     2. rejects empty
//     3. rejects non-"/"-rooted OR "//"-prefixed
//     4. rejects raw CR/LF (/[\r\n]/)
//     5. otherwise returns the href verbatim
//   There is NO decodeURIComponent, NO query parsing, NO null-byte handling.
//   A raw "\0" is NOT in the CR/LF reject set, so it does not trigger the
//   fallback. The percent-encoded token "%00" is just three literal characters
//   "%", "0", "0" — never decoded, never truncated. Text AFTER the null token is
//   preserved exactly; nothing is cut at the "null character boundary". These
//   tests pin that exact behavior for both encoded and raw forms.

describe("resolveInternalRouteHref — percent-encoded null bytes are preserved verbatim", () => {
  it("returns the href unchanged with %00 inside a parameter value (no truncation)", () => {
    expect(
      resolveInternalRouteHref("/api/v1?data=valid%00truncated", "/fallback")
    ).toBe("/api/v1?data=valid%00truncated");
  });

  it("does NOT cut text following the %00 token", () => {
    const out = resolveInternalRouteHref(
      "/api/v1?data=valid%00truncated",
      "/fallback"
    );
    expect(out).toContain("truncated");
    expect(out).toContain("%00");
    expect(out).not.toBe("/api/v1?data=valid");
  });

  it("preserves %00 across array-formatted query parameters", () => {
    expect(
      resolveInternalRouteHref(
        "/api/v1?ids[]=a%00b&ids[]=c%00d",
        "/fallback"
      )
    ).toBe("/api/v1?ids[]=a%00b&ids[]=c%00d");
  });

  it("preserves a lowercase-equivalent %00 without altering the hex digits", () => {
    expect(
      resolveInternalRouteHref("/search?q=x%00y", "/fallback")
    ).toBe("/search?q=x%00y");
  });
});

describe("resolveInternalRouteHref — raw null character is not a reject trigger", () => {
  it("returns a raw \\0-containing href verbatim (only CR/LF are rejected)", () => {
    const href = "/api/v1?data=valid\u0000truncated";
    expect(resolveInternalRouteHref(href, "/fallback")).toBe(href);
  });

  it("does not fall back for a raw null byte the way it would for CR/LF", () => {
    expect(
      resolveInternalRouteHref("/api/v1?x=a\u0000b", "/fallback")
    ).not.toBe("/fallback");
    // contrast: a CR/LF-bearing href DOES fall back
    expect(
      resolveInternalRouteHref("/api/v1?x=a\nb", "/fallback")
    ).toBe("/fallback");
  });
});

describe("resolveInternalRouteHref — fallback path still applies around %00 inputs", () => {
  it("falls back for a protocol-relative href even when it carries %00", () => {
    expect(
      resolveInternalRouteHref("//evil.example?data=a%00b", "/fallback")
    ).toBe("/fallback");
  });

  it("falls back for a non-rooted href that contains %00", () => {
    expect(
      resolveInternalRouteHref("api/v1?data=a%00b", "/fallback")
    ).toBe("/fallback");
  });

  it("trims surrounding whitespace while keeping the inner %00 intact", () => {
    expect(
      resolveInternalRouteHref("  /api/v1?data=a%00b  ", "/fallback")
    ).toBe("/api/v1?data=a%00b");
  });
});
