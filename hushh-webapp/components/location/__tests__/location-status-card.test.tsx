import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The status card must never say "Location is on" from a single switch: the
 * server's persisted `sharing_state` and the device's OS permission are two
 * facts, and the card only says "on" when both hold. Every write goes through
 * the same account-settings contract the voice tools use.
 */

const harness = vi.hoisted(() => ({
  update: vi.fn(),
  refresh: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  openAppSettings: vi.fn(),
}));

class FakeApiError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ vaultOwnerToken: "vault-token", vaultKey: "key" }),
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    userId: "me",
    user: null,
    loading: false,
    isAuthenticated: true,
  }),
}));
vi.mock("@/lib/location/account-settings", () => ({
  useLocationAccountSettings: () => ({
    status: "ready",
    settings: null,
    error: null,
    refresh: harness.refresh,
    update: harness.update,
  }),
  locationSettingsErrorCode: (error: unknown) =>
    error instanceof FakeApiError ? error.code : null,
}));
vi.mock("@/lib/morphy-ux/morphy", () => ({ morphyToast: harness.toast }));
vi.mock("@/lib/one-location/service", () => ({
  OneLocationService: { openAppSettings: harness.openAppSettings },
}));

import {
  LocationStatusCard,
  describeLocationStatus,
  type LocationStatusFacts,
} from "@/components/location/location-status-card";

const ON_AND_GRANTED: LocationStatusFacts = {
  osPermission: "granted",
  sharingState: "on",
  precision: "precise",
};

describe("LocationStatusCard", () => {
  beforeEach(() => {
    harness.update.mockReset();
    harness.update.mockResolvedValue({
      settings: { sharing_state: "off", precision: "precise" },
    });
    harness.openAppSettings.mockResolvedValue({ opened: true });
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('says "Location is on" only when the server says on AND the OS granted', () => {
    expect(describeLocationStatus(ON_AND_GRANTED).headline).toBe(
      "Location is on",
    );
    expect(
      describeLocationStatus({ ...ON_AND_GRANTED, osPermission: "denied" })
        .headline,
    ).not.toBe("Location is on");
    expect(
      describeLocationStatus({ ...ON_AND_GRANTED, osPermission: "prompt" })
        .headline,
    ).not.toBe("Location is on");
    expect(
      describeLocationStatus({ ...ON_AND_GRANTED, sharingState: "off" })
        .headline,
    ).not.toBe("Location is on");
    expect(
      describeLocationStatus({ ...ON_AND_GRANTED, sharingState: "unset" })
        .headline,
    ).not.toBe("Location is on");
  });

  it("renders device permission, app sharing and precision as three distinct rows", () => {
    render(
      <LocationStatusCard
        facts={{ ...ON_AND_GRANTED, precision: "approximate" }}
      />,
    );
    expect(screen.getByTestId("location-status-headline")).toHaveTextContent(
      "Location is on",
    );
    expect(screen.getByTestId("location-status-device-row")).toHaveAttribute(
      "data-value",
      "Allowed while using",
    );
    expect(screen.getByTestId("location-status-sharing-row")).toHaveAttribute(
      "data-value",
      "On",
    );
    expect(screen.getByTestId("location-status-precision-row")).toHaveAttribute(
      "data-value",
      "Approximate (~1 km)",
    );
  });

  it("does not claim on when sharing is on but the device denied permission", () => {
    render(
      <LocationStatusCard
        facts={{ ...ON_AND_GRANTED, osPermission: "denied" }}
      />,
    );
    expect(
      screen.getByTestId("location-status-headline"),
    ).not.toHaveTextContent("Location is on");
    expect(screen.getByTestId("location-status-device-row")).toHaveAttribute(
      "data-value",
      "Denied",
    );
    expect(screen.getByTestId("location-status-sharing-row")).toHaveAttribute(
      "data-value",
      "On",
    );
    expect(
      screen.getByRole("button", { name: "Open Settings" }),
    ).toBeInTheDocument();
  });

  it("shows Not set up with a setup link instead of Turn on when sharing_state is unset", () => {
    render(
      <LocationStatusCard
        facts={{ ...ON_AND_GRANTED, sharingState: "unset" }}
      />,
    );
    expect(screen.getByTestId("location-status-sharing-row")).toHaveAttribute(
      "data-value",
      "Not set up",
    );
    expect(screen.getByTestId("location-status-setup-link")).toHaveAttribute(
      "href",
      "/one/setup/location",
    );
    expect(screen.queryByTestId("location-status-turn-on")).toBeNull();
  });

  it("turns off only after the confirm dialog, through the account-settings PATCH", async () => {
    render(<LocationStatusCard facts={ON_AND_GRANTED} />);
    fireEvent.click(screen.getByTestId("location-status-turn-off"));
    expect(harness.update).not.toHaveBeenCalled();
    expect(
      await screen.findByTestId("location-status-turn-off-dialog"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("location-status-turn-off-confirm"));
    await waitFor(() =>
      expect(harness.update).toHaveBeenCalledWith({
        sharingState: "off",
        includeSos: false,
      }),
    );
  });

  it("explains an active Save My Soul and only includes SOS after a second explicit choice", async () => {
    harness.update.mockRejectedValueOnce(
      new FakeApiError("LOCATION_SOS_ACTIVE"),
    );
    render(<LocationStatusCard facts={ON_AND_GRANTED} />);
    fireEvent.click(screen.getByTestId("location-status-turn-off"));
    fireEvent.click(
      await screen.findByTestId("location-status-turn-off-confirm"),
    );

    await waitFor(() => expect(harness.update).toHaveBeenCalledTimes(1));
    expect(
      await screen.findByText("Save My Soul is active"),
    ).toBeInTheDocument();
    expect(harness.toast.error).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("location-status-turn-off-confirm"));
    await waitFor(() =>
      expect(harness.update).toHaveBeenLastCalledWith({
        sharingState: "off",
        includeSos: true,
      }),
    );
  });

  it("turns on through the PATCH and links to setup when consent is required", async () => {
    harness.update.mockRejectedValueOnce(
      new FakeApiError("LOCATION_SHARING_CONSENT_REQUIRED"),
    );
    render(
      <LocationStatusCard facts={{ ...ON_AND_GRANTED, sharingState: "off" }} />,
    );
    fireEvent.click(screen.getByTestId("location-status-turn-on"));
    await waitFor(() =>
      expect(harness.update).toHaveBeenCalledWith({ sharingState: "on" }),
    );
    const notice = await screen.findByTestId(
      "location-status-consent-required",
    );
    expect(notice).toHaveTextContent("Accept the Location consent first");
    expect(screen.getByRole("link", { name: "Open setup" })).toHaveAttribute(
      "href",
      "/one/setup/location",
    );
    expect(harness.toast.success).not.toHaveBeenCalled();
  });

  it("toggles precision through the same PATCH", async () => {
    render(<LocationStatusCard facts={ON_AND_GRANTED} />);
    fireEvent.click(screen.getByTestId("location-status-precision-toggle"));
    await waitFor(() =>
      expect(harness.update).toHaveBeenCalledWith({ precision: "approximate" }),
    );
  });
});
