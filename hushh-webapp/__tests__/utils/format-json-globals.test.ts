import { describe, expect, it } from "vitest";

import { formatCompleteJson } from "@/lib/utils/json-to-human";

// Characterization tests for formatCompleteJson
// (hushh-webapp/lib/utils/json-to-human.ts) focused on objects that hold direct
// references to native JavaScript global / execution-scope roots (globalThis,
// window) and to callable scope members (functions).
//
// TRUTH-FIRST (verified against the source AND the live run):
//   formatCompleteJson does NOT use JSON.stringify. It iterates
//   Object.entries(json) at the top level and dispatches purely on `typeof`:
//     - null/undefined            -> skipped (continue)
//     - "number" | "string"       -> "Label: <formatted>"
//     - Array.isArray             -> "--- Label (N items) ---" branch
//     - "object"                  -> "--- Label ---" then ONE nested level via
//                                    Object.entries(value); a nested value that
//                                    is itself a plain object descends ONE more
//                                    level, otherwise formatValue(...) ends in
//                                    String(value) for non-scalar leaves.
//   Baselines established here:
//   1. A value whose typeof is "function" matches NONE of the section branches,
//      so a top-level function-valued section produces NO output. The SAME
//      function held as a FIELD inside an object section IS rendered, via
//      formatValue -> String(fn). getFieldLabel preserves inner capitals, so
//      "onClick" -> "OnClick".
//   2. A global root reached as a bounded LEAF (nested under a normal object) is
//      coerced with String() to "[object ...]" and the walk TERMINATES — there
//      is no deep/infinite recursion into globalThis.
//   3. A global root placed DIRECTLY as a top-level section value is enumerated
//      one level deep and HITS a member that cannot be coerced to a primitive,
//      so the formatter THROWS `TypeError: Cannot convert object to primitive
//      value`. The documented guidance: never feed raw execution-scope roots in
//      as section values.

describe("formatCompleteJson — global roots as bounded leaf values terminate via String()", () => {
  it("renders globalThis referenced as a nested leaf via String() (no deep recursion)", () => {
    const out = formatCompleteJson({
      account_metadata: { context: { scope: globalThis } },
    });
    expect(typeof out).toBe("string");
    expect(out).toContain("--- Account Information ---");
    expect(out).toContain("Context:");
    // String(globalThis) is "[object global]" (node) / "[object Window]" (jsdom)
    expect(out).toContain("[object");
    expect(out).toContain("Scope:");
  });

  it("renders globalThis referenced one level deep as an object field via String()", () => {
    const out = formatCompleteJson({
      account_metadata: { scope: { ref: globalThis } },
    });
    expect(out).toContain("Scope:");
    expect(out).toContain("[object");
  });
});

describe("formatCompleteJson — function-valued sections produce no output", () => {
  it("skips a top-level section whose value is a function (typeof 'function')", () => {
    expect(formatCompleteJson({ run: () => 1 })).toBe("");
  });

  it("skips multiple function-valued sections and keeps only scalar sections", () => {
    const out = formatCompleteJson({
      callback: () => 1,
      handler: function named() {},
      total_value: 1000,
    });
    // Only the scalar section is emitted; the two function sections vanish.
    expect(out).toBe("Total Portfolio Value: $1,000.00");
    expect(out).not.toContain("Callback");
    expect(out).not.toContain("Handler");
  });

  it("stringifies a function held as a FIELD inside an object section", () => {
    const out = formatCompleteJson({
      account_metadata: { onClick: () => 1 },
    });
    // Field-level functions are not skipped: formatValue -> String(fn).
    // getFieldLabel("onClick") preserves the inner capital -> "OnClick".
    expect(out).toContain("--- Account Information ---");
    expect(out).toContain("OnClick:");
    expect(out).toContain("=>");
  });
});

describe("formatCompleteJson — a global root as a top-level section throws on ToPrimitive", () => {
  // Enumerating globalThis/window one nested level deep eventually reaches a
  // member that cannot be coerced by the template-literal/String() path, so the
  // formatter throws rather than silently serializing the whole scope. This is
  // the documented baseline: do NOT feed raw execution-scope roots in directly.
  it("throws 'Cannot convert object to primitive value' for a globalThis section", () => {
    expect(() => formatCompleteJson({ globalThis })).toThrow(
      /Cannot convert object to primitive value/
    );
  });

  it("throws a TypeError for a window-shaped global execution scope reference", () => {
    const scope = (globalThis as { window?: unknown }).window ?? globalThis;
    expect(() => formatCompleteJson({ execution_scope: scope })).toThrow(
      TypeError
    );
  });
});
