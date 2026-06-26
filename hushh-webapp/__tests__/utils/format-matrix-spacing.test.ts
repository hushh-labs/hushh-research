import { describe, expect, it } from "vitest";

import { formatCompleteJson } from "@/lib/utils/json-to-human";

// Characterization tests for formatCompleteJson
// (hushh-webapp/lib/utils/json-to-human.ts) focused on the layout/indentation of
// DEEPLY nested object "matrices" (>6 levels of recursion).
//
// TRUTH-FIRST — IMPORTANT CORRECTION: the premise that formatCompleteJson applies
// "specialized indentation adjustments" or "spacing compression patterns" once a
// nested object exceeds 6 levels of depth is FALSE. There is NO recursive depth
// engine and NO depth threshold (no `depth > 6` branch, no dynamic indent
// computed from level). The object renderer descends a FIXED maximum of THREE
// levels with HARD-CODED indentation:
//   Level 1 (section): `\n--- <Section> ---`           (0-space header)
//   Level 2 (field):   `  <Field>:`                    (2-space indent)
//   Level 3 (nested):  `    • <Key>: <formattedValue>` (4-space bullet)
// At level 3, `formatValue` is called on the value. If that value is itself an
// object (i.e. there is a level 4+), it is NOT recursed — it falls through to
// `String(value)`, producing the literal `[object Object]`. So a 4-, 6-, or
// 50-level matrix all collapse to the SAME three lines, with the deepest visible
// cell rendered as `[object Object]`. Indentation never grows past 4 spaces.
//
// These tests pin that real fixed-depth contract.

const deepCollapse = "\n--- Level1 ---\n  Level2:\n    • Level3: [object Object]";

describe("formatCompleteJson — deeply nested matrix spacing", () => {
  it("collapses a 4-level object to 3 lines ending in [object Object]", () => {
    const input = { level1: { level2: { level3: { level4: 1 } } } };
    expect(formatCompleteJson(input)).toBe(deepCollapse);
  });

  it("produces IDENTICAL output for a 7-level matrix (no depth>6 special-casing)", () => {
    const input = {
      level1: {
        level2: { level3: { level4: { level5: { level6: { level7: 1 } } } } },
      },
    };
    expect(formatCompleteJson(input)).toBe(deepCollapse);
  });

  it("never indents deeper than 4 spaces, regardless of nesting depth", () => {
    const input = {
      level1: {
        level2: {
          level3: { level4: { level5: { level6: { level7: { level8: 1 } } } } },
        },
      },
    };
    const out = formatCompleteJson(input);
    // No line carries 6 or more leading spaces — indentation is capped at 4.
    for (const line of out.split("\n")) {
      expect(line.startsWith("      ")).toBe(false);
    }
  });

  it("applies no spacing compression: header/field/bullet whitespace is constant", () => {
    const shallow = { alpha: { beta: { gamma: 5 } } };
    // Level-3 scalar is formatted (5 → "5"), proving the fixed 0/2/4 layout.
    expect(formatCompleteJson(shallow)).toBe(
      "\n--- Alpha ---\n  Beta:\n    • Gamma: 5"
    );
  });

  it("renders only [object Object] at the cutoff, dropping deeper keys/values", () => {
    const input = { level1: { level2: { level3: { secretDeep: "hidden" } } } };
    const out = formatCompleteJson(input);
    expect(out).toContain("[object Object]");
    expect(out).not.toContain("secretDeep");
    expect(out).not.toContain("hidden");
  });
});
