import { describe, expect, it } from "vitest";

import { formatCompleteJson } from "@/lib/utils/json-to-human";

// Characterization tests for formatCompleteJson
// (hushh-webapp/lib/utils/json-to-human.ts) under object configurations whose
// PROPERTY KEYS are abnormally large (single keys exceeding 1,000+ characters).
//
// TRUTH-FIRST — CURRENT CONTRACT (verified against source):
//
// formatCompleteJson imposes NO key-length cap, truncation, ellipsis, or
// buffer pre-allocation. Keys flow through getFieldLabel():
//
//   FIELD_LABELS[key] || key.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())
//
// So an unrecognized key is humanized by (1) swapping every "_" for a space and
// (2) upper-casing the first character of every word (\b\w). The full,
// arbitrarily long key text is preserved verbatim apart from those two pure
// string transforms — there is no spacing collapse, no length guard, and no
// allocation exception for 1,000+ character keys.
//
// CORRECTION TO THE TASK PREMISE: there are no "serialization limits" or
// "buffer allocation" boundaries to hit here. The function builds plain strings
// via Array.join("\n"); an extreme key simply produces an equally long line.

const LONG = 2048;

describe("formatCompleteJson — extreme property key lengths are serialized without limits", () => {
  it("does not throw on a single top-level key exceeding 1,000+ characters", () => {
    const key = "a".repeat(LONG);
    expect(() => formatCompleteJson({ [key]: "value" })).not.toThrow();
  });

  it("preserves the full key length (no truncation / ellipsis / buffer cap)", () => {
    const key = "z".repeat(LONG);
    const out = formatCompleteJson({ [key]: "value" });
    // First char upper-cased by \b\w, remainder untouched → label length === key length.
    const expectedLabel = "Z" + "z".repeat(LONG - 1);
    expect(out).toBe(`${expectedLabel}: value`);
    expect(out).not.toContain("...");
  });

  it("upper-cases only the first character of a long single-word key", () => {
    const key = "k".repeat(LONG);
    const out = formatCompleteJson({ [key]: 1 });
    expect(out.startsWith("K")).toBe(true);
    // Exactly one upper-case 'K' produced from the leading word boundary.
    expect((out.match(/K/g) ?? []).length).toBe(1);
  });

  it("replaces every underscore in a long snake_case key with a single space", () => {
    // 600 "word_" repeats → a very long key, each word boundary title-cased.
    const key = Array.from({ length: 600 }, () => "word").join("_");
    const out = formatCompleteJson({ [key]: "v" });
    const expectedLabel = Array.from({ length: 600 }, () => "Word").join(" ");
    expect(out).toBe(`${expectedLabel}: v`);
    expect(out).not.toContain("_");
  });

  it("serializes an extreme key inside a nested object section verbatim", () => {
    const longKey = "q".repeat(LONG);
    const out = formatCompleteJson({
      account_metadata: { [longKey]: "shown" },
    });
    const expectedLabel = "Q" + "q".repeat(LONG - 1);
    expect(out).toContain("--- Account Information ---");
    expect(out).toContain(`  ${expectedLabel}: shown`);
  });

  it("handles many extreme keys in one object without spacing corruption", () => {
    const json: Record<string, unknown> = {};
    for (let i = 0; i < 5; i++) {
      json[`${"x".repeat(LONG)}${i}`] = i;
    }
    const out = formatCompleteJson(json);
    const lines = out.split("\n");
    expect(lines).toHaveLength(5);
    for (const line of lines) {
      // Each line is "X...<digit>: <digit>" — header transform + value.
      expect(line).toMatch(/^X x*\d: \d$|^X+x*\d: \d$/);
    }
  });

  it("treats a recognized label preferentially even if surrounded by long keys", () => {
    const longKey = "m".repeat(LONG);
    const out = formatCompleteJson({
      portfolio_summary: { ending_value: 100, [longKey]: "x" },
    });
    // Known field still maps to its friendly label and currency formatting.
    expect(out).toContain("  Ending Value: $100.00");
    // The long key is humanized, not dropped.
    expect(out).toContain("M" + "m".repeat(LONG - 1));
  });
});
