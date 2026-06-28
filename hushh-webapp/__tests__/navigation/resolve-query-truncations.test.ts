import { resolveInternalRouteHref } from "@/lib/navigation/routes";

// Characterization tests for resolveInternalRouteHref
// (hushh-webapp/lib/navigation/routes.ts) focused on query strings that carry
// MULTIPLE raw, un-escaped question marks, e.g. "/search?q=what?&user=123".
//
// TRUTH-FIRST — LITERAL CONTRACT (verified against the source):
//   export function resolveInternalRouteHref(value, fallback): string {
//     return normalizeInternalRouteHref(value) ?? fallback;
//   }
//   export function normalizeInternalRouteHref(value): string | null {
//     const href = String(value ?? "").trim();
//     if (!href) return null;
//     if (!href.startsWith("/") || href.startsWith("//")) return null;
//     if (/[\r\n]/.test(href)) return null;
//     return href;
//   }
//
// PREMISE CORRECTION: there is NO query parser here. resolveInternalRouteHref
// does NOT split on "?", does NOT treat only the first "?" as the query
// delimiter, does NOT truncate at a second "?", and does NOT decode anything.
// For any valid internal href the ENTIRE string — including every additional raw
// "?" — is returned verbatim. The "isolates everything following the initial
// question mark" framing is therefore not something the utility does at all: it
// keeps the whole opaque string (path + all `?` + params) unchanged.

const FALLBACK = "/one";

describe("resolveInternalRouteHref — multiple raw '?' in the query are kept verbatim (no truncation)", () => {
  it("returns the href verbatim when a '?' appears inside a query value", () => {
    expect(resolveInternalRouteHref("/search?q=what?&user=123", FALLBACK)).toBe(
      "/search?q=what?&user=123"
    );
  });

  it("does NOT truncate at the second '?' (no first-delimiter-only parsing)", () => {
    const href = "/search?q=what?&user=123";
    const out = resolveInternalRouteHref(href, FALLBACK);
    expect(out.endsWith("&user=123")).toBe(true);
    expect(out).toContain("what?");
  });

  it("preserves several consecutive raw question marks", () => {
    expect(resolveInternalRouteHref("/x?a=1???b=2", FALLBACK)).toBe(
      "/x?a=1???b=2"
    );
  });

  it("preserves a trailing raw '?' at the very end of the query", () => {
    expect(resolveInternalRouteHref("/x?q=huh?", FALLBACK)).toBe("/x?q=huh?");
  });

  it("preserves a '?' that sits in the path segment before any query", () => {
    expect(resolveInternalRouteHref("/faq?/topic?id=7", FALLBACK)).toBe(
      "/faq?/topic?id=7"
    );
  });

  it("does not decode, reorder, or collapse the surrounding params", () => {
    const href = "/list?b=2&q=a?b?c&a=1";
    expect(resolveInternalRouteHref(href, FALLBACK)).toBe(
      "/list?b=2&q=a?b?c&a=1"
    );
  });

  it("trims surrounding whitespace but keeps every interior '?' intact", () => {
    expect(resolveInternalRouteHref("  /search?q=what?&user=123  ", FALLBACK)).toBe(
      "/search?q=what?&user=123"
    );
  });
});

describe("resolveInternalRouteHref — guards still apply regardless of extra '?'", () => {
  it("falls back for a protocol-relative href even with multi-'?' query", () => {
    expect(
      resolveInternalRouteHref("//evil.example?q=what?&user=123", FALLBACK)
    ).toBe(FALLBACK);
  });

  it("falls back for an absolute URL even with multi-'?' query", () => {
    expect(
      resolveInternalRouteHref("https://evil.example/s?q=what?&user=1", FALLBACK)
    ).toBe(FALLBACK);
  });

  it("falls back for a non-rooted candidate that begins with '?'", () => {
    expect(resolveInternalRouteHref("?q=what?&user=123", FALLBACK)).toBe(
      FALLBACK
    );
  });

  it("falls back when a newline rides along with the multi-'?' query", () => {
    expect(
      resolveInternalRouteHref("/search?q=what?\n&user=123", FALLBACK)
    ).toBe(FALLBACK);
  });

  it("falls back on null/empty input regardless of intended query shape", () => {
    expect(resolveInternalRouteHref(null, FALLBACK)).toBe(FALLBACK);
    expect(resolveInternalRouteHref(undefined, FALLBACK)).toBe(FALLBACK);
    expect(resolveInternalRouteHref("   ", FALLBACK)).toBe(FALLBACK);
  });
});
