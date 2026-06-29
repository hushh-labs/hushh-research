import { describe, expect, it } from "vitest";

import { formatCompleteJson } from "@/lib/utils/json-to-human";

// Characterization tests for formatCompleteJson
// (hushh-webapp/lib/utils/json-to-human.ts) focused on objects that carry an
// un-invoked JavaScript Generator function as a property value, e.g.
//   function* demo() { yield 1; }
//
// TRUTH-FIRST (verified against the source): there is NO `typeof === "function"`
// branch anywhere in formatCompleteJson. A generator function is just a function
// value, so its handling depends entirely on WHICH data plane it lands on:
//
//   1. TOP-LEVEL value:
//      The top-level loop only special-cases number|string, Array, and
//      `typeof === "object"`. For a function, `typeof` is "function" (NOT
//      "object"), and it is not a number/string/array, so NONE of the branches
//      match and the entry is SILENTLY DROPPED — it produces no line at all.
//      (This is the "standard function omission" outcome — but only here.)
//
//   2. INSIDE AN OBJECT SECTION:
//      The per-field loop's final `else` calls formatValue(key, value). For a
//      function, formatValue falls through to `return String(value)`, which
//      stringifies the function's SOURCE TEXT. So the generator is rendered as
//      "<Label>: function* demo() { yield 1; }" — NOT blank, NOT omitted.
//
//   3. GENERIC ARRAY of objects:
//      The generic array branch picks the first non-null value via Object.values
//      and prints `• ${String(firstValue)}` — again the function SOURCE TEXT.
//
// These tests pin all three planes exactly.

function makeGenerator() {
  function* demo() {
    yield 1;
  }
  return demo;
}

describe("formatCompleteJson — generator function as a TOP-LEVEL value (omitted)", () => {
  it("drops a bare top-level generator function entirely (no line emitted)", () => {
    const out = formatCompleteJson({ demo: makeGenerator() });
    expect(out).toBe("");
  });

  it("keeps surrounding scalar sections while omitting the generator", () => {
    const out = formatCompleteJson({
      account_id: "ACME-1",
      demo: makeGenerator(),
    });
    // Only the scalar survives; the generator contributes nothing.
    expect(out).toContain("ACME-1");
    expect(out).not.toContain("function*");
    expect(out).not.toContain("yield");
  });
});

describe("formatCompleteJson — generator function INSIDE an object section (source text)", () => {
  it("renders the generator's source text via String(value)", () => {
    const out = formatCompleteJson({
      account_metadata: { demo: makeGenerator() },
    });
    expect(out).toContain("--- Account Information ---");
    // String(function*) includes the "function*" keyword and the body.
    expect(out).toContain("function*");
    expect(out).toContain("yield 1");
  });

  it("places the generator source under its title-cased field label", () => {
    const out = formatCompleteJson({
      account_metadata: { stream_factory: makeGenerator() },
    });
    expect(out).toContain("Stream Factory: function*");
  });
});

describe("formatCompleteJson — generator function inside a generic ARRAY (source text)", () => {
  it("prints the generator source as the first value bullet", () => {
    const out = formatCompleteJson({
      custom_rows: [{ demo: makeGenerator() }],
    });
    expect(out).toContain("--- Custom Rows (1 items) ---");
    expect(out).toContain("• function*");
    expect(out).toContain("yield 1");
  });
});
