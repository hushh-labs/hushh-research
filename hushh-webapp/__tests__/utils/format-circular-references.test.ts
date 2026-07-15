import { describe, expect, it } from "vitest";

import { formatCompleteJson } from "@/lib/utils/json-to-human";

// Characterization tests for formatCompleteJson in lib/utils/json-to-human.ts,
// focused on self-referential (circular) input objects.
//
// Truth-first note on the real implementation:
//
// formatCompleteJson is NOT recursive and has NO explicit cycle detection.
// It walks a FIXED, bounded structure — at most three levels deep:
//
//   level 0: Object.entries(json)                 -> section
//   level 1: Object.entries(sectionValue)         -> field
//   level 2: Object.entries(value)                -> nested field
//
// At level 2, each nested value is rendered through formatValue(), which for a
// non-null, non-primitive value falls through to String(value) and yields the
// literal "[object Object]". Because the walk never descends past level 2, a
// cycle (obj.self = obj, or a parent/child back-reference) is simply printed as
// "[object Object]" at the leaf — it can never trigger unbounded recursion or a
// RangeError: Maximum call stack size exceeded.
//
// IMPORTANT: this is safety by bounded depth, NOT by deliberate cycle
// "decoupling". These tests pin that real behavior so any future change (e.g.
// introducing real recursion, a WeakSet seen-guard, or a "[Circular]" marker)
// becomes a visible, deliberate contract change rather than silent drift.
//
// These tests never call JSON.stringify on the cyclic objects (which WOULD
// throw), so no exception blocks or loop lockups are involved.

describe("formatCompleteJson — circular reference bounds", () => {
  it("does not throw or loop on a direct self-reference (obj.self = obj)", () => {
    const obj: Record<string, unknown> = {};
    obj.self = obj;

    expect(() => formatCompleteJson(obj)).not.toThrow();
  });

  it("renders a direct self-reference leaf as the literal '[object Object]'", () => {
    const obj: Record<string, unknown> = {};
    obj.self = obj;

    const output = formatCompleteJson(obj);
    expect(typeof output).toBe("string");
    // Section header derived from the key, then the bounded leaf stringification.
    expect(output).toContain("--- Self ---");
    expect(output).toContain("[object Object]");
  });

  it("does not throw on a two-node parent/child back-reference cycle", () => {
    const parent: Record<string, unknown> = { label: "root" };
    const child: Record<string, unknown> = { parent };
    parent.child = child;

    expect(() => formatCompleteJson(parent)).not.toThrow();
    const output = formatCompleteJson(parent);
    expect(output).toContain("--- Child ---");
    // The cycle back to `parent` is flattened at the bounded leaf depth.
    expect(output).toContain("[object Object]");
  });

  it("does not throw on a cycle routed through an array container", () => {
    const node: Record<string, unknown> = {};
    node.items = [node];

    expect(() => formatCompleteJson(node)).not.toThrow();
    const output = formatCompleteJson(node);
    // Array section header uses the (length) suffix; content is bounded.
    expect(output).toContain("--- Items (1 items) ---");
  });

  it("terminates deterministically and returns a finite string for a self-cycle", () => {
    const obj: Record<string, unknown> = { note: "cyclic" };
    obj.self = obj;

    const output = formatCompleteJson(obj);
    // Bounded output: no runaway growth from the cycle.
    expect(output.length).toBeLessThan(500);
    expect(output).toContain("Note: cyclic");
  });

  it("keeps sibling primitive fields intact alongside a self-reference", () => {
    const obj: Record<string, unknown> = { total_value: 1000 };
    obj.self = obj;

    const output = formatCompleteJson(obj);
    // The scalar sibling is still formatted normally (currency field).
    expect(output).toContain("Total Portfolio Value: $1,000.00");
    // And the cyclic branch is still safely flattened.
    expect(output).toContain("[object Object]");
  });
});
