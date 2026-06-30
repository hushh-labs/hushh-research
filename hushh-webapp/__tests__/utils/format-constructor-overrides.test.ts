import { describe, expect, it } from "vitest";

import { formatCompleteJson } from "@/lib/utils/json-to-human";

// Characterization tests for formatCompleteJson
// (hushh-webapp/lib/utils/json-to-human.ts) focused on payload dictionaries
// whose standard `constructor` reference tag has been overwritten by a plain
// string value (e.g., { constructor: "overridden-with-string" }), including the
// array-nested-object code path.
//
// TRUTH-FIRST (verified against the source AND the live run):
//   `{ constructor: "..." }` IS an own enumerable property, so Object.entries /
//   Object.values include it and the string VALUE always passes through
//   correctly. There is NO prototype-pollution guard and NO special omission for
//   `constructor`.
//
//   The surprising, pinned behavior is in the LABEL path, not the value path:
//   the field-label lookup resolves the key against a plain object map
//   (something like fieldMappings[key]). For key === "constructor" that lookup
//   does NOT miss — it hits the INHERITED `Object.prototype.constructor`, i.e.
//   the native `Object` function. That function is then used as the label and
//   stringified, so the rendered label becomes:
//       "function Object() { [native code] }"
//   rather than a title-cased "Constructor". This is the documented baseline:
//   an attacker/user-supplied `constructor` key leaks the native Object function
//   into the label via inherited-property lookup, but the value is untouched.
//
//   The GENERIC array branch renders each item object as
//   "• <first non-null own value via Object.values(...)>" with NO key label, so
//   it is immune to the label leak and shows the plain string.

const OBJECT_CTOR_LABEL = "function Object() { [native code] }";

describe("formatCompleteJson — overridden constructor as an object-section field", () => {
  it("leaks the native Object function as the label (inherited-property lookup)", () => {
    const out = formatCompleteJson({
      account_metadata: { constructor: "overridden-with-string" },
    });
    expect(out).toContain("--- Account Information ---");
    expect(out).toContain(`${OBJECT_CTOR_LABEL}: overridden-with-string`);
    // The value is never special-cased away.
    expect(out).toContain("overridden-with-string");
  });

  it("applies no special omission — constructor sits beside normal fields", () => {
    const out = formatCompleteJson({
      account_metadata: {
        institution_name: "Acme Bank",
        constructor: "overridden-with-string",
      },
    });
    expect(out).toContain("Institution: Acme Bank");
    expect(out).toContain(`${OBJECT_CTOR_LABEL}: overridden-with-string`);
  });

  it("strips markdown from the value while still leaking the Object-function label", () => {
    const out = formatCompleteJson({
      account_metadata: { constructor: "**bold-ctor**" },
    });
    expect(out).toContain(`${OBJECT_CTOR_LABEL}: bold-ctor`);
    expect(out).not.toContain("**");
  });
});

describe("formatCompleteJson — overridden constructor inside array-nested objects", () => {
  it("renders the overridden constructor as the first value in the generic array branch", () => {
    const out = formatCompleteJson({
      custom_rows: [{ constructor: "overridden-with-string" }],
    });
    // generic array branch: "--- <Label> (N items) ---" then "• <firstValue>"
    // (Object.values, no key label) -> immune to the label leak.
    expect(out).toContain("--- Custom Rows (1 items) ---");
    expect(out).toContain("• overridden-with-string");
    expect(out).not.toContain(OBJECT_CTOR_LABEL);
  });

  it("treats constructor as an ordinary key when picking the first non-null value", () => {
    const out = formatCompleteJson({
      custom_rows: [{ constructor: "ctor-string", label: "second" }],
    });
    // Object.values order: own-enumerable insertion order -> constructor first.
    expect(out).toContain("• ctor-string");
  });

  it("handles multiple array items each carrying an overridden constructor", () => {
    const out = formatCompleteJson({
      custom_rows: [
        { constructor: "first-ctor" },
        { constructor: "second-ctor" },
      ],
    });
    expect(out).toContain("--- Custom Rows (2 items) ---");
    expect(out).toContain("• first-ctor");
    expect(out).toContain("• second-ctor");
  });
});

describe("formatCompleteJson — overridden constructor as a top-level scalar section", () => {
  it("leaks the native Object function as the label at the top level too", () => {
    const out = formatCompleteJson({ constructor: "overridden-with-string" });
    expect(out).toBe(`${OBJECT_CTOR_LABEL}: overridden-with-string`);
  });
});
