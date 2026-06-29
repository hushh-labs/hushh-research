import { describe, expect, it } from "vitest";

import { formatCompleteJson } from "@/lib/utils/json-to-human";

// Characterization tests for formatCompleteJson
// (hushh-webapp/lib/utils/json-to-human.ts) when native RegExp instances are
// embedded directly as values.
//
// TRUTH-FIRST — LITERAL CONTRACT: formatCompleteJson has NO RegExp-aware branch.
// A RegExp is `typeof === "object"`, is NOT an Array, and is NOT a number/string,
// so it falls into the generic "Handle objects" path. Crucially,
// `Object.entries(/^[a-z]+$/gi)` is `[]` — a RegExp exposes NO own enumerable
// properties (source/flags/lastIndex are non-enumerable). Therefore:
//
//  * A TOP-LEVEL RegExp value emits ONLY a section header (`"", "--- Label ---"`)
//    and zero field lines — the pattern source and flags are NEVER rendered.
//  * A RegExp NESTED inside a section object emits ONLY the field label followed
//    by a bare colon (`"  Label:"`) via the nested-object branch, again with no
//    pattern/flags text.
//
// These tests pin that exact "regex bodies are invisible" behavior. They do NOT
// claim any regex serialization (no `.source`, no `.toString()`, no flags) —
// because the implementation performs none.

describe("formatCompleteJson — native RegExp instance values", () => {
  it("renders a top-level RegExp as a header only (no source/flags)", () => {
    const out = formatCompleteJson({ matcher: /^[a-z]+$/gi });
    expect(out).toBe("\n--- Matcher ---");
    // The pattern body and flags never appear in the output.
    expect(out).not.toContain("[a-z]");
    expect(out).not.toContain("gi");
    expect(out).not.toContain("/");
  });

  it("renders a nested RegExp as a bare labelled line with no value", () => {
    const out = formatCompleteJson({ validation: { pattern: /\d+/g } });
    expect(out).toBe("\n--- Validation ---\n  Pattern:");
    expect(out).not.toContain("\\d");
    expect(out).not.toContain("/g");
  });

  it("does not invoke RegExp.toString() / .source anywhere in the output", () => {
    const out = formatCompleteJson({ rules: { email: /.+@.+/i, zip: /^\d{5}$/ } });
    // Each nested RegExp collapses to just its label + colon, in insertion order.
    expect(out).toBe("\n--- Rules ---\n  Email:\n  Zip:");
    expect(out).not.toContain("@");
    expect(out).not.toContain("\\d{5}");
  });

  it("treats a RegExp like an empty object (same shape as {} produces)", () => {
    const withRegExp = formatCompleteJson({ probe: /anything/ });
    const withEmptyObject = formatCompleteJson({ probe: {} });
    // Both yield only the section header — RegExp own-enumerable keys == {} keys == none.
    expect(withRegExp).toBe(withEmptyObject);
    expect(withRegExp).toBe("\n--- Probe ---");
  });

  it("interleaves a RegExp section between normal scalar sections without leaking the pattern", () => {
    const out = formatCompleteJson({
      account_type: "IRA",
      matcher: /secret-[0-9]+/g,
      cash_balance: 100,
    });
    // Scalar sections format normally; the RegExp contributes only its header.
    expect(out).toContain("Account Type: IRA");
    expect(out).toContain("--- Matcher ---");
    expect(out).toContain("Cash Balance: $100.00");
    expect(out).not.toContain("secret-");
  });
});
