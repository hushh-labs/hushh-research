import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type {
  InPlaceConnectOutcome,
  InPlaceConnectStart,
} from "@/lib/connections/google-connect-in-place";
import { useInPlaceConnect } from "@/lib/connections/use-in-place-connect";

function deferred() {
  let resolve!: (value: InPlaceConnectOutcome) => void;
  const promise = new Promise<InPlaceConnectOutcome>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("useInPlaceConnect", () => {
  it("tracks one pending window, exposes cancel, and reports the cancelled flag", async () => {
    const { result } = renderHook(() => useInPlaceConnect());
    const outcome = deferred();
    const finish = vi.fn();
    let cancelSignal!: AbortSignal;
    act(() => {
      const started = result.current.start(
        "item-1",
        (controls) => {
          cancelSignal = controls.cancelSignal;
          return { surface: "window", result: outcome.promise } satisfies InPlaceConnectStart;
        },
        finish,
      );
      expect(started).toBe("started");
    });
    expect(result.current.pending).toEqual({ key: "item-1", cancellable: true });
    // A second attempt while one is open is refused, not stacked.
    act(() => {
      expect(result.current.start("item-2", () => ({ surface: "window", result: outcome.promise }), vi.fn())).toBe("busy");
    });
    act(() => result.current.cancel());
    expect(cancelSignal.aborted).toBe(true);
    await act(async () => outcome.resolve("not_connected"));
    expect(result.current.pending).toBeNull();
    expect(finish).toHaveBeenCalledExactlyOnceWith("not_connected", { cancelled: true, surface: "window" });
  });

  it("returns blocked without pending state or a finish call", () => {
    const { result } = renderHook(() => useInPlaceConnect());
    const finish = vi.fn();
    act(() => {
      expect(
        result.current.start("k", () => ({ surface: "blocked", result: Promise.resolve("not_connected") }), finish),
      ).toBe("blocked");
    });
    expect(result.current.pending).toBeNull();
    expect(finish).not.toHaveBeenCalled();
  });

  it("drops stale outcomes and anything after unmount", async () => {
    const { result, unmount } = renderHook(() => useInPlaceConnect());
    const stale = deferred();
    const finish = vi.fn();
    act(() => {
      result.current.start("k", () => ({ surface: "native", result: stale.promise }), finish);
    });
    expect(result.current.pending).toEqual({ key: "k", cancellable: false });
    await act(async () => stale.resolve("stale"));
    expect(finish).not.toHaveBeenCalled();
    expect(result.current.pending).toBeNull();

    const late = deferred();
    let lifetime!: AbortSignal;
    act(() => {
      result.current.start("k2", (controls) => {
        lifetime = controls.signal;
        return { surface: "window", result: late.promise };
      }, finish);
    });
    unmount();
    expect(lifetime.aborted).toBe(true);
    await late.resolve("connected");
    await Promise.resolve();
    expect(finish).not.toHaveBeenCalled();
  });
});
