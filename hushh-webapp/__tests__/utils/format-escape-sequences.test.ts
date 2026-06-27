import { describe, expect, it } from "vitest";

import { formatCompleteJson } from "@/lib/utils/json-to-human";

// Characterization tests for formatCompleteJson
// (hushh-webapp/lib/utils/json-to-human.ts) focused on STRING values that carry
// C-style control escape characters: \b, \f, \n, \r, \t.
//
// TRUTH-FIRST (verified against the source AND the JS runtime):
//   - String values route through formatValue → cleanMarkdown(value), which only
//     strips markdown tokens (***, **, *, `) and then calls String.prototype.trim().
//     There is NO escaping, NO whitespace collapsing, NO newline-to-space
//     conversion, and NO control-character stripping beyond what trim() removes.
//   - JS trim() removes \t \n \r \f (and space) ONLY at the string EDGES. It does
//     NOT treat \b (U+0008 backspace) as whitespace, so a leading/trailing \b
//     survives trimming.
//   - INTERIOR control characters (including \n, \t, \r, \f, \b) are preserved
//     verbatim — the raw bytes pass straight into the joined output. The "layout"
//     (section headers, "  " indentation, "\n".join) is built around these
//     values, so an interior "\n" inside a value visually splits a line but the
//     utility itself never sanitizes it.
// These tests pin that exact behavior.

describe("formatCompleteJson — interior control escapes are preserved verbatim", () => {
  it("keeps an interior newline and tab inside a top-level string value", () => {
    expect(formatCompleteJson({ notes: "a\nb\tc" })).toBe("Notes: a\nb\tc");
  });

  it("keeps interior backspace, formfeed, and carriage-return verbatim", () => {
    expect(formatCompleteJson({ notes: "x\by\fz\rw" })).toBe(
      "Notes: x\by\fz\rw"
    );
  });

  it("preserves a fully escape-laden value inside a nested object field", () => {
    expect(
      formatCompleteJson({ account_metadata: { account_holder: "a\b\f\n\r\tb" } })
    ).toBe("\n--- Account Information ---\n  Account Holder: a\b\f\n\r\tb");
  });
});

describe("formatCompleteJson — trim() only affects edge whitespace escapes", () => {
  it("trims leading/trailing \\n and \\t (they are trim-whitespace)", () => {
    expect(formatCompleteJson({ notes: "\n\t lead trail \t\n" })).toBe(
      "Notes: lead trail"
    );
  });

  it("trims a leading formfeed and carriage-return", () => {
    expect(formatCompleteJson({ notes: "\f\rhi" })).toBe("Notes: hi");
  });

  it("does NOT trim a leading backspace (\\b is not trim-whitespace)", () => {
    expect(formatCompleteJson({ notes: "\bhi" })).toBe("Notes: \bhi");
  });

  it("does NOT trim a trailing backspace", () => {
    expect(formatCompleteJson({ notes: "hi\b" })).toBe("Notes: hi\b");
  });
});

describe("formatCompleteJson — escapes do not break structural boundaries", () => {
  it("keeps the section header and indentation around an escape-laden value", () => {
    const out = formatCompleteJson({
      portfolio_summary: { total_change: 5, ending_value: 10 },
      notes: "line1\nline2",
    });
    // The escape lives ONLY inside the value; the header/indent structure stays.
    expect(out).toContain("--- Portfolio Summary ---");
    expect(out).toContain("  Total Change: $5.00");
    expect(out).toContain("  Ending Value: $10.00");
    expect(out).toContain("Notes: line1\nline2");
  });

  it("does not collapse or escape an interior tab between words", () => {
    const out = formatCompleteJson({ notes: "col1\tcol2\tcol3" });
    expect(out).toBe("Notes: col1\tcol2\tcol3");
    expect(out).toContain("\t");
  });
});
