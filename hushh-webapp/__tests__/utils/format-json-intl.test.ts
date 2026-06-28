import { describe, expect, it } from "vitest";

import { formatCompleteJson } from "@/lib/utils/json-to-human";

/**
 * Characterization tests for formatCompleteJson
 * (hushh-webapp/lib/utils/json-to-human.ts) when native `Intl` instances
 * (`Intl.Collator`, `Intl.DateTimeFormat`, `Intl.NumberFormat`) are embedded
 * inside the payload object.
 *
 * TRUTH-FIRST (verified against the source):
 *   formatCompleteJson never calls `.toString()`, `.resolvedOptions()`, or any
 *   Intl-specific API. It treats every value purely by `typeof` and by
 *   `Object.entries(...)`. A freshly constructed `Intl.*` instance exposes NO
 *   own enumerable properties, so `Object.entries(new Intl.Collator())` is `[]`.
 *   Consequences pinned below:
 *     - At the TOP LEVEL an Intl instance hits the object branch and emits only
 *       the blank line + `--- <Label> ---` header, with ZERO field lines after
 *       it (no serialized locale/options, no `[object Intl.Collator]` text).
 *     - NESTED inside a section object it emits `  <Label>:` (the nested-object
 *       label line) followed by ZERO bullet lines.
 *     - INSIDE AN ARRAY the generic branch reads `Object.values(item)`, finds no
 *       defined value, and falls back to the literal `  • Item`.
 *   There is NO crash, NO `[object Object]`, and NO option serialization — the
 *   Intl instance is structurally invisible because it carries no own
 *   enumerable data.
 */

describe("formatCompleteJson — top-level Intl instances render as an empty section", () => {
  it("emits only a header for a top-level Intl.Collator (no field lines)", () => {
    const out = formatCompleteJson({ collator: new Intl.Collator("en-US") });
    expect(out).toBe("\n--- Collator ---");
  });

  it("emits only a header for a top-level Intl.DateTimeFormat", () => {
    const out = formatCompleteJson({
      formatter: new Intl.DateTimeFormat("en-US"),
    });
    expect(out).toBe("\n--- Formatter ---");
  });

  it("does NOT serialize locale/options and does NOT emit [object ...]", () => {
    const out = formatCompleteJson({ collator: new Intl.Collator("fr-FR") });
    expect(out).not.toContain("fr-FR");
    expect(out).not.toContain("[object");
    expect(out).not.toContain("resolvedOptions");
  });
});

describe("formatCompleteJson — nested Intl instances emit a label with no bullets", () => {
  it("emits `  <Label>:` for an Intl instance nested in a section object", () => {
    const out = formatCompleteJson({
      meta: { sorter: new Intl.Collator("en-US") },
    });
    expect(out).toBe("\n--- Meta ---\n  Sorter:");
  });

  it("keeps sibling scalar fields intact alongside a nested Intl instance", () => {
    const out = formatCompleteJson({
      meta: { label: "active", sorter: new Intl.Collator("en-US") },
    });
    expect(out).toBe("\n--- Meta ---\n  Label: active\n  Sorter:");
  });
});

describe("formatCompleteJson — Intl instances inside arrays fall back to `Item`", () => {
  it("renders a single-element array of an Intl instance as `  • Item`", () => {
    const out = formatCompleteJson({ items: [new Intl.Collator("en-US")] });
    expect(out).toBe("\n--- Items (1 items) ---\n  • Item");
  });

  it("renders each Intl element independently as `  • Item`", () => {
    const out = formatCompleteJson({
      items: [new Intl.Collator("en-US"), new Intl.DateTimeFormat("en-US")],
    });
    expect(out).toBe("\n--- Items (2 items) ---\n  • Item\n  • Item");
  });
});

describe("formatCompleteJson — Intl instances do not crash the formatter", () => {
  it("returns a string and never throws for a mixed Intl payload", () => {
    expect(() =>
      formatCompleteJson({
        collator: new Intl.Collator("en-US"),
        nested: { fmt: new Intl.NumberFormat("en-US") },
        items: [new Intl.DateTimeFormat("en-US")],
      })
    ).not.toThrow();

    const out = formatCompleteJson({
      collator: new Intl.Collator("en-US"),
      nested: { fmt: new Intl.NumberFormat("en-US") },
      items: [new Intl.DateTimeFormat("en-US")],
    });
    expect(typeof out).toBe("string");
    expect(out).toContain("--- Collator ---");
    expect(out).toContain("--- Nested ---");
    expect(out).toContain("--- Items (1 items) ---");
  });
});
