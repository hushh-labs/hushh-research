import { describe, expect, it } from "vitest";

import { formatCompleteJson } from "@/lib/utils/json-to-human";

// Characterization tests for formatCompleteJson
// (hushh-webapp/lib/utils/json-to-human.ts) focused on explicit `undefined`
// object properties at both the top level and inside nested objects.
//
// TRUTH-FIRST: formatCompleteJson OMITS undefined (and null) properties — it
// does NOT strip them to an empty line and does NOT convert them to the literal
// string "undefined". The exact guards are:
//   - top-level loop: `if (sectionValue === null || sectionValue === undefined)
//     continue;`
//   - nested-object loop: `if (value === null || value === undefined) continue;`
//   - deeper-nested loop: `if (nestedValue === null || nestedValue === undefined)
//     continue;`
// So an undefined key contributes NOTHING to the output (no label, no bullet,
// no placeholder). undefined is treated identically to null. The surviving keys
// render exactly as if the undefined keys were never present. Note: because
// `Record<string, unknown>` is typed, the test object is built with an explicit
// `undefined` value cast to satisfy the signature; runtime behavior is what is
// pinned here.

describe("formatCompleteJson — undefined property handling", () => {
  it("omits a top-level undefined key while keeping its siblings", () => {
    expect(
      formatCompleteJson({ alpha: 1, beta: undefined, gamma: "x" })
    ).toBe("Alpha: 1\nGamma: x");
  });

  it("produces empty output when the only key is undefined", () => {
    expect(formatCompleteJson({ beta: undefined })).toBe("");
  });

  it("never emits the literal string 'undefined'", () => {
    expect(formatCompleteJson({ alpha: 1, beta: undefined })).not.toContain(
      "undefined"
    );
  });

  it("omits an undefined property inside a nested object", () => {
    expect(
      formatCompleteJson({ details: { a: 1, b: undefined, c: "y" } })
    ).toBe("\n--- Details ---\n  A: 1\n  C: y");
  });

  it("omits an undefined property inside a deeper nested object", () => {
    expect(
      formatCompleteJson({ details: { nested: { p: undefined, q: 2 } } })
    ).toBe("\n--- Details ---\n  Nested:\n    • Q: 2");
  });

  it("treats undefined identically to null (both fully omitted)", () => {
    const withUndef = formatCompleteJson({ alpha: 1, beta: undefined });
    const withNull = formatCompleteJson({ alpha: 1, beta: null });
    expect(withUndef).toBe(withNull);
    expect(withUndef).toBe("Alpha: 1");
  });
});
