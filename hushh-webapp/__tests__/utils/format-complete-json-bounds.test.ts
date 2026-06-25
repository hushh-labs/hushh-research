import { describe, expect, it } from "vitest";

import { formatCompleteJson } from "@/lib/utils/json-to-human";

/**
 * Characterization tests for `formatCompleteJson` from
 * `hushh-webapp/lib/utils/json-to-human.ts`.
 *
 * Scope: pin down the *exact, narrow* contract of how this formatter behaves
 * when a payload contains arrays with nested `null` elements or mixed
 * primitive members.
 *
 * Truth-first note: the formatter is NOT uniformly null-safe across array
 * shapes. The generic array branch (for unrecognized section keys) tolerates
 * `null` and mixed primitives without throwing, but the specialized branches
 * (`holdings`, `asset_allocation`, `activity_and_transactions`) dereference
 * each element as an object and therefore THROW when an element is `null`.
 * These tests document both the safe boundary and the throwing boundary so
 * the real contract is captured, not an aspirational one.
 */
describe("formatCompleteJson — array bounds with null and mixed primitives", () => {
  it("renders generic-array null elements as the literal string 'null' without throwing", () => {
    const out = formatCompleteJson({
      // `misc_items` is not a recognized section key, so it takes the
      // generic array branch which guards `item !== null`.
      misc_items: [null, null],
    });

    expect(() =>
      formatCompleteJson({ misc_items: [null, null] })
    ).not.toThrow();
    expect(out).toContain("--- Misc Items (2 items) ---");
    expect(out).toContain("• null");
  });

  it("stringifies mixed primitive elements (number, string, boolean) in a generic array", () => {
    const out = formatCompleteJson({
      misc_items: [42, "alpha", true],
    });

    expect(out).toContain("--- Misc Items (3 items) ---");
    expect(out).toContain("• 42");
    expect(out).toContain("• alpha");
    expect(out).toContain("• true");
  });

  it("truncates a generic array longer than 3 elements and reports the remainder", () => {
    const out = formatCompleteJson({
      misc_items: [1, 2, 3, 4, 5],
    });

    expect(out).toContain("--- Misc Items (5 items) ---");
    expect(out).toContain("• 1");
    expect(out).toContain("• 2");
    expect(out).toContain("• 3");
    expect(out).not.toContain("• 4");
    expect(out).toContain("... and 2 more");
  });

  it("uses the first non-nullish value of a generic-array object element", () => {
    const out = formatCompleteJson({
      misc_items: [{ first: null, second: "visible-label" }],
    });

    expect(out).toContain("• visible-label");
  });

  it("skips empty arrays entirely — no section header is emitted", () => {
    const out = formatCompleteJson({
      misc_items: [],
    });

    expect(out).not.toContain("Misc Items");
    expect(out).toBe("");
  });

  it("skips top-level null/undefined sections rather than rendering them", () => {
    const out = formatCompleteJson({
      misc_items: null,
      other_section: undefined,
    });

    expect(out).toBe("");
  });

  it("THROWS on a null element inside the specialized `holdings` array (documented boundary)", () => {
    // The holdings branch casts each element to an object and reads
    // `holding.symbol_cusip`, which throws a TypeError on a null element.
    expect(() =>
      formatCompleteJson({ holdings: [null] })
    ).toThrow(TypeError);
  });

  it("THROWS on a null element inside the specialized `asset_allocation` array (documented boundary)", () => {
    expect(() =>
      formatCompleteJson({ asset_allocation: [null] })
    ).toThrow(TypeError);
  });

  it("formats well-formed holdings entries alongside mixed-presence fields safely", () => {
    const out = formatCompleteJson({
      holdings: [
        { symbol_cusip: "AAPL", market_value: 1500, unrealized_gain_loss: 300 },
        // missing optional fields must not throw — they are simply omitted
        { symbol_cusip: "MSFT" },
      ],
    });

    expect(out).toContain("--- Holdings (2 items) ---");
    expect(out).toContain("• AAPL");
    expect(out).toContain("• MSFT");
  });
});
