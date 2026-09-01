// @vitest-environment jsdom
import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isNative: vi.fn(() => false),
  addListener: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("@/lib/capacitor/platform", () => ({
  isNative: mocks.isNative,
  getPlatform: () => "web",
}));

vi.mock("@capacitor/app", () => ({
  App: { addListener: mocks.addListener },
}));

import { useSettingsReturn } from "@/lib/permissions/use-settings-return";

/**
 * Reported after an iOS build: "settings ios wali jab bhi open ho rahin ... ek
 * back tap mein app par switch nahi karwa rha."
 *
 * The half this covers is what the app does once the person is back. It used
 * to do nothing on native, because the only listeners were `visibilitychange`
 * and `focus` -- web events that a Capacitor WKWebView does not reliably fire
 * for an app-lifecycle change. So the screen that sent somebody to Settings
 * was the screen that could not notice them returning from it.
 */

function Harness(props: {
  enabled: boolean;
  readGranted: () => Promise<boolean>;
  onRestored: () => void;
  permissionName?: string;
}) {
  useSettingsReturn(props);
  return null;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isNative.mockReturnValue(false);
  mocks.addListener.mockResolvedValue({ remove: mocks.remove });
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => "visible",
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useSettingsReturn", () => {
  it("listens to the native lifecycle, not just web visibility", async () => {
    // The bug, as a test. On native this MUST subscribe to `appStateChange` --
    // it is the only signal that reliably fires when an iOS app is
    // foregrounded from Settings.
    mocks.isNative.mockReturnValue(true);
    const onRestored = vi.fn();

    render(
      <Harness
        enabled
        readGranted={async () => false}
        onRestored={onRestored}
      />,
    );

    await waitFor(() => expect(mocks.addListener).toHaveBeenCalled());
    expect(mocks.addListener.mock.calls[0][0]).toBe("appStateChange");
  });

  it("re-reads permission when the app comes back to the foreground", async () => {
    mocks.isNative.mockReturnValue(true);
    const onRestored = vi.fn();
    let granted = false;

    render(
      <Harness
        enabled
        readGranted={async () => granted}
        onRestored={onRestored}
      />,
    );

    await waitFor(() => expect(mocks.addListener).toHaveBeenCalled());
    const handler = mocks.addListener.mock.calls[0][1] as (state: {
      isActive: boolean;
    }) => void;

    // Backgrounded, and still nothing granted: no false recovery.
    handler({ isActive: false });
    await waitFor(() => expect(onRestored).not.toHaveBeenCalled());

    // They switched it on and came back.
    granted = true;
    handler({ isActive: true });
    await waitFor(() => expect(onRestored).toHaveBeenCalledTimes(1));
  });

  it("arms without firing, then fires once however many signals arrive", async () => {
    // A second call would re-enter the caller's work while the first is still
    // running -- on iOS that spends a prompt, and for a contact sync it starts
    // a second pass over the address book.
    mocks.isNative.mockReturnValue(true);
    const onRestored = vi.fn();

    render(
      <Harness enabled readGranted={async () => true} onRestored={onRestored} />,
    );

    // Nothing on mount: arming the watcher is not the same as coming back, and
    // at this point the person has not even left yet.
    await waitFor(() => expect(mocks.addListener).toHaveBeenCalled());
    expect(onRestored).not.toHaveBeenCalled();

    const handler = mocks.addListener.mock.calls[0][1] as (state: {
      isActive: boolean;
    }) => void;

    // Every signal at once -- native foreground, plus both web events. On iOS
    // they really do overlap.
    handler({ isActive: true });
    handler({ isActive: true });
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));

    await waitFor(() => expect(onRestored).toHaveBeenCalledTimes(1));
    expect(onRestored).toHaveBeenCalledTimes(1);
  });

  it("still works on the web, where there is no native lifecycle", async () => {
    mocks.isNative.mockReturnValue(false);
    const onRestored = vi.fn();
    let granted = false;

    render(
      <Harness
        enabled
        readGranted={async () => granted}
        onRestored={onRestored}
      />,
    );

    expect(mocks.addListener).not.toHaveBeenCalled();

    granted = true;
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(onRestored).toHaveBeenCalledTimes(1));
  });

  it("watches nothing until somebody is actually waiting", async () => {
    mocks.isNative.mockReturnValue(true);
    const onRestored = vi.fn();
    const readGranted = vi.fn(async () => true);

    render(
      <Harness
        enabled={false}
        readGranted={readGranted}
        onRestored={onRestored}
      />,
    );

    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(mocks.addListener).not.toHaveBeenCalled());
    expect(readGranted).not.toHaveBeenCalled();
    expect(onRestored).not.toHaveBeenCalled();
  });

  it("treats an unreadable permission as not recovered", async () => {
    // Unreadable is not a failure to recover from, and it is certainly not a
    // grant. The person can still press the button.
    mocks.isNative.mockReturnValue(true);
    const onRestored = vi.fn();

    render(
      <Harness
        enabled
        readGranted={async () => {
          throw new Error("bridge unavailable");
        }}
        onRestored={onRestored}
      />,
    );

    await waitFor(() => expect(mocks.addListener).toHaveBeenCalled());
    const handler = mocks.addListener.mock.calls[0][1] as (state: {
      isActive: boolean;
    }) => void;
    handler({ isActive: true });

    await waitFor(() => expect(onRestored).not.toHaveBeenCalled());
  });

  it("removes the native listener when it stops watching", async () => {
    mocks.isNative.mockReturnValue(true);
    const view = render(
      <Harness enabled readGranted={async () => false} onRestored={vi.fn()} />,
    );

    await waitFor(() => expect(mocks.addListener).toHaveBeenCalled());
    view.unmount();
    await waitFor(() => expect(mocks.remove).toHaveBeenCalled());
  });
});
