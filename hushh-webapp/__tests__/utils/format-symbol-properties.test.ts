import { describe, expect, it } from "vitest";

import { formatCompleteJson } from "@/lib/utils/json-to-human";

// Characterization tests for formatCompleteJson in lib/utils/json-to-human.ts,
// focused on native Symbol-keyed properties in the input object.
//
// Truth-first note on the real implementation:
//
// formatCompleteJson enumerates keys with the standard string-key iteration
// APIs (Object.entries / Object.keys / for...in style access). By JavaScript
// spec, those APIs DO NOT enumerate Symbol-keyed properties — a property whose
// KEY is a Symbol (e.g. obj[Symbol('internal_meta')] = ...) is invisible to
// them (only Object.getOwnPropertySymbols / Reflect.ownKeys expose it).
//
// Therefore the utility does not "discard" symbol metadata via a deliberate
// filter, nor does it "serialize" it into a fragment: the entries are simply
// never visited. The observable contract is:
//
//   * Symbol-KEYED entries are structurally absent from the output.
//   * Sibling STRING-keyed properties on the same object are unaffected.
//   * A Symbol used as a VALUE (not a key) under a string key is a different
//     path: it reaches formatValue() and falls through to String(value),
//     yielding e.g. "Symbol(internal_meta)".
//
// Pinning this guards against silent drift if the walk is ever switched to
// Reflect.ownKeys (which WOULD begin surfacing symbol keys) — that would be a
// deliberate, visible contract change rather than an accident.

describe("formatCompleteJson — native Symbol properties", () => {
  it("does not throw when an object mixes string keys and a Symbol key", () => {
    const meta = Symbol("internal_meta");
    const payload = {
      metrics: {
        total_value: 1000,
        [meta]: "secret-token",
      },
    };
    expect(() => formatCompleteJson(payload)).not.toThrow();
  });

  it("omits Symbol-keyed entries entirely (not enumerated by string-key APIs)", () => {
    const meta = Symbol("internal_meta");
    const output = formatCompleteJson({
      metrics: {
        total_value: 1000,
        [meta]: "secret-token",
      },
    });
    // The symbol-keyed value never appears...
    expect(output).not.toContain("secret-token");
    expect(output).not.toContain("internal_meta");
    // ...while the string-keyed sibling renders normally.
    expect(output).toContain("Total Portfolio Value: $1,000.00");
  });

  it("renders nothing extra for a section whose ONLY property is Symbol-keyed", () => {
    const meta = Symbol("internal_meta");
    const output = formatCompleteJson({ metrics: { [meta]: "hidden" } });
    // Header is still emitted for the (string-keyed) section container,
    // but no field lines are produced from the invisible symbol entry.
    expect(output).toContain("--- Metrics ---");
    expect(output).not.toContain("hidden");
  });

  it("ignores a top-level Symbol-keyed property while keeping string sections", () => {
    const meta = Symbol("internal_meta");
    const payload: Record<string | symbol, unknown> = {
      [meta]: { total_value: 999 },
      metrics: { total_value: 1000 },
    };
    const output = formatCompleteJson(payload);
    expect(output).toContain("--- Metrics ---");
    expect(output).toContain("Total Portfolio Value: $1,000.00");
    // The symbol-keyed branch (999) is never walked.
    expect(output).not.toContain("999");
  });

  it("renders a Symbol used as a VALUE (under a string key) via String() fallback", () => {
    const output = formatCompleteJson({
      metrics: { tag: Symbol("internal_meta") },
    });
    // String(Symbol('internal_meta')) === "Symbol(internal_meta)".
    expect(output).toContain("Tag: Symbol(internal_meta)");
  });
});
