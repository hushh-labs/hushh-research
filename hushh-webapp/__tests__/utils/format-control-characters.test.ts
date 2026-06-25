import { describe, expect, it } from "vitest";

import { formatCompleteJson } from "@/lib/utils/json-to-human";

// Characterization tests for formatCompleteJson
// (hushh-webapp/lib/utils/json-to-human.ts) focused on hidden ASCII control
// characters embedded in top-level string values: backspace \b (U+0008),
// form-feed \f (U+000C), and vertical-tab \v (U+000B).
//
// Relevant implementation:
//   if (typeof sectionValue === "number" || typeof sectionValue === "string") {
//     lines.push(`${label}: ${formatValue(key, sectionValue)}`);
//   }
//   // formatValue(string) → cleanMarkdown(value)
//   // cleanMarkdown(text) =
//   //   text.replace(/\*\*\*/g,'').replace(/\*\*/g,'')
//   //       .replace(/\*/g,'').replace(/`/g,'').trim()
//
// TRUTH-FIRST: there is NO control-character sanitization, escaping, or
// "securing" of structural output. cleanMarkdown only strips markdown markers
// (***, **, *, backtick) and then runs String.prototype.trim(). The ONLY effect
// on control characters is incidental:
//   - \f (U+000C) and \v (U+000B) are Unicode whitespace, so trim() removes
//     them when they sit at the START or END of the value — but NOT when interior.
//   - \b (U+0008) is NOT whitespace, so trim() never touches it; it is emitted
//     verbatim wherever it appears.
// Nothing is escaped to "\\b" / "\\f" / "\\v"; the raw bytes pass through.
// The premise that the formatter "secures" control characters is FALSE. These
// tests pin that the raw control bytes survive (interior) or are trimmed only
// as a side effect of being whitespace (leading/trailing).

describe("formatCompleteJson — embedded ASCII control characters", () => {
  it("emits an interior backspace (\\b) verbatim (no escaping, no removal)", () => {
    const out = formatCompleteJson({ note: "a\bb" });
    expect(out).toContain(": a\bb");
    expect(out).not.toContain("\\b");
  });

  it("preserves a leading/trailing backspace (\\b) because it is NOT whitespace", () => {
    const out = formatCompleteJson({ note: "\bvalue\b" });
    expect(out).toContain(": \bvalue\b");
  });

  it("trims a leading and trailing form-feed (\\f) as whitespace", () => {
    const out = formatCompleteJson({ note: "\fhello\f" });
    expect(out).toContain(": hello");
    expect(out).not.toContain("\f");
  });

  it("keeps an INTERIOR form-feed (\\f) verbatim — trim only affects the ends", () => {
    const out = formatCompleteJson({ note: "x\fy" });
    expect(out).toContain(": x\fy");
  });

  it("trims a leading and trailing vertical-tab (\\v) as whitespace", () => {
    const out = formatCompleteJson({ note: "\vhello\v" });
    expect(out).toContain(": hello");
    expect(out).not.toContain("\v");
  });

  it("keeps an INTERIOR vertical-tab (\\v) verbatim", () => {
    const out = formatCompleteJson({ note: "x\vy" });
    expect(out).toContain(": x\vy");
  });

  it("does not escape control chars even when interleaved with stripped markdown", () => {
    // markdown markers are removed; the control byte between them survives.
    const out = formatCompleteJson({ note: "**bo\bld**" });
    expect(out).toContain(": bo\bld");
    expect(out).not.toContain("*");
  });

  it("emits a raw NUL (U+0000) byte verbatim (not whitespace, not escaped)", () => {
    const out = formatCompleteJson({ note: "a\u0000b" });
    expect(out).toContain(": a\u0000b");
  });
});
