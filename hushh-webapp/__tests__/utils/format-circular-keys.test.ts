import { describe, expect, it } from "vitest";

import { formatCompleteJson } from "@/lib/utils/json-to-human";

// Characterization tests for formatCompleteJson
// (hushh-webapp/lib/utils/json-to-human.ts) when multiple sibling objects
// inside a layout array each hold a reference to a SINGLE shared object that
// lives further up the tree.
//
// TRUTH-FIRST — CURRENT CONTRACT (verified against source):
//
//   formatCompleteJson has NO reference tracking whatsoever. There is no
//   WeakSet/seen-set, no cycle detection, no de-duplication, and no
//   "[Circular]" marker. Each sibling is walked independently, so a shared
//   reference is simply visited once per occurrence — never "tracked",
//   skipped, or collapsed.
//
//   For a GENERIC top-level array (not holdings / transactions /
//   asset_allocation / legal_and_disclosures / historical_values), the else
//   branch runs:
//     - takes the first 3 items
//     - for each object item, picks the FIRST non-null property value via
//       Object.values(obj).find(v => v != null)
//     - emits `  • ${String(firstValue || "Item")}`
//     - if length > 3, appends `  ... and ${length - 3} more`
//
//   When that first value is itself the shared OBJECT, String(object) yields
//   "[object Object]" — every time, with zero special-casing for the fact
//   that it is the same instance referenced by every sibling.
//
// CORRECTION TO THE TASK PREMISE: there are no "specialized tracking
// exceptions or omissions" for shared references. The shared object is
// rendered identically and repeatedly (once per sibling, up to the 3-item
// preview cap). These tests pin that repeat-without-dedup behavior.

describe("formatCompleteJson — shared-reference siblings get no tracking/dedup/omission", () => {
  it("renders the shared object once per sibling as '[object Object]' (no dedup, no [Circular])", () => {
    const shared = { id: "root-shared", label: "Shared Node" };
    const out = formatCompleteJson({
      widgets: [{ ref: shared }, { ref: shared }, { ref: shared }],
    });

    // Three identical bullets — one per sibling, no collapsing.
    const bullets = out.split("\n").filter((l: string) => l.trim().startsWith("• "));
    expect(bullets).toHaveLength(3);
    for (const bullet of bullets) {
      expect(bullet).toContain("[object Object]");
    }

    // No special tracking markers are ever emitted.
    expect(out).not.toContain("[Circular]");
    expect(out).not.toContain("[Reference]");
    expect(out).not.toContain("root-shared");
  });

  it("includes the array length and the generic '(N items)' header verbatim", () => {
    const shared = { id: "x" };
    const out = formatCompleteJson({
      widgets: [{ ref: shared }, { ref: shared }],
    });
    expect(out).toContain("--- Widgets (2 items) ---");
  });

  it("caps the preview at 3 siblings and reports the remainder, counting shared refs as distinct slots", () => {
    const shared = { id: "x" };
    const out = formatCompleteJson({
      widgets: [
        { ref: shared },
        { ref: shared },
        { ref: shared },
        { ref: shared },
        { ref: shared },
      ],
    });
    // 5 items → 3 bullets + remainder line.
    const bullets = out.split("\n").filter((l: string) => l.trim().startsWith("• "));
    expect(bullets).toHaveLength(3);
    expect(out).toContain("... and 2 more");
  });

  it("uses the FIRST non-null property — a scalar before the shared ref is what surfaces", () => {
    const shared = { id: "deep" };
    const out = formatCompleteJson({
      widgets: [{ name: "Alpha", ref: shared }],
    });
    // First non-null value is the scalar "Alpha", not the shared object.
    expect(out).toContain("• Alpha");
    expect(out).not.toContain("[object Object]");
  });

  it("does not throw and does not recurse into the shared object's keys", () => {
    const shared = { secret: "should-not-appear", nested: { deep: 1 } };
    const fn = () =>
      formatCompleteJson({ widgets: [{ ref: shared }, { ref: shared }] });
    expect(fn).not.toThrow();
    const out = fn();
    expect(out).not.toContain("should-not-appear");
    expect(out).not.toContain("deep");
  });
});
