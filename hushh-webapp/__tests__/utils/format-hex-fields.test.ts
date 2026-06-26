import { describe, expect, it } from "vitest";

import { formatCompleteJson } from "@/lib/utils/json-to-human";

// Characterization tests for formatCompleteJson
// (hushh-webapp/lib/utils/json-to-human.ts) focused on long hexadecimal /
// hash-profile string values (crypto signatures, sha256 digests, color hex).
//
// TRUTH-FIRST: For string values, formatCompleteJson runs them through
// `formatValue` → `cleanMarkdown`, which does exactly four things:
//   .replace(/\*\*\*/g, '')  // strip ***
//   .replace(/\*\*/g, '')    // strip **
//   .replace(/\*/g, '')      // strip *
//   .replace(/`/g, '')       // strip backticks
//   .trim();                 // strip surrounding whitespace
// Therefore long hex strings are emitted VERBATIM:
//   - NOT truncated / ellipsized regardless of length
//   - NOT case-folded ("0xdeadBEEF…" keeps mixed case)
//   - "0x", "#", digits, a–f/A–F all pass through unchanged
// The ONLY mutations are markdown-asterisk/backtick removal and outer trim.
// The premise that hex fields get special formatting/truncation is FALSE — they
// are plain strings subject only to markdown cleaning. The label is derived from
// the key via getFieldLabel (underscores → spaces, Title Case).

describe("formatCompleteJson — hex / hash string fields", () => {
  it("emits a long 0x crypto signature verbatim (no truncation, no case-fold)", () => {
    const sig =
      "0xdeadBEEF0123456789abcdefABCDEF0123456789abcdefABCDEF0123456789ab";
    expect(formatCompleteJson({ signature: sig })).toBe(`Signature: ${sig}`);
  });

  it("emits a 64-char sha256 hash verbatim", () => {
    const hash =
      "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
    expect(formatCompleteJson({ hash })).toBe(`Hash: ${hash}`);
  });

  it("emits a # color hex index verbatim", () => {
    expect(formatCompleteJson({ color_hex: "#FF00AA" })).toBe(
      "Color Hex: #FF00AA"
    );
  });

  it("preserves mixed-case hex (does not lower/upper-case)", () => {
    expect(formatCompleteJson({ addr: "0xABCdef123" })).toBe("Addr: 0xABCdef123");
  });

  it("trims surrounding whitespace around a hex value", () => {
    expect(formatCompleteJson({ tx_hash: "  0xABCDEF  " })).toBe(
      "Tx Hash: 0xABCDEF"
    );
  });

  it("strips markdown asterisks/backticks embedded in a hex-like string", () => {
    // cleanMarkdown removes *, **, ***, and ` — so the interior markers vanish.
    expect(formatCompleteJson({ weird: "0x2a*b**c***d`e" })).toBe(
      "Weird: 0x2abcde"
    );
  });
});
