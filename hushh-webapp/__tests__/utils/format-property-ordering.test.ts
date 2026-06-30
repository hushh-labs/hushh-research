import { describe, expect, it } from "vitest";

import { formatCompleteJson } from "@/lib/utils/json-to-human";

// Characterization tests for formatCompleteJson
// (hushh-webapp/lib/utils/json-to-human.ts) documenting how key/property order
// is serialized when an array contains objects that share an identical key set
// but were declared in completely different orders.
//
// TRUTH-FIRST — LITERAL CONTRACT: formatCompleteJson walks the input with
// `Object.entries(...)` / `Object.values(...)` and never sorts, canonicalizes,
// or re-orders keys. JavaScript object iteration order for string
// (non-integer-like) keys is INSERTION ORDER. Therefore the formatter is
// deterministic but it preserves each object's *own declaration order* exactly
// as given — it does NOT impose a single shared/alphabetized ordering across
// array elements. Two objects with the same keys in different orders serialize
// according to their respective insertion orders.

describe("formatCompleteJson — array object property ordering follows insertion order (no sort)", () => {
  it("uses each object's own first-declared value in a generic array section", () => {
    // Generic array handling emits `• <first non-null value>` per item, where
    // "first" = first key in insertion order. Identical keys, reversed order.
    const json = {
      records: [
        { gamma: "G", alpha: "A", bravo: "B" },
        { alpha: "A", bravo: "B", gamma: "G" },
      ],
    };
    const out = formatCompleteJson(json);
    expect(out).toBe(
      ["", "--- Records (2 items) ---", "  • G", "  • A"].join("\n"),
    );
  });

  it("preserves object-section key order verbatim (not alphabetized)", () => {
    const json = {
      config: { gamma: "G", alpha: "A", bravo: "B" },
    };
    const out = formatCompleteJson(json);
    expect(out).toBe(
      [
        "",
        "--- Config ---",
        "  Gamma: G",
        "  Alpha: A",
        "  Bravo: B",
      ].join("\n"),
    );
    // Explicitly NOT alphabetical (which would be Alpha, Bravo, Gamma).
    expect(out.indexOf("Gamma")).toBeLessThan(out.indexOf("Alpha"));
  });

  it("preserves a second object's differing key order independently", () => {
    const json = {
      config: { charlie: "C", bravo: "B", alpha: "A" },
    };
    const out = formatCompleteJson(json);
    expect(out).toBe(
      [
        "",
        "--- Config ---",
        "  Charlie: C",
        "  Bravo: B",
        "  Alpha: A",
      ].join("\n"),
    );
  });

  it("preserves nested object key order verbatim", () => {
    const json = {
      config: {
        nested: { zulu: "Z", yankee: "Y", xray: "X" },
      },
    };
    const out = formatCompleteJson(json);
    expect(out).toBe(
      [
        "",
        "--- Config ---",
        "  Nested:",
        "    • Zulu: Z",
        "    • Yankee: Y",
        "    • Xray: X",
      ].join("\n"),
    );
  });

  it("is deterministic: identical input yields byte-identical output across calls", () => {
    const json = {
      config: { gamma: "G", alpha: "A", bravo: "B" },
    };
    expect(formatCompleteJson(json)).toBe(formatCompleteJson(json));
  });

  it("orders top-level sections by their own insertion order", () => {
    const json = {
      config: { alpha: "A" },
      profile: { beta: "B" },
    };
    const out = formatCompleteJson(json);
    expect(out.indexOf("--- Config ---")).toBeLessThan(
      out.indexOf("--- Profile ---"),
    );
  });
});
