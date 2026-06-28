import { describe, expect, it } from "vitest";

import { normalizeInternalRouteHref } from "@/lib/navigation/routes";

/**
 * Characterization tests for normalizeInternalRouteHref
 * (hushh-webapp/lib/navigation/routes.ts) when the href contains nested,
 * percent-encoded hash symbols (e.g. `/legal%2523privacy-policy`, where `%25`
 * is an encoded `%`, so `%2523` is the encoded form of the literal text
 * `%23`, which is itself the encoded form of `#`).
 *
 * TRUTH-FIRST (verified against the source):
 *   The guard is a pure allow/deny gate on the trimmed string:
 *     const href = String(value ?? "").trim();
 *     if (!href) return null;
 *     if (!href.startsWith("/") || href.startsWith("//")) return null;
 *     if (/[\r\n]/.test(href)) return null;
 *     return href;
 *   It performs NO `decodeURIComponent`, NO percent-decoding of any stage, and
 *   NO `#`/anchor splitting. For any href that passes the three checks
 *   (non-empty, single leading slash, no CR/LF) it is an IDENTITY function.
 *   Consequence: a layered token like `%2523` is left fully intact — it is
 *   never collapsed to `%23` and never to an active `#` anchor boundary. The
 *   string stays exactly as given, byte-for-byte.
 */

describe("normalizeInternalRouteHref — multi-stage percent-encoded hashes are preserved verbatim", () => {
  it("returns a layered %2523 href byte-for-byte (no decoding to %23 or #)", () => {
    const href = "/legal%2523privacy-policy";
    const out = normalizeInternalRouteHref(href);
    expect(out).toBe("/legal%2523privacy-policy");
  });

  it("does NOT decode %2523 down to %23", () => {
    const out = normalizeInternalRouteHref("/legal%2523privacy-policy");
    expect(out).not.toContain("%23privacy");
    expect(out).toContain("%2523");
  });

  it("does NOT decode %2523 into an active # anchor boundary", () => {
    const out = normalizeInternalRouteHref("/legal%2523privacy-policy");
    expect(out).not.toContain("#");
  });

  it("preserves a single-stage encoded hash %23 verbatim too (no anchor split)", () => {
    const out = normalizeInternalRouteHref("/legal%23privacy-policy");
    expect(out).toBe("/legal%23privacy-policy");
    expect(out).not.toContain("#");
  });

  it("preserves multiple layered %2523 tokens across segments", () => {
    const out = normalizeInternalRouteHref("/a%2523b/c%2523d");
    expect(out).toBe("/a%2523b/c%2523d");
  });

  it("preserves a real literal # alongside an encoded %2523 (no normalization)", () => {
    const out = normalizeInternalRouteHref("/legal%2523privacy#section");
    expect(out).toBe("/legal%2523privacy#section");
  });

  it("trims surrounding whitespace while keeping the inner %2523 intact", () => {
    const out = normalizeInternalRouteHref("  /legal%2523privacy-policy  ");
    expect(out).toBe("/legal%2523privacy-policy");
  });

  it("still rejects protocol-relative hrefs even when they carry %2523", () => {
    expect(normalizeInternalRouteHref("//evil.example/legal%2523privacy")).toBeNull();
  });

  it("still rejects non-rooted hrefs even when they carry %2523", () => {
    expect(normalizeInternalRouteHref("legal%2523privacy-policy")).toBeNull();
  });

  it("still rejects a %2523-bearing href that contains a newline", () => {
    expect(normalizeInternalRouteHref("/legal%2523privacy\npolicy")).toBeNull();
  });
});
