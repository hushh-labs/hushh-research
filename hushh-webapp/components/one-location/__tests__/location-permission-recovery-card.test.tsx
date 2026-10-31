// The card that replaces a dead end.
//
// Before it, a blocked browser permission produced a toast reading "Allow
// location permission before sharing" plus an "Open Location Settings" button
// that resolves `{ opened: false }` on the web. The toast then vanished, and
// the Location screen was left saying "blocked" with nothing to act on.

import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const platform = vi.hoisted(() => ({
  isNative: vi.fn(() => false),
  getPlatform: vi.fn(() => "web"),
}));

const service = vi.hoisted(() => ({
  getPermissionState: vi.fn(),
}));

vi.mock("@/lib/capacitor/platform", () => ({
  isNative: platform.isNative,
  getPlatform: platform.getPlatform,
}));

vi.mock("@/lib/one-location/service", () => ({
  OneLocationService: service,
}));

import { LocationPermissionRecoveryCard } from "@/components/one-location/location-permission-recovery-card";

const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

function setUserAgent(value: string) {
  Object.defineProperty(navigator, "userAgent", {
    configurable: true,
    get: () => value,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  platform.isNative.mockReturnValue(false);
  platform.getPlatform.mockReturnValue("web");
  service.getPermissionState.mockResolvedValue({ state: "denied" });
  setUserAgent(CHROME_MAC);
  // Not implemented in jsdom; the Safari path (query rejects) is the default.
  Object.defineProperty(navigator, "permissions", {
    configurable: true,
    value: undefined,
  });
});

describe("when location is not blocked", () => {
  it("renders nothing at all", () => {
    render(
      <LocationPermissionRecoveryCard blocked={false} onRetry={vi.fn()} />,
    );
    // Someone whose location works must never be told it is blocked.
    expect(
      screen.queryByTestId("location-permission-recovery"),
    ).not.toBeInTheDocument();
  });
});

describe("when the browser is blocking location", () => {
  it("names the browser doing the blocking", () => {
    render(<LocationPermissionRecoveryCard blocked onRetry={vi.fn()} />);
    // "Something went wrong" leaves the person guessing. Naming Chrome is what
    // turns this into a ten-second fix.
    expect(screen.getByText(/chrome is blocking location/i)).toBeInTheDocument();
  });

  it("gives the actual click path, not just 'allow location'", () => {
    render(<LocationPermissionRecoveryCard blocked onRetry={vi.fn()} />);
    const steps = screen.getByTestId("location-permission-recovery-steps");
    expect(steps).toHaveTextContent(/left of the web address/i);
    expect(steps).toHaveTextContent(/turn location on/i);
  });

  it("promises the page will notice by itself", () => {
    render(<LocationPermissionRecoveryCard blocked onRetry={vi.fn()} />);
    expect(
      screen.getByTestId("location-permission-recovery-steps"),
    ).toHaveTextContent(/turns on by itself/i);
  });

  it("offers no Settings button on the web", () => {
    // `openLocationSettings()` is a hard-coded no-op in a browser. A button
    // that does nothing is worse than no button.
    render(
      <LocationPermissionRecoveryCard
        blocked
        onRetry={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole("button", { name: /open settings/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /check again/i }),
    ).toBeInTheDocument();
  });

  it("offers Settings inside the native app, where it genuinely opens", () => {
    platform.isNative.mockReturnValue(true);
    platform.getPlatform.mockReturnValue("ios");
    render(
      <LocationPermissionRecoveryCard
        blocked
        onRetry={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: /open settings/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/iphone settings is blocking/i)).toBeInTheDocument();
  });
});

describe("healing itself", () => {
  it("retries on its own once permission becomes granted", async () => {
    const onRetry = vi.fn();
    service.getPermissionState.mockResolvedValue({ state: "granted" });

    render(<LocationPermissionRecoveryCard blocked onRetry={onRetry} />);
    document.dispatchEvent(new Event("visibilitychange"));

    // The person fixed it in browser settings and came back. Asking them to
    // press a button as well would be one instruction too many.
    await waitFor(() => expect(onRetry).toHaveBeenCalled());
  });

  it("does not retry while permission is still refused", async () => {
    const onRetry = vi.fn();
    service.getPermissionState.mockResolvedValue({ state: "denied" });

    render(<LocationPermissionRecoveryCard blocked onRetry={onRetry} />);
    document.dispatchEvent(new Event("visibilitychange"));
    await new Promise((resolve) => setTimeout(resolve, 30));

    // Retrying into a standing denial spends a prompt on iOS and produces a
    // failure toast on every tab switch.
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("retries only once even when the signal repeats", async () => {
    const onRetry = vi.fn();
    service.getPermissionState.mockResolvedValue({ state: "granted" });

    render(<LocationPermissionRecoveryCard blocked onRetry={onRetry} />);
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));

    await waitFor(() => expect(onRetry).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 30));
    // A second capture while the first is still running doubles the GPS work
    // and, on iOS, can spend a second system prompt.
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("watches nothing while the person is not stuck", async () => {
    const onRetry = vi.fn();
    render(
      <LocationPermissionRecoveryCard blocked={false} onRetry={onRetry} />,
    );
    document.dispatchEvent(new Event("visibilitychange"));
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(service.getPermissionState).not.toHaveBeenCalled();
    expect(onRetry).not.toHaveBeenCalled();
  });
});
