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

  it("uses the iOS path when the WebView signal is stale in either direction", () => {
    const status = vi.fn();
    const host = window as Window & { __HUSHH_NETWORK_ONLINE__?: boolean };
    const previous = Object.getOwnPropertyDescriptor(navigator, "onLine");
    try {
      Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
      host.__HUSHH_NETWORK_ONLINE__ = true;
      const view = render(<Harness onStatus={status} />);
      expect(status).toHaveBeenLastCalledWith({ online: true, offline: false });
      Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
      host.__HUSHH_NETWORK_ONLINE__ = false;
      act(() => { window.dispatchEvent(new Event("offline")); });
      expect(status).toHaveBeenLastCalledWith({ online: false, offline: true });
      view.unmount();
    } finally {
      delete host.__HUSHH_NETWORK_ONLINE__;
      if (previous) Object.defineProperty(navigator, "onLine", previous);
      else Reflect.deleteProperty(navigator, "onLine");
    }
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