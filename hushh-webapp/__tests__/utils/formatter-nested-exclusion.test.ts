import { describe, expect, it } from "vitest";

import { formatCompleteJson } from "@/lib/utils/json-to-human";

// Characterization tests for how `formatCompleteJson`
// (hushh-webapp/lib/utils/json-to-human.ts) enumerates keys of nested object
// structures — specifically that inherited (prototype-chain) and non-enumerable
// properties are excluded. Test-only; no production change.
//
// TRUTH-FIRST CORRECTION TO THE TASK PREMISE
// ------------------------------------------
// The task described a "recursive line-builder" that omits inherited keys
// "across all node depths." That is NOT how this function works. Two corrections,
// both verified against the current source:
//
// 1) `formatCompleteJson` is NOT recursive. It performs a FIXED manual descent of
//    exactly THREE `Object.entries` passes:
//       - level 1: `Object.entries(json)`                       (root, line 233)
//       - level 2: `Object.entries(sectionValue)`               (section, line 333)
//       - level 3: `Object.entries(value)`                      (nested, line 339)
//    A level-4 value is NOT descended: it is passed to `formatValue`, whose
//    object fall-through returns `String(value)` === "[object Object]" (line 202).
//    So there is a HARD depth ceiling at level 3; "all node depths" is false.
//
// 2) The exclusion of inherited / non-enumerable keys is a real property, but it
//    is a *consequence of `Object.entries`* (own-enumerable-string keys only) at
//    the three levels that are actually iterated — not of any recursion.
//
// These tests pin BOTH the genuine exclusion behavior (levels 1–3) AND the
// non-recursive ceiling (level 4 renders as "[object Object]", never expanded).

/** Build an object with an OWN enumerable key plus an INHERITED enumerable key. */
function withInheritedKey(
  own: Record<string, unknown>,
  inherited: Record<string, unknown>,
): Record<string, unknown> {
  const obj = Object.create(inherited) as Record<string, unknown>;
  for (const [k, v] of Object.entries(own)) obj[k] = v;
  return obj;
}

/** Build an object with an OWN enumerable key plus an OWN non-enumerable key. */
function withNonEnumerableKey(
  own: Record<string, unknown>,
  hiddenKey: string,
  hiddenValue: unknown,
): Record<string, unknown> {
  const obj: Record<string, unknown> = { ...own };
  Object.defineProperty(obj, hiddenKey, {
    value: hiddenValue,
    enumerable: false,
    writable: true,
    configurable: true,
  });
  return obj;
}

describe("formatCompleteJson — inherited & non-enumerable key exclusion (levels 1–3)", () => {
  it("excludes an INHERITED key on a level-2 section object (Object.entries own-only)", () => {
    const section = withInheritedKey(
      { own_field: "visible" },
      { inherited_field: "should-not-appear" },
    );
    const out = formatCompleteJson({ portfolio_summary: section });

    expect(out).toContain("Own Field");
    expect(out).toContain("visible");
    expect(out).not.toContain("inherited_field");
    expect(out).not.toContain("should-not-appear");
  });

  it("excludes a NON-ENUMERABLE own key on a level-2 section object", () => {
    const section = withNonEnumerableKey(
      { own_field: "visible" },
      "hidden_field",
      "should-not-appear",
    );
    const out = formatCompleteJson({ cash_management: section });

    expect(out).toContain("visible");
    expect(out).not.toContain("hidden_field");
    expect(out).not.toContain("should-not-appear");
  });

  it("excludes INHERITED and NON-ENUMERABLE keys on a level-3 nested object", () => {
    const nested = withNonEnumerableKey(
      withInheritedKey(
        { visible_nested: "yes" },
        { inherited_nested: "nope-proto" },
      ),
      "hidden_nested",
      "nope-hidden",
    );
    // section (level 2) holds a nested object (level 3)
    const section = { totals: nested };
    const out = formatCompleteJson({ income_summary: section });

    expect(out).toContain("yes");
    expect(out).not.toContain("inherited_nested");
    expect(out).not.toContain("nope-proto");
    expect(out).not.toContain("hidden_nested");
    expect(out).not.toContain("nope-hidden");
  });
});

describe("formatCompleteJson — NON-recursive depth ceiling at level 3", () => {
  it("does NOT descend into a level-4 object: renders it as '[object Object]'", () => {
    // root(1) -> section(2) -> nested(3) -> level4Object(4)
    const level4 = { deep_leaf: "unreachable" };
    const nested = { level4_container: level4 };
    const section = { totals: nested };
    const out = formatCompleteJson({ income_summary: section });

    // The level-3 pass hits `level4_container` and, because its value is an
    // object, calls formatValue -> String(value) === "[object Object]".
    expect(out).toContain("[object Object]");
    // The level-4 key/value are never enumerated or rendered.
    expect(out).not.toContain("deep_leaf");
    expect(out).not.toContain("unreachable");
  });

  it("an inherited key that only exists at level 4 is irrelevant (never reached)", () => {
    const level4 = withInheritedKey(
      { own_leaf: "own4" },
      { inherited_leaf: "proto4" },
    );
    const nested = { container: level4 };
    const section = { totals: nested };
    const out = formatCompleteJson({ realized_gain_loss: section });

    // Level 4 is stringified wholesale, so neither its own nor inherited keys
    // surface as individual lines.
    expect(out).toContain("[object Object]");
    expect(out).not.toContain("own_leaf");
    expect(out).not.toContain("own4");
    expect(out).not.toContain("inherited_leaf");
    expect(out).not.toContain("proto4");
  });
});
