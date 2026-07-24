import { describe, expect, it, vi } from "vitest";

import {
  resolveTopShellHeight,
  resolveTopShellRouteProfile,
} from "@/components/app-ui/top-shell-metrics";
import { memoize } from "@/lib/utils/memoize";

describe("memoize", () => {
  it("returns cached results for matching value arguments", () => {
    const compute = vi.fn((input: { id: string }) => ({ label: input.id.toUpperCase() }));
    const memoized = memoize(compute);

    const first = memoized({ id: "profile" });
    const second = memoized({ id: "profile" });

    expect(second).toBe(first);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("supports argument identity through custom key resolvers", () => {
    const ids = new WeakMap<object, string>();
    let nextId = 0;
    const resolveIdentityKey = (value: object) => {
      const existing = ids.get(value);
      if (existing) return existing;
      const key = `object-${nextId++}`;
      ids.set(value, key);
      return key;
    };
    const compute = vi.fn((input: { id: string }) => ({ label: input.id }));
    const memoized = memoize(compute, { keyResolver: resolveIdentityKey });

    const input = { id: "same" };
    const equalValue = { id: "same" };

    expect(memoized(input)).toBe(memoized(input));
    expect(memoized(equalValue)).not.toBe(memoized(input));
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("evicts the oldest entry when maxSize is exceeded", () => {
    const compute = vi.fn((value: string) => value.toUpperCase());
    const memoized = memoize(compute, { maxSize: 2 });

    expect(memoized("")).toBe("");
    expect(memoized("a")).toBe("A");
    expect(memoized("b")).toBe("B");
    expect(memoized("")).toBe("");

    expect(compute).toHaveBeenCalledTimes(4);
  });
});

describe("top-shell route profile memoization", () => {
  it("keeps current route behavior while reusing repeated pure route resolutions", () => {
    const first = resolveTopShellRouteProfile("/profile");
    const second = resolveTopShellRouteProfile("/profile");

    expect(second).toBe(first);
    expect(first).toEqual({
      id: "standard",
      metrics: {
        shellVisible: true,
        hasTabs: false,
        contentOffsetMode: "normal",
      },
    });
    expect(resolveTopShellHeight("/profile")).toBe("var(--top-shell-reserved-height)");
    expect(resolveTopShellHeight("/")).toBe("0px");
  });
});
