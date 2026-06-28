import { describe, expect, it } from "vitest";

import { formatCompleteJson } from "@/lib/utils/json-to-human";

/**
 * Characterization tests for formatCompleteJson
 * (hushh-webapp/lib/utils/json-to-human.ts) when payload objects carry an
 * explicit `Symbol.toStringTag` modifier
 * (e.g. `{ [Symbol.toStringTag]: "HushhSecurePayload" }`).
 *
 * TRUTH-FIRST (verified against the source):
 *   formatCompleteJson walks values with `Object.entries(...)` and dispatches on
 *   `typeof`. It NEVER calls `String(obj)` on a section/nested object, and
 *   `Object.entries` returns ONLY string-keyed enumerable properties. A
 *   `Symbol.toStringTag` entry is keyed by a Symbol, so it is structurally
 *   excluded from every `Object.entries` pass. Consequences pinned below:
 *     - The custom tag (`"HushhSecurePayload"`) NEVER appears in the output.
 *     - The default-tag artifact `"[object HushhSecurePayload]"` NEVER appears,
 *       because objects are iterated, not stringified.
 *     - A section object whose ONLY own enumerable string key is the symbol tag
 *       collapses to a bare header (`"\n--- <Label> ---"`) — the symbol adds no
 *       field lines.
 *     - Sibling string-keyed scalars render exactly as normal; the symbol tag is
 *       simply skipped alongside them.
 *     - Nested objects behave the same: the symbol tag is invisible at any depth.
 *   The Symbol.toStringTag override has ZERO effect on the produced layout.
 */

const TAG = Symbol.toStringTag;

describe("formatCompleteJson — Symbol.toStringTag is structurally invisible", () => {
  it("omits the custom tag for a section object whose only own key is the symbol tag", () => {
    const out = formatCompleteJson({
      payload: { [TAG]: "HushhSecurePayload" } as Record<string, unknown>,
    });
    expect(out).toBe("\n--- Payload ---");
  });

  it("never emits the custom tag string anywhere in the output", () => {
    const out = formatCompleteJson({
      payload: { [TAG]: "HushhSecurePayload" } as Record<string, unknown>,
    });
    expect(out).not.toContain("HushhSecurePayload");
  });

  it("never emits the [object HushhSecurePayload] default-tag artifact", () => {
    const out = formatCompleteJson({
      payload: { [TAG]: "HushhSecurePayload" } as Record<string, unknown>,
    });
    expect(out).not.toContain("[object");
  });
});

describe("formatCompleteJson — string-keyed siblings are unaffected by the tag", () => {
  it("renders normal scalar fields while skipping the symbol tag", () => {
    const out = formatCompleteJson({
      payload: {
        [TAG]: "HushhSecurePayload",
        status: "active",
      } as Record<string, unknown>,
    });
    expect(out).toBe("\n--- Payload ---\n  Status: active");
    expect(out).not.toContain("HushhSecurePayload");
  });

  it("renders a top-level scalar identically with or without a sibling tag is N/A; here keeps order of string keys", () => {
    const out = formatCompleteJson({
      payload: {
        institution_name: "Hushh Bank",
        [TAG]: "HushhSecurePayload",
        account_type: "Vault",
      } as Record<string, unknown>,
    });
    expect(out).toBe(
      "\n--- Payload ---\n  Institution: Hushh Bank\n  Account Type: Vault"
    );
  });
});

describe("formatCompleteJson — the tag stays invisible at nested depth", () => {
  it("ignores a Symbol.toStringTag on a nested object", () => {
    const out = formatCompleteJson({
      payload: {
        meta: { [TAG]: "HushhSecurePayload", label: "x" } as Record<
          string,
          unknown
        >,
      } as Record<string, unknown>,
    });
    expect(out).toBe("\n--- Payload ---\n  Meta:\n    • Label: x");
    expect(out).not.toContain("HushhSecurePayload");
  });

  it("produces output identical to the same object without the symbol tag", () => {
    const withTag = formatCompleteJson({
      payload: {
        [TAG]: "HushhSecurePayload",
        status: "active",
        count: 3,
      } as Record<string, unknown>,
    });
    const withoutTag = formatCompleteJson({
      payload: { status: "active", count: 3 },
    });
    expect(withTag).toBe(withoutTag);
  });
});

describe("formatCompleteJson — Symbol.toStringTag does not crash the formatter", () => {
  it("returns a string and never throws for a tagged payload", () => {
    expect(() =>
      formatCompleteJson({
        payload: { [TAG]: "HushhSecurePayload", status: "ok" } as Record<
          string,
          unknown
        >,
      })
    ).not.toThrow();
  });
});
