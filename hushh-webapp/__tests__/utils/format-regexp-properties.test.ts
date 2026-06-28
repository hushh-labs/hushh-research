import { describe, expect, it } from "vitest";

import { formatCompleteJson } from "@/lib/utils/json-to-human";

// Characterization tests for formatCompleteJson
// (hushh-webapp/lib/utils/json-to-human.ts) focused on native RegExp instances
// reached through the GENERIC ARRAY branch — i.e. RegExp values nested inside
// objects that live inside an array section.
//
// TRUTH-FIRST notes (verified against the source):
//   - formatCompleteJson has NO RegExp-aware branch. Behaviour is determined
//     purely by structural position.
//   - In the object/scalar branches, a RegExp is `typeof === "object"`, not an
//     array, and exposes NO own-enumerable properties (`Object.entries(re)` is
//     `[]`). So source/flags are NEVER rendered there. (Covered separately in
//     format-json-regexp.test.ts.)
//   - The GENERIC ARRAY branch is different. For an unknown array section, each
//     of the first 3 items is handled as:
//        if (typeof item === "object" && item !== null) {
//          const firstValue = Object.values(obj).find(v => v != null);
//          lines.push(`  • ${String(firstValue || "Item")}`);
//        } else {
//          lines.push(`  • ${String(item)}`);
//        }
//   - Therefore a RegExp that is the FIRST non-null value of a nested object
//     IS stringified via `String(regexp)` → `/source/flags` literal text.
//   - A BARE RegExp array element is itself an object with no own-enumerable
//     values, so `firstValue` is `undefined` and it collapses to the literal
//     fallback string "Item".

describe("formatCompleteJson — RegExp via the generic array branch", () => {
  it("stringifies a RegExp that is the first value of a nested object item", () => {
    const out = formatCompleteJson({
      validators: [{ pattern: /^[a-z]+$/i }],
    });
    expect(out).toContain("--- Validators (1 items) ---");
    // String(/^[a-z]+$/i) === "/^[a-z]+$/i" — source AND flags are rendered here.
    expect(out).toContain("  • /^[a-z]+$/i");
  });

  it("collapses a BARE RegExp array element to the 'Item' fallback (no own values)", () => {
    const out = formatCompleteJson({
      rules: [/\d{3}-\d{4}/g],
    });
    expect(out).toContain("--- Rules (1 items) ---");
    // A RegExp object has no own-enumerable values → firstValue is undefined.
    expect(out).toContain("  • Item");
    expect(out).not.toContain("\\d{3}");
  });

  it("renders only the first non-null value, so a leading scalar hides the RegExp", () => {
    const out = formatCompleteJson({
      checks: [{ label: "email", matcher: /.+@.+/ }],
    });
    // `label` is the first non-null value → it wins; the RegExp is never reached.
    expect(out).toContain("  • email");
    expect(out).not.toContain("@");
  });

  it("caps the generic array preview at 3 items and notes the remainder", () => {
    const out = formatCompleteJson({
      patterns: [
        { p: /a/ },
        { p: /b/ },
        { p: /c/ },
        { p: /d/ },
      ],
    });
    expect(out).toContain("  • /a/");
    expect(out).toContain("  • /b/");
    expect(out).toContain("  • /c/");
    // 4th item is truncated by slice(0, 3).
    expect(out).not.toContain("  • /d/");
    expect(out).toContain("  ... and 1 more");
  });

  it("does not throw on arrays mixing RegExp-first objects and bare RegExps", () => {
    expect(() =>
      formatCompleteJson({
        mixed: [{ rx: /^x$/ }, /bare/, { name: "n", rx: /y/ }],
      })
    ).not.toThrow();
  });
});
