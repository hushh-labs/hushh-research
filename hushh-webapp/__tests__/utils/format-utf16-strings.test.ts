import { describe, expect, it } from "vitest";

import { formatCompleteJson } from "@/lib/utils/json-to-human";

// Characterization tests for formatCompleteJson
// (hushh-webapp/lib/utils/json-to-human.ts) against multi-byte UTF-16 strings,
// emoji (astral / surrogate-pair) characters, and emoji arrays.
//
// TRUTH-FIRST — LITERAL CONTRACT for non-numeric/boolean values:
//  * String values flow through `formatValue` -> `cleanMarkdown`, which ONLY:
//      - removes the literal markdown markers `***`, `**`, `*`, and backtick
//      - calls `.trim()`
//    It performs NO Unicode normalization (NFC/NFD), NO surrogate-pair
//    re-encoding, NO escaping, and NO emoji stripping. So emoji and astral
//    characters survive BYTE-FOR-BYTE except when they are adjacent to literal
//    "*"/backtick markers (which are removed) or surrounding whitespace (trimmed).
//  * Arrays use a header `--- <Label> (<N> items) ---` where N is the ARRAY
//    element count (`Array.prototype.length`) — NOT a UTF-16 code-unit count. A
//    single emoji string element counts as exactly one item even though it spans
//    two UTF-16 code units.
//  * Generic (non-special-cased) arrays render the first 3 elements as
//    `  • ${String(item)}` and then `  ... and <N-3> more`. `String(emoji)`
//    returns the emoji unchanged.
//
// These tests pin that "pass-through, no normalization, element-count not
// code-unit-count" behavior precisely.

describe("formatCompleteJson — multi-byte UTF-16 / emoji strings", () => {
  it("passes an astral emoji in an object field through verbatim", () => {
    expect(
      formatCompleteJson({ account_metadata: { account_holder: "José 🚀🎉" } }),
    ).toBe("\n--- Account Information ---\n  Account Holder: José 🚀🎉");
  });

  it("preserves surrogate-pair mathematical bold letters verbatim", () => {
    expect(
      formatCompleteJson({ account_metadata: { account_holder: "𝕳𝖚𝖘𝖍" } }),
    ).toBe("\n--- Account Information ---\n  Account Holder: 𝕳𝖚𝖘𝖍");
  });

  it("strips markdown markers around an emoji but keeps the emoji", () => {
    // "**🚀**" -> cleanMarkdown removes the "**" pairs -> "🚀"
    expect(
      formatCompleteJson({ account_metadata: { account_holder: "**🚀**" } }),
    ).toBe("\n--- Account Information ---\n  Account Holder: 🚀");
  });

  it("renders a top-level emoji scalar string verbatim", () => {
    expect(formatCompleteJson({ note: "🚀 launch" })).toBe("Note: 🚀 launch");
  });

  it("counts emoji array ITEMS by element, not UTF-16 code units, and lists first 3", () => {
    // 4 single-emoji elements (each is a 2-code-unit surrogate pair).
    expect(formatCompleteJson({ tags: ["🚀", "🎉", "😀", "🔥"] })).toBe(
      "\n--- Tags (4 items) ---\n  • 🚀\n  • 🎉\n  • 😀\n  ... and 1 more",
    );
  });

  it("treats a single multi-emoji string as one array element", () => {
    // The whole "🚀🎉😀🔥" string is ONE element -> "(1 items)", String() verbatim.
    expect(formatCompleteJson({ tags: ["🚀🎉😀🔥"] })).toBe(
      "\n--- Tags (1 items) ---\n  • 🚀🎉😀🔥",
    );
  });

  it("does NOT Unicode-normalize: decomposed (NFD) sequence is preserved", () => {
    // "e" + U+0301 combining acute accent (NFD) must remain two code points,
    // not be collapsed to the precomposed "é" (NFC).
    const decomposed = "e\u0301"; // é in NFD form
    const out = formatCompleteJson({
      account_metadata: { account_holder: decomposed },
    });
    expect(out).toBe(
      `\n--- Account Information ---\n  Account Holder: ${decomposed}`,
    );
    // Guard: it is still the 2-code-point decomposed form, not precomposed.
    expect(out.endsWith("e\u0301")).toBe(true);
    expect(out.endsWith("\u00e9")).toBe(false);
  });

  it("preserves a zero-width joiner (ZWJ) family emoji sequence verbatim", () => {
    const family = "👩‍👩‍👧‍👦"; // multiple code points joined by U+200D
    expect(
      formatCompleteJson({ account_metadata: { account_holder: family } }),
    ).toBe(`\n--- Account Information ---\n  Account Holder: ${family}`);
  });
});
