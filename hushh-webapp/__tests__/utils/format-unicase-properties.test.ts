import { describe, expect, it } from "vitest";

import { formatCompleteJson } from "@/lib/utils/json-to-human";

// Characterization tests for formatCompleteJson
// (hushh-webapp/lib/utils/json-to-human.ts) focused on mixed-case / Unicode
// object keys.
//
// TRUTH-FIRST (verified against the source):
//   - Unknown keys are labeled via getFieldLabel:
//       key.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())
//   - `\w` is ASCII-only ([A-Za-z0-9_]). The ONLY transform is UP-casing the
//     first ASCII word character of each whitespace-delimited token. There is
//     NO down-casing anywhere, and non-ASCII letters are never `\w`, so any key
//     made purely of non-ASCII characters is emitted VERBATIM.
//   - Interior already-uppercase characters (ASCII or Unicode) are preserved.
//   - Values pass through formatValue → for strings, only markdown is stripped
//     and ends trimmed; letter case (incl. Unicode) is never changed.

describe("formatCompleteJson — mixed-case / Unicode property keys", () => {
  it("emits a pure non-ASCII uppercase key verbatim (never down-cased)", () => {
    expect(formatCompleteJson({ "ÄÖÜ": "x" })).toBe("ÄÖÜ: x");
  });

  it("emits a pure non-ASCII lowercase key verbatim (no ASCII initial to up-case)", () => {
    expect(formatCompleteJson({ "äöü": "x" })).toBe("äöü: x");
  });

  it("preserves a mixed-case Greek key verbatim", () => {
    expect(formatCompleteJson({ "λΛ": "x" })).toBe("λΛ: x");
  });

  it("up-cases only the first ASCII letter, preserving interior case", () => {
    // "fooBar" → "FooBar": leading 'f' up-cased; interior 'B' untouched.
    expect(formatCompleteJson({ fooBar: "x" })).toBe("FooBar: x");
  });

  it("leaves an already-uppercase ASCII acronym key unchanged", () => {
    expect(formatCompleteJson({ ABC: "x" })).toBe("ABC: x");
  });

  it("never alters letter case inside string values (ASCII or Unicode)", () => {
    expect(formatCompleteJson({ alpha: "MiXeD Ünï" })).toBe("Alpha: MiXeD Ünï");
  });

  it("preserves a mixed-case non-ASCII key verbatim inside an object section", () => {
    const out = formatCompleteJson({ portfolio_summary: { "ΩÇ": "val" } });
    const lines = out.split("\n");
    expect(lines[0]).toBe("");
    expect(lines[1]).toBe("--- Portfolio Summary ---");
    expect(lines[2]).toBe("  ΩÇ: val");
  });
});
