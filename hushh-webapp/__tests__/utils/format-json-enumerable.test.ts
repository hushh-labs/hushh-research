import { describe, expect, it } from "vitest";

import { formatCompleteJson } from "@/lib/utils/json-to-human";

// Characterization tests for formatCompleteJson
// (hushh-webapp/lib/utils/json-to-human.ts) for properties defined via
// `Object.defineProperty` — specifically NON-ENUMERABLE properties.
//
// TRUTH-FIRST — LITERAL CONTRACT:
//
// Top-level iteration is `for (const [sectionKey, sectionValue] of
// Object.entries(json))`, and nested object iteration is also
// `Object.entries(...)`. `Object.entries` returns ONLY own ENUMERABLE
// string-keyed properties. `Object.defineProperty` defaults `enumerable` to
// `false`, so a property added that way is invisible to `Object.entries` unless
// `enumerable: true` is explicitly passed.
//
// Therefore formatCompleteJson NEVER reads non-enumerable properties — there is
// no "parsing of hidden attributes". It simply skips them, identical to an
// object that never had the property at all. This is the literal property
// boundary: enumerable-own-string only.

describe("formatCompleteJson — non-enumerable property handling", () => {
  it("ignores a top-level non-enumerable property entirely", () => {
    const obj: Record<string, unknown> = {};
    Object.defineProperty(obj, "account_metadata", {
      value: { account_number: "123" },
      enumerable: false, // default, stated for clarity
      configurable: true,
      writable: true,
    });
    // No enumerable keys -> no output.
    expect(formatCompleteJson(obj)).toBe("");
  });

  it("renders an enumerable: true defineProperty value (boundary control)", () => {
    const obj: Record<string, unknown> = {};
    Object.defineProperty(obj, "account_metadata", {
      value: { account_number: "123" },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    expect(formatCompleteJson(obj)).toBe(
      "\n--- Account Information ---\n  Account Number: 123",
    );
  });

  it("renders only the enumerable sibling when mixed with a non-enumerable one", () => {
    const obj: Record<string, unknown> = { account_metadata: { account_number: "123" } };
    Object.defineProperty(obj, "portfolio_summary", {
      value: { total_value: 999 },
      enumerable: false,
      configurable: true,
      writable: true,
    });
    // The non-enumerable portfolio_summary is skipped; only account_metadata shows.
    expect(formatCompleteJson(obj)).toBe(
      "\n--- Account Information ---\n  Account Number: 123",
    );
  });


  it("renders identically to an object that never had the non-enumerable key", () => {
    const withHidden: Record<string, unknown> = { account_metadata: { account_number: "123" } };
    Object.defineProperty(withHidden, "portfolio_summary", {
      value: { total_value: 999 },
      enumerable: false,
      configurable: true,
      writable: true,
    });
    const without: Record<string, unknown> = { account_metadata: { account_number: "123" } };
    expect(formatCompleteJson(withHidden)).toBe(formatCompleteJson(without));
  });

  it("ignores a NESTED non-enumerable property inside a section object", () => {
    const nested: Record<string, unknown> = { account_number: "123" };
    Object.defineProperty(nested, "ssn", {
      value: "secret",
      enumerable: false,
      configurable: true,
      writable: true,
    });
    // Nested iteration also uses Object.entries -> "ssn" is invisible.
    expect(formatCompleteJson({ account_metadata: nested })).toBe(
      "\n--- Account Information ---\n  Account Number: 123",
    );

  });

  it("treats an all-non-enumerable object as empty output", () => {
    const obj: Record<string, unknown> = {};
    Object.defineProperty(obj, "a", { value: 1, enumerable: false });
    Object.defineProperty(obj, "b", { value: 2, enumerable: false });
    expect(formatCompleteJson(obj)).toBe("");
  });

  it("does NOT read non-enumerable getter-backed accessors", () => {
    const obj: Record<string, unknown> = {};
    let getterCalls = 0;
    Object.defineProperty(obj, "account_metadata", {
      get() {
        getterCalls += 1;
        return { account_number: "123" };
      },
      enumerable: false,
      configurable: true,
    });
    expect(formatCompleteJson(obj)).toBe("");
    // Object.entries never enumerates it, so the getter is never invoked.
    expect(getterCalls).toBe(0);
  });
});
