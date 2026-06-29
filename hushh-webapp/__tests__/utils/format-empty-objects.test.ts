import { describe, expect, it } from "vitest";

import { formatCompleteJson } from "@/lib/utils/json-to-human";

// Characterization tests for formatCompleteJson
// (hushh-webapp/lib/utils/json-to-human.ts) focused on deeply nested but
// entirely empty object trees.
//
// TRUTH-FIRST (verified against the source):
//   - formatCompleteJson emits NO brackets at all. There is no `{`/`}` in the
//     output; it produces section headers (`--- Label ---`) and indented label
//     lines instead. "Structural cleanliness" here means: empty objects collapse
//     to headers/labels with no bracket characters.
//   - Level 1 (top-level empty object `a: {}`): pushes a blank line then a
//     `--- A ---` header; the entries loop over `{}` adds nothing.
//   - Level 2 (`b: { c: {} }`): header `--- B ---`, then `  C:` (nested-object
//     branch prints the label with a trailing colon), and the empty `{}` adds
//     no child bullets.
//   - Level 3 (`b: { c: { d: {} } }`): the 3rd-level empty object is NOT
//     recursed; it reaches the scalar `formatValue` path as a bullet, and
//     `formatValue` falls through to `String({})`, leaking the literal
//     `[object Object]`. This is the real (leaky) boundary, pinned here.

describe("formatCompleteJson — empty object trees", () => {
  it("collapses a single top-level empty object to a bare header (no brackets)", () => {
    const out = formatCompleteJson({ a: {} });
    expect(out).toBe("\n--- A ---");
    expect(out).not.toContain("{");
    expect(out).not.toContain("}");
  });

  it("formats `{ a: {}, b: { c: {} } }` as headers + a single label line", () => {
    const out = formatCompleteJson({ a: {}, b: { c: {} } });
    expect(out).toBe("\n--- A ---\n\n--- B ---\n  C:");
    expect(out).not.toContain("{");
    expect(out).not.toContain("}");
  });

  it("emits no child bullets for a level-2 empty nested object", () => {
    const out = formatCompleteJson({ b: { c: {} } });
    expect(out).toBe("\n--- B ---\n  C:");
    expect(out.split("\n")).toHaveLength(3);
  });

  it("leaks '[object Object]' for a level-3 empty object (real boundary)", () => {
    const out = formatCompleteJson({ b: { c: { d: {} } } });
    expect(out).toBe("\n--- B ---\n  C:\n    • D: [object Object]");
  });

  it("renders multiple sibling empty objects as independent headers", () => {
    const out = formatCompleteJson({ a: {}, b: {}, c: {} });
    expect(out).toBe("\n--- A ---\n\n--- B ---\n\n--- C ---");
  });
});
