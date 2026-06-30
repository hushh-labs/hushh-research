import { describe, expect, it } from "vitest";

import { formatCompleteJson } from "@/lib/utils/json-to-human";

// Characterization tests for formatCompleteJson
// (hushh-webapp/lib/utils/json-to-human.ts) for the GENERIC array branch when
// array elements are objects whose keys are stringified indices (e.g.
// `[{ "0": "a" }]`).
//
// TRUTH-FIRST — LITERAL CONTRACT (generic, non-special-cased section key):
//
//   for (const item of sectionValue.slice(0, 3)) {
//     if (typeof item === "object" && item !== null) {
//       const obj = item as Record<string, unknown>;
//       const firstValue = Object.values(obj).find(v => v !== null && v !== undefined);
//       lines.push(`  • ${String(firstValue || "Item")}`);
//     } else {
//       lines.push(`  • ${String(item)}`);
//     }
//   }
//   if (sectionValue.length > 3) lines.push(`  ... and ${sectionValue.length - 3} more`);
//
// CORRECTION to the "index inversion" framing: the KEY NAME is irrelevant. The
// formatter never reads object keys in the generic array branch — it takes the
// FIRST value via `Object.values(obj).find(...)`. So `{ "0": "a" }` and
// `{ foo: "a" }` render identically. There is no "matching value tag isolation";
// the only thing the layout records is the first non-null/undefined VALUE.
//
// SHARP EDGE pinned here: the fallback uses `firstValue || "Item"` (truthiness),
// NOT `firstValue ?? "Item"` (nullishness). So a FALSY-but-present first value
// (0, "", false) is replaced by the literal "Item" even though `.find()` already
// selected it as non-null/undefined.

describe("formatCompleteJson — array element key/value 'inversion'", () => {
  it("renders the first VALUE, ignoring a stringified-index key", () => {
    expect(formatCompleteJson({ items: [{ "0": "a" }] })).toBe(
      "\n--- Items (1 items) ---\n  • a",
    );
  });

  it("renders identically whether the key is '0' or a normal name", () => {
    const a = formatCompleteJson({ items: [{ "0": "a" }] });
    const b = formatCompleteJson({ items: [{ foo: "a" }] });
    expect(a).toBe(b);
  });

  it("uses the FIRST value when an index-named object has several keys", () => {
    expect(formatCompleteJson({ items: [{ "0": "a", "1": "b" }] })).toBe(
      "\n--- Items (1 items) ---\n  • a",
    );
  });

  it("lists first 3 index-named objects then a '... and N more' summary", () => {
    expect(
      formatCompleteJson({
        items: [{ "0": "a" }, { "0": "b" }, { "0": "c" }, { "0": "d" }],
      }),
    ).toBe("\n--- Items (4 items) ---\n  • a\n  • b\n  • c\n  ... and 1 more");
  });

  it("falls back to 'Item' for a falsy-but-present first value of 0 (|| not ??)", () => {
    // Object.values -> [0]; find selects 0 (non-null); String(0 || "Item") = "Item".
    expect(formatCompleteJson({ items: [{ "0": 0 }] })).toBe(
      "\n--- Items (1 items) ---\n  • Item",
    );
  });

  it("falls back to 'Item' for a falsy-but-present empty-string first value", () => {
    expect(formatCompleteJson({ items: [{ "0": "" }] })).toBe(
      "\n--- Items (1 items) ---\n  • Item",
    );
  });

  it("falls back to 'Item' for a falsy-but-present false first value", () => {
    expect(formatCompleteJson({ items: [{ "0": false }] })).toBe(
      "\n--- Items (1 items) ---\n  • Item",
    );
  });

  it("skips a leading null value and reports the next non-null value", () => {
    // find() skips null/undefined; first kept value is the truthy "b".
    expect(formatCompleteJson({ items: [{ "0": null, "1": "b" }] })).toBe(
      "\n--- Items (1 items) ---\n  • b",
    );
  });
});
