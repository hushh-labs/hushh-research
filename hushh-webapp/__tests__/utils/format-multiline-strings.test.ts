import { describe, expect, it } from "vitest";

import { formatCompleteJson } from "@/lib/utils/json-to-human";

// Characterization tests for formatCompleteJson
// (hushh-webapp/lib/utils/json-to-human.ts) focused on string property values
// containing explicit carriage returns (`\r`) and line feeds (`\n`).
//
// Relevant implementation:
//   - Top-level scalar strings render as `${label}: ${formatValue(key, value)}`.
//   - formatValue() for a string returns cleanMarkdown(value).
//   - cleanMarkdown() ONLY strips markdown tokens (***, **, *, `) and applies
//     String.prototype.trim() at the ends.
//
// TRUTH-FIRST: there is NO multi-line "normalization". Interior `\r` / `\n`
// characters are NOT collapsed, escaped, or replaced — they are preserved
// verbatim inside the value. trim() only removes leading/trailing whitespace
// (including leading/trailing CR/LF). The premise that "spacing metrics remain
// unbroken" is FALSE: an interior newline literally splits the rendered line
// into multiple physical lines. These tests pin that real behavior.

describe("formatCompleteJson — multi-line string values (\\r, \\n)", () => {
  it("preserves an interior \\n verbatim (the rendered line is split, not normalized)", () => {
    const out = formatCompleteJson({ note: "line1\nline2" });
    expect(out).toBe("Note: line1\nline2");
    // The output spans two physical lines — spacing is NOT kept on one line.
    expect(out.split("\n")).toHaveLength(2);
  });

  it("preserves an interior CRLF (\\r\\n) verbatim", () => {
    const out = formatCompleteJson({ note: "a\r\nb" });
    expect(out).toBe("Note: a\r\nb");
    expect(out).toContain("\r\n");
  });

  it("preserves a lone carriage return (\\r) verbatim", () => {
    const out = formatCompleteJson({ note: "a\rb" });
    expect(out).toBe("Note: a\rb");
  });

  it("trims leading/trailing newlines but keeps interior ones", () => {
    const out = formatCompleteJson({ note: "\n\nmiddle\n\n" });
    expect(out).toBe("Note: middle");
  });

  it("trims trailing CRLF while keeping the interior break", () => {
    const out = formatCompleteJson({ note: "top\r\nbottom\r\n" });
    expect(out).toBe("Note: top\r\nbottom");
  });

  it("strips markdown tokens but leaves the embedded newline intact", () => {
    const out = formatCompleteJson({ note: "**bold**\n`code`" });
    expect(out).toBe("Note: bold\ncode");
  });

  it("does not escape newlines into literal backslash-n sequences", () => {
    const out = formatCompleteJson({ note: "x\ny" });
    expect(out).not.toContain("\\n");
    expect(out).toContain("\n");
  });
});
