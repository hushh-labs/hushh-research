import { describe, expect, it } from "vitest";

import { resolveInternalRouteHref } from "@/lib/navigation/routes";

// Characterization tests for resolveInternalRouteHref
// (hushh-webapp/lib/navigation/routes.ts) for query segments that contain a
// percent-encoded ampersand (%26) inside a single field's string parameter,
// e.g. "/one?utm_campaign=spring%26summer".
//
// TRUTH-FIRST — LITERAL CONTRACT:
//
//   export function resolveInternalRouteHref(value, fallback): string {
//     return normalizeInternalRouteHref(value) ?? fallback;
//   }
//
//   export function normalizeInternalRouteHref(value): string | null {
//     const href = String(value ?? "").trim();
//     if (!href) return null;
//     if (!href.startsWith("/") || href.startsWith("//")) return null;
//     if (/[\r\n]/.test(href)) return null;
//     return href;
//   }
//
// CORRECTION TO THE TASK PREMISE: resolveInternalRouteHref does NOT parse,
// decode, split, or re-serialize the query string. It performs NO
// URLSearchParams round-trip. It is a thin wrapper that either returns the
// trimmed href verbatim (when it passes the same-origin/rooted safety gate) or
// returns the caller's fallback. Therefore a `%26` inside a query value is
// preserved BYTE-FOR-BYTE as the three literal characters "%26" — it is never
// decoded into "&" and the surrounding value is never split into two params.
// The "tracking chain" stays intact precisely because nothing tokenizes it.

describe("resolveInternalRouteHref — percent-encoded ampersand (%26) in a query value is literal text", () => {
  const FALLBACK = "/one";

  it("keeps %26 inside a single utm field verbatim (no decode, no split)", () => {
    const href = "/one?utm_campaign=spring%26summer";
    const out = resolveInternalRouteHref(href, FALLBACK);
    expect(out).toBe("/one?utm_campaign=spring%26summer");
  });

  it("does NOT decode %26 into a literal & (would split the tracking chain)", () => {
    const out = resolveInternalRouteHref(
      "/one?utm_campaign=spring%26summer",
      FALLBACK,
    );
    expect(out).toContain("%26");
    expect(out).not.toContain("spring&summer");
  });

  it("does NOT introduce a second query parameter from the encoded ampersand", () => {
    const out = resolveInternalRouteHref(
      "/one?ref=a%26utm_source=b",
      FALLBACK,
    );
    // Single real '?' separator, single real '=' for the one field key 'ref',
    // and the encoded ampersand stays inside the value.
    expect(out).toBe("/one?ref=a%26utm_source=b");
    expect(out.split("&").length).toBe(1);
  });

  it("preserves a real & delimiter AND an encoded %26 distinctly", () => {
    const href = "/one?a=x%26y&b=z";
    const out = resolveInternalRouteHref(href, FALLBACK);
    expect(out).toBe("/one?a=x%26y&b=z");
    // Exactly one real delimiter splits into two fields; the %26 does not add a third.
    expect(out.split("&").length).toBe(2);
  });

  it("trims surrounding whitespace but keeps the encoded ampersand intact", () => {
    const out = resolveInternalRouteHref(
      "  /one?utm_campaign=spring%26summer  ",
      FALLBACK,
    );
    expect(out).toBe("/one?utm_campaign=spring%26summer");
  });

  it("preserves lowercase %26 exactly (no case normalization of the escape)", () => {
    const out = resolveInternalRouteHref("/x?q=a%26b", FALLBACK);
    expect(out).toBe("/x?q=a%26b");
  });

  it("returns the fallback (not the raw value) when the href fails the safety gate", () => {
    // Protocol-relative is rejected even though it carries an encoded ampersand.
    expect(
      resolveInternalRouteHref("//evil.example?q=a%26b", FALLBACK),
    ).toBe(FALLBACK);
    // A non-rooted value is also rejected.
    expect(resolveInternalRouteHref("one?q=a%26b", FALLBACK)).toBe(FALLBACK);
  });

  it("returns the fallback for nullish input regardless of encoding intent", () => {
    expect(resolveInternalRouteHref(null, FALLBACK)).toBe(FALLBACK);
    expect(resolveInternalRouteHref(undefined, FALLBACK)).toBe(FALLBACK);
  });
});
