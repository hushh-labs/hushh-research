import { afterEach, describe, expect, it } from "vitest";

import { formatCompleteJson } from "@/lib/utils/json-to-human";

// Characterization tests for formatCompleteJson
// (hushh-webapp/lib/utils/json-to-human.ts) documenting its exact behavior when
// the input object carries hazardous own keys: "__proto__", "constructor", and
// "prototype" — the classic prototype-poisoning property names.
//
// TRUTH-FIRST — LITERAL CONTRACT: formatCompleteJson is a READ-ONLY serializer.
// It only ever READS the input via `Object.entries(...)` / `Object.values(...)`
// and appends strings to a local `lines` array. It performs NO assignment back
// onto the input, NO `obj[key] = ...`, NO `Object.assign`, and NO recursive
// merge. Therefore it CANNOT pollute `Object.prototype` regardless of what keys
// the input contains.
//
// REAL RUNTIME PATH: in production these objects arrive via `tryFormatComplete`,
// which does `JSON.parse(...)` then calls `formatCompleteJson`. Critically,
// `JSON.parse('{"__proto__": ...}')` does NOT set the object's prototype — it
// defines "__proto__" as an OWN, ENUMERABLE data property. So these tests build
// payloads with `JSON.parse` (mirroring the real path) so that the hazardous
// names are genuine own keys that `Object.entries` will iterate. We then pin
// that the formatter (a) treats them as ordinary keys, and (b) never leaks onto
// the global prototype chain.

const OBJECT_PROTO = Object.prototype as unknown as Record<string, unknown>;

afterEach(() => {
  // Defensive cleanup: if any assertion above somehow polluted the chain, undo
  // it so test isolation holds. (Expected to be a no-op.)
  delete OBJECT_PROTO.polluted;
  delete OBJECT_PROTO.injected;
});

describe("formatCompleteJson — prototype-poisoning property keys are handled safely", () => {
  it("does NOT pollute Object.prototype from a JSON __proto__ payload", () => {
    // JSON.parse makes "__proto__" an OWN enumerable key (not a prototype set).
    const payload = JSON.parse('{"__proto__":{"polluted":"yes"}}') as Record<
      string,
      unknown
    >;

    // Sanity: the payload's own prototype is still the pristine Object.prototype,
    // and the dangerous key is an own enumerable property (the real hazard shape).
    expect(Object.getPrototypeOf(payload)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(payload, "__proto__")).toBe(
      true,
    );

    const out = formatCompleteJson(payload);

    expect(typeof out).toBe("string");
    // The global prototype chain is untouched: a fresh object sees nothing.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect("polluted" in Object.prototype).toBe(false);
  });

  it("treats an own __proto__ object key as an ordinary serialized section", () => {
    const payload = JSON.parse('{"__proto__":{"alpha":"A"}}') as Record<
      string,
      unknown
    >;
    const out = formatCompleteJson(payload);
    // TRUTH-FIRST QUIRK: the section label is derived from
    // `SECTION_LABELS["__proto__"]`, and since SECTION_LABELS is a plain object
    // literal, that lookup INHERITS `Object.prototype` (a truthy value) — so the
    // label stringifies to "[object Object]" rather than a cleaned name. This is
    // a harmless READ-only artifact of label resolution; the nested value is
    // still rendered, and nothing is written to the global chain.
    expect(out).toContain("[object Object]");
    expect(out).toContain("Alpha: A");
    expect(({} as Record<string, unknown>).alpha).toBeUndefined();
  });

  it("serializes a top-level scalar __proto__ value without pollution", () => {
    const payload = JSON.parse('{"__proto__":"danger"}') as Record<
      string,
      unknown
    >;
    const out = formatCompleteJson(payload);
    expect(out).toContain("danger");
    expect("danger" in Object.prototype).toBe(false);
  });

  it("treats a 'constructor' own key as a normal field (no global mutation)", () => {
    const payload = JSON.parse('{"constructor":{"x":1}}') as Record<
      string,
      unknown
    >;
    const out = formatCompleteJson(payload);
    // TRUTH-FIRST QUIRK: like __proto__, the "constructor" section label is read
    // from `SECTION_LABELS["constructor"]`, which inherits the native `Object`
    // constructor function from the literal's prototype. It stringifies to
    // "function Object() { [native code] }" — hence the label contains "Object".
    // Still a harmless READ; nothing is mutated.
    expect(out).toContain("Object");
    expect(out).toContain("X: 1");
    // Object's real constructor is unchanged.
    expect(Object.prototype.constructor).toBe(Object);
  });

  it("treats a 'prototype' own key as a normal field", () => {
    const payload = JSON.parse('{"prototype":{"y":2}}') as Record<
      string,
      unknown
    >;
    const out = formatCompleteJson(payload);
    expect(out).toContain("Prototype");
    expect(out).toContain("Y: 2");
  });

  it("handles a poisoning key nested inside a section object without pollution", () => {
    const payload = JSON.parse(
      '{"config":{"__proto__":"x","real":"r"}}',
    ) as Record<string, unknown>;
    const out = formatCompleteJson(payload);
    expect(out).toContain("--- Config ---");
    expect(out).toContain("Real: r");
    expect(({} as Record<string, unknown>).real).toBeUndefined();
  });

  it("is read-only: does not throw and leaves the global prototype pristine across all keys", () => {
    const payload = JSON.parse(
      '{"__proto__":{"injected":"1"},"constructor":{"injected":"2"},"prototype":{"injected":"3"}}',
    ) as Record<string, unknown>;
    expect(() => formatCompleteJson(payload)).not.toThrow();
    expect(({} as Record<string, unknown>).injected).toBeUndefined();
    expect("injected" in Object.prototype).toBe(false);
  });
});
