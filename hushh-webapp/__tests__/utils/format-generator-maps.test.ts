import { describe, expect, it } from "vitest";

import { formatCompleteJson } from "@/lib/utils/json-to-human";

// Characterization tests for formatCompleteJson
// (hushh-webapp/lib/utils/json-to-human.ts) focused on native JavaScript `Map`
// instances supplied as section values.
//
// TRUTH-FIRST notes (verified against the source):
//   - formatCompleteJson has NO Map-aware branch. A Map is `typeof === "object"`
//     and is NOT an Array, so it falls into the generic "Handle objects" path.
//   - Crucially, a Map stores its entries internally, NOT as own-enumerable
//     properties. `Object.entries(map)` is therefore `[]` — the .get/.set/.size
//     accessors live on the prototype and are non-enumerable.
//   - Result: a Map section emits ONLY the header lines ("" then
//     "--- <Label> ---") and ZERO field lines. The explicit entry pairs are
//     NEVER converted or rendered. It behaves identically to an empty object.
//   - This pins the contract: passing a Map does NOT serialize its key/value
//     pairs; the formatter returns the standard default (header-only) layout.

describe("formatCompleteJson — native Map instance values", () => {
  it("renders a Map section as a header only, never converting its entries", () => {
    const payload = new Map<string, unknown>([
      ["institution_name", "Vanguard"],
      ["cash_balance", 4200],
    ]);
    const out = formatCompleteJson({ account_metadata: payload });
    expect(out).toBe("\n--- Account Information ---");
    // Entry keys and values are never surfaced.
    expect(out).not.toContain("Vanguard");
    expect(out).not.toContain("4,200");
    expect(out).not.toContain("institution_name");
  });

  it("humanizes an unknown section key label but still emits no Map entries", () => {
    const out = formatCompleteJson({
      lookup_table: new Map([["a", 1], ["b", 2]]),
    });
    expect(out).toBe("\n--- Lookup Table ---");
    expect(out).not.toContain("• ");
  });

  it("treats a populated Map identically to an empty plain object", () => {
    const withMap = formatCompleteJson({ probe: new Map([["x", 10]]) });
    const withEmptyObject = formatCompleteJson({ probe: {} });
    expect(withMap).toBe(withEmptyObject);
    expect(withMap).toBe("\n--- Probe ---");
  });

  it("interleaves a Map section between scalar sections without leaking pairs", () => {
    const out = formatCompleteJson({
      account_type: "IRA",
      registry: new Map([["secret_key", "secret_value"]]),
      cash_balance: 100,
    });
    expect(out).toContain("Account Type: IRA");
    expect(out).toContain("--- Registry ---");
    expect(out).toContain("Cash Balance: $100.00");
    expect(out).not.toContain("secret_key");
    expect(out).not.toContain("secret_value");
  });

  it("does not throw when handling a Map with mixed-type entries", () => {
    expect(() =>
      formatCompleteJson({
        config: new Map<unknown, unknown>([
          ["enabled", true],
          [1, "one"],
          [{ nested: true }, [1, 2, 3]],
        ]),
      })
    ).not.toThrow();
  });
});
