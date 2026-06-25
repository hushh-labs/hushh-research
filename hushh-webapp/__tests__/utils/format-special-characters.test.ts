import { describe, expect, it } from "vitest";

import { formatCompleteJson } from "@/lib/utils/json-to-human";

// Characterization tests for formatCompleteJson
// (hushh-webapp/lib/utils/json-to-human.ts) focused on object KEYS that contain
// escape symbols, punctuation symbols, and non-ASCII / mathematical notation
// (e.g. "\n", "$", "λ").
//
// Truth-first note on key transformation: unknown keys flow through
// getFieldLabel:
//   FIELD_LABELS[key] || key.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())
// Behavior verified by running this suite:
//   - underscores become spaces.
//   - title-casing uses JS \b\w WITHOUT the Unicode flag, so \w === [A-Za-z0-9_].
//     A \b boundary sits between any non-word char and an ASCII word char, so an
//     ASCII letter that FOLLOWS a symbol / newline / string-start IS upper-cased
//     (e.g. "$amount" -> "$Amount", "line\nbreak" -> "Line\nBreak").
//   - a NON-ASCII letter (λ, ✓) is itself never upper-cased (it is not \w), but
//     it still acts as a non-word boundary, so an ASCII letter directly after it
//     is upper-cased ("✓done" -> "✓Done"). A non-ASCII letter followed by a
//     space + ASCII keeps the non-ASCII char as-is ("λ_rate" -> "λ Rate").
//   - there is NO escaping/encoding: a literal newline inside a key stays a real
//     newline; the sequence "\\n" is never produced.
// These tests pin the ACTUAL behavior, not an assumed verbatim pass-through.

describe("formatCompleteJson — special-character keys", () => {
  it("converts underscores to spaces and ASCII title-cases an unknown key", () => {
    const out = formatCompleteJson({ custom_label: "hello" });
    // "custom_label" -> "custom label" -> "Custom Label"
    expect(out).toContain("Custom Label: hello");
  });

  it("does not upper-case a non-ASCII Greek letter but title-cases the ASCII rest", () => {
    const out = formatCompleteJson({ "λ_rate": "x" });
    // "λ_rate" -> "λ rate" -> "λ Rate" (λ unchanged, ASCII word-start upper-cased)
    expect(out).toContain("λ Rate: x");
  });

  it("keeps symbol chars verbatim but upper-cases the ASCII letter after them", () => {
    const out = formatCompleteJson({ "$amount": "a", "%change": "b", "#id": "c" });
    expect(out).toContain("$Amount: a");
    expect(out).toContain("%Change: b");
    expect(out).toContain("#Id: c");
  });

  it("keeps an embedded newline literal (never emits the escape sequence)", () => {
    const out = formatCompleteJson({ "line\nbreak": "v" });
    // Real newline survives; "b" after it is upper-cased; no "\\n" text appears.
    expect(out).toContain("Line\nBreak: v");
    expect(out).not.toContain("\\n");
  });

  it("emits a unicode checkmark verbatim and upper-cases the ASCII letter after it", () => {
    const out = formatCompleteJson({ "✓done": "y" });
    expect(out).toContain("✓Done: y");
  });

  it("renders an object-valued non-ASCII key as a section header", () => {
    const out = formatCompleteJson({ "λ_section": { inner: "z" } });
    expect(out).toContain("--- λ Section ---");
    expect(out).toContain("  Inner: z");
  });
});
