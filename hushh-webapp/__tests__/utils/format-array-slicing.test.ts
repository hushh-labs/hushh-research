import { describe, expect, it } from "vitest";

import { formatCompleteJson } from "@/lib/utils/json-to-human";

// Characterization tests for formatCompleteJson
// (hushh-webapp/lib/utils/json-to-human.ts) focused on object configs that carry
// ultra-long linear array fields (5,000+ items).
//
// TRUTH-FIRST — IMPORTANT CORRECTION: the premise that formatCompleteJson
// "serializes the COMPLETE dataset WITHOUT applying clipping filters" is FALSE —
// it is the OPPOSITE of the real behavior. The array branch ALWAYS clips. For a
// generic (non-special) array key it:
//   1. pushes a blank line, then a header `--- <Label> (<N> items) ---` that
//      reports the FULL length N,
//   2. renders only the FIRST 3 items via `sectionValue.slice(0, 3)`,
//   3. if N > 3, appends `  ... and <N-3> more`.
// So a 5,000-item array yields a header citing 5000, exactly 3 bullet lines, and
// a `... and 4997 more` line — the full dataset is NEVER serialized.
//
// Per-item rendering in the generic branch: primitives → `  • ${String(item)}`;
// objects → `  • ${String(firstNonNullValue || "Item")}` (first defined value).
//
// Special-cased keys clip at different bounds (holdings → 10, transactions → 5)
// and `legal_and_disclosures` / `historical_values` render ONLY a count line and
// emit zero item bullets. These tests pin that real clipping contract.

describe("formatCompleteJson — ultra-long linear array slicing", () => {
  it("clips a 5,000-item primitive array to the first 3 + a remainder line", () => {
    const items = Array.from({ length: 5000 }, (_, i) => i);
    const out = formatCompleteJson({ data_points: items });
    expect(out).toBe(
      [
        "",
        "--- Data Points (5000 items) ---",
        "  • 0",
        "  • 1",
        "  • 2",
        "  ... and 4997 more",
      ].join("\n")
    );
  });

  it("header reports the FULL length even though only 3 items are serialized", () => {
    const items = Array.from({ length: 7500 }, (_, i) => `tag-${i}`);
    const out = formatCompleteJson({ labels: items });
    expect(out).toContain("--- Labels (7500 items) ---");
    expect(out).toContain("  ... and 7497 more");
    // Exactly 3 bullet lines are emitted regardless of dataset size.
    expect((out.match(/^ {2}• /gm) ?? []).length).toBe(3);
  });

  it("renders the first non-null value for generic object items (falsy 0 → 'Item')", () => {
    // GOTCHA pinned: the generic branch uses `String(firstNonNullValue || "Item")`.
    // `find` returns the first NON-null/undefined value, so for { id: 0 } it
    // returns 0 — but `0 || "Item"` is falsy, so the bullet renders "Item", NOT
    // "0". Subsequent items (id 1, 2) render their numeric first value.
    const items = Array.from({ length: 6000 }, (_, i) => ({ id: i, name: `n${i}` }));
    const out = formatCompleteJson({ records: items });
    expect(out).toBe(
      [
        "",
        "--- Records (6000 items) ---",
        "  • Item",
        "  • 1",
        "  • 2",
        "  ... and 5997 more",
      ].join("\n")
    );
  });

  it("legal_and_disclosures emits ONLY a count line (no item bullets) for huge arrays", () => {
    const items = Array.from({ length: 5000 }, (_, i) => `disclosure ${i}`);
    const out = formatCompleteJson({ legal_and_disclosures: items });
    expect(out).toContain("(5000 items) ---");
    expect(out).toContain("  5000 disclosure(s) extracted");
    expect(out).not.toContain("  • ");
  });

  it("does not emit a remainder line when the array has exactly 3 items", () => {
    const out = formatCompleteJson({ items: [10, 20, 30] });
    expect(out).toBe(
      ["", "--- Items (3 items) ---", "  • 10", "  • 20", "  • 30"].join("\n")
    );
    expect(out).not.toContain("more");
  });
});
