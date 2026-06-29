import { describe, expect, it } from "vitest";

import { resolveInternalRouteHref } from "@/lib/navigation/routes";

// Characterization tests for resolveInternalRouteHref
// (hushh-webapp/lib/navigation/routes.ts) against percent-encoded colons (%3A)
// embedded inside query/parameter text values.
//
// TRUTH-FIRST — LITERAL CONTRACT: resolveInternalRouteHref is a one-line wrapper:
//
//   return normalizeInternalRouteHref(value) ?? fallback;
//
// and normalizeInternalRouteHref is purely:
//
//   const href = String(value ?? "").trim();
//   if (!href) return null;
//   if (!href.startsWith("/") || href.startsWith("//")) return null;
//   if (/[\r\n]/.test(href)) return null;
//   return href;
//
// IMPORTANT CORRECTION to the framing: there is NO "search query extractor" here.
// resolveInternalRouteHref does NOT parse query strings, does NOT split on "?",
// "&", or "=", does NOT percent-decode, and has NO concept of protocol or port
// selectors. A literal `%3A` (or a raw ":") is just ordinary text inside the
// href string. The only decisions are: same-origin (single leading "/", no
// CRLF) -> echo verbatim; otherwise -> return the caller's `fallback`.
//
// Consequences for `%3A`:
//  * `%3A` is NEVER decoded to ":" — it survives byte-for-byte in a kept href.
//  * A raw ":" inside the path/query is NOT treated as a protocol/port marker,
//    because the guard never inspects beyond the leading "/" + CRLF check.
//  * The leading character is all that decides keep-vs-fallback; colons (encoded
//    or raw) appearing AFTER a valid leading "/" do not change the outcome.
//  * A value that itself looks like a URL with a scheme (e.g. `https://...`,
//    or `javascript:...`) does not start with "/", so it is rejected and the
//    fallback is returned — the encoded/real colon plays no special role.

const FALLBACK = "/one";

describe("resolveInternalRouteHref — percent-encoded colon (%3A) handling", () => {
  it("keeps %3A verbatim in a query value (no decoding to ':')", () => {
    expect(
      resolveInternalRouteHref("/search?q=time%3A12%3A30", FALLBACK),
    ).toBe("/search?q=time%3A12%3A30");
  });

  it("keeps a RAW ':' in a query value without treating it as a port", () => {
    // ":" after the leading "/" is just text; no port/protocol parsing happens.
    expect(resolveInternalRouteHref("/search?q=ratio=3:2", FALLBACK)).toBe(
      "/search?q=ratio=3:2",
    );
  });

  it("keeps %3A appearing in the path segment verbatim", () => {
    expect(resolveInternalRouteHref("/items/id%3A42", FALLBACK)).toBe(
      "/items/id%3A42",
    );
  });

  it("does NOT collapse or normalize multiple %3A across multiple params", () => {
    expect(
      resolveInternalRouteHref("/a?x=1%3A1&y=2%3A2", FALLBACK),
    ).toBe("/a?x=1%3A1&y=2%3A2");
  });

  it("returns fallback for an absolute http(s) URL — leading scheme colon, not a route", () => {
    // Starts with "h", not "/": rejected. The "://" colon is irrelevant to the
    // decision; the guard fails on the very first character.
    expect(
      resolveInternalRouteHref("https://evil.example.com/path", FALLBACK),
    ).toBe(FALLBACK);
  });

  it("returns fallback for a javascript: pseudo-scheme regardless of the colon", () => {
    expect(
      resolveInternalRouteHref("javascript:alert(1)", FALLBACK),
    ).toBe(FALLBACK);
  });

  it("returns fallback for a protocol-relative //host value carrying %3A", () => {
    // startsWith("//") is explicitly rejected even though it begins with "/".
    expect(
      resolveInternalRouteHref("//host%3A8080/path", FALLBACK),
    ).toBe(FALLBACK);
  });

  it("trims surrounding whitespace, then echoes a %3A-bearing href verbatim", () => {
    expect(
      resolveInternalRouteHref("   /q?t=a%3Ab   ", FALLBACK),
    ).toBe("/q?t=a%3Ab");
  });
});
