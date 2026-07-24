import { describe, expect, it } from "vitest";

import { buildRiaClientQueryKey } from "@/lib/services/ria-cache-keys";
import { createStableHash, stableStringify } from "@/lib/utils/hash";

describe("stable object hashing", () => {
  it("normalizes object key ordering", () => {
    expect(stableStringify({ b: 2, a: 1 })).toBe(stableStringify({ a: 1, b: 2 }));
  });

  it("normalizes nested object keys without changing array order", () => {
    const left = {
      filter: {
        tags: ["ria", "active"],
        range: { end: 2, start: 1 },
      },
    };
    const right = {
      filter: {
        range: { start: 1, end: 2 },
        tags: ["ria", "active"],
      },
    };
    const differentArrayOrder = {
      filter: {
        range: { start: 1, end: 2 },
        tags: ["active", "ria"],
      },
    };

    expect(createStableHash(left)).toBe(createStableHash(right));
    expect(createStableHash(left)).not.toBe(createStableHash(differentArrayOrder));
  });

  it("supports primitive values distinctly", () => {
    expect(createStableHash("1")).not.toBe(createStableHash(1));
    expect(createStableHash(null)).not.toBe(createStableHash(false));
  });

  it("rejects unsupported values instead of silently collapsing them", () => {
    expect(() => stableStringify({ value: undefined })).toThrow(TypeError);
    expect(() => stableStringify({ value: () => null })).toThrow(TypeError);
    expect(() => stableStringify({ value: Symbol("x") })).toThrow(TypeError);
    expect(() => stableStringify({ value: Number.NaN })).toThrow(TypeError);
  });

  it("keeps collision-sensitive RIA client query keys distinct", () => {
    const withDelimiterInQuery = buildRiaClientQueryKey({
      q: "alice_active",
      status: "",
      page: 1,
      limit: 50,
    });
    const withDelimiterAcrossFields = buildRiaClientQueryKey({
      q: "alice",
      status: "active",
      page: 1,
      limit: 50,
    });

    expect(withDelimiterInQuery).not.toBe(withDelimiterAcrossFields);
    expect(buildRiaClientQueryKey({ status: "active", q: "alice" })).toBe(
      buildRiaClientQueryKey({ q: "alice", status: "active" })
    );
  });
});
