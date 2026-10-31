import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useHeldValue } from "@/hooks/use-held-value";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useHeldValue", () => {
  it("bridges a short gap so a continuous state never reads as ended", () => {
    const { result, rerender } = renderHook(
      ({ value }: { value: string | null }) => useHeldValue(value, 4_000),
      { initialProps: { value: "Fetching" as string | null } },
    );
    expect(result.current).toBe("Fetching");

    // One job ends and the next is queued shortly after.
    rerender({ value: null });
    expect(result.current).toBe("Fetching");
    act(() => {
      vi.advanceTimersByTime(1_500);
    });
    expect(result.current).toBe("Fetching");
    rerender({ value: "Fetching" });
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(result.current).toBe("Fetching");
  });

  it("releases only after the hold elapses with nothing new", () => {
    const { result, rerender } = renderHook(
      ({ value }: { value: string | null }) => useHeldValue(value, 4_000),
      { initialProps: { value: "Fetching" as string | null } },
    );
    rerender({ value: null });
    act(() => {
      vi.advanceTimersByTime(3_999);
    });
    expect(result.current).toBe("Fetching");
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBeNull();
  });

  it("shows a new value immediately and never invents one on first render", () => {
    const { result, rerender } = renderHook(
      ({ value }: { value: string | null }) => useHeldValue(value, 4_000),
      { initialProps: { value: null as string | null } },
    );
    expect(result.current).toBeNull();
    rerender({ value: "Older" });
    expect(result.current).toBe("Older");
    rerender({ value: "Latest" });
    expect(result.current).toBe("Latest");
  });
});
