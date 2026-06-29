import { describe, expect, it } from "vitest";

import { normalizeInternalRouteHref } from "@/lib/navigation/routes";

// Characterization tests for normalizeInternalRouteHref
// (hushh-webapp/lib/navigation/routes.ts) focused on non-standard DOUBLE
// question marks inside raw query paths (e.g. "/search??query=value" or
// "/page?id=1?type=all").
//
// TRUTH-FIRST: normalizeInternalRouteHref does NOT parse, split, or validate the
// query string. It performs only structural guards on the whole href:
//   - reject empty / whitespace-only input  → null
//   - reject input not beginning with "/"   → null
//   - reject protocol-relative "//..."       → null
//   - reject input containing CR or LF        → null
//   - otherwise return the (trimmed) string VERBATIM
// The "?" character is never special-cased. A secondary "?" is therefore NOT
// flagged, NOT collapsed, and NOT stripped — the entire path (including every
// extra "?") is returned exactly as-is. The premise that the guard might "flag
// the secondary characters" is FALSE; they are left verbatim.

describe("normalizeInternalRouteHref — double question marks", () => {
  it("returns a leading-double-question path verbatim (does not flag the 2nd ?)", () => {
    expect(normalizeInternalRouteHref("/search??query=value")).toBe(
      "/search??query=value"
    );
  });

  it("returns an interior second-question path verbatim", () => {
    expect(normalizeInternalRouteHref("/page?id=1?type=all")).toBe(
      "/page?id=1?type=all"
    );
  });

  it("preserves three or more question marks unchanged", () => {
    expect(normalizeInternalRouteHref("/a???b")).toBe("/a???b");
  });

  it("keeps a trailing bare double-question verbatim", () => {
    expect(normalizeInternalRouteHref("/results??")).toBe("/results??");
  });

  it("still rejects a double-question path that is not rooted (no leading slash)", () => {
    expect(normalizeInternalRouteHref("search??query=value")).toBeNull();
  });

  it("still rejects a protocol-relative double-question path", () => {
    expect(normalizeInternalRouteHref("//evil.com??x=1")).toBeNull();
  });

  it("trims a TRAILING newline then accepts (trim() runs before the CR/LF guard)", () => {
    // trim() removes the trailing \n first, so the CR/LF guard never sees it.
    expect(normalizeInternalRouteHref("/search??q=1\n")).toBe("/search??q=1");
  });

  it("still rejects a double-question path with an INTERIOR newline (CR/LF guard)", () => {
    expect(normalizeInternalRouteHref("/search??q=1\nx=2")).toBeNull();
  });
});
