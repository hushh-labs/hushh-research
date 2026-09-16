import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { VoiceToolEffectHandlers } from "@/lib/one-voice/session-types";

/**
 * The Now tab: a status card fed by the composed sharing view, quick actions
 * that navigate by URL, and summaries read from the shared state resource.
 * Setup-required means a "Set up Location" card, not a status card claiming
 * anything. A successful voice tool result refetches; a rejected one does not.
 */

const harness = vi.hoisted(() => ({
  sharing: {
    os: "granted" as string,
    sharingState: "on" as string,
    precision: "precise" as string,
    resolving: false,
    status: "ready" as string,
    refresh: vi.fn(async () => undefined),
  },
  state: null as Record<string, unknown> | null,
  getState: vi.fn(),
  push: vi.fn(),
  replace: vi.fn(),
  publish: vi.fn(),
  effects: [] as VoiceToolEffectHandlers[],
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  invalidate: vi.fn(),
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
  useRouter: () => ({ push: harness.push, replace: harness.replace }),
  usePathname: () => "/one/location",
}));
vi.mock("@/lib/location/sharing-state", () => ({
  useLocationSharingState: () => ({
    ...harness.sharing,
    osPrecise: null,
    appSharing: harness.sharing.sharingState === "on",
    paused: false,
    effective: "sharing",
    activeShareCount: 0,
  }),
}));
vi.mock("@/lib/location/account-settings", () => ({
  useLocationAccountSettings: () => ({
    status: "ready",
    settings: null,
    error: null,
    refresh: vi.fn(),
    update: vi.fn(),
  }),
  locationSettingsErrorCode: () => null,
}));
vi.mock("@/lib/one-location/service", () => ({
  OneLocationService: {
    getState: harness.getState,
    revokeGrant: vi.fn(),
    approveRequest: vi.fn(),
    denyRequest: vi.fn(),
    openAppSettings: vi.fn(),
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
    invalidate: harness.invalidate,
    mergeOwnerGrant: vi.fn(),
    mergeRequestStatus: vi.fn(),
    write: vi.fn(),
  },
}));
vi.mock("@/lib/voice/voice-surface-metadata", () => ({
  usePublishVoiceSurfaceMetadata: (metadata: unknown) =>
    harness.publish(metadata),
}));
vi.mock("@/lib/voice/location-voice-actions", () => ({
  deriveLocationVoiceActions: () => [],
}));
vi.mock("@/lib/one-voice/session-store", async () => {
  const { useRef } = await import("react");
  return {
    // One registration per hook instance, like the real store; the latest
    // handlers are read through the same object so the test can fire them.
    useVoiceToolEffects: (handlers: VoiceToolEffectHandlers) => {
      const ref = useRef<VoiceToolEffectHandlers | null>(null);
      if (!ref.current) {
        ref.current = {};
        harness.effects.push(ref.current);
      }
      Object.assign(ref.current, handlers);
    },
  };
});
vi.mock("@/lib/morphy-ux/morphy", () => ({ morphyToast: harness.toast }));

import {
  LocationHome,
  reconcileVoiceResult,
} from "@/components/location/location-home";

function serverState(overrides: Record<string, unknown> = {}) {
  return {
    recipients: [],
    ownerGrants: [
      {
        id: "g1",
        ownerUserId: "me",
        recipientUserId: "u2",
        recipientDisplayName: "Priya Sharma",
        recipientKeyId: "k2",
        status: "active",
        consentScope: "location",
        capabilityScopes: [],
        durationMode: "timed",
        durationHours: 1,
        expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      },
    ],
    receivedGrants: [],
    requests: [
      {
        id: "r1",
        ownerUserId: "me",
        requesterUserId: "u3",
        requesterDisplayName: "Arjun Mehta",
        status: "pending",
      },
    ],
    referrals: [],
    publicInvites: [],
    publicInviteSubmissions: [],
    capabilityScopes: [],
    ...overrides,
  };
}

describe("LocationHome", () => {
  beforeEach(() => {
    harness.state = null;
    harness.effects.length = 0;
    harness.sharing.sharingState = "on";
    harness.sharing.os = "granted";
    harness.sharing.resolving = false;
    harness.getState.mockReset();
    harness.getState.mockResolvedValue(serverState());
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders the status card and summaries from server state", async () => {
    render(<LocationHome />);
    expect(screen.getByTestId("location-status-card")).toBeInTheDocument();
    expect(screen.getByTestId("location-status-headline")).toHaveTextContent(
      "Location is on",
    );
    await waitFor(() => expect(harness.getState).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("1 person can see you")).toBeInTheDocument();
    expect(
      screen.getByText("1 request is waiting for you"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("No one is sharing with you right now"),
    ).toBeInTheDocument();
    // The preview shows the server's name for the recipient, never an id.
    expect(screen.getByText("Priya Sharma")).toBeInTheDocument();
    expect(screen.queryByText("u2")).toBeNull();
  });

  it("publishes the one_location screen id", () => {
    render(<LocationHome />);
    const metadata = harness.publish.mock.calls.at(-1)?.[0] as {
      screenId: string;
    };
    expect(metadata.screenId).toBe("one_location");
  });

  it("shows a Set up Location card instead of a status card when sharing_state is unset", () => {
    harness.sharing.sharingState = "unset";
    render(<LocationHome />);
    const card = screen.getByTestId("location-home-setup-card");
    expect(card).toHaveTextContent("Set up Location");
    expect(
      screen.getByRole("link", { name: "Set up Location" }),
    ).toHaveAttribute("href", "/one/setup/location");
    expect(screen.queryByTestId("location-status-card")).toBeNull();
    expect(screen.queryByText("Location is on")).toBeNull();
  });

  it("navigates quick actions by URL", () => {
    render(<LocationHome />);
    fireEvent.click(
      screen.getByRole("button", { name: "Share Your location" }),
    );
    expect(harness.push).toHaveBeenLastCalledWith(
      "/one/location?action=share",
      { scroll: false },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Save My Soul Emergency" }),
    );
    expect(harness.push).toHaveBeenLastCalledWith("/one/location?action=sos", {
      scroll: false,
    });
    fireEvent.click(screen.getByRole("button", { name: /^Settings/ }));
    expect(harness.push).toHaveBeenLastCalledWith(
      "/one/location?action=settings",
      {
        scroll: false,
      },
    );
    fireEvent.click(screen.getByRole("button", { name: /^Needs review/ }));
    expect(harness.push).toHaveBeenLastCalledWith(
      "/one/location?action=needs-review",
      {
        scroll: false,
      },
    );
  });

  it("refetches state after a successful voice tool result and not after a rejected one", async () => {
    render(<LocationHome />);
    await waitFor(() => expect(harness.getState).toHaveBeenCalledTimes(1));
    const calls = harness.getState.mock.calls.length;

    act(() => {
      for (const handlers of harness.effects) {
        handlers.onToolResult?.("share_with", {
          status: "rejected",
          ui_refresh: ["location_active_shares"],
        });
      }
    });
    expect(harness.getState).toHaveBeenCalledTimes(calls);
    expect(harness.invalidate).not.toHaveBeenCalled();

    act(() => {
      for (const handlers of harness.effects) {
        handlers.onToolResult?.("stop_share", {
          status: "stopped",
          ui_refresh: ["location_active_shares", "location_shared_with_me"],
        });
      }
    });
    await waitFor(() =>
      expect(harness.getState).toHaveBeenCalledTimes(calls + 1),
    );
    expect(harness.invalidate).toHaveBeenCalledWith("me");
  });

  it("wakes the settings handler for posture tools and not for people tools", () => {
    const onLocationState = vi.fn();
    const onSettings = vi.fn();
    reconcileVoiceResult(
      "turn_sharing_off",
      {
        status: "off",
        ui_refresh: ["location_state", "location_settings", "location_map"],
      },
      { onLocationState, onSettings },
    );
    expect(onSettings).toHaveBeenCalledTimes(1);
    expect(onLocationState).not.toHaveBeenCalled();

    reconcileVoiceResult(
      "request_location",
      { status: "pending", ui_refresh: ["location_people"] },
      { onLocationState, onSettings },
    );
    // `pending` is not a success status: nothing refetches.
    expect(onLocationState).not.toHaveBeenCalled();

    reconcileVoiceResult(
      "respond_request",
      {
        status: "approved",
        ui_refresh: ["location_needs_review", "location_active_shares"],
      },
      { onLocationState, onSettings },
    );
    expect(onLocationState).toHaveBeenCalledTimes(1);
    expect(onSettings).toHaveBeenCalledTimes(1);
  });
});
