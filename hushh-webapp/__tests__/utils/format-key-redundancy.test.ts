import { describe, expect, it } from "vitest";

import { formatCompleteJson } from "@/lib/utils/json-to-human";

// Characterization tests for formatCompleteJson
// (hushh-webapp/lib/utils/json-to-human.ts) focused on objects that REUSE the
// same key string at completely different structural tiers of the payload tree
// (e.g. `{ id: 1, meta: { id: 2 } }`).
//
// TRUTH-FIRST — IMPORTANT CORRECTION: the premise of "variable scoping leaks" or
// a shared key registry that could let a duplicate key at one tier overwrite or
// collide with the same key at another tier is FALSE. formatCompleteJson holds NO
// cross-level key map and NO accumulator keyed by name. It walks the tree with
// plain `for...of Object.entries(...)` loops and pushes one independent output
// line per entry. Each key is labeled/formatted in isolation at its own tier:
//   Top-level scalar:  `Id: 1`                (no indent)
//   Object section:    `\n--- Meta ---`        (header)
//   Object field:      `  Id: 2`               (2-space indent)
// So the SAME key name appears multiple times in the output, each at its own
// level, with NO dedupe and NO last-wins overwrite. There is no token isolation
// bug because there is no shared token state to leak.
//
// These tests pin that real isolated-per-tier contract.

describe("formatCompleteJson — multi-tier duplicate key redundancy", () => {
  it("renders the same key at two tiers independently (no overwrite/leak)", () => {
    const input = { id: 1, meta: { id: 2 } };
    expect(formatCompleteJson(input)).toBe("Id: 1\n\n--- Meta ---\n  Id: 2");
  });

  it("emits BOTH occurrences of a duplicate key (no dedupe)", () => {
    const out = formatCompleteJson({ id: 1, meta: { id: 2 } });
    const matches = out.match(/Id:/g) ?? [];
    expect(matches.length).toBe(2);
  });

  it("keeps the deeper-tier value distinct from the top-level value", () => {
    const out = formatCompleteJson({ id: 1, meta: { id: 2 } });
    expect(out).toContain("Id: 1"); // top-level scalar
    expect(out).toContain("  Id: 2"); // nested field, 2-space indent
    expect(out).not.toContain("Id: 2\n"); // the "2" never appears at top level
  });

  it("isolates a triply-shared key across scalar/section/nested tiers", () => {
    const input = { value: 10, alpha: { value: 20, beta: { value: 30 } } };
    // Top scalar uses CURRENCY formatting for `value`; nested also currency.
    expect(formatCompleteJson(input)).toBe(
      "Value: $10.00\n\n--- Alpha ---\n  Value: $20.00\n  Beta:\n    • Value: $30.00"
    );
  });

  it("does not let an earlier section's key bleed into a later section", () => {
    // NB: getFieldLabel only splits on `_`, not camelCase, so `sectionA` →
    // `SectionA` (first char upper-cased). The two sections stay independent.
    const input = { sectionA: { id: "A" }, sectionB: { id: "B" } };
    expect(formatCompleteJson(input)).toBe(
      "\n--- SectionA ---\n  Id: A\n\n--- SectionB ---\n  Id: B"
    );
  });
});
