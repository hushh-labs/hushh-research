import { describe, expect, it } from "vitest";

import {
  normalizeInternalRouteHref,
  resolveInternalRouteHref,
} from "@/lib/navigation/routes";

// Characterization tests for normalizeInternalRouteHref in
// lib/navigation/routes.ts, focused on route hrefs whose path segments contain
// non-ASCII Unicode characters, emoji, or percent-encoded (percent-escaped)
// octets (e.g. "/app/profile/🔥" or "/user/c%C3%B3rdoba").
//
// Truth-first note on the real implementation (routes.ts):
//
//   export function normalizeInternalRouteHref(value) {
//     const href = String(value ?? "").trim();
//     if (!href) return null;
//     if (!href.startsWith("/") || href.startsWith("//")) return null;
//     if (/[\r\n]/.test(href)) return null;
//     return href;
//   }
//
// Consequences these tests pin down:
//   * The validator performs NO Unicode normalization (no NFC/NFD folding) and
//     NO percent-decoding. A valid single-leading-slash href is returned
//     byte-for-byte / code-point-for-code-point verbatim after `.trim()`.
//   * Multi-byte characters and emoji are treated as ordinary path content;
//     they do not trigger rejection.
//   * The only rejection triggers remain: empty, missing leading "/", a "//"
//     prefix (protocol-relative guard), and embedded CR/LF.

describe("normalizeInternalRouteHref — unicode and emoji route bounds", () => {
  it("returns an emoji path segment byte-for-byte (no decode, no strip)", () => {
    expect(normalizeInternalRouteHref("/app/profile/🔥")).toBe(
      "/app/profile/🔥",
    );
  });

  it("returns raw non-ASCII (accented) segments verbatim without normalization", () => {
    // "córdoba" carries a precomposed U+00F3; it must survive unchanged.
    expect(normalizeInternalRouteHref("/user/córdoba")).toBe("/user/córdoba");
  });

  it("preserves percent-encoded octets verbatim (no percent-decoding)", () => {
    // %C3%B3 is the UTF-8 encoding of "ó" — the validator must NOT decode it.
    expect(normalizeInternalRouteHref("/user/c%C3%B3rdoba")).toBe(
      "/user/c%C3%B3rdoba",
    );
  });

  it("preserves a percent-encoded emoji sequence verbatim", () => {
    // %F0%9F%94%A5 is the UTF-8 encoding of 🔥.
    expect(normalizeInternalRouteHref("/app/%F0%9F%94%A5")).toBe(
      "/app/%F0%9F%94%A5",
    );
  });

  it("keeps CJK and other multi-byte scripts intact", () => {
    expect(normalizeInternalRouteHref("/検索/結果")).toBe("/検索/結果");
  });

  it("trims surrounding ASCII whitespace but keeps the unicode payload intact", () => {
    expect(normalizeInternalRouteHref("  /app/名前/🚀  ")).toBe("/app/名前/🚀");
  });

  it("rejects a protocol-relative href even when it contains unicode", () => {
    // "//" prefix triggers the protocol-relative guard regardless of payload.
    expect(normalizeInternalRouteHref("//evil.example/🔥")).toBeNull();
  });

  it("rejects a unicode href that embeds a newline (CR/LF guard)", () => {
    expect(normalizeInternalRouteHref("/app/🔥\n/inject")).toBeNull();
    // resolveInternalRouteHref surfaces the caller-supplied base fallback
    // instead of the unsafe unicode+newline input.
    expect(resolveInternalRouteHref("/app/🔥\n/inject", "/one")).toBe("/one");
  });
});
