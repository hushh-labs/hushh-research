import { describe, expect, it } from "vitest";

import { formatCompleteJson } from "@/lib/utils/json-to-human";

// Characterization tests for formatCompleteJson
// (hushh-webapp/lib/utils/json-to-human.ts) against cyclic self-references.
//
// TRUTH-FIRST — LITERAL CONTRACT: formatCompleteJson has NO cycle guard, NO
// try/catch, and NO "strip looping params" logic. It does NOT need one, because
// it is NOT recursive. It walks a HARD-CODED, FIXED depth of exactly three
// levels via plain `for...of Object.entries(...)` loops:
//
//   level 1: section entries        (top-level keys)
//   level 2: field entries          (inside an object section)
//   level 3: nested-field entries   (inside a nested object field)
//
// At level 3 each value is passed to `formatValue`, whose fallthrough for a
// non-null/number/string/boolean value is `return String(value)` ->
// "[object Object]". There is no fourth level and no self-call, so a cyclic
// reference can NEVER cause infinite recursion or a RangeError (stack overflow).
// The cycle is simply truncated by the fixed depth and rendered as the literal
// string "[object Object]".
//
// These tests pin that "no guard needed, naturally bounded, no throw" behavior.
// They deliberately do NOT assert any WeakSet/seen-set protection, thrown
// "Converting circular structure to JSON" error, or key stripping — the code
// performs none of those.

describe("formatCompleteJson — cyclic self-reference handling", () => {
  it("does NOT throw on a direct self-cycle (obj.self = obj)", () => {
    const obj: Record<string, unknown> = {};
    obj.self = obj;
    expect(() => formatCompleteJson(obj)).not.toThrow();
  });

  it("truncates a direct self-cycle at the fixed 3rd level as [object Object]", () => {
    const obj: Record<string, unknown> = {};
    obj.self = obj;
    // level1 section "Self" -> level2 field "Self:" -> level3 "• Self: <String(obj)>"
    expect(formatCompleteJson(obj)).toBe(
      "\n--- Self ---\n  Self:\n    • Self: [object Object]",
    );
  });

  it("does NOT throw on a two-node mutual cycle (a.b = b; b.a = a)", () => {
    const a: Record<string, unknown> = {};
    const b: Record<string, unknown> = {};
    a.b = b;
    b.a = a;
    expect(() => formatCompleteJson(a)).not.toThrow();
  });

  it("renders a two-node mutual cycle bounded to three levels", () => {
    const a: Record<string, unknown> = {};
    const b: Record<string, unknown> = {};
    a.b = b;
    b.a = a;
    expect(formatCompleteJson(a)).toBe(
      "\n--- B ---\n  A:\n    • B: [object Object]",
    );
  });

  it("keeps sibling scalar fields intact alongside a cyclic field (no stripping)", () => {
    const node: Record<string, unknown> = { cash_balance: 100 };
    node.loop = node;
    const out = formatCompleteJson({ portfolio_summary: node });
    // The real scalar still formats as currency; the cyclic field is not removed,
    // it just bottoms out at [object Object] (no infinite expansion, no throw).
    expect(out).toContain("--- Portfolio Summary ---");
    expect(out).toContain("Cash Balance: $100.00");
    expect(out).toContain("[object Object]");
  });

  it("completes synchronously and bounded even for a deep cycle (no RangeError)", () => {
    const root: Record<string, unknown> = {};
    let cursor = root;
    for (let i = 0; i < 1000; i++) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }
    cursor.next = root; // close the loop
    // Fixed-depth walk ignores the depth of the chain entirely — never recurses.
    expect(() => formatCompleteJson(root)).not.toThrow();
  });
});
