import { describe, expect, it } from "vitest";

import { normalizeInternalRouteHref } from "@/lib/navigation/routes";

// Characterization tests for normalizeInternalRouteHref
// (hushh-webapp/lib/navigation/routes.ts) focused on internal route paths whose
// directory segments are composed of multi-byte UTF-8 / international localized
// text, e.g. '/legal/데이터/보안'.
//
// TRUTH-FIRST (verified against the source): normalizeInternalRouteHref does
// NOT "normalize" text content in any locale-aware sense. Its entire body is:
//   1. href = String(value ?? "").trim()      // edge whitespace only
//   2. if (!href) return null
//   3. if (!href.startsWith("/") || href.startsWith("//")) return null
//   4. if (/[\r\n]/.test(href)) return null
//   5. return href                            // otherwise VERBATIM
//
//   There is NO Unicode normalization (no NFC/NFD), NO percent-encoding, NO
//   transliteration, and NO per-segment validation. Multi-byte UTF-8 directory
//   names satisfy the guards (they start with "/", are not "//", and contain no
//   CR/LF), so they are returned BYTE-FOR-BYTE IDENTICAL to the input. These
//   tests pin that verbatim pass-through for several scripts.

describe("normalizeInternalRouteHref — multi-byte UTF-8 directory segments pass through verbatim", () => {
  it("preserves Korean (Hangul) directory segments", () => {
    const href = "/legal/데이터/보안";
    expect(normalizeInternalRouteHref(href)).toBe(href);
  });

  it("preserves Japanese (Kanji/Kana) directory segments", () => {
    const href = "/設定/プロファイル";
    expect(normalizeInternalRouteHref(href)).toBe(href);
  });

  it("preserves Arabic (RTL) directory segments", () => {
    const href = "/الإعدادات/الملف";
    expect(normalizeInternalRouteHref(href)).toBe(href);
  });

  it("preserves Cyrillic directory segments", () => {
    const href = "/настройки/профиль";
    expect(normalizeInternalRouteHref(href)).toBe(href);
  });

  it("preserves emoji / astral-plane (surrogate-pair) segments", () => {
    const href = "/dashboard/🚀/settings";
    expect(normalizeInternalRouteHref(href)).toBe(href);
  });

  it("preserves accented Latin (diacritics) without NFC/NFD folding", () => {
    // Composed é (U+00E9) must survive unchanged — no Unicode normalization.
    const composed = "/café/menü";
    expect(normalizeInternalRouteHref(composed)).toBe(composed);
  });

  it("does NOT fold a decomposed sequence into its composed form", () => {
    // e + combining acute (U+0065 U+0301) stays decomposed (length preserved).
    const decomposed = "/cafe\u0301";
    const result = normalizeInternalRouteHref(decomposed);
    expect(result).toBe(decomposed);
    expect(result).not.toBe("/caf\u00e9");
  });
});

describe("normalizeInternalRouteHref — UTF-8 segments combined with the existing guards", () => {
  it("still trims only the outer edges around a UTF-8 path", () => {
    expect(normalizeInternalRouteHref("  /legal/데이터  ")).toBe("/legal/데이터");
  });

  it("rejects a protocol-relative href even when followed by UTF-8 text", () => {
    expect(normalizeInternalRouteHref("//evil.example/데이터")).toBeNull();
  });

  it("rejects a UTF-8 path that does not start with '/'", () => {
    expect(normalizeInternalRouteHref("데이터/보안")).toBeNull();
  });

  it("rejects a UTF-8 path containing a newline", () => {
    expect(normalizeInternalRouteHref("/legal/데이터\n보안")).toBeNull();
  });
});
