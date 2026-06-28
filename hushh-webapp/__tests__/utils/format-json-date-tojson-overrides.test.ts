import { describe, expect, it } from "vitest";

import { formatCompleteJson } from "@/lib/utils/json-to-human";

// Characterization tests for formatCompleteJson
// (hushh-webapp/lib/utils/json-to-human.ts) focused on native Date instances
// whose standard `.toJSON` method has been explicitly DISABLED or MODIFIED via
// local (instance-level) overrides.
//
// TRUTH-FIRST (verified against the source):
//   - formatCompleteJson does NOT call JSON.stringify, .toJSON, .toISOString,
//     or .toString on Date values. It serializes objects purely by walking
//     `Object.entries(value)` — i.e. ENUMERABLE OWN properties only.
//   - A pristine native Date has NO enumerable own properties, so at the top
//     level it collapses to a bare `--- Label ---` header (timestamp dropped),
//     and nested it collapses to an empty `  <Label>:` line.
//   - Consequence pinned below: because the formatter ignores `.toJSON`,
//     DISABLING the method (set to undefined, `delete`, or a NON-enumerable
//     redefinition) changes NOTHING — output is byte-identical to a plain Date.
//   - The ONLY way an override is observable is when it is installed as an
//     ENUMERABLE OWN property (plain assignment `d.toJSON = ...`), in which case
//     it LEAKS into the output as a `ToJSON: <value>` line. This is an accident
//     of property enumeration, not date serialization.

const ISO = "2023-12-31T23:59:59.999Z";

describe("formatCompleteJson — Date with .toJSON disabled (non-observable overrides)", () => {
  it("set to undefined: top-level Date still collapses to a bare header", () => {
    const d = new Date(ISO);
    // Plain assignment of undefined IS an own enumerable property, but the
    // formatter skips null/undefined values, so the line is suppressed.
    (d as unknown as { toJSON?: unknown }).toJSON = undefined;
    expect(formatCompleteJson({ custom_ts: d })).toBe("\n--- Custom Ts ---");
  });

  it("deleted instance method: identical to a pristine Date (bare header)", () => {
    const d = new Date(ISO);
    delete (d as unknown as { toJSON?: unknown }).toJSON; // no own prop anyway
    const pristine = new Date(ISO);
    expect(formatCompleteJson({ custom_ts: d })).toBe(
      formatCompleteJson({ custom_ts: pristine })
    );
    expect(formatCompleteJson({ custom_ts: d })).toBe("\n--- Custom Ts ---");
  });

  it("non-enumerable redefinition: override is invisible to the formatter", () => {
    const d = new Date(ISO);
    Object.defineProperty(d, "toJSON", {
      value: () => "SHOULD-NOT-APPEAR",
      enumerable: false,
      configurable: true,
      writable: true,
    });
    expect(formatCompleteJson({ custom_ts: d })).toBe("\n--- Custom Ts ---");
  });

  it("nested non-enumerable override: collapses to an empty label line", () => {
    const d = new Date(ISO);
    Object.defineProperty(d, "toJSON", {
      value: () => "SHOULD-NOT-APPEAR",
      enumerable: false,
      configurable: true,
    });
    expect(formatCompleteJson({ portfolio_summary: { as_of: d } })).toBe(
      "\n--- Portfolio Summary ---\n  As Of:"
    );
  });
});

describe("formatCompleteJson — Date with .toJSON modified as an enumerable own prop (leaks)", () => {
  it("string override leaks as a 'ToJSON' value line at the top level", () => {
    const d = new Date(ISO);
    (d as unknown as { toJSON: unknown }).toJSON = "DISABLED";
    expect(formatCompleteJson({ custom_ts: d })).toBe(
      "\n--- Custom Ts ---\n  ToJSON: DISABLED"
    );
  });

  it("numeric override is run through the number formatter, not date logic", () => {
    const d = new Date(ISO);
    (d as unknown as { toJSON: unknown }).toJSON = 123;
    // "toJSON" is not a currency/percentage field, so formatNumber applies.
    expect(formatCompleteJson({ custom_ts: d })).toBe(
      "\n--- Custom Ts ---\n  ToJSON: 123"
    );
  });

  it("nested string override leaks as a bullet under the label", () => {
    const d = new Date(ISO);
    (d as unknown as { toJSON: unknown }).toJSON = "DISABLED";
    expect(formatCompleteJson({ portfolio_summary: { as_of: d } })).toBe(
      "\n--- Portfolio Summary ---\n  As Of:\n    • ToJSON: DISABLED"
    );
  });

  it("a custom enumerable timestamp property is what actually surfaces", () => {
    // Demonstrates the only reliable way to get a Date's instant into the
    // output: attach the precision as an enumerable own property yourself.
    const d = new Date(ISO);
    (d as unknown as { iso: string }).iso = d.toISOString();
    expect(formatCompleteJson({ custom_ts: d })).toBe(
      `\n--- Custom Ts ---\n  Iso: ${ISO}`
    );
  });
});

describe("formatCompleteJson — disabling .toJSON never affects output vs a plain Date", () => {
  it("undefined / delete / non-enumerable all equal the pristine rendering", () => {
    const pristine = formatCompleteJson({ custom_ts: new Date(ISO) });

    const a = new Date(ISO);
    (a as unknown as { toJSON?: unknown }).toJSON = undefined;

    const b = new Date(ISO);
    delete (b as unknown as { toJSON?: unknown }).toJSON;

    const c = new Date(ISO);
    Object.defineProperty(c, "toJSON", {
      value: () => "x",
      enumerable: false,
      configurable: true,
    });

    expect(formatCompleteJson({ custom_ts: a })).toBe(pristine);
    expect(formatCompleteJson({ custom_ts: b })).toBe(pristine);
    expect(formatCompleteJson({ custom_ts: c })).toBe(pristine);
  });
});
