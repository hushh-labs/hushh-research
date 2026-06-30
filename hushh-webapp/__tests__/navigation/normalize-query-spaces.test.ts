import { describe, expect, it } from "vitest";

import { normalizeInternalRouteHref } from "@/lib/navigation/routes";

// Characterization tests for normalizeInternalRouteHref
// (hushh-webapp/lib/navigation/routes.ts) focused on percent-encoded spaces
// (`%20`) appearing inside the SEARCH QUERY portion of a rooted href.
//
// TRUTH-FIRST: normalizeInternalRouteHref does NOT parse or decode the query
// string. Its full contract is:
//   const href = String(value ?? "").trim();
//   if (!href) return null;                                   // empty
//   if (!href.startsWith("/") || href.startsWith("//")) return null; // rooted, not protocol-relative
//   if (/[\r\n]/.test(href)) return null;                     // no CR/LF
//   return href;                                              // else VERBATIM
// So a `%20` in the query is RETAINED literally — it is never decoded to a
// space, never re-encoded, and never collapsed. The only mutation that can apply
// is an OUTER trim of the whole string. Outer-rejection rules (leading `//`,
// CR/LF) still apply to the whole href even when the offending part is "in" the
// query.

describe("normalizeInternalRouteHref — percent-encoded spaces in query", () => {
  it("retains a literal %20 in the query string verbatim", () => {
    expect(normalizeInternalRouteHref("/search?q=open%20source")).toBe(
      "/search?q=open%20source"
    );
  });

  it("does NOT decode %20 into a real space", () => {
    const out = normalizeInternalRouteHref("/search?q=open%20source");
    expect(out).toContain("%20");
    expect(out).not.toContain("open source");
  });

  it("retains multiple %20 sequences in one query value", () => {
    expect(
      normalizeInternalRouteHref("/search?q=a%20b%20c&sort=desc")
    ).toBe("/search?q=a%20b%20c&sort=desc");
  });

  it("leaves a RAW space in the query untouched (no encoding added)", () => {
    // The guard does not encode; a literal space stays a literal space.
    expect(normalizeInternalRouteHref("/search?q=open source")).toBe(
      "/search?q=open source"
    );
  });

  it("trims only the OUTER whitespace, preserving inner %20", () => {
    expect(normalizeInternalRouteHref("  /search?q=open%20source  ")).toBe(
      "/search?q=open%20source"
    );
  });

  it("still rejects a protocol-relative href even with %20 in the query", () => {
    expect(normalizeInternalRouteHref("//evil.com/?q=open%20source")).toBeNull();
  });

  it("rejects an INTERIOR CR/LF even when %20 is present in the query", () => {
    // The CR/LF guard catches newlines that survive the outer trim.
    expect(
      normalizeInternalRouteHref("/search?q=open%20\nsource")
    ).toBeNull();
  });

  it("TRIMS a trailing newline (runs before the CR/LF guard) and returns verbatim", () => {
    // TRUTH-FIRST: `.trim()` executes BEFORE the /[\r\n]/ check, so a trailing
    // \n is stripped first and the href is accepted — it is NOT rejected.
    expect(
      normalizeInternalRouteHref("/search?q=open%20source\n")
    ).toBe("/search?q=open%20source");
  });
});


