import { describe, expect, it } from "vitest";

import { formatCompleteJson } from "@/lib/utils/json-to-human";

// Characterization tests for formatCompleteJson
// (hushh-webapp/lib/utils/json-to-human.ts) focused on structural layout when
// an object has several tiers of nested depth.
//
// Truth-first note: formatCompleteJson is NOT a recursive pretty-printer. It
// descends a FIXED, finite number of tiers:
//   tier 1 — top-level section key
//   tier 2 — keys of a section object        ("  Label: ..." / "  Label:")
//   tier 3 — keys of ONE nested object       ("    • NestedLabel: value")
// The tier-3 value is rendered with formatValue(). If that value is itself an
// object (i.e. a 4th tier), formatValue() has no object branch and falls through
// to String(value), producing the literal "[object Object]".
//
// So contrary to a "resolves accurately without truncation" assumption, depth
// >= 4 IS flattened. These tests pin both the faithfully-rendered tiers (1-3)
// and the real flattening boundary at tier 4.

describe("formatCompleteJson — deeply nested object layout", () => {
  it("renders three tiers faithfully (section -> object -> nested scalar)", () => {
    const out = formatCompleteJson({
      custom_section: {
        level_two: {
          level_three: 42,
        },
      },
    });

    expect(out).toContain("--- Custom Section ---");
    expect(out).toContain("  Level Two:");
    expect(out).toContain("    • Level Three: 42");
  });

  it("flattens the FOURTH tier to the literal '[object Object]' (real boundary)", () => {
    const out = formatCompleteJson({
      custom_section: {
        level_two: {
          level_three: {
            level_four: 99,
          },
        },
      },
    });

    // tier 3's value is an object -> formatValue -> String() -> "[object Object]"
    expect(out).toContain("    • Level Three: [object Object]");
    // The 4th-tier key/value never appears.
    expect(out).not.toContain("Level Four");
    expect(out).not.toContain("99");
  });

  it("renders a nested ARRAY as a count, not its contents (no deep expansion)", () => {
    const out = formatCompleteJson({
      custom_section: {
        nested_items: [1, 2, 3],
      },
    });
    expect(out).toContain("  Nested Items: 3 item(s)");
    // Individual array elements are not emitted at this nesting level.
    expect(out).not.toContain("• 1");
  });

  it("skips null/undefined values at both the section and nested tiers", () => {
    const out = formatCompleteJson({
      custom_section: {
        present: 7,
        absent_null: null,
        nested: {
          keep: 5,
          drop: undefined,
        },
      },
    });
    expect(out).toContain("  Present: 7");
    expect(out).not.toContain("Absent Null");
    expect(out).toContain("    • Keep: 5");
    expect(out).not.toContain("Drop");
  });

  it("does not throw and emits no truncation marker for a single deep chain", () => {
    const deep = {
      a: { b: { c: { d: { e: 1 } } } },
    };
    const out = formatCompleteJson(deep);
    // Faithful down to where formatValue stringifies the object tier.
    expect(out).toContain("--- A ---");
    expect(out).toContain("  B:");
    expect(out).toContain("    • C: [object Object]");
    // No "... and N more" style truncation marker for nested objects.
    expect(out).not.toMatch(/\.\.\. and \d+ more/);
  });
});
