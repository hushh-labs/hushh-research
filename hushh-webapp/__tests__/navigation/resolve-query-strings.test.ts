import { describe, expect, it } from "vitest";

import { resolveInternalRouteHref } from "@/lib/navigation/routes";

// Characterization tests for resolveInternalRouteHref
// (hushh-webapp/lib/navigation/routes.ts), focused on how query strings ride
// along when appended to an internal route.
//
// Real implementation:
//   resolveInternalRouteHref(value, fallback) =
//     normalizeInternalRouteHref(value) ?? fallback
//   normalizeInternalRouteHref trims, rejects non-internal / "//" / CR|LF, and
//   otherwise returns the (trimmed) string VERBATIM.
//
// Truth captured below: resolveInternalRouteHref does NOT parse, re-order, or
// re-encode the query string. For a valid internal href it passes the query
// portion through byte-for-byte. There is no URLSearchParams round-trip on this
// path, so parameter order, key casing, and existing percent-encoding survive
// exactly as written.

describe("resolveInternalRouteHref — query string preservation", () => {
  it("preserves exact parameter order verbatim (no sorting)", () => {
    expect(
      resolveInternalRouteHref("/profile?z=1&a=2&m=3", "/")
    ).toBe("/profile?z=1&a=2&m=3");
  });

  it("preserves key casing verbatim (no normalization)", () => {
    expect(
      resolveInternalRouteHref("/one/kai?Tab=Privacy&UserId=AB12", "/")
    ).toBe("/one/kai?Tab=Privacy&UserId=AB12");
  });

  it("preserves existing percent-encoding without re-encoding or decoding", () => {
    expect(
      resolveInternalRouteHref("/search?q=hello%20world&filter=a%2Bb", "/")
    ).toBe("/search?q=hello%20world&filter=a%2Bb");
  });

  it("does not encode raw special characters already present in the query", () => {
    // The function performs no encoding pass, so a raw space / plus / ampersand
    // structure is returned exactly as supplied.
    expect(
      resolveInternalRouteHref("/x?a=1&b=c+d&e=f", "/")
    ).toBe("/x?a=1&b=c+d&e=f");
  });

  it("preserves repeated keys and empty values verbatim", () => {
    expect(
      resolveInternalRouteHref("/list?tag=a&tag=b&empty=", "/")
    ).toBe("/list?tag=a&tag=b&empty=");
  });

  it("trims surrounding whitespace but leaves the query body intact", () => {
    expect(
      resolveInternalRouteHref("   /profile?z=1&a=2   ", "/")
    ).toBe("/profile?z=1&a=2");
  });

  it("falls back when the route portion itself is invalid, ignoring the query", () => {
    // Guard fires on the route shape before any query consideration.
    expect(
      resolveInternalRouteHref("https://evil.example.com/?a=1", "/safe")
    ).toBe("/safe");
    expect(resolveInternalRouteHref("//evil?a=1", "/safe")).toBe("/safe");
  });
});
