// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  syncPermission: vi.fn(),
  ensure: vi.fn(),
  request: vi.fn(),
}));

vi.mock("@/lib/one-location/location-bus", () => ({
  LocationBus: {
    syncPermission: mocks.syncPermission,
    ensure: mocks.ensure,
    request: mocks.request,
  },
}));

import { LocationPermissionPrimerGate } from "@/components/onboarding/setup/location-permission-primer";

const SNAPSHOT = {
  latitude: 1,
  longitude: 2,
  accuracyM: 10,
  capturedAt: new Date().toISOString(),
};

function renderGate() {
  return render(
    <LocationPermissionPrimerGate>
      <div data-testid="capability-body">Location setup</div>
    </LocationPermissionPrimerGate>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.syncPermission.mockResolvedValue("prompt");
  mocks.ensure.mockResolvedValue(SNAPSHOT);
  mocks.request.mockResolvedValue(SNAPSHOT);
});

describe("LocationPermissionPrimerGate", () => {
  it("never fires the OS prompt on mount", async () => {
    renderGate();

    await screen.findByTestId("location-permission-primer");
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("asks the device only when the user taps Allow", async () => {
    renderGate();

    fireEvent.click(await screen.findByTestId("location-permission-primer-allow"));

    await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId("capability-body")).toBeTruthy();
  });

  it("skips the screen when location was already granted, and seeds the bus", async () => {
    mocks.syncPermission.mockResolvedValue("granted");

    renderGate();

    expect(await screen.findByTestId("capability-body")).toBeTruthy();
    expect(screen.queryByTestId("location-permission-primer")).toBeNull();
    expect(mocks.ensure).toHaveBeenCalledTimes(1);
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("skips a screen it cannot act on when the OS already refused", async () => {
    mocks.syncPermission.mockResolvedValue("denied");

    renderGate();

    expect(await screen.findByTestId("capability-body")).toBeTruthy();
    expect(screen.queryByTestId("location-permission-primer")).toBeNull();
  });

  it("skips on a device with no geolocation at all", async () => {
    mocks.syncPermission.mockResolvedValue("unavailable");

    renderGate();

    expect(await screen.findByTestId("capability-body")).toBeTruthy();
  });

  it("never blocks setup on a refusal", async () => {
    mocks.request.mockResolvedValue(null);

    renderGate();
    fireEvent.click(await screen.findByTestId("location-permission-primer-allow"));

    expect(
      await screen.findByText("Location is off. Turn it on in Settings anytime."),
    ).toBeTruthy();

    fireEvent.click(screen.getByTestId("location-permission-primer-skip"));
    expect(await screen.findByTestId("capability-body")).toBeTruthy();
  });

  it("lets the user move on without deciding", async () => {
    renderGate();

    fireEvent.click(await screen.findByTestId("location-permission-primer-skip"));

    expect(await screen.findByTestId("capability-body")).toBeTruthy();
    expect(mocks.request).not.toHaveBeenCalled();
  });
});
