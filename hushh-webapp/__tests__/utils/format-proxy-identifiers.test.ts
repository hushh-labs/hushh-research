import { describe, expect, it } from "vitest";

import { formatCompleteJson } from "@/lib/utils/json-to-human";

// Characterization tests for formatCompleteJson
// (hushh-webapp/lib/utils/json-to-human.ts) focused on native JavaScript
// `Proxy` wrappers placed around the evaluation object graph.
//
// Real implementation walks the input purely with standard reflection:
//   for (const [sectionKey, sectionValue] of Object.entries(json)) { ... }
//   typeof sectionValue === "number" | "string" | "object"
//   Array.isArray(sectionValue)
//   nested: Object.entries(sectionValue as Record<string, unknown>)
//
// KEY INVARIANT: A Proxy is transparent to `Object.entries`, `typeof`, and
// `Array.isArray` when its target is a plain object/array and the traps simply
// forward (or are omitted). So the formatter does NOT special-case proxies — it
// traverses them exactly like their underlying targets, and any `get`/
// `ownKeys`/`getOwnPropertyDescriptor` traps WILL fire during formatting.

describe("formatCompleteJson — Proxy-wrapped evaluation fields", () => {
  it("serializes a Proxy-wrapped top-level object identically to its plain target", () => {
    const plainTarget = {
      account_metadata: {
        institution_name: "Acme Bank",
        account_number: "12345",
      },
    };
    const proxied = new Proxy(plainTarget, {});

    expect(formatCompleteJson(proxied)).toBe(formatCompleteJson(plainTarget));
  });

  it("fires a forwarding get trap while reading nested fields", () => {
    const reads: string[] = [];
    const nested = new Proxy(
      { institution_name: "Trapped Bank", account_number: "999" },
      {
        get(target, prop, receiver) {
          if (typeof prop === "string") reads.push(prop);
          return Reflect.get(target, prop, receiver);
        },
      }
    );

    const output = formatCompleteJson({ account_metadata: nested });

    // The trap observed real key access during traversal.
    expect(reads).toContain("institution_name");
    expect(output).toContain("Institution: Trapped Bank");
  });

  it("treats a Proxy whose target is an array as an array section", () => {
    const arrayTarget = [
      { symbol_cusip: "AAPL", market_value: 1000, unrealized_gain_loss: 50 },
    ];
    const proxiedArray = new Proxy(arrayTarget, {});

    const output = formatCompleteJson({ holdings: proxiedArray });

    // Array.isArray sees through the proxy → array branch, not object branch.
    expect(output).toContain("--- Holdings (1 items) ---");
    expect(output).toContain("• AAPL");
  });

  it("honors an ownKeys/getOwnPropertyDescriptor trap that hides a field from Object.entries", () => {
    const target = { institution_name: "Visible", account_number: "SECRET" };
    const hidden = new Proxy(target, {
      ownKeys(t) {
        return Reflect.ownKeys(t).filter((k) => k !== "account_number");
      },
      getOwnPropertyDescriptor(t, prop) {
        if (prop === "account_number") return undefined;
        return Reflect.getOwnPropertyDescriptor(t, prop);
      },
    });

    const output = formatCompleteJson({ account_metadata: hidden });

    // Object.entries respects ownKeys → hidden key never reaches the formatter.
    expect(output).toContain("Institution: Visible");
    expect(output).not.toContain("SECRET");
  });

  it("propagates a throwing get trap (formatter does not swallow proxy errors)", () => {
    const exploding = new Proxy(
      { institution_name: "Boom" },
      {
        get() {
          throw new Error("trap exploded");
        },
      }
    );

    expect(() => formatCompleteJson({ account_metadata: exploding })).toThrow(
      "trap exploded"
    );
  });

  it("formats a Proxy-wrapped scalar-bearing object via the generic object branch", () => {
    const proxied = new Proxy(
      { custom_field: "kept", another_field: 42 },
      {}
    );

    const output = formatCompleteJson({ misc_section: proxied });

    expect(output).toContain("--- Misc Section ---");
    expect(output).toContain("Custom Field: kept");
    expect(output).toContain("Another Field: 42");
  });
});
