import { describe, expect, it } from "vitest";

import { formatCompleteJson } from "@/lib/utils/json-to-human";

// Characterization tests for formatCompleteJson
// (hushh-webapp/lib/utils/json-to-human.ts) focused on the EXACT runtime
// invariants for native JavaScript `Symbol` inputs.
//
// Truth-first, verified against the source:
//   - formatCompleteJson iterates with `Object.entries(json)` (line 233) and
//     hand-builds output lines. It NEVER calls JSON.stringify. `Object.entries`
//     only returns enumerable, own, STRING-keyed properties — symbol keys are
//     excluded by the language spec, not by any formatter branch. So a
//     symbol-keyed property contributes no output line.
//   - A symbol VALUE attached to a mapped string key routes through
//     formatValue, which is a typeof-cascade (number/string/boolean) whose final
//     fallback is `return String(value)` (line 202). `String(Symbol("x"))`
//     yields "Symbol(x)" and does NOT throw, unlike the `${sym}` template form.
// These tests pin those two invariants precisely. They document existing
// behavior only; no production code is changed.

describe("formatCompleteJson — native Symbol invariants", () => {
  it("drops symbol-keyed properties via Object.entries enumeration rules", () => {
    const sym = Symbol("hidden");
    const input: Record<string, unknown> = { custom_status: "active" };
    // Attach a symbol-keyed property alongside a normal string key.
    (input as Record<symbol, unknown>)[sym] = "should-not-appear";

    const out = formatCompleteJson(input);

    // The string key is emitted...
    expect(out).toContain("Custom Status: active");
    // ...but the symbol-keyed entry is never enumerated by Object.entries,
    // so its value contributes nothing to the output.
    expect(out).not.toContain("should-not-appear");
  });

  it("emits nothing at all for an object whose only keys are symbols", () => {
    const symA = Symbol("a");
    const symB = Symbol("b");
    const input: Record<string, unknown> = {};
    (input as Record<symbol, unknown>)[symA] = "alpha";
    (input as Record<symbol, unknown>)[symB] = "beta";

    // No enumerable string keys -> Object.entries returns [] -> empty output.
    expect(formatCompleteJson(input)).toBe("");
  });

  it("renders a top-level symbol value as String(sym) without throwing", () => {
    // `symbol_cusip` is a mapped field label ("Symbol"), but the top-level
    // scalar branch (line 239) only fires for number|string. A symbol is
    // neither number/string, not an array, and typeof symbol !== "object",
    // so a TOP-LEVEL symbol value matches no branch and is silently skipped.
    const out = formatCompleteJson({ description: Symbol("AAPL") });
    expect(out).toBe("");
  });

  it("renders a symbol value on a mapped key inside an object as 'Symbol(x)'", () => {
    // Inside a named object section, a non-null value that is not an object and
    // not an array reaches formatValue, whose final branch is String(value).
    // String(Symbol("AAPL")) === "Symbol(AAPL)".
    const out = formatCompleteJson({
      holdings_detail: { description: Symbol("AAPL") },
    });
    expect(out).toContain("--- Holdings Detail ---");
    expect(out).toContain("Security: Symbol(AAPL)");
  });

  it("does not throw for symbol values nested inside an object section", () => {
    expect(() =>
      formatCompleteJson({
        account_metadata: { account_type: Symbol("IRA") },
      })
    ).not.toThrow();

    const out = formatCompleteJson({
      account_metadata: { account_type: Symbol("IRA") },
    });
    expect(out).toContain("Account Type: Symbol(IRA)");
  });
});
