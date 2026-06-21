import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockUseRequireAuth,
  mockUseVault,
  mockEnsureKey,
  mockEncryptLocationForRecipient,
  mockDecryptLocationEnvelope,
  mockRegisterKey,
  mockGetPermissionState,
  mockRequestLocationPermission,
  mockOpenLocationSettings,
  mockOpenAppSettings,
  mockCaptureCurrentPosition,
  mockCreateGrant,
  mockStoreEnvelope,
  mockViewEnvelope,
  mockRevokeGrant,
  mockRequestAccess,
  mockCreatePublicInvite,
  mockCreateCircleInvite,
  mockGetActivity,
  mockGetState,
  mockSyncCurrentUser,
  mockSyncOneLocationContactSignals,
  mockTrackEvent,
  mockRouterPush,
  mockSearchParamsGet,
  mockCopyToClipboard,
} = vi.hoisted(() => ({
  mockUseRequireAuth: vi.fn(),
  mockUseVault: vi.fn(),
  mockEnsureKey: vi.fn(),
  mockEncryptLocationForRecipient: vi.fn(),
  mockDecryptLocationEnvelope: vi.fn(),
  mockRegisterKey: vi.fn(),
  mockGetPermissionState: vi.fn(),
  mockRequestLocationPermission: vi.fn(),
  mockOpenLocationSettings: vi.fn(),
  mockOpenAppSettings: vi.fn(),
  mockCaptureCurrentPosition: vi.fn(),
  mockCreateGrant: vi.fn(),
  mockStoreEnvelope: vi.fn(),
  mockViewEnvelope: vi.fn(),
  mockRevokeGrant: vi.fn(),
  mockRequestAccess: vi.fn(),
  mockCreatePublicInvite: vi.fn(),
  mockCreateCircleInvite: vi.fn(),
  mockGetActivity: vi.fn(),
  mockGetState: vi.fn(),
  mockSyncCurrentUser: vi.fn(),
  mockSyncOneLocationContactSignals: vi.fn(),
  mockTrackEvent: vi.fn(),
  mockRouterPush: vi.fn(),
  mockSearchParamsGet: vi.fn(),
  mockCopyToClipboard: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mockRouterPush,
  }),
  useSearchParams: () => ({
    get: mockSearchParamsGet,
    toString: () => "",
  }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useRequireAuth: mockUseRequireAuth,
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: mockUseVault,
}));

vi.mock("@/lib/observability/client", () => ({
  trackEvent: mockTrackEvent,
  toDurationBucket: () => "lt_100ms",
}));

vi.mock("@/components/vault/vault-lock-guard", () => ({
  VaultLockGuard: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/vault/vault-flow", () => ({
  VaultFlow: ({
    onSuccess,
  }: {
    onSuccess: (meta?: { mode: string }) => void;
  }) => (
    <button type="button" onClick={() => onSuccess({ mode: "passphrase" })}>
      Mock Vault Flow
    </button>
  ),
}));

vi.mock("@/lib/one-location/encryption", () => ({
  ensureLocationRecipientKey: mockEnsureKey,
  encryptLocationForRecipient: mockEncryptLocationForRecipient,
  decryptLocationEnvelope: mockDecryptLocationEnvelope,
}));

vi.mock("@/lib/one-location/service", () => ({
  OneLocationService: {
    registerRecipientKey: mockRegisterKey,
    getPermissionState: mockGetPermissionState,
    requestLocationPermission: mockRequestLocationPermission,
    openLocationSettings: mockOpenLocationSettings,
    openAppSettings: mockOpenAppSettings,
    getActivity: mockGetActivity,
    getState: mockGetState,
    createGrant: mockCreateGrant,
    storeEnvelope: mockStoreEnvelope,
    captureCurrentPosition: mockCaptureCurrentPosition,
    viewEnvelope: mockViewEnvelope,
    revokeGrant: mockRevokeGrant,
    requestAccess: mockRequestAccess,
    approveRequest: vi.fn(),
    denyRequest: vi.fn(),
    referRecipient: vi.fn(),
    createPublicInvite: mockCreatePublicInvite,
    createCircleInvite: mockCreateCircleInvite,
    revokePublicInvite: vi.fn(),
    revokeCircleInvite: vi.fn(),
  },
}));

vi.mock("@/lib/one-location/contact-signals", () => ({
  syncOneLocationContactSignals: mockSyncOneLocationContactSignals,
}));

vi.mock("@/lib/utils/clipboard", () => ({
  copyToClipboard: mockCopyToClipboard,
}));

vi.mock("@/lib/services/account-identity-service", () => ({
  AccountIdentityService: {
    syncCurrentUser: mockSyncCurrentUser,
  },
}));

vi.mock("sonner", () => {
  const toast = vi.fn();
  return {
    toast: Object.assign(toast, {
      success: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      dismiss: vi.fn(),
    }),
  };
});

import OneLocationAgentPage from "@/app/one/location/page";

if (!window.localStorage) {
  const localStorageStore = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      clear: () => localStorageStore.clear(),
      getItem: (key: string) => localStorageStore.get(key) ?? null,
      removeItem: (key: string) => localStorageStore.delete(key),
      setItem: (key: string, value: string) =>
        localStorageStore.set(key, String(value)),
    },
  });
}

function locationState() {
  return {
    recipients: [
      {
        userId: "user_b",
        displayName: "Trusted B",
        maskedPhone: "******8012",
        phoneVerified: true,
        keyId: "key_b",
        publicKeyJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
        keyAlgorithm: "ECDH-P256-AES256-GCM",
        canReceiveLocation: true,
        recommendationScore: 96,
        recommendationRank: 1,
        recommendationTier: "trusted_circle",
        recommendationCategory: "trusted_circle",
        recommendationCategoryLabel: "Trusted Circle",
        recommendationSummary: "Recently shared location with you",
        recommendationReasons: [
          {
            code: "recent_share",
            label: "Recent share history",
            weight: 60,
          },
        ],
        trustLevel: "high",
      },
      {
        userId: "user_c",
        displayName: "Advisor C",
        maskedPhone: "******4455",
        phoneVerified: true,
        keyId: null,
        publicKeyJwk: null,
        keyAlgorithm: "test-location-key-agreement",
        canReceiveLocation: false,
        recommendationScore: 42,
        recommendationRank: 2,
        recommendationTier: "setup_needed",
        recommendationCategory: "professional_network",
        recommendationCategoryLabel: "Advisor network",
        recommendationSummary: "Open One Location once to finish setup",
        recommendationReasons: [
          {
            code: "professional_match",
            label: "Advisor network",
            weight: 30,
          },
        ],
      },
      {
        userId: "user_d",
        displayName: "Investor D",
        maskedPhone: "******9911",
        phoneVerified: true,
        keyId: "key_d",
        publicKeyJwk: { kty: "EC", crv: "P-256", x: "x2", y: "y2" },
        keyAlgorithm: "test-location-key-agreement",
        canReceiveLocation: true,
        recommendationScore: 78,
        recommendationRank: 3,
        recommendationTier: "kai_network",
        recommendationCategory: "professional_network",
        recommendationCategoryLabel: "Investor network",
        recommendationSummary: "Aligned with your investor circle",
        recommendationReasons: [
          {
            code: "investor_match",
            label: "Investor network",
            weight: 42,
          },
        ],
        trustLevel: "medium",
      },
    ],
    ownerGrants: [
      {
        id: "grant_1",
        ownerUserId: "user_a",
        recipientUserId: "user_b",
        recipientDisplayName: "Trusted B",
        recipientMaskedPhone: "******8012",
        recipientKeyId: "key_b",
        status: "active",
        consentScope: "cap.location.live.view",
        capabilityScopes: ["cap.location.live.view"],
        durationHours: 1,
        expiresAt: "2026-05-20T08:00:00.000Z",
      },
    ],
    receivedGrants: [],
    requests: [],
    referrals: [],
    publicInvites: [],
    publicInviteSubmissions: [],
    capabilityScopes: [
      "cap.location.live.share",
      "cap.location.live.view",
      "cap.location.live.request",
      "cap.location.live.revoke",
      "cap.location.live.refer_request",
    ],
  };
}

function locationActivity() {
  return {
    range: "30d",
    summary: {
      sharedWithCount: 1,
      activeShareCount: 1,
      requestsReceivedCount: 1,
      requestsSentCount: 1,
      viewsCount: 1,
      publicLinkCount: 1,
      publicResponseCount: 1,
      totalEvents: 5,
    },
    buckets: [
      {
        key: "2026-05-20",
        label: "May 20",
        shares: 2,
        requests: 2,
        views: 1,
        publicActivity: 1,
        total: 5,
      },
    ],
    events: [
      {
        id: "event_viewed",
        kind: "share",
        eventType: "location_share_viewed",
        occurredAt: "2026-05-20T07:45:00.000Z",
        title: "Viewed by Trusted B",
        detail: "Private sharing - May 20, 07:45 UTC",
      },
      {
        id: "event_shared",
        kind: "share",
        eventType: "location_share_created",
        occurredAt: "2026-05-20T07:30:00.000Z",
        title: "Shared with Trusted B",
        detail: "Private sharing - May 20, 07:30 UTC",
      },
      {
        id: "event_request",
        kind: "request",
        eventType: "location_access_request",
        occurredAt: "2026-05-20T07:25:00.000Z",
        title: "Request from Advisor C",
        detail: "Approval workflow - May 20, 07:25 UTC",
      },
      {
        id: "event_public",
        kind: "public",
        eventType: "location_public_invite_submitted",
        occurredAt: "2026-05-20T07:20:00.000Z",
        title: "Response from Visitor Alpha",
        detail: "Request link - May 20, 07:20 UTC",
      },
    ],
  };
}

async function skipLocationEntryFlow() {
  expect(
    await screen.findByRole("heading", {
      name: "Experience location sharing with One.",
    }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(
    await screen.findByRole("heading", { name: /location/i }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Not now" }));
  expect(
    await screen.findByRole("heading", { name: "One Location Agent" }),
  ).toBeTruthy();
}

describe("OneLocationAgentPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
    window.localStorage.clear();
    mockSearchParamsGet.mockReturnValue(null);
    mockUseRequireAuth.mockReturnValue({
      loading: false,
      isAuthenticated: true,
      userId: "user_a",
      user: { uid: "user_a" },
    });
    mockUseVault.mockReturnValue({
      isVaultUnlocked: true,
      vaultOwnerToken: "vault-token",
    });
    mockEnsureKey.mockResolvedValue({
      keyId: "key_a",
      publicKeyJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
      algorithm: "ECDH-P256-AES256-GCM",
    });
    mockRegisterKey.mockResolvedValue({});
    mockGetPermissionState.mockResolvedValue({
      state: "granted",
      precise: true,
      background: "foreground-only",
      locationServicesEnabled: true,
    });
    mockOpenLocationSettings.mockResolvedValue({
      opened: true,
      sourcePlatform: "android",
    });
    mockOpenAppSettings.mockResolvedValue({
      opened: true,
      sourcePlatform: "android",
    });
    mockRequestLocationPermission.mockResolvedValue({
      state: "granted",
      precise: true,
      background: "foreground-only",
      locationServicesEnabled: true,
    });
    mockCaptureCurrentPosition.mockResolvedValue({
      latitude: 28.6139,
      longitude: 77.209,
      accuracyM: 18,
      capturedAt: "2026-05-20T07:30:00.000Z",
      sourcePlatform: "web",
    });
    mockCreateGrant.mockResolvedValue({
      id: "grant_new",
      ownerUserId: "user_a",
      recipientUserId: "user_b",
      recipientDisplayName: "Trusted B",
      recipientKeyId: "key_b",
      status: "active",
      consentScope: "cap.location.live.view",
      capabilityScopes: ["cap.location.live.view"],
      durationHours: 1,
      expiresAt: "2026-05-20T08:30:00.000Z",
    });
    mockEncryptLocationForRecipient.mockResolvedValue({
      recipientKeyId: "key_b",
      algorithm: "ECDH-P256-AES256-GCM",
      ciphertext: "ciphertext",
      iv: "iv",
      senderEphemeralPublicKeyJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
      capturedAt: "2026-05-20T07:30:00.000Z",
      sourcePlatform: "web",
    });
    mockStoreEnvelope.mockResolvedValue({});
    mockViewEnvelope.mockResolvedValue({
      grant: {},
      envelope: {
        recipientKeyId: "key_a",
        algorithm: "ECDH-P256-AES256-GCM",
        ciphertext: "ciphertext",
        iv: "iv",
        senderEphemeralPublicKeyJwk: {
          kty: "EC",
          crv: "P-256",
          x: "x",
          y: "y",
        },
        capturedAt: "2026-05-20T07:30:00.000Z",
        sourcePlatform: "web",
      },
    });
    mockDecryptLocationEnvelope.mockResolvedValue({
      latitude: 28.6139,
      longitude: 77.209,
      accuracyM: 18,
      capturedAt: "2026-05-20T07:30:00.000Z",
      sourcePlatform: "web",
    });
    mockRevokeGrant.mockResolvedValue({});
    mockRequestAccess.mockResolvedValue({});
    mockCopyToClipboard.mockResolvedValue(true);
    mockCreatePublicInvite.mockResolvedValue({
      publicUrl: "/one/location/request/invite_1",
    });
    mockGetState.mockResolvedValue(locationState());
    mockGetActivity.mockResolvedValue(locationActivity());
    mockSyncCurrentUser.mockResolvedValue({
      user_id: "user_a",
      phone_verified: true,
    });
    mockSyncOneLocationContactSignals.mockResolvedValue({
      matches: [],
      matchedUserIds: [],
      totalContacts: 0,
      inviteCandidateCount: 0,
      sourcePlatform: "ios",
    });
  });

  it("renders the One-owned encrypted location control surface", async () => {
    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();

    expect(
      await screen.findByRole("heading", { name: "One Location Agent" }),
    ).toBeTruthy();
    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    expect(
      await screen.findByRole("heading", { name: "One Network" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("heading", { name: "Proximity alerts" }),
    ).toBeNull();
    expect(screen.queryByText("Advisor meetup")).toBeNull();
    expect(screen.queryAllByText("Trusted B").length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: "Create public link" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Shared with me" })).toBeTruthy();
    expect(screen.queryByText(/8012|9911/)).toBeNull();
    expect(screen.getByText("Share Encrypted Update")).toBeTruthy();
    expect(mockRegisterKey).toHaveBeenCalledWith({
      vaultOwnerToken: "vault-token",
      keyId: "key_a",
      publicKeyJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
      algorithm: "ECDH-P256-AES256-GCM",
    });
    expect(mockSyncCurrentUser).toHaveBeenCalledWith({ uid: "user_a" });
  });

  it("does not render the removed onboarding tour", async () => {
    render(<OneLocationAgentPage />);

    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /Show onboarding tour/i })).toBeNull();
    expect(
      screen.queryByRole("dialog", { name: /One Location guided tour/i }),
    ).toBeNull();
  });

  it("previews my live location without creating a share, request, or public link", async () => {
    mockGetState.mockResolvedValueOnce({
      ...locationState(),
      ownerGrants: [],
      receivedGrants: [],
    });

    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();

    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    fireEvent.click(
      screen.getByRole("button", { name: /Show my location/i }),
    );

    await waitFor(() => expect(mockCaptureCurrentPosition).toHaveBeenCalledTimes(1));
    const mapPreview = await screen.findByTitle("Live location map preview");
    expect(mapPreview.getAttribute("src")).toContain(
      "https://www.google.com/maps?q=28.613900%2C77.209000",
    );
    expect(mockCreateGrant).not.toHaveBeenCalled();
    expect(mockRequestAccess).not.toHaveBeenCalled();
    expect(mockCreatePublicInvite).not.toHaveBeenCalled();
  });

  it("loads One Location setup without requiring backend phone verification", async () => {
    mockSyncCurrentUser.mockResolvedValueOnce({
      user_id: "user_a",
      display_name: "Test User",
      phone_verified: false,
    });

    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();

    await waitFor(() => expect(mockEnsureKey).toHaveBeenCalledWith("user_a"));
    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    expect(screen.queryByText("Verify your phone number first")).toBeNull();
  });

  it("requests native foreground permission from the onboarding permission step", async () => {
    mockGetState.mockResolvedValueOnce({
      ...locationState(),
      ownerGrants: [],
    });
    mockGetPermissionState
      .mockResolvedValueOnce({
        state: "prompt",
        precise: null,
        background: "foreground-only",
        locationServicesEnabled: true,
      })
      .mockResolvedValueOnce({
        state: "prompt",
        precise: null,
        background: "foreground-only",
        locationServicesEnabled: true,
      })
      .mockResolvedValueOnce({
        state: "granted",
        precise: true,
        background: "foreground-only",
        locationServicesEnabled: true,
      });

    render(<OneLocationAgentPage />);

    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    expect(
      await screen.findByRole("heading", {
        name: "Experience location sharing with One.",
      }),
    ).toBeTruthy();
    expect(mockCaptureCurrentPosition).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(
      await screen.findByRole("heading", { name: "Allow location access" }),
    ).toBeTruthy();
    expect(screen.getByText("You can pause sharing anytime")).toBeTruthy();
    expect(mockRequestLocationPermission).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Allow Location" }));
    await waitFor(() =>
      expect(mockRequestLocationPermission).toHaveBeenCalledTimes(1),
    );
    expect(mockCaptureCurrentPosition).not.toHaveBeenCalled();
    expect(
      await screen.findByRole("heading", { name: "One Location Agent" }),
    ).toBeTruthy();
    expect(window.localStorage.getItem("one_location_onboarding_v1:user_a")).toBeNull();
  });

  it("shows the location entry flow even when foreground permission is already granted", async () => {
    mockGetState.mockResolvedValueOnce({
      ...locationState(),
      ownerGrants: [],
    });

    render(<OneLocationAgentPage />);

    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    expect(
      await screen.findByRole("heading", {
        name: "Experience location sharing with One.",
      }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(
      await screen.findByRole("heading", { name: "Allow location access" }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Allow Location" }));
    expect(
      await screen.findByRole("heading", { name: "One Location Agent" }),
    ).toBeTruthy();
    expect(mockCaptureCurrentPosition).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("one_location_onboarding_v1:user_a")).toBeNull();
  });

  it("renders One Network recommendation metadata without phone-derived labels", async () => {
    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();

    await waitFor(() => expect(mockGetState).toHaveBeenCalled());

    expect(screen.getByRole("heading", { name: "One Network" })).toBeTruthy();
    expect(screen.getAllByText("Trusted Circle").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Recent share history").length).toBeGreaterThan(
      0,
    );
    expect(screen.getByText("Recently shared location with you")).toBeTruthy();
    expect(screen.queryByText(/8012|4455|9911/)).toBeNull();

    fireEvent.change(screen.getByPlaceholderText("Search One Network..."), {
      target: { value: "advisor" },
    });

    expect(screen.getAllByText("Advisor C").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Advisor network").length).toBeGreaterThan(0);
    expect(screen.queryByText(/8012|4455|9911/)).toBeNull();
  });

  it("shows the entry flow before the main-page skeleton while state refresh is loading", async () => {
    let resolveState: (value: ReturnType<typeof locationState>) => void = () =>
      undefined;
    mockGetState.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveState = resolve;
      }),
    );

    const { container } = render(<OneLocationAgentPage />);

    await waitFor(() => expect(mockRegisterKey).toHaveBeenCalled());
    expect(
      await screen.findByRole("heading", {
        name: "Experience location sharing with One.",
      }),
    ).toBeTruthy();
    const onboardingShellClass = screen.getByRole("main").getAttribute("class") || "";
    expect(onboardingShellClass).toContain("fixed");
    expect(onboardingShellClass).toContain("inset-0");
    expect(onboardingShellClass).toContain("z-[540]");
    expect(
      container.querySelectorAll('[data-slot="skeleton"]').length,
    ).toBe(0);

  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(
      await screen.findByRole("heading", { name: "Allow location access" }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(await screen.findByLabelText("Loading One Location")).toBeTruthy();
    expect(
      container.querySelectorAll('[data-slot="skeleton"]').length,
    ).toBeGreaterThan(0);

    resolveState(locationState());
    await waitFor(() =>
      expect(screen.getByText("Share Encrypted Update")).toBeTruthy(),
    );
  });

  it("renders public and private invite controls", async () => {
    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();

    await waitFor(() => expect(mockGetState).toHaveBeenCalled());

    expect(screen.getByText("Invite to One")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Create Circle Invite/i })).toBeTruthy();
    expect(screen.getByText("Create public link")).toBeTruthy();
    expect(screen.queryByText("Public link responses")).toBeNull();
    expect(screen.queryByText(/Share a public location link/i)).toBeNull();
    expect(screen.queryByText(/whatsapp/i)).toBeNull();
  });

  it("keeps location activity hidden in the compact mobile flow", async () => {
    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();

    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    expect(screen.queryByRole("heading", { name: "Location activity" })).toBeNull();
    expect(screen.queryByText("Activity history")).toBeNull();
    expect(screen.queryByText(/8012|4455|9911/)).toBeNull();
  });

  it("warns the recipient when the decrypted location update is stale", async () => {
    const staleGrant = {
      id: "grant_stale",
      ownerUserId: "user_a",
      recipientUserId: "user_b",
      ownerDisplayName: "Trusted A",
      recipientKeyId: "key_b",
      status: "active",
      consentScope: "cap.location.live.view",
      capabilityScopes: ["cap.location.live.view"],
      durationHours: 1,
      expiresAt: "2099-05-20T08:00:00.000Z",
    };
    mockUseRequireAuth.mockReturnValue({
      loading: false,
      isAuthenticated: true,
      userId: "user_b",
      user: { uid: "user_b" },
    });
    window.localStorage.setItem(
      "one_location_opened_grants_v1:user_b",
      JSON.stringify(["grant_stale"]),
    );
    mockGetState.mockResolvedValue({
      ...locationState(),
      ownerGrants: [],
      receivedGrants: [staleGrant],
    });
    mockViewEnvelope.mockResolvedValueOnce({
      grant: staleGrant,
      envelope: {
        recipientKeyId: "key_b",
        algorithm: "ECDH-P256-AES256-GCM",
        ciphertext: "ciphertext",
        iv: "iv",
        senderEphemeralPublicKeyJwk: {
          kty: "EC",
          crv: "P-256",
          x: "x",
          y: "y",
        },
        capturedAt: "2000-01-01T00:00:00.000Z",
        sourcePlatform: "web",
      },
    });
    mockDecryptLocationEnvelope.mockResolvedValueOnce({
      latitude: 28.6139,
      longitude: 77.209,
      accuracyM: 18,
      capturedAt: "2000-01-01T00:00:00.000Z",
      sourcePlatform: "web",
    });

    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();

    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    await waitFor(() => expect(mockViewEnvelope).toHaveBeenCalled());
    expect(
      await screen.findByText("Location update may be stale. Ask them to refresh sharing."),
    ).toBeTruthy();

    const mapPreview = screen.getByTitle("Live location map preview");
    expect(mapPreview.getAttribute("src")).toContain(
      "https://www.google.com/maps?q=28.613900%2C77.209000",
    );
    expect(screen.queryAllByText("Last known location").length).toBeGreaterThan(0);
    expect(screen.getByText(/Accuracy \+\/- 18 m/)).toBeTruthy();
    expect(screen.queryByText("Lat")).toBeNull();
    expect(screen.queryByText("Lng")).toBeNull();

    const directionsLink = screen.getByRole("link", {
      name: "Open Google Maps directions to shared live location",
    });
    expect(directionsLink.getAttribute("target")).toBe("_blank");
    expect(directionsLink.getAttribute("rel")).toBe("noopener noreferrer");
    expect(directionsLink.getAttribute("href")).toContain(
      "https://www.google.com/maps/dir/?api=1&destination=28.613900%2C77.209000&travelmode=driving",
    );

    const startLink = screen.getByRole("link", {
      name: "Start Google Maps navigation to shared live location",
    });
    expect(startLink.getAttribute("target")).toBe("_blank");
    expect(startLink.getAttribute("rel")).toBe("noopener noreferrer");
    expect(startLink.getAttribute("href")).toContain("dir_action=navigate");
  });

  it("tracks public location link creation without analytics identity payloads", async () => {
    const longPublicUrl =
      "https://uat.kai.hushh.ai/one/location/request/aQluqHFAdgETh91oLTmG6o7v8A6TAB7PmZjrOJwPcIA";
    mockGetState.mockResolvedValue({
      ...locationState(),
      ownerGrants: [],
    });
    mockCreatePublicInvite.mockResolvedValueOnce({
      publicUrl: longPublicUrl,
    });

    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();

    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    fireEvent.click(
      screen.getByRole("button", { name: /Create public link/i }),
    );

    await waitFor(() => expect(mockCreatePublicInvite).toHaveBeenCalledTimes(1));
    expect(mockCaptureCurrentPosition).toHaveBeenCalledTimes(1);
    expect(mockCreatePublicInvite).toHaveBeenCalledWith({
      vaultOwnerToken: "vault-token",
      durationHours: 1,
      locationSnapshot: expect.objectContaining({
        latitude: 28.6139,
        longitude: 77.209,
      }),
    });
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "one_location_public_link_created",
      expect.objectContaining({
        route_id: "one_location",
        result: "success",
        duration_bucket: "1h",
        copied_to_clipboard: true,
        active_invite_count: 1,
      }),
    );
    expect(screen.queryByText(longPublicUrl)).toBeNull();
    const publicLinkPreview = await screen.findByText(`${longPublicUrl.slice(0, 52)}...`);
    expect(publicLinkPreview.getAttribute("title")).toBe(longPublicUrl);
    expect(JSON.stringify(mockTrackEvent.mock.calls)).not.toMatch(
      /8012|9911|latitude|longitude|28\.6139|77\.209/u,
    );
  });

  it("creates one encrypted share without exposing phone-derived labels", async () => {
    mockGetState.mockResolvedValueOnce({
      ...locationState(),
      ownerGrants: [],
    });

    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();

    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    fireEvent.click(
      screen.getByRole("button", { name: /Review Share/i }),
    );
    expect(
      await screen.findByRole("region", { name: "Share safety review" }),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: /Confirm & Share Location/i }),
    );

    await waitFor(() => expect(mockCreateGrant).toHaveBeenCalledTimes(1));
    expect(mockCaptureCurrentPosition).toHaveBeenCalled();
    expect(mockEncryptLocationForRecipient).toHaveBeenCalledWith(
      expect.objectContaining({
        point: expect.objectContaining({
          latitude: 28.6139,
          longitude: 77.209,
        }),
        recipientKeyId: "key_b",
      }),
    );
    expect(mockStoreEnvelope).toHaveBeenCalledWith({
      vaultOwnerToken: "vault-token",
      grantId: "grant_new",
      envelope: expect.objectContaining({
        ciphertext: "ciphertext",
        recipientKeyId: "key_b",
      }),
    });
    expect(screen.queryByText(/8012|9911/)).toBeNull();
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "one_location_share_review_opened",
      expect.objectContaining({
        route_id: "one_location",
        result: "success",
        selected_count: 1,
        duration_bucket: "1h",
      }),
      expect.any(Object),
    );
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "one_location_share_confirmed",
      expect.objectContaining({
        route_id: "one_location",
        result: "success",
        selected_count: 1,
        success_count: 1,
        failure_count: 0,
      }),
    );
    await waitFor(() =>
      expect(
        screen.getByText("Select one or more One users for private sharing."),
      ).toBeTruthy(),
    );
    expect(
      screen.queryByRole("region", { name: "Share safety review" }),
    ).toBeNull();
  });

  it("retries transient foreground publish failures and tracks backoff metadata", async () => {
    mockGetState.mockResolvedValueOnce({
      ...locationState(),
      ownerGrants: [],
    });
    mockStoreEnvelope
      .mockRejectedValueOnce(
        Object.assign(new Error("One API unavailable"), { status: 503 }),
      )
      .mockResolvedValueOnce({});

    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();

    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: /Review Share/i }));
    expect(
      await screen.findByRole("region", { name: "Share safety review" }),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: /Confirm & Share Location/i }),
    );

    await waitFor(() => expect(mockStoreEnvelope).toHaveBeenCalledTimes(2));
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "one_location_foreground_retry",
      expect.objectContaining({
        route_id: "one_location",
        operation: "publish",
        trigger: "manual",
        result: "expected_error",
        attempt_count: 1,
        retry_count: 1,
        backoff_bucket: "lt_500ms",
        error_class: "one_api_unavailable",
      }),
    );
    const retryCall = mockTrackEvent.mock.calls.find(
      ([eventName]) => eventName === "one_location_foreground_retry",
    );
    expect(JSON.stringify(retryCall)).not.toMatch(
      /8012|9911|latitude|longitude|28\.6139|77\.209|ciphertext|grant_new/u,
    );
  });

  it("shares one GPS capture through separate encrypted grants for multiple selected recipients", async () => {
    mockGetState.mockResolvedValue({
      ...locationState(),
      ownerGrants: [],
    });
    mockCreateGrant.mockImplementation(
      async ({
        recipientUserId,
        recipientKeyId,
        durationHours,
      }: {
        recipientUserId: string;
        recipientKeyId: string;
        durationHours: number;
      }) => ({
        id: `grant_${recipientUserId}`,
        ownerUserId: "user_a",
        recipientUserId,
        recipientDisplayName:
          recipientUserId === "user_d" ? "Investor D" : "Trusted B",
        recipientKeyId,
        status: "active",
        consentScope: "cap.location.live.view",
        capabilityScopes: ["cap.location.live.view"],
        durationHours,
        expiresAt: "2026-05-20T08:30:00.000Z",
      }),
    );
    mockEncryptLocationForRecipient.mockImplementation(
      async ({ point, recipientKeyId }) => ({
        recipientKeyId,
        ciphertext: `ciphertext-${recipientKeyId}`,
        iv: `iv-${recipientKeyId}`,
        senderEphemeralPublicKeyJwk: {
          kty: "EC",
          crv: "P-256",
          x: "x",
          y: "y",
        },
        capturedAt: point.capturedAt,
        sourcePlatform: point.sourcePlatform,
      }),
    );

    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();

    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    expect(await screen.findByText(/1 person selected/i)).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", {
        name: /Select Investor D from One Network/i,
      }),
    );
    expect(await screen.findByText(/2 people selected/i)).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: /Review Share/i }),
    );
    expect(
      await screen.findByRole("region", { name: "Share safety review" }),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: /Confirm & Share Location/i }),
    );

    await waitFor(() => expect(mockCreateGrant).toHaveBeenCalledTimes(2));
    expect(mockCaptureCurrentPosition).toHaveBeenCalledTimes(1);
    expect(
      mockCreateGrant.mock.calls.map(([payload]) => payload.recipientUserId),
    ).toEqual(["user_b", "user_d"]);
    expect(
      mockEncryptLocationForRecipient.mock.calls.map(
        ([payload]) => payload.recipientKeyId,
      ),
    ).toEqual(["key_b", "key_d"]);
    expect(mockEncryptLocationForRecipient.mock.calls[0][0].point).toBe(
      mockEncryptLocationForRecipient.mock.calls[1][0].point,
    );
    expect(mockStoreEnvelope).toHaveBeenCalledTimes(2);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "one_location_recommendation_selected",
      expect.objectContaining({
        route_id: "one_location",
        action: "share",
        selection_surface: "section_list",
        selected_count: 2,
      }),
      expect.any(Object),
    );
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "one_location_share_confirmed",
      expect.objectContaining({
        route_id: "one_location",
        result: "success",
        selected_count: 2,
        success_count: 2,
        failure_count: 0,
      }),
    );
  });

  it("stops private sharing when a selected recipient still needs setup", async () => {
    mockGetState.mockResolvedValue({
      ...locationState(),
      ownerGrants: [],
    });

    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();

    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    fireEvent.click(
      screen.getByRole("button", {
        name: /Select Advisor C from One Network/i,
      }),
    );

    expect(
      await screen.findByText(
        /need to open One Location once before private sharing/i,
      ),
    ).toBeTruthy();
    const shareButton = screen.getByRole("button", {
      name: /Review Share/i,
    }) as HTMLButtonElement;
    expect(shareButton.disabled).toBe(true);
    expect(mockCreateGrant).not.toHaveBeenCalled();
  });

  it("sends an approval-first location request without sharing coordinates", async () => {
    mockGetState.mockResolvedValue({
      ...locationState(),
      ownerGrants: [],
    });

    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();

    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("tab", { name: "request" }));
    fireEvent.change(screen.getByPlaceholderText("Optional reason"), {
      target: { value: "Need pickup coordination" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Send Request/i }));

    await waitFor(() => expect(mockRequestAccess).toHaveBeenCalledTimes(1));
    expect(mockRequestAccess).toHaveBeenCalledWith({
      vaultOwnerToken: "vault-token",
      ownerUserId: "user_b",
      message: "Need pickup coordination",
    });
    expect(mockCaptureCurrentPosition).not.toHaveBeenCalled();
    expect(mockStoreEnvelope).not.toHaveBeenCalled();
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "one_location_request_sent",
      expect.objectContaining({
        route_id: "one_location",
        result: "success",
        selected_count: 1,
        success_count: 1,
        failure_count: 0,
        has_note: true,
      }),
    );
    await waitFor(() =>
      expect(
        screen.getByText(
          "Select one or more One users before requesting location access.",
        ),
      ).toBeTruthy(),
    );
    expect(
      (screen.getByPlaceholderText("Optional reason") as HTMLTextAreaElement)
        .value,
    ).toBe("");
  });

  it("renders my requests with safe labels instead of raw owner ids", async () => {
    mockGetState.mockResolvedValue({
      ...locationState(),
      ownerGrants: [],
      requests: [
        {
          id: "request_1",
          ownerUserId: "user_b",
          requesterUserId: "user_a",
          status: "pending",
          requestedAt: "2026-05-20T07:30:00.000Z",
        },
      ],
    });

    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();

    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    expect(screen.getByText("My requests")).toBeTruthy();
    expect(screen.getAllByText("Trusted B").length).toBeGreaterThan(0);
    expect(screen.queryByText("user_b")).toBeNull();
    expect(screen.queryByText("request_1")).toBeNull();
  });

  it("fans out approval-first requests to multiple selected owners without coordinates", async () => {
    mockGetState.mockResolvedValue({
      ...locationState(),
      ownerGrants: [],
    });

    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();

    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("tab", { name: "request" }));
    fireEvent.click(
      screen.getByRole("button", {
        name: /Select Investor D from One Network/i,
      }),
    );
    expect(await screen.findByText(/2 people selected/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Send Request/i }));

    await waitFor(() => expect(mockRequestAccess).toHaveBeenCalledTimes(2));
    expect(
      mockRequestAccess.mock.calls.map(([payload]) => payload.ownerUserId),
    ).toEqual(["user_b", "user_d"]);
    expect(mockCaptureCurrentPosition).not.toHaveBeenCalled();
    expect(mockStoreEnvelope).not.toHaveBeenCalled();
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "one_location_request_sent",
      expect.objectContaining({
        route_id: "one_location",
        result: "success",
        selected_count: 2,
        success_count: 2,
        failure_count: 0,
      }),
    );
  });

  it("adds mobile contact matches as a ranking reason without showing phone digits", async () => {
    mockUseRequireAuth.mockReturnValue({
      loading: false,
      isAuthenticated: true,
      userId: "user_a",
      user: { uid: "user_a", getIdToken: vi.fn().mockResolvedValue("id-token") },
    });
    mockSyncOneLocationContactSignals.mockResolvedValueOnce({
      matches: [
        {
          user_id: "user_d",
          kind: "investor",
          display_name: "Investor D",
          phone_last4: "9911",
          profile: {},
        },
      ],
      matchedUserIds: ["user_d"],
      totalContacts: 8,
      inviteCandidateCount: 7,
      sourcePlatform: "ios",
    });

    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();

    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: /Sync Contacts/i }));

    await waitFor(() =>
      expect(mockSyncOneLocationContactSignals).toHaveBeenCalledWith({
        idToken: "id-token",
      }),
    );
    expect(await screen.findByText("In your contacts")).toBeTruthy();
    expect(screen.queryByText(/9911|8012|4455/)).toBeNull();
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "one_location_contact_signal_synced",
      expect.objectContaining({
        route_id: "one_location",
        result: "success",
        source_platform: "ios",
        contact_count_bucket: "1_10",
        matched_count: 1,
        invite_candidate_count: 7,
      }),
    );
  });

  it("creates an approval-first invite path for contacts who are not One users", async () => {
    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();

    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: /Share to Contacts/i }));

    await waitFor(() => expect(mockCreatePublicInvite).toHaveBeenCalledTimes(1));
    expect(mockCreatePublicInvite).toHaveBeenCalledWith({
      vaultOwnerToken: "vault-token",
      durationHours: 1,
      locationSnapshot: expect.objectContaining({
        latitude: 28.6139,
        longitude: 77.209,
      }),
    });
    expect(JSON.stringify(mockTrackEvent.mock.calls)).not.toMatch(
      /8012|9911|latitude|longitude|28\.6139|77\.209/u,
    );
  });

  it("does not show owner-grant revoke actions in the compact mobile flow", async () => {
    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();

    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    expect(
      screen.queryByRole("button", { name: /Revoke access for Trusted B/i }),
    ).toBeNull();
    expect(mockRevokeGrant).not.toHaveBeenCalled();
  });

  it("blocks share actions when browser location permission is denied", async () => {
    mockGetPermissionState.mockResolvedValueOnce({
      state: "denied",
      precise: false,
      background: "unavailable",
      locationServicesEnabled: true,
    });
    mockGetState.mockResolvedValueOnce({
      ...locationState(),
      ownerGrants: [],
    });

    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();

    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    const shareButton = screen.getByRole("button", {
      name: /Review Share/i,
    }) as HTMLButtonElement;
    fireEvent.click(shareButton);
    await waitFor(() => expect(mockCaptureCurrentPosition).not.toHaveBeenCalled());
    expect(mockCreateGrant).not.toHaveBeenCalled();
  });

  it("blocks sharing and opens settings when phone location services are off", async () => {
    mockGetPermissionState.mockResolvedValue({
      state: "unavailable",
      precise: false,
      background: "foreground-only",
      locationServicesEnabled: false,
    });
    mockGetState.mockResolvedValueOnce({
      ...locationState(),
      ownerGrants: [],
    });

    render(<OneLocationAgentPage />);

    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    expect(
      await screen.findByRole("heading", {
        name: "Experience location sharing with One.",
      }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("Turn on phone Location")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: /Open Location Settings/i }),
    );

    await waitFor(() => expect(mockOpenLocationSettings).toHaveBeenCalled());
    expect(mockCreateGrant).not.toHaveBeenCalled();
    expect(mockStoreEnvelope).not.toHaveBeenCalled();
  });

  it("keeps One Network section empty states visible when no candidates exist", async () => {
    mockGetState.mockResolvedValueOnce({
      ...locationState(),
      recipients: [],
      ownerGrants: [],
    });

    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();

    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    expect(screen.getByText("One Network is empty")).toBeTruthy();
    expect(screen.queryByText(/No approvals waiting/)).toBeNull();
    expect(screen.queryByText(/No trusted matches yet/)).toBeNull();
    expect(screen.queryByText(/No professional signals yet/)).toBeNull();
    expect(screen.queryByText(/No ready One users yet/)).toBeNull();
    expect(screen.queryByText(/No setup blockers/)).toBeNull();
    expect(
      screen.getByRole("button", { name: /Create public link/i }),
    ).toBeTruthy();
  });

  it("does not leave refresh spinning when the vault owner token is unavailable", async () => {
    mockUseVault.mockReturnValue({
      isVaultUnlocked: false,
      vaultOwnerToken: null,
    });

    render(<OneLocationAgentPage />);

    expect(
      await screen.findByText("Unlock your vault before loading location sharing."),
    ).toBeTruthy();
    expect(mockRegisterKey).not.toHaveBeenCalled();
    expect(mockGetState).not.toHaveBeenCalled();
  });
});
