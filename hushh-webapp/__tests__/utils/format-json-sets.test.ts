import { describe, expect, it } from "vitest";

import { formatCompleteJson } from "@/lib/utils/json-to-human";

// Characterization tests for formatCompleteJson
// (hushh-webapp/lib/utils/json-to-human.ts) focused on native JavaScript `Set`
// instances embedded inside payload objects.
//
// TRUTH-FIRST (verified against the source). formatCompleteJson never special-
// cases Set. The literal control flow for a Set value is:
//
//   * A Set passes `typeof value === "object"` and FAILS `Array.isArray(value)`,
//     so at the SECTION level it enters the "Handle objects" branch:
//
//       if (typeof sectionValue === "object") {
//         lines.push("");
//         lines.push(`--- ${sectionLabel} ---`);
//         for (const [key, value] of Object.entries(sectionValue ...)) { ... }
//       }
//
//   * At a NESTED field level it enters:
//
//       if (typeof value === "object" && !Array.isArray(value)) {
//         lines.push(`  ${getFieldLabel(key)}:`);
//         for (const [nestedKey, nestedValue] of Object.entries(value ...)) { ... }
//       }
//
//   The decisive fact: `Object.entries(new Set([...]))` is ALWAYS `[]`, because
//   a Set stores its members internally, NOT as own enumerable string-keyed
//   properties. `.size` is a getter on the prototype, also not enumerable.
//
//   Literal contract this pins:
//   1. A Set value NEVER throws and NEVER serializes its members.
//   2. As a top-level section, only the `--- <Label> ---` header is emitted;
//      no member/bullet lines follow from the Set.
//   3. As a nested field, only the `  <Field Label>:` line is emitted; the Set's
//      members are silently dropped (NO size, NO values, NO "item(s)" count —
//      that count path is reserved for Array.isArray values only).

describe("formatCompleteJson — native Set instances in payloads", () => {
  it("does not throw when a section value is a Set", () => {
    expect(() =>
      formatCompleteJson({ tags: new Set(["alpha", "beta"]) as unknown as object }),
    ).not.toThrow();
  });

  it("emits the section header but drops all Set members (top-level Set)", () => {
    const out = formatCompleteJson({ tags: new Set(["alpha", "beta", "gamma"]) as unknown as object });
    // Section header is produced from the object branch.
    expect(out).toContain("--- Tags ---");
    // None of the Set members surface anywhere in the output.
    expect(out).not.toContain("alpha");
    expect(out).not.toContain("beta");
    expect(out).not.toContain("gamma");
  });

  it("does not emit any '• ' bullet line for a top-level Set's members", () => {
    const out = formatCompleteJson({ tags: new Set([1, 2, 3]) as unknown as object });
    expect(out).not.toContain("•");
    // Nor the array-only "item(s)" count path.
    expect(out).not.toContain("item(s)");
  });

  it("renders only the field label for a Set nested inside a section object", () => {
    const out = formatCompleteJson({
      profile: { categories: new Set(["x", "y", "z"]) },
    });
    expect(out).toContain("--- Profile ---");
    // Nested object branch prints the field label line ...
    expect(out).toContain("Categories:");
    // ... but none of the Set's members.
    expect(out).not.toContain("x, y");
    expect(out).not.toContain("• x");
  });

  it("does not surface Set.size for a nested Set value", () => {
    const out = formatCompleteJson({
      profile: { categories: new Set(["one", "two", "three", "four"]) },
    });
    // size is a non-enumerable prototype getter, never iterated by Object.entries.
    expect(out).not.toContain("4 item(s)");
    expect(out).not.toContain(": 4");
  });

  it("treats an empty Set identically to a populated one (label only)", () => {
    const populated = formatCompleteJson({ tags: new Set(["a"]) as unknown as object });
    const empty = formatCompleteJson({ tags: new Set() as unknown as object });
    expect(populated).toContain("--- Tags ---");
    expect(empty).toContain("--- Tags ---");
    // Neither produces member output, so the rendered Tags section is identical.
    expect(empty).toBe(populated);
  });

  it("keeps sibling primitive fields intact alongside a dropped nested Set", () => {
    const out = formatCompleteJson({
      profile: { name: "Ada", categories: new Set(["m", "n"]) },
    });
    expect(out).toContain("--- Profile ---");
    // Sibling primitive is still serialized normally.
    expect(out).toContain("Ada");
    // The Set field's label appears, its members do not.
    expect(out).toContain("Categories:");
    expect(out).not.toContain("• m");
    expect(out).not.toContain("• n");
  });
});
