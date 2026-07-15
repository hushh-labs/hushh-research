import { describe, expect, it } from "vitest";

import { formatCompleteJson } from "@/lib/utils/json-to-human";

// Characterization tests for formatCompleteJson
// (hushh-webapp/lib/utils/json-to-human.ts) focused on objects whose property
// keys are the empty string, e.g. { "": "blank value" }.
//
// TRUTH-FIRST — CURRENT CONTRACT (verified against source):
//
//   formatCompleteJson does NO column alignment, padding, or width-based
//   "spacing bounds". Each emitted line is a plain template literal:
//     - top-level scalar:  `${sectionLabel}: ${formatValue(sectionKey, value)}`
//     - object field:      `  ${getFieldLabel(key)}: ${formatValue(key, value)}`
//   Labels come from getFieldLabel(key) = FIELD_LABELS[key] ||
//     key.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()).
//
//   For an EMPTY key (""), FIELD_LABELS[""] is undefined and "".replace(...) is
//   still "", so getFieldLabel("") === "". The label segment collapses to the
//   empty string and the line becomes literally ": value" (top-level) or
//   "  : value" (nested field). There is no special handling, no skipping, and
//   no alignment — only the fixed prefix ("" or two spaces) and the literal
//   ": " separator survive.
//
// CORRECTION TO THE TASK PREMISE: there are no "empty token spacing bounds" or
// "structural alignment" to tune. Empty-key serialization is fully determined
// by the fixed indent prefix + ": " + formatted value. These tests pin that.

describe("formatCompleteJson — empty string keys collapse the label to '' with no alignment/padding", () => {
  it("top-level empty key emits a leading ': ' with no label", () => {
    expect(formatCompleteJson({ "": "blank value" })).toBe(": blank value");
  });

  it("top-level empty key with a numeric (non-currency) value formats the number after ': '", () => {
    expect(formatCompleteJson({ "": 1234.5 })).toBe(": 1,234.5");
  });

  it("nested object empty key emits two-space indent then ': ' then value", () => {
    // The wrapper key 'metadata' is not scalar/array, so it produces a header
    // block; the inner empty key becomes "  : v".
    expect(formatCompleteJson({ metadata: { "": "v" } })).toBe(
      ["", "--- Metadata ---", "  : v"].join("\n"),
    );
  });

  it("empty key with an empty string value yields just the indent + ': ' (trailing space)", () => {
    expect(formatCompleteJson({ inner: { "": "" } })).toBe(
      ["", "--- Inner ---", "  : "].join("\n"),
    );
  });

  it("empty key alongside a normal key preserves insertion order and per-line layout", () => {
    expect(
      formatCompleteJson({ section: { "": "first", note: "second" } }),
    ).toBe(["", "--- Section ---", "  : first", "  Note: second"].join("\n"));
  });

  it("does not pad/align labels to equal width (no extra spaces inserted around short vs long keys)", () => {
    const out = formatCompleteJson({ block: { "": "x", description: "Sec" } });
    // Empty-key line is exactly "  : x" (no padding to match "Security" width).
    expect(out).toContain("  : x");
    // 'description' maps via FIELD_LABELS to 'Security'.
    expect(out).toContain("  Security: Sec");
    // No alignment spaces were inserted before the colon on the empty-key line.
    expect(out).not.toContain("  :  x");
  });

  it("null/undefined values under an empty key are skipped (guard fires regardless of key)", () => {
    expect(formatCompleteJson({ "": null })).toBe("");
    expect(formatCompleteJson({ "": undefined })).toBe("");
  });
});
