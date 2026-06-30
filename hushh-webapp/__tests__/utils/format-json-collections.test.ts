import { describe, expect, it } from "vitest";

import { formatCompleteJson } from "@/lib/utils/json-to-human";

// Characterization tests for formatCompleteJson
// (hushh-webapp/lib/utils/json-to-human.ts) processing native JavaScript Map and
// Set objects as section values.
//
// TRUTH-FIRST — IMPORTANT CORRECTION: the premise that Map/Set "map safely
// without dropping data elements" is FALSE. formatCompleteJson is built for
// plain JSON. A Map or Set is:
//   - not a number/string  → skips the scalar branch
//   - not Array.isArray()   → skips the array branch
//   - typeof === "object"   → ENTERS the object branch
// The object branch enumerates entries with `Object.entries(value)`. For a Map
// or Set, `Object.entries(...)` returns `[]` because their contents live in
// internal slots, NOT own enumerable string-keyed properties. Result: only the
// section HEADER is emitted and EVERY contained element is silently DROPPED.
// (Map keys/values and Set members never appear; .size is never read.)
// These tests pin that real data-loss contract so any future Map/Set support is
// a deliberate, observable change.

describe("formatCompleteJson — native Map / Set collections", () => {
  it("DROPS all entries of a top-level Map (emits header only)", () => {
    const prefs = new Map([
      ["a", 1],
      ["b", 2],
    ]);
    // Header is emitted; the two Map entries are NOT serialized.
    expect(formatCompleteJson({ prefs })).toBe("\n--- Prefs ---");
  });

  it("DROPS all members of a top-level Set (emits header only)", () => {
    const tags = new Set([1, 2, 3]);
    expect(formatCompleteJson({ tags })).toBe("\n--- Tags ---");
  });

  it("emits only the key label for a NESTED Map (members dropped)", () => {
    const prefs = new Map([["a", 1]]);
    // Nested object branch prints the field label line, then Object.entries(map)
    // yields nothing, so no member lines follow.
    expect(formatCompleteJson({ config: { prefs } })).toBe(
      "\n--- Config ---\n  Prefs:"
    );
  });

  it("emits only the key label for a NESTED Set (members dropped)", () => {
    const tags = new Set(["x", "y"]);
    expect(formatCompleteJson({ config: { tags } })).toBe(
      "\n--- Config ---\n  Tags:"
    );
  });

  it("keeps plain sibling fields while still dropping Map contents", () => {
    const prefs = new Map([["a", 1]]);
    expect(formatCompleteJson({ name: "x", prefs })).toBe(
      "Name: x\n\n--- Prefs ---"
    );
  });

  it("never serializes Map keys/values or Set members into the output", () => {
    const prefs = new Map([["secretKey", "secretValue"]]);
    const out = formatCompleteJson({ prefs });
    expect(out).not.toContain("secretKey");
    expect(out).not.toContain("secretValue");
  });
});
