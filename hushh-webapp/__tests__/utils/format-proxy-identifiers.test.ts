import { describe, expect, it } from "vitest";

import { formatCompleteJson } from "@/lib/utils/json-to-human";

// Characterization tests for formatCompleteJson
// (hushh-webapp/lib/utils/json-to-human.ts) for native JavaScript `Proxy`
// wrappers around the evaluation object graph.
//
// TRUTH-FIRST / NON-OVERLAP SCOPE NOTE:
//   The generic "Object.entries enumerable-own" traversal contract is ALREADY
//   pinned by sibling files — notably `format-json-enumerable.test.ts` (which
//   proves non-enumerable keys and non-enumerable getters are invisible) plus
//   `format-json-poisoning.test.ts`, `format-json-inheritance.test.ts`, and
//   `format-constructor-overrides.test.ts`. A Proxy whose traps merely forward
//   (or omit) is just a transparent re-expression of that SAME contract, so
//   identical-passthrough / ownKeys-hiding / generic-object-branch cases would
//   duplicate existing coverage and are intentionally NOT re-added here.
//
//   This file is narrowed to the two behaviors a Proxy can express that plain
//   objects and `Object.defineProperty` CANNOT, and that no existing test
//   covers:
//     1. `Array.isArray` transparency over an array-TARGET proxy (the formatter
//        routes it through the array branch, not the object branch).
//     2. A LIVE, enumerable trap that actually fires during traversal and whose
//        thrown error is NOT swallowed — the exact complement of the enumerable
//        file's "a non-enumerable getter is never invoked" boundary.

describe("formatCompleteJson — Proxy-unique behaviors (non-overlapping)", () => {
  it("treats a Proxy whose target is an array as an array section (Array.isArray transparency)", () => {
    const arrayTarget = [
      { symbol_cusip: "AAPL", market_value: 1000, unrealized_gain_loss: 50 },
    ];
    const proxiedArray = new Proxy(arrayTarget, {});

    const output = formatCompleteJson({ holdings: proxiedArray });

    // Array.isArray sees through the proxy → Holdings (array) branch fires,
    // NOT the generic object branch. This is unique to a proxy target; a plain
    // object can never satisfy Array.isArray.
    expect(output).toContain("--- Holdings (1 items) ---");
    expect(output).toContain("• AAPL");
  });

  it("invokes a live enumerable get trap during traversal (complement of the non-enumerable-getter boundary)", () => {
    const reads: string[] = [];
    const live = new Proxy(
      { institution_name: "Trapped Bank" },
      {
        get(target, prop, receiver) {
          if (typeof prop === "string") reads.push(prop);
          return Reflect.get(target, prop, receiver);
        },
      }
    );

    const output = formatCompleteJson({ account_metadata: live });

    // Unlike a NON-enumerable getter (which Object.entries never reaches), a
    // proxy over an enumerable key IS traversed, so the trap fires for real.
    expect(reads).toContain("institution_name");
    expect(output).toContain("Institution: Trapped Bank");
  });

  it("does NOT swallow an error thrown by a trap fired mid-traversal", () => {
    const exploding = new Proxy(
      { institution_name: "Boom" },
      {
        get() {
          throw new Error("trap exploded");
        },
      }
    );

    // formatCompleteJson has no try/catch around section traversal, so a
    // throwing live trap propagates to the caller verbatim.
    expect(() => formatCompleteJson({ account_metadata: exploding })).toThrow(
      "trap exploded"
    );
  });
});
