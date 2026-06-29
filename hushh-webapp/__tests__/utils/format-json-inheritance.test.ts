import { describe, expect, it } from "vitest";

import { formatCompleteJson } from "@/lib/utils/json-to-human";

// Characterization tests for formatCompleteJson
// (hushh-webapp/lib/utils/json-to-human.ts) focused on how it treats properties
// that live on the PROTOTYPE CHAIN rather than directly on the object.
//
// TRUTH-FIRST — LITERAL CONTRACT: formatCompleteJson's top-level walk is exactly
//   `for (const [sectionKey, sectionValue] of Object.entries(json)) { ... }`.
// `Object.entries` enumerates ONLY the object's OWN ENUMERABLE string-keyed
// properties. Therefore:
//   1. inherited enumerable properties (set on a prototype) are NOT serialized,
//   2. own NON-enumerable properties are NOT serialized,
//   3. only OWN ENUMERABLE properties are serialized.
// These tests pin that literal boundary — they do NOT claim any extra filtering
// beyond what `Object.entries` itself provides.

describe("formatCompleteJson — prototype-inherited field boundary", () => {
  it("excludes an enumerable property inherited via prototype", () => {
    const proto = { inherited_field: "from-proto" };
    const obj = Object.create(proto) as Record<string, unknown>;
    obj.own_field = "from-own";

    const out = formatCompleteJson(obj);
    expect(out).toBe("Own Field: from-own");
    expect(out).not.toContain("inherited_field");
    expect(out).not.toContain("from-proto");
    expect(out).not.toContain("Inherited Field");
  });

  it("excludes own NON-enumerable properties (Object.entries skips them)", () => {
    const obj: Record<string, unknown> = { visible: "yes" };
    Object.defineProperty(obj, "hidden", {
      value: "no",
      enumerable: false,
    });

    const out = formatCompleteJson(obj);
    expect(out).toBe("Visible: yes");
    expect(out).not.toContain("hidden");
    expect(out).not.toContain("Hidden");
  });

  it("serializes ONLY own enumerable keys, in own-key order", () => {
    const proto = { a: 1 };
    const obj = Object.create(proto) as Record<string, unknown>;
    obj.b = 2;
    obj.c = 3;

    const out = formatCompleteJson(obj);
    // `a` is inherited → excluded; only own `b`, `c` appear, in insertion order.
    expect(out).toBe("B: 2\nC: 3");
  });

  it("produces empty output when every property is inherited (no own keys)", () => {
    const proto = { only_inherited: "x" };
    const obj = Object.create(proto) as Record<string, unknown>;

    const out = formatCompleteJson(obj);
    expect(out).toBe("");
  });

  it("an own property shadowing an inherited key serializes the OWN value only", () => {
    const proto = { status: "inherited-status" };
    const obj = Object.create(proto) as Record<string, unknown>;
    obj.status = "own-status";

    const out = formatCompleteJson(obj);
    expect(out).toBe("Status: own-status");
    expect(out).not.toContain("inherited-status");
  });
});
