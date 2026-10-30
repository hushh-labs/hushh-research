import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ARMED_ACTION_DEFAULT_DISARM_MS,
  useArmedAction,
} from "@/lib/ui/use-armed-action";

describe("useArmedAction", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("arms on the first activation without firing", () => {
    const fire = vi.fn();
    const { result } = renderHook(() => useArmedAction());

    expect(result.current.armed).toBe(false);
    expect(result.current.label("Decline")).toBe("Decline");
    expect(result.current.ariaLabel("Decline")).toBe(
      "Decline (tap again to confirm)",
    );

    act(() => result.current.activate(fire));

    expect(fire).not.toHaveBeenCalled();
    expect(result.current.armed).toBe(true);
    expect(result.current.label("Decline")).toBe("Sure?");
    expect(result.current.ariaLabel("Decline")).toBe("Confirm Decline");
  });

  it("fires on the second activation inside the window and disarms", () => {
    const fire = vi.fn();
    const { result } = renderHook(() => useArmedAction());

    act(() => result.current.activate(fire));
    act(() => vi.advanceTimersByTime(ARMED_ACTION_DEFAULT_DISARM_MS - 1));
    act(() => result.current.activate(fire));

    expect(fire).toHaveBeenCalledTimes(1);
    expect(result.current.armed).toBe(false);
    expect(result.current.label("Decline")).toBe("Decline");

    // The timer was cleared along with the armed state: nothing flips later.
    act(() => vi.advanceTimersByTime(ARMED_ACTION_DEFAULT_DISARM_MS * 2));
    expect(result.current.armed).toBe(false);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it("disarms by itself once the window passes, so a later tap only re-arms", () => {
    const fire = vi.fn();
    const { result } = renderHook(() => useArmedAction({ disarmAfterMs: 500 }));

    act(() => result.current.activate(fire));
    expect(result.current.armed).toBe(true);

    act(() => vi.advanceTimersByTime(499));
    expect(result.current.armed).toBe(true);

    act(() => vi.advanceTimersByTime(1));
    expect(result.current.armed).toBe(false);

    act(() => result.current.activate(fire));
    expect(fire).not.toHaveBeenCalled();
    expect(result.current.armed).toBe(true);
  });

  it("disarms on demand without firing", () => {
    const fire = vi.fn();
    const { result } = renderHook(() => useArmedAction());

    act(() => result.current.activate(fire));
    act(() => result.current.disarm());

    expect(result.current.armed).toBe(false);
    expect(fire).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the disarm timer on unmount", () => {
    const { result, unmount } = renderHook(() => useArmedAction());

    act(() => result.current.activate(vi.fn()));
    expect(vi.getTimerCount()).toBe(1);

    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });
});
