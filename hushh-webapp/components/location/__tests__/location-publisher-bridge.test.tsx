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
    // Never called by the bridge: the relay armed the grants and the server
    // verifies delivery. Spied so a regression that re-runs the manual SOS
    // path (a second publisher) fails loudly.
    createGrant: vi.fn(),
    sendSosEmails: vi.fn(),
    revokeGrant: vi.fn(),
  },
  runSosPanic: vi.fn(),
  pathname: "/one/location",
  getSetupProgress: vi.fn(),
  toast: { warning: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/lib/one-location/sos-trigger", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/one-location/sos-trigger")>();
  return { ...actual, runSosPanic: mocks.runSosPanic };
});

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

import {
  LocationPublisherBridge,
  hasValidCoordinates,
} from "@/components/location/location-publisher-bridge";
import { LocationAccountSettingsResource } from "@/lib/location/account-settings";
import { encryptLocationForRecipient } from "@/lib/one-location/encryption";
import {
  clearSosIncident,
  loadSosIncident,
  saveSosIncident,
} from "@/lib/one-location/sos-incident";
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
  clearSosIncident();
  mocks.pathname = "/one/location";
  window.history.replaceState({}, "", "/one/location");
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

describe("LocationPublisherBridge: Save My Soul", () => {
  const BOB = {
    userId: "bob",
    displayName: "Bob",
    phoneVerified: true,
    keyId: "k-bob",
    publicKeyJwk: { kty: "EC" },
    keyAlgorithm: "ECDH-P256-AES256-GCM",
    canReceiveLocation: true,
  };
  const ALICE = (mocks.state.value as { recipients: unknown[] }).recipients[0];
  const FIX = {
    latitude: 12.97194,
    longitude: 77.59456,
    accuracyM: 8,
    capturedAt: new Date().toISOString(),
    sourcePlatform: "web",
  };
  /** The step the relay sends after `trigger_save_my_soul` armed two grants. */
  const sosStep = (stepId: string) => ({
    stepId,
    kind: "publish_location_envelopes",
    payload: {
      purpose: "sos",
      sos: true,
      grant_ids: ["sos-a", "sos-b"],
      grants: [
        { grant_id: "sos-a", user_id: "alice", key_id: "k-alice" },
        { grant_id: "sos-b", user_id: "bob", key_id: "k-bob" },
      ],
      timeout_s: 25,
    },
    timeoutS: 25,
  });

  function armServerState() {
    // The state read lags the write: neither SOS grant is listed yet, so the
    // step's own `grants` rows are what the bridge publishes to.
    mocks.service.getState.mockResolvedValue({
      ...(mocks.state.value as Record<string, unknown>),
      recipients: [ALICE, BOB],
      ownerGrants: [],
    });
    mocks.service.captureCurrentPosition.mockResolvedValue({ ...FIX });
    mocks.service.storeEnvelope.mockResolvedValue({
      envelope: {},
      recipientAlerted: true,
    });
  }

  async function mountBridge() {
    render(<LocationPublisherBridge />);
    await waitFor(() =>
      expect(useVoiceSessionStore.getState().effects.size).toBeGreaterThan(0),
    );
  }

  function storedGrantIds(): string[] {
    return mocks.service.storeEnvelope.mock.calls.map(
      (call) => (call[0] as { grantId: string }).grantId,
    );
  }

  it("(i) publishes an SOS step from Home: the route never gates the bridge", async () => {
    mocks.pathname = "/one";
    window.history.replaceState({}, "", "/one");
    armServerState();
    await mountBridge();
    expect(window.location.pathname).toBe("/one");

    const report = vi.fn();
    await act(async () => {
      useVoiceSessionStore.getState().emitClientStep(sosStep("sos-step-1"), report);
    });
    await waitFor(() => expect(report).toHaveBeenCalledTimes(1));
    const [status, payload] = report.mock.calls[0]! as [
      string,
      Record<string, unknown>,
    ];
    expect(status).toBe("ok");
    expect(payload.published).toEqual(["sos-a", "sos-b"]);
    expect(payload.failures).toEqual([]);
    // SOS is always precise, and always a fresh fix.
    expect(payload.precision).toBe("precise");
    expect(mocks.service.captureCurrentPosition).toHaveBeenCalledWith({
      maxAgeMs: 0,
    });
    expect(storedGrantIds().sort()).toEqual(["sos-a", "sos-b"]);
    for (const call of mocks.service.storeEnvelope.mock.calls) {
      const params = call[0] as {
        vaultOwnerToken: string;
        envelope: { metadata?: Record<string, unknown> };
      };
      expect(params.vaultOwnerToken).toBe("vot");
      expect(params.envelope.metadata?.precision).toBe("precise");
      expect(JSON.stringify(params.envelope)).not.toContain("12.97194");
    }
  });

  it("(ii) the same step id delivered twice is published and reported once", async () => {
    armServerState();
    await mountBridge();
    const report = vi.fn();
    await act(async () => {
      useVoiceSessionStore.getState().emitClientStep(sosStep("sos-step-2"), report);
      useVoiceSessionStore.getState().emitClientStep(sosStep("sos-step-2"), report);
    });
    await waitFor(() => expect(report).toHaveBeenCalledTimes(1));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(report).toHaveBeenCalledTimes(1);
    expect(mocks.service.captureCurrentPosition).toHaveBeenCalledTimes(1);
    expect(storedGrantIds().sort()).toEqual(["sos-a", "sos-b"]);
  });

  it("(iii) one store failure out of two still reports ok, naming the failed grant", async () => {
    armServerState();
    mocks.service.storeEnvelope.mockImplementation(
      async (params: { grantId: string }) => {
        if (params.grantId === "sos-b") throw new Error("store boom");
        return { envelope: {}, recipientAlerted: true };
      },
    );
    await mountBridge();
    const report = vi.fn();
    await act(async () => {
      useVoiceSessionStore.getState().emitClientStep(sosStep("sos-step-3"), report);
    });
    await waitFor(() => expect(report).toHaveBeenCalledTimes(1));
    const [status, payload] = report.mock.calls[0]! as [
      string,
      { published: string[]; failures: Array<Record<string, unknown>> },
    ];
    expect(status).toBe("ok");
    expect(payload.published).toEqual(["sos-a"]);
    expect(payload.failures).toHaveLength(1);
    expect(payload.failures[0]).toMatchObject({
      grant_id: "sos-b",
      code: "store_failed",
    });
    // The report never claims the failed one; the server decides "reached".
    expect(JSON.stringify(payload)).not.toMatch(/sent|delivered/);
  });

  it("(iv) an invalid coordinate is never encrypted: it reports no fix", async () => {
    expect(hasValidCoordinates({ latitude: 0, longitude: 0 })).toBe(true);
    expect(hasValidCoordinates({ latitude: -90, longitude: 180 })).toBe(true);
    expect(hasValidCoordinates({ latitude: Number.NaN, longitude: 1 })).toBe(false);
    expect(hasValidCoordinates({ latitude: 1, longitude: Number.POSITIVE_INFINITY })).toBe(false);
    expect(hasValidCoordinates({ latitude: 90.0001, longitude: 0 })).toBe(false);
    expect(hasValidCoordinates({ latitude: 0, longitude: -180.5 })).toBe(false);

    for (const bad of [
      { latitude: Number.NaN, longitude: 77.59456 },
      { latitude: 12.97194, longitude: 181 },
      { latitude: -91, longitude: 77.59456 },
    ]) {
      vi.clearAllMocks();
      useVoiceSessionStore.getState().effects.clear();
      armServerState();
      mocks.service.captureCurrentPosition.mockResolvedValue({ ...FIX, ...bad });
      const { unmount } = render(<LocationPublisherBridge />);
      await waitFor(() =>
        expect(useVoiceSessionStore.getState().effects.size).toBeGreaterThan(0),
      );
      const report = vi.fn();
      await act(async () => {
        useVoiceSessionStore
          .getState()
          .emitClientStep(sosStep(`sos-step-4-${bad.latitude}-${bad.longitude}`), report);
      });
      await waitFor(() => expect(report).toHaveBeenCalledTimes(1));
      const [status, payload] = report.mock.calls[0]! as [
        string,
        Record<string, unknown>,
      ];
      expect(status, JSON.stringify(bad)).toBe("failed");
      expect(payload.code).toBe("no_fix");
      expect(payload.grant_ids).toEqual(["sos-a", "sos-b"]);
      expect(payload.failures).toEqual([
        { grant_id: "sos-a", code: "store_failed", reason: "invalid_coordinates" },
        { grant_id: "sos-b", code: "store_failed", reason: "invalid_coordinates" },
      ]);
      expect(mocks.service.storeEnvelope).not.toHaveBeenCalled();
      expect(vi.mocked(encryptLocationForRecipient)).not.toHaveBeenCalled();
      // No coordinate leaves the device in the report either.
      expect(JSON.stringify(payload)).not.toMatch(/77\.59456|12\.97194/);
      unmount();
    }
  });

  it("(v) an SOS step never re-runs the manual path: no runSosPanic, no emails, no new grants", async () => {
    armServerState();
    await mountBridge();
    const report = vi.fn();
    await act(async () => {
      useVoiceSessionStore.getState().emitClientStep(sosStep("sos-step-5"), report);
    });
    await waitFor(() => expect(report).toHaveBeenCalledTimes(1));
    expect(report.mock.calls[0]![0]).toBe("ok");
    expect(mocks.runSosPanic).not.toHaveBeenCalled();
    expect(mocks.service.sendSosEmails).not.toHaveBeenCalled();
    expect(mocks.service.createGrant).not.toHaveBeenCalled();
    expect(mocks.service.revokeGrant).not.toHaveBeenCalled();
  });

  it("(vi) persists the owner-scoped incident when the trigger card resolves armed, on any route", async () => {
    mocks.pathname = "/one";
    window.history.replaceState({}, "", "/one");
    armServerState();
    await mountBridge();
    const armed = {
      status: "sos_grants_created",
      grant_ids: ["sos-a", "sos-b"],
      armed: [
        { grant_id: "sos-a", user_id: "alice", display_name: "Alice" },
        { grant_id: "sos-b", user_id: "bob", display_name: "Bob" },
      ],
      note: "note_SECRET",
      client_step: { kind: "publish_location_envelopes", purpose: "sos", grant_ids: ["sos-a", "sos-b"] },
    };
    await act(async () => {
      useVoiceSessionStore
        .getState()
        .emitPendingResolved("pa-sos", "executed", armed);
    });
    const stored = loadSosIncident("u1");
    expect(stored).not.toBeNull();
    expect(stored!.grantIds).toEqual(["sos-a", "sos-b"]);
    expect(stored!.ownerUserId).toBe("u1");
    expect(typeof stored!.startedAt).toBe("string");
    // Owner-scoped: another account never sees it.
    expect(loadSosIncident("u2")).toBeNull();
    // Nothing but ids, a time and the owner reaches storage.
    const raw = window.localStorage.getItem("one_location_sos_incident_v1")!;
    expect(raw).not.toContain("note_SECRET");
    expect(raw).not.toContain("Alice");
    expect(raw).not.toContain("alice");

    // The relay mirrors the arming as a tool.result too: same alert, same record.
    await act(async () => {
      useVoiceSessionStore
        .getState()
        .emitToolResult("trigger_save_my_soul", { ...armed });
    });
    expect(loadSosIncident("u1")).toEqual(stored);

    // A failed resolution never records an incident.
    clearSosIncident();
    await act(async () => {
      useVoiceSessionStore
        .getState()
        .emitPendingResolved("pa-sos-2", "failed", {
          status: "rejected",
          reason_code: "sos_audience_changed",
        });
    });
    expect(loadSosIncident("u1")).toBeNull();
  });

  it("clears the incident on sos_stopped and keeps only the unresolved shares on sos_partially_stopped", async () => {
    await mountBridge();
    saveSosIncident({
      grantIds: ["sos-a", "sos-b"],
      startedAt: "2026-09-15T10:00:00.000Z",
      ownerUserId: "u1",
    });
    await act(async () => {
      useVoiceSessionStore
        .getState()
        .emitPendingResolved("pa-stop", "executed", {
          status: "sos_partially_stopped",
          stopped: [{ grant_id: "sos-a", user_id: "alice", display_name: "Alice" }],
          unresolved: [{ grant_id: "sos-b", user_id: "bob", display_name: "Bob" }],
          unresolved_grant_ids: ["sos-b"],
        });
    });
    expect(loadSosIncident("u1")).toEqual({
      grantIds: ["sos-b"],
      startedAt: "2026-09-15T10:00:00.000Z",
      ownerUserId: "u1",
    });
    await act(async () => {
      useVoiceSessionStore
        .getState()
        .emitToolResult("stop_save_my_soul", {
          status: "sos_stopped",
          stopped_count: 1,
        });
    });
    expect(loadSosIncident("u1")).toBeNull();
    expect(mocks.service.revokeGrant).not.toHaveBeenCalled();
  });
});
