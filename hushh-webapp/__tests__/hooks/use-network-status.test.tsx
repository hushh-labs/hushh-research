import * as React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, render, renderHook } from "@testing-library/react";

import { useNetworkStatus } from "@/hooks/use-network-status";

function Harness({
  onStatus,
}: {
  onStatus: (status: { online: boolean; offline: boolean }) => void;
}) {
  const status = useNetworkStatus();

  React.useEffect(() => {
    onStatus(status);
  }, [status, onStatus]);

  return null;
}

describe("useNetworkStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports online status", () => {
    const callback = vi.fn();

    Object.defineProperty(window.navigator, "onLine", {
      configurable: true,
      value: true,
    });

    render(<Harness onStatus={callback} />);

    expect(callback).toHaveBeenCalledWith({
      online: true,
      offline: false,
    });
  });

  it("responds to offline events", () => {
    const callback = vi.fn();

    Object.defineProperty(window.navigator, "onLine", {
      configurable: true,
      value: true,
    });

    render(<Harness onStatus={callback} />);

    callback.mockClear();

    Object.defineProperty(window.navigator, "onLine", {
      configurable: true,
      value: false,
    });

    act(() => {
      window.dispatchEvent(new Event("offline"));
    });

    expect(callback).toHaveBeenLastCalledWith({
      online: false,
      offline: true,
    });
  });

  it("responds to online events", () => {
    const callback = vi.fn();

    Object.defineProperty(window.navigator, "onLine", {
      configurable: true,
      value: false,
    });

    render(<Harness onStatus={callback} />);

    callback.mockClear();

    Object.defineProperty(window.navigator, "onLine", {
      configurable: true,
      value: true,
    });

    act(() => {
      window.dispatchEvent(new Event("online"));
    });

    expect(callback).toHaveBeenLastCalledWith({
      online: true,
      offline: false,
    });
  });

  it("reports offline status on initial mount if navigator is offline", () => {
    const callback = vi.fn();

    Object.defineProperty(window.navigator, "onLine", {
      configurable: true,
      value: false,
    });

    render(<Harness onStatus={callback} />);

    expect(callback).toHaveBeenLastCalledWith({
      online: false,
      offline: true,
    });
  });

  it("removes window event listeners on unmount", () => {
    const addSpy = vi.spyOn(window, "addEventListener");
    const removeSpy = vi.spyOn(window, "removeEventListener");

    const { unmount } = render(<Harness onStatus={vi.fn()} />);

    expect(addSpy).toHaveBeenCalledWith("online", expect.any(Function));
    expect(addSpy).toHaveBeenCalledWith("offline", expect.any(Function));

    unmount();

    expect(removeSpy).toHaveBeenCalledWith("online", expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith("offline", expect.any(Function));
  });

  it("verifies hook status directly using renderHook", () => {
    Object.defineProperty(window.navigator, "onLine", {
      configurable: true,
      value: true,
    });

    const { result } = renderHook(() => useNetworkStatus());
    expect(result.current).toEqual({
      online: true,
      offline: false,
    });
  });
});