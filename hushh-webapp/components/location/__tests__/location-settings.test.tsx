import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Settings: every control calls the same endpoint its voice tool calls. The
 * header follows the Location contract (eyebrow "Location", title equal to
 * the "Settings" crumb, no in-content back control).
 */

const harness = vi.hoisted(() => ({
  state: null as Record<string, unknown> | null,
  settings: { sharing_state: "on", precision: "precise" } as Record<
    string,
    unknown
  > | null,
  update: vi.fn(),
  refresh: vi.fn(),
  getState: vi.fn(),
  getMapPreferences: vi.fn(),
  updateMapPreferences: vi.fn(),
  updateAutoApprovePreference: vi.fn(),
  updateNearbyCheckInPreferences: vi.fn(),
  push: vi.fn(),
  publish: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    userId: "me",
    user: null,
    loading: false,
    isAuthenticated: true,
  }),
}));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ vaultOwnerToken: "vault-token", vaultKey: "key" }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: harness.push, replace: vi.fn() }),
  usePathname: () => "/one/location",
}));
vi.mock("@/lib/location/account-settings", () => ({
  useLocationAccountSettings: () => ({
    status: "ready",
    settings: harness.settings,
    error: null,
    refresh: harness.refresh,
    update: harness.update,
  }),
  locationSettingsErrorCode: () => null,
}));
vi.mock("@/lib/one-location/service", () => ({
  OneLocationService: {
    getState: harness.getState,
    getMapPreferences: harness.getMapPreferences,
    updateMapPreferences: harness.updateMapPreferences,
    updateAutoApprovePreference: harness.updateAutoApprovePreference,
    updateNearbyCheckInPreferences: harness.updateNearbyCheckInPreferences,
  },
}));
vi.mock("@/lib/one-location/one-location-state-resource", () => ({
  OneLocationStateResource: {
    readPresentation: () => harness.state,
    load: async (_userId: string, loader: () => Promise<unknown>) => {
      const next = await loader();
      harness.state = next as Record<string, unknown>;
      return next;
    },
    invalidate: vi.fn(),
    mergeOwnerGrant: vi.fn(),
    mergeRequestStatus: vi.fn(),
    write: vi.fn(),
  },
}));
vi.mock("@/lib/voice/voice-surface-metadata", () => ({
  usePublishVoiceSurfaceMetadata: (metadata: unknown) =>
    harness.publish(metadata),
}));
vi.mock("@/lib/one-voice/session-store", () => ({
  useVoiceToolEffects: () => undefined,
}));
vi.mock("@/lib/morphy-ux/morphy", () => ({ morphyToast: harness.toast }));

import { LocationSettings } from "@/components/location/settings/location-settings";

const STATE = {
  recipients: [],
  ownerGrants: [],
  receivedGrants: [],
  requests: [],
  referrals: [],
  publicInvites: [],
  publicInviteSubmissions: [],
  capabilityScopes: [],
  circles: [
    {
      id: "c1",
      name: "Family",
      kind: "family",
      role: "owner",
      memberCount: 3,
      memberLimit: null,
    },
  ],
  autoApprovePreference: {
    enabled: false,
    scope: null,
    enabledAt: null,
    ruleVersion: 1,
  },
  nearbyCheckInPreferences: { visible: false, allowConnectionRequests: true },
  smsContactUserIds: ["u2", "u3"],
};

describe("LocationSettings", () => {
  beforeEach(() => {
    harness.state = null;
    harness.settings = { sharing_state: "on", precision: "precise" };
    harness.getState.mockResolvedValue(STATE);
    harness.getMapPreferences.mockResolvedValue({
      presenceMode: "foreground_private",
    });
    harness.updateMapPreferences.mockResolvedValue({ presenceMode: "ghost" });
    harness.updateAutoApprovePreference.mockResolvedValue({
      enabled: true,
      scope: { kind: "all_contacts" },
      enabledAt: null,
      ruleVersion: 2,
    });
    harness.updateNearbyCheckInPreferences.mockResolvedValue({
      visible: true,
      allowConnectionRequests: true,
    });
    harness.update.mockResolvedValue({
      settings: { sharing_state: "on", precision: "approximate" },
    });
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("titles the screen Settings under the Location eyebrow and publishes one_location_settings", async () => {
    render(<LocationSettings />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Settings",
    );
    expect(screen.getByText("Location")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    const metadata = harness.publish.mock.calls.at(-1)?.[0] as {
      screenId: string;
    };
    expect(metadata.screenId).toBe("one_location_settings");
    await screen.findByText("2");
  });

  it("changes precision through the account-settings PATCH", async () => {
    render(<LocationSettings />);
    fireEvent.click(screen.getByRole("tab", { name: "Approximate" }));
    await waitFor(() =>
      expect(harness.update).toHaveBeenCalledWith({ precision: "approximate" }),
    );
  });

  it("hides on the map through map-preferences (the hide_on_map endpoint)", async () => {
    render(<LocationSettings />);
    const ghost = await screen.findByTestId("location-settings-ghost-switch");
    await waitFor(() => expect(ghost).toBeEnabled());
    fireEvent.click(ghost);
    await waitFor(() =>
      expect(harness.updateMapPreferences).toHaveBeenCalledWith({
        vaultOwnerToken: "vault-token",
        presenceMode: "ghost",
      }),
    );
  });

  it("turns auto-approve on for all contacts through auto-approve-preference", async () => {
    harness.getState
      .mockReset()
      .mockResolvedValueOnce(STATE)
      .mockRejectedValueOnce(new Error("reconcile unavailable"));
    render(<LocationSettings />);
    const toggle = await screen.findByTestId(
      "location-settings-auto-approve-switch",
    );
    await waitFor(() => expect(toggle).toBeEnabled());
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(harness.updateAutoApprovePreference).toHaveBeenCalledWith({
        vaultOwnerToken: "vault-token",
        enabled: true,
        scope: { kind: "all_contacts" },
      }),
    );
    await waitFor(() =>
      expect(
        screen.getByTestId("location-settings-auto-approve-switch"),
      ).toHaveAttribute("aria-checked", "true"),
    );
  });

  it("saves nearby defaults through nearby-check-in-preferences", async () => {
    harness.getState
      .mockReset()
      .mockResolvedValueOnce(STATE)
      .mockRejectedValueOnce(new Error("reconcile unavailable"));
    render(<LocationSettings />);
    const visible = await screen.findByTestId(
      "location-settings-nearby-visible-switch",
    );
    await waitFor(() => expect(visible).toBeEnabled());
    fireEvent.click(visible);
    await waitFor(() =>
      expect(harness.updateNearbyCheckInPreferences).toHaveBeenCalledWith({
        vaultOwnerToken: "vault-token",
        visible: true,
        allowConnectionRequests: true,
      }),
    );
    await waitFor(() => expect(visible).toHaveAttribute("aria-checked", "true"));
  });

  it("opens the Turn off confirmation before turning sharing off", async () => {
    render(<LocationSettings />);
    fireEvent.click(screen.getByTestId("location-settings-sharing-switch"));
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
});
