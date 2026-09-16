import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sharing: {
    value: {
      os: "granted" as const,
      osPermission: "granted" as const,
      osPrecise: true,
      appSharing: true,
      sharingState: "on" as const,
      precision: "precise" as const,
      paused: false,
      effective: "sharing" as const,
      activeShareCount: 1,
      resolving: false,
      status: "ready" as const,
      refresh: vi.fn(async () => undefined),
    },
  },
  state: {
    value: {
      recipients: [
        {
          userId: "alice",
          displayName: "Alice",
          phoneVerified: true,
          keyId: "k-alice",
          publicKeyJwk: { kty: "EC" },
          keyAlgorithm: "ECDH-P256-AES256-GCM",
          canReceiveLocation: true,
        },
      ],
      ownerGrants: [
        {
          id: "g1",
          ownerUserId: "u1",
          recipientUserId: "alice",
          recipientKeyId: "k-alice",
          status: "active",
          consentScope: "location.live",
          capabilityScopes: [],
          durationHours: 1,
          expiresAt: null,
        },
      ],
      receivedGrants: [],
      requests: [],
      referrals: [],
      publicInvites: [],
      publicInviteSubmissions: [],
      capabilityScopes: [],
    } as unknown,
  },
  settings: {
    update: vi.fn(async () => ({ settings: {} })),
    settings: { sharing_state: "on", precision: "precise" },
  },
  service: {
    watchCurrentPosition: vi.fn(),
    clearLocationWatch: vi.fn(async () => undefined),
    stopBackgroundShare: vi.fn(async () => undefined),
    requestLocationPermission: vi.fn(),
    captureCurrentPosition: vi.fn(),
    storeEnvelope: vi.fn(),
    getState: vi.fn(),
    openAppSettings: vi.fn(async () => ({
      opened: true,
      sourcePlatform: "ios",
    })),
  },
  getSetupProgress: vi.fn(),
  toast: { warning: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false, getPlatform: () => "web" },
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ userId: "u1" }) }));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ vaultOwnerToken: "vot", vaultKey: "vk" }),
}));
vi.mock("@/lib/services/api-service", () => ({
  ApiService: { getAuthHeaders: () => ({}) },
  getApiBaseUrl: () => "http://localhost:8000",
}));
vi.mock("@/lib/location/sharing-state", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/location/sharing-state")>();
  return {
    ...actual,
    useLocationSharingState: () => mocks.sharing.value,
    useOneLocationStateSnapshot: () => mocks.state.value,
  };
});
vi.mock("@/lib/location/account-settings", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/location/account-settings")>();
  return {
    ...actual,
    useLocationAccountSettings: () => ({
      status: "ready",
      error: null,
      settings: mocks.settings.settings,
      refresh: vi.fn(async () => null),
      update: mocks.settings.update,
    }),
  };
});
vi.mock("@/lib/location/setup-progress", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/location/setup-progress")>();
  return { ...actual, getSetupProgress: mocks.getSetupProgress };
});
vi.mock("@/lib/one-location/service", () => ({
  OneLocationService: mocks.service,
}));
vi.mock("@/lib/one-location/encryption", () => ({
  encryptLocationForRecipient: vi.fn(
    async (params: {
      recipientKeyId: string;
      point: { capturedAt: string; sourcePlatform: string };
    }) => ({
      algorithm: "ECDH-P256-AES256-GCM",
      recipientKeyId: params.recipientKeyId,
      ciphertext: "ct",
      iv: "iv",
      senderEphemeralPublicKeyJwk: { kty: "EC" },
      capturedAt: params.point.capturedAt,
      sourcePlatform: params.point.sourcePlatform,
      metadata: { payload: "coordinate_envelope", plaintext: false },
    }),
  ),
}));
vi.mock("@/lib/one-location/key-bootstrap", () => ({
  bootstrapCurrentUserLocationRecipientKey: vi.fn(async () => ({
    keyId: "k-me",
  })),
}));
vi.mock("@/lib/one-location/location-bus", () => ({
  LocationBus: {
    syncPermission: vi.fn(async () => "granted"),
    invalidate: vi.fn(),
    subscribe: () => () => undefined,
    getState: () => ({ permission: "granted" }),
  },
}));
vi.mock("@/lib/one-location/background-share-runtime", () => ({
  syncBackgroundShare: vi.fn(async () => undefined),
}));
vi.mock("@/lib/morphy-ux/morphy", () => ({ morphyToast: mocks.toast }));

import { LocationPublisherBridge } from "@/components/location/location-publisher-bridge";
import { LocationAccountSettingsResource } from "@/lib/location/account-settings";
import { useVoiceSessionStore } from "@/lib/one-voice/session-store";

type SharingValue = typeof mocks.sharing.value;

function setSharing(patch: Partial<SharingValue>) {
  mocks.sharing.value = { ...mocks.sharing.value, ...patch };
}

beforeEach(() => {
  vi.clearAllMocks();
  useVoiceSessionStore.getState().reset();
  useVoiceSessionStore.getState().effects.clear();
  LocationAccountSettingsResource.__resetForTests();
  mocks.service.watchCurrentPosition.mockResolvedValue("watch-1");
  setSharing({
    appSharing: true,
    sharingState: "on",
    effective: "sharing",
    os: "granted",
  });
});

afterEach(() => {
  useVoiceSessionStore.getState().effects.clear();
});

describe("LocationPublisherBridge", () => {
  it("starts the watch while sharing and stops it the moment app sharing turns off", async () => {
    const { rerender } = render(<LocationPublisherBridge />);
    await waitFor(() =>
      expect(mocks.service.watchCurrentPosition).toHaveBeenCalledTimes(1),
    );
    expect(mocks.service.clearLocationWatch).not.toHaveBeenCalled();

    // The server said off (turn_sharing_off result / settings resource).
    setSharing({ appSharing: false, sharingState: "off", effective: "off" });
    rerender(<LocationPublisherBridge />);

    await waitFor(() =>
      expect(mocks.service.clearLocationWatch).toHaveBeenCalledWith("watch-1"),
    );
    expect(mocks.service.stopBackgroundShare).toHaveBeenCalled();
    // Nothing restarts while off.
    expect(mocks.service.watchCurrentPosition).toHaveBeenCalledTimes(1);
  });

  it("does not watch when the OS blocks sharing even though the app says on", async () => {
    setSharing({
      os: "denied",
      osPermission: "denied",
      effective: "blocked_by_os",
    });
    render(<LocationPublisherBridge />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.service.watchCurrentPosition).not.toHaveBeenCalled();
  });

  it("publishes a coarsened, tagged envelope for each fix the watch delivers", async () => {
    setSharing({ precision: "approximate" });
    mocks.service.storeEnvelope.mockResolvedValue({
      envelope: {},
      recipientAlerted: null,
    });
    render(<LocationPublisherBridge />);
    await waitFor(() =>
      expect(mocks.service.watchCurrentPosition).toHaveBeenCalledTimes(1),
    );
    const onPoint = mocks.service.watchCurrentPosition.mock.calls[0]![0] as (
      point: unknown,
    ) => void;
    await act(async () => {
      onPoint({
        latitude: 37.774929,
        longitude: -122.419416,
        accuracyM: 5,
        capturedAt: new Date().toISOString(),
        sourcePlatform: "web",
      });
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(mocks.service.storeEnvelope).toHaveBeenCalledTimes(1),
    );
    const stored = mocks.service.storeEnvelope.mock.calls[0]![0] as {
      grantId: string;
      vaultOwnerToken: string;
      envelope: {
        metadata?: Record<string, unknown>;
        publicationContext?: string;
      };
    };
    expect(stored.grantId).toBe("g1");
    expect(stored.vaultOwnerToken).toBe("vot");
    expect(stored.envelope.metadata?.precision).toBe("approximate");
    expect(stored.envelope.publicationContext).toBe("foreground_map_visible");
  });

  it("refuses request_os_permission without server-side consent and never prompts", async () => {
    mocks.getSetupProgress.mockResolvedValue({
      step: "intro",
      next_step: "consent",
      started: true,
      completed: false,
      consent_version: null,
      consent_accepted_at: null,
      os_permission_state: "unknown",
      precision: null,
      recipient_key_registered_at: null,
      started_at: "x",
      completed_at: null,
      steps: [],
    });
    render(<LocationPublisherBridge />);
    await waitFor(() =>
      expect(useVoiceSessionStore.getState().effects.size).toBeGreaterThan(0),
    );

    const settle = vi.fn();
    await act(async () => {
      useVoiceSessionStore
        .getState()
        .emitDirective(
          "d1",
          "request_os_permission",
          { permission: "location", requires_consent_receipt: true },
          settle,
        );
    });
    await waitFor(() => expect(settle).toHaveBeenCalledWith("failed"));
    expect(mocks.service.requestLocationPermission).not.toHaveBeenCalled();
    expect(mocks.settings.update).not.toHaveBeenCalled();
    expect(useVoiceSessionStore.getState().state.error?.code).toBe(
      "consent_required",
    );
  });

  it("prompts after consent, reports the OS answer to account settings, and settles opened", async () => {
    mocks.getSetupProgress.mockResolvedValue({
      step: "consent",
      next_step: "os_permission",
      started: true,
      completed: false,
      consent_version: "one-location-sharing-v1",
      consent_accepted_at: "2026-09-15T09:00:00Z",
      os_permission_state: "unknown",
      precision: null,
      recipient_key_registered_at: null,
      started_at: "x",
      completed_at: null,
      steps: [],
    });
    mocks.service.requestLocationPermission.mockResolvedValue({
      state: "granted",
      precise: true,
      background: "foreground-only",
    });
    mocks.settings.update.mockResolvedValue({
      settings: {
        sharing_state: "on",
        precision: "precise",
        os_permission_reported: "granted",
      },
    });
    render(<LocationPublisherBridge />);
    await waitFor(() =>
      expect(useVoiceSessionStore.getState().effects.size).toBeGreaterThan(0),
    );

    const settle = vi.fn();
    await act(async () => {
      useVoiceSessionStore
        .getState()
        .emitDirective(
          "d2",
          "request_os_permission",
          { permission: "location", requires_consent_receipt: true },
          settle,
        );
    });
    await waitFor(() => expect(settle).toHaveBeenCalledWith("opened"));
    expect(mocks.service.requestLocationPermission).toHaveBeenCalledTimes(1);
    expect(mocks.settings.update).toHaveBeenCalledWith({
      osPermissionReported: "granted",
    });
    expect(mocks.toast.warning).not.toHaveBeenCalled();
  });

  it("shows the recovery guide when the prompt is denied", async () => {
    mocks.getSetupProgress.mockResolvedValue({
      step: "consent",
      started: true,
      completed: false,
      consent_accepted_at: "2026-09-15T09:00:00Z",
      steps: [],
    });
    mocks.service.requestLocationPermission.mockResolvedValue({
      state: "denied",
      precise: null,
      background: "unavailable",
    });
    render(<LocationPublisherBridge />);
    await waitFor(() =>
      expect(useVoiceSessionStore.getState().effects.size).toBeGreaterThan(0),
    );
    const settle = vi.fn();
    await act(async () => {
      useVoiceSessionStore
        .getState()
        .emitDirective("d3", "request_os_permission", {}, settle);
    });
    await waitFor(() => expect(settle).toHaveBeenCalledWith("opened"));
    expect(mocks.settings.update).toHaveBeenCalledWith({
      osPermissionReported: "denied",
    });
    expect(mocks.toast.warning).toHaveBeenCalledTimes(1);
    // On the web no in-app button can open the browser's site settings.
    expect(mocks.service.openAppSettings).not.toHaveBeenCalled();
  });

  it("runs publish_location_envelopes with a fresh fix and reports only what was stored", async () => {
    mocks.service.captureCurrentPosition.mockResolvedValue({
      latitude: 37.774929,
      longitude: -122.419416,
      accuracyM: 5,
      capturedAt: new Date().toISOString(),
      sourcePlatform: "web",
    });
    mocks.service.getState.mockResolvedValue(mocks.state.value);
    mocks.service.storeEnvelope.mockImplementation(
      async (params: { grantId: string }) => {
        if (params.grantId === "g1")
          return { envelope: {}, recipientAlerted: null };
        throw new Error("boom");
      },
    );
    render(<LocationPublisherBridge />);
    await waitFor(() =>
      expect(useVoiceSessionStore.getState().effects.size).toBeGreaterThan(0),
    );

    const report = vi.fn();
    await act(async () => {
      useVoiceSessionStore.getState().emitClientStep(
        {
          stepId: "s1",
          kind: "publish_location_envelopes",
          payload: { grant_ids: ["g1", "g-missing"], purpose: "share" },
          timeoutS: 30,
        },
        report,
      );
    });
    await waitFor(() => expect(report).toHaveBeenCalledTimes(1));
    expect(mocks.service.captureCurrentPosition).toHaveBeenCalledWith({
      maxAgeMs: 0,
    });
    const [status, payload] = report.mock.calls[0]! as [
      string,
      Record<string, unknown>,
    ];
    expect(status).toBe("ok");
    expect(payload.published).toEqual(["g1"]);
    expect(payload.precision).toBe("precise");
    expect(typeof payload.captured_at).toBe("string");
    expect(payload.failures).toEqual([
      {
        grant_id: "g-missing",
        code: "store_failed",
        reason: "grant_not_found",
      },
    ]);
  });

  it("reports failed when no fix can be taken, naming a denial", async () => {
    const denied = Object.assign(new Error("User denied Geolocation"), {
      code: 1,
    });
    mocks.service.captureCurrentPosition.mockRejectedValue(denied);
    render(<LocationPublisherBridge />);
    await waitFor(() =>
      expect(useVoiceSessionStore.getState().effects.size).toBeGreaterThan(0),
    );
    const report = vi.fn();
    await act(async () => {
      useVoiceSessionStore
        .getState()
        .emitClientStep(
          {
            stepId: "s2",
            kind: "publish_location_envelopes",
            payload: { grant_ids: ["g1"], sos: true },
            timeoutS: 30,
          },
          report,
        );
    });
    await waitFor(() => expect(report).toHaveBeenCalledTimes(1));
    const [status, payload] = report.mock.calls[0]! as [
      string,
      Record<string, unknown>,
    ];
    expect(status).toBe("failed");
    expect(payload.code).toBe("permission_denied");
    expect(payload.precision).toBe("precise");
    expect(mocks.service.storeEnvelope).not.toHaveBeenCalled();
  });

  it("flips the settings resource off on a turn_sharing_off result and stops native sharing", async () => {
    LocationAccountSettingsResource.write("u1", {
      sharing_state: "on",
      sharing_enabled: true,
      precision: "precise",
      sharing_consent_version: null,
      sharing_consent_accepted_at: null,
      sharing_enabled_at: null,
      sharing_disabled_at: null,
      os_permission_reported: "granted",
      os_permission_reported_at: null,
      sharingState: "on",
      sharingEnabled: true,
      sharingConsentVersion: null,
      sharingConsentAcceptedAt: null,
      osPermissionReported: "granted",
    });
    render(<LocationPublisherBridge />);
    await waitFor(() =>
      expect(useVoiceSessionStore.getState().effects.size).toBeGreaterThan(0),
    );
    await act(async () => {
      useVoiceSessionStore.getState().emitToolResult("turn_sharing_off", {
        status: "off",
        sharing_state: "off",
        changed: true,
        revoked_shares: 1,
      });
    });
    expect(
      LocationAccountSettingsResource.peek("u1").settings?.sharing_state,
    ).toBe("off");
    expect(mocks.service.stopBackgroundShare).toHaveBeenCalled();
  });

  it("ignores a sos_active refusal: sharing stays on", async () => {
    LocationAccountSettingsResource.merge("u1", { sharing_state: "on" });
    render(<LocationPublisherBridge />);
    await waitFor(() =>
      expect(useVoiceSessionStore.getState().effects.size).toBeGreaterThan(0),
    );
    const before = mocks.service.stopBackgroundShare.mock.calls.length;
    await act(async () => {
      useVoiceSessionStore
        .getState()
        .emitToolResult("turn_sharing_off", {
          status: "sos_active",
          reason_code: "LOCATION_SOS_ACTIVE",
        });
    });
    expect(mocks.service.stopBackgroundShare.mock.calls.length).toBe(before);
  });
});
