import { describe, expect, it } from "vitest";

import { formatCompleteJson } from "@/lib/utils/json-to-human";

// Characterization tests for formatCompleteJson
// (hushh-webapp/lib/utils/json-to-human.ts) focused on the EXACT contract when a
// top-level section value is an instance of a user-defined class versus a plain
// object literal with the same own fields.
//
// TRUTH-FIRST (verified against the source + a JS-runtime probe):
//   formatCompleteJson walks values with Object.entries(...) at every level
//   (top-level sections, object sections, and one nested level). Object.entries
//   returns ONLY OWN ENUMERABLE string-keyed properties. For a JS class:
//     - field declarations (`id = 1`) and constructor assignments (`this.x = 5`)
//       become OWN ENUMERABLE instance properties — identical to a literal.
//     - prototype methods and getters are NON-ENUMERABLE on the prototype, so
//       Object.entries never sees them.
//     - inherited field declarations from a base class are initialized as OWN
//       enumerable properties on the instance, so they ARE included.
//   Therefore the formatted output for a class instance is byte-for-byte equal to
//   the output for a plain literal carrying the same own enumerable fields. There
//   is no instanceof / constructor / class-name branch anywhere in the utility.
// These tests pin that exact equivalence and the method/getter exclusion.

describe("formatCompleteJson — class instance vs plain object literal parity", () => {
  it("produces identical output for a class instance and an equivalent literal (object section)", () => {
    class CustomModel {
      institution_name = "Acme Bank";
      account_holder = "Jane Doe";
    }

    const fromInstance = formatCompleteJson({
      account_metadata: new CustomModel(),
    });
    const fromLiteral = formatCompleteJson({
      account_metadata: {
        institution_name: "Acme Bank",
        account_holder: "Jane Doe",
      },
    });

    expect(fromInstance).toBe(fromLiteral);
    expect(fromInstance).toBe(
      "\n--- Account Information ---\n  Institution: Acme Bank\n  Account Holder: Jane Doe"
    );
  });

  it("treats a constructor-assigned instance the same as a field-declared instance", () => {
    class FieldModel {
      account_holder = "Jane";
    }
    class CtorModel {
      constructor() {
        // assigned in constructor → still an own enumerable property
        (this as { account_holder?: string }).account_holder = "Jane";
      }
    }

    expect(formatCompleteJson({ account_metadata: new CtorModel() })).toBe(
      formatCompleteJson({ account_metadata: new FieldModel() })
    );
  });
});

describe("formatCompleteJson — only own enumerable instance fields are mapped", () => {
  it("ignores prototype methods and getters on a class instance", () => {
    class WithBehavior {
      account_holder = "Jane";
      getLabel() {
        return "ignored-method";
      }
      get derived() {
        return "ignored-getter";
      }
    }

    const out = formatCompleteJson({ account_metadata: new WithBehavior() });
    expect(out).toBe(
      "\n--- Account Information ---\n  Account Holder: Jane"
    );
    expect(out).not.toContain("getLabel");
    expect(out).not.toContain("derived");
    expect(out).not.toContain("ignored");
  });

  it("includes inherited class field declarations (own props on the instance)", () => {
    class Base {
      institution_name = "Base Bank";
    }
    class Derived extends Base {
      account_holder = "Jane";
    }

    expect(formatCompleteJson({ account_metadata: new Derived() })).toBe(
      formatCompleteJson({
        account_metadata: {
          institution_name: "Base Bank",
          account_holder: "Jane",
        },
      })
    );
  });
});

describe("formatCompleteJson — class instances honor field-specific formatting", () => {
  it("applies currency formatting to numeric class fields exactly like a literal", () => {
    class Summary {
      beginning_value = 1000;
      ending_value = 1500.5;
    }

    expect(formatCompleteJson({ portfolio_summary: new Summary() })).toBe(
      formatCompleteJson({
        portfolio_summary: { beginning_value: 1000, ending_value: 1500.5 },
      })
    );
  });

  it("formats a top-level class instance section the same as a literal", () => {
    class Meta {
      account_type = "Roth IRA";
      account_number = "XXXX-1234";
    }

    expect(formatCompleteJson({ account_metadata: new Meta() })).toBe(
      formatCompleteJson({
        account_metadata: {
          account_type: "Roth IRA",
          account_number: "XXXX-1234",
        },
      })
    );
  });
});
