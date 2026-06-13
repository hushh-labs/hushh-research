import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";

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
});