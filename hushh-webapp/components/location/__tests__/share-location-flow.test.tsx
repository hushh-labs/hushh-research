import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Share location: the first point is captured here, coarsened to the
 * persisted precision, encrypted for the recipient's key and sent with the
 * grant, then stored; a `LOCATION_SHARING_OFF` refusal is explained with a
 * Turn on that uses the same account-settings contract as the voice tools.
 */

const harness = vi.hoisted(() => ({
  state: null as Record<string, unknown> | null,
  settings: { sharing_state: "on", precision: "precise" } as Record<
    string,
    unknown
  >,
  accountStatus: "ready" as string,
  update: vi.fn(),
  refresh: vi.fn(),
  getState: vi.fn(),
  listRecipientsPage: vi.fn(),
  captureCurrentPosition: vi.fn(),
  createGrantWithEnvelope: vi.fn(),
  storeEnvelope: vi.fn(),
  encrypt: vi.fn(),
  coarsen: vi.fn(),
  push: vi.fn(),
  publish: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

class FakeApiError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

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
    status: harness.accountStatus,
    settings: harness.settings,
    error: null,
    refresh: harness.refresh,
    update: harness.update,
  }),
  locationSettingsErrorCode: (error: unknown) =>
    error instanceof FakeApiError ? error.code : null,
}));
vi.mock("@/lib/location/coarsen", () => ({
  coarsenPoint: harness.coarsen,
}));
vi.mock("@/lib/one-location/encryption", () => ({
  encryptLocationForRecipient: harness.encrypt,
}));
vi.mock("@/lib/services/api-client", () => ({
  apiErrorCode: (error: unknown) =>
    error instanceof FakeApiError ? error.code : null,
}));
vi.mock("@/lib/one-location/service", () => ({
  OneLocationService: {
    getState: harness.getState,
    listRecipientsPage: harness.listRecipientsPage,
    captureCurrentPosition: harness.captureCurrentPosition,
    createGrantWithEnvelope: harness.createGrantWithEnvelope,
    storeEnvelope: harness.storeEnvelope,
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
vi.mock("@/lib/voice/location-voice-actions", () => ({
  deriveLocationVoiceActions: () => [],
}));
vi.mock("@/lib/one-voice/session-store", () => ({
  useVoiceToolEffects: () => undefined,
}));
vi.mock("@/lib/morphy-ux/morphy", () => ({ morphyToast: harness.toast }));

import { ShareLocationFlow } from "@/components/location/share/share-location-flow";

const PRIYA = {
  userId: "u2",
  displayName: "Priya Sharma",
  photoUrl: null,
  phoneVerified: true,
  keyAlgorithm: "ECDH-P256",
  keyId: "k2",
  publicKeyJwk: { kty: "EC", crv: "P-256" },
  canReceiveLocation: true,
};

const POINT = {
  latitude: 12.97194,
  longitude: 77.59456,
  accuracyM: 12,
  capturedAt: "2026-09-15T00:00:00.000Z",
  sourcePlatform: "web",
};

const EMPTY_STATE = {
  recipients: [PRIYA],
  ownerGrants: [],
  receivedGrants: [],
  requests: [],
  referrals: [],
  publicInvites: [],
  publicInviteSubmissions: [],
  capabilityScopes: [],
};

describe("ShareLocationFlow", () => {
  beforeEach(() => {
    harness.state = null;
    harness.settings = { sharing_state: "on", precision: "precise" };
    harness.accountStatus = "ready";
    harness.getState.mockResolvedValue(EMPTY_STATE);
    harness.listRecipientsPage.mockResolvedValue({
      items: [PRIYA],
      page: 1,
      hasMore: false,
      totalCount: 1,
    });
    harness.captureCurrentPosition.mockResolvedValue(POINT);
    harness.coarsen.mockImplementation(
      (point: Record<string, unknown>, precision: string) => ({
        ...point,
        precision,
      }),
    );
    harness.encrypt.mockResolvedValue({
      algorithm: "ECDH-P256-AES256-GCM",
      recipientKeyId: "k2",
      ciphertext: "c",
      iv: "i",
      senderEphemeralPublicKeyJwk: { kty: "EC" },
      capturedAt: POINT.capturedAt,
      sourcePlatform: "web",
      metadata: { payload: "coordinate_envelope", plaintext: false },
    });
    harness.createGrantWithEnvelope.mockResolvedValue({
      grant: {
        id: "g-1",
        recipientUserId: "u2",
        recipientDisplayName: "Priya Sharma",
        status: "active",
        durationMode: "timed",
        durationHours: 1,
      },
      envelope: {},
      idempotentReplay: false,
    });
    harness.storeEnvelope.mockResolvedValue({
      envelope: {},
      recipientAlerted: null,
    });
    harness.update.mockResolvedValue({
      settings: { sharing_state: "on", precision: "precise" },
    });
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("uses the breadcrumb title and publishes one_location_share", async () => {
    render(<ShareLocationFlow />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Share location",
    );
    const metadata = harness.publish.mock.calls.at(-1)?.[0] as {
      screenId: string;
    };
    expect(metadata.screenId).toBe("one_location_share");
    await screen.findByText("Priya Sharma");
  });

  it("encrypts the coarsened first point, creates the grant with it, then stores it", async () => {
    harness.settings = { sharing_state: "on", precision: "approximate" };
    render(<ShareLocationFlow personId="u2" />);
    await screen.findByText("Priya Sharma");
    const submit = await screen.findByTestId("share-submit");
    await waitFor(() => expect(submit).toBeEnabled());
    expect(submit).toHaveTextContent("Share with Priya Sharma");

    fireEvent.click(submit);
    await waitFor(() => expect(harness.storeEnvelope).toHaveBeenCalledTimes(1));

    expect(harness.captureCurrentPosition).toHaveBeenCalledWith({
      fresh: true,
    });
    expect(harness.coarsen).toHaveBeenCalledWith(POINT, "approximate");
    expect(harness.encrypt).toHaveBeenCalledWith(
      expect.objectContaining({
        point: expect.objectContaining({ precision: "approximate" }),
        recipientKeyId: "k2",
        recipientPublicKeyJwk: PRIYA.publicKeyJwk,
      }),
    );
    const grantCall = harness.createGrantWithEnvelope.mock
      .calls[0]?.[0] as Record<string, unknown>;
    expect(grantCall).toEqual(
      expect.objectContaining({
        vaultOwnerToken: "vault-token",
        recipientUserId: "u2",
        recipientKeyId: "k2",
        durationHours: 1,
        durationMode: "timed",
        shareKind: "share",
      }),
    );
    expect(typeof grantCall.clientOperationId).toBe("string");
    expect(
      (grantCall.envelope as { metadata: { precision: string } }).metadata
        .precision,
    ).toBe("approximate");
    expect(harness.storeEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        vaultOwnerToken: "vault-token",
        grantId: "g-1",
      }),
    );
    expect(await screen.findByTestId("share-outcome")).toHaveTextContent(
      "Priya Sharma",
    );
  });

  it("explains a LOCATION_SHARING_OFF refusal and offers Turn on through the settings PATCH", async () => {
    harness.createGrantWithEnvelope.mockRejectedValueOnce(
      new FakeApiError("LOCATION_SHARING_OFF"),
    );
    render(<ShareLocationFlow personId="u2" />);
    const submit = await screen.findByTestId("share-submit");
    await waitFor(() => expect(submit).toBeEnabled());
    fireEvent.click(submit);

    const notice = await screen.findByTestId("share-sharing-off");
    expect(notice).toHaveTextContent("Sharing with people is off");
    expect(harness.storeEnvelope).not.toHaveBeenCalled();
    expect(harness.toast.success).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("share-turn-on"));
    await waitFor(() =>
      expect(harness.update).toHaveBeenCalledWith({ sharingState: "on" }),
    );
  });

  it("shows the sharing-off explanation up front when the persisted posture is off", async () => {
    harness.settings = { sharing_state: "off", precision: "precise" };
    render(<ShareLocationFlow personId="u2" />);
    expect(await screen.findByTestId("share-sharing-off")).toBeInTheDocument();
    const submit = screen.getByTestId("share-submit");
    expect(submit).toBeDisabled();
    expect(harness.createGrantWithEnvelope).not.toHaveBeenCalled();
  });
});
