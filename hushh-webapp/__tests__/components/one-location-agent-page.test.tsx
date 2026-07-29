import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { Children, type ReactNode } from "react";
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
  mockReverseGeocode,
  mockAddSavedLocation,
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
  mockSearchConnectionDirectory,
  mockListConnections,
  mockSendConnectionRequest,
  mockTrackEvent,
  mockRouterPush,
  mockRouterReplace,
  mockRouterBack,
  mockSearchParamsGet,
  mockSearchParams,
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
  mockReverseGeocode: vi.fn(),
  mockAddSavedLocation: vi.fn(),
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
  mockSearchConnectionDirectory: vi.fn(),
  mockListConnections: vi.fn(),
  mockSendConnectionRequest: vi.fn(),
  mockTrackEvent: vi.fn(),
  mockRouterPush: vi.fn(),
  mockRouterReplace: vi.fn(),
  mockRouterBack: vi.fn(),
  mockSearchParamsGet: vi.fn(),
  mockSearchParams: {
    get: vi.fn(),
    toString: () => "",
  },
  mockCopyToClipboard: vi.fn(),
}));

mockSearchParams.get = mockSearchParamsGet;

vi.mock("next/navigation", () => ({
  usePathname: () => "/one/location",
  useRouter: () => ({
    push: mockRouterPush,
    replace: mockRouterReplace,
    back: mockRouterBack,
  }),
  useSearchParams: () => mockSearchParams,
}));

vi.mock("@/hooks/use-auth", () => ({
  useRequireAuth: mockUseRequireAuth,
}));

// CapabilityExploreCard (rendered on the location tab) reads useAuth from the
// firebase auth context directly, so it needs its own stub in this harness.
vi.mock("@/lib/firebase/auth-context", () => ({
  useAuth: () => ({ user: { uid: "user_a" }, loading: false }),
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: mockUseVault,
}));

vi.mock("@/components/one-location/saved-locations-section", () => ({
  SavedLocationsSection: () => (
    <section aria-label="Saved Locations">Saved Locations</section>
  ),
}));

vi.mock("@/lib/observability/client", () => ({
  trackEvent: mockTrackEvent,
  toDurationBucket: () => "lt_100ms",
}));

vi.mock("@/components/vault/vault-lock-guard", () => ({
  VaultLockGuard: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

// Location redesign uses SwipeViews for its route-owned tabs. This suite tests
// the Location views, so replace the browser viewport primitive with controls
// that simulate a swipe by reporting the selected tab upward.
vi.mock("@/lib/morphy-ux/ui/swipe-views", () => ({
  SwipeViews: ({
    children,
    options,
    activeValue,
    onSelectionChange,
  }: {
    children: ReactNode;
    options: readonly { label: string; value: string }[];
    activeValue: string;
    onSelectionChange?: (value: string) => void;
  }) => {
    const activeIndex = options.findIndex(({ value }) => value === activeValue);
    const activeChild = Children.toArray(children)[activeIndex];

    return (
      <div>
        {options.map(({ label, value }) => (
          <button
            key={value}
            type="button"
            aria-pressed={value === activeValue}
            onClick={() => onSelectionChange?.(value)}
          >
            {label}
          </button>
        ))}
        {activeChild}
      </div>
    );
  },
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
    reverseGeocode: mockReverseGeocode,
    watchCurrentPosition: vi.fn().mockResolvedValue(null),
    clearWatch: vi.fn(),
    clearLocationWatch: vi.fn().mockResolvedValue(undefined),
    startBackgroundShare: vi.fn().mockResolvedValue({ started: false }),
    stopBackgroundShare: vi.fn().mockResolvedValue(undefined),
    requestAlwaysAuthorization: vi
      .fn()
      .mockResolvedValue({ background: "unavailable" }),
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

vi.mock("@/lib/one-location/saved-locations", () => ({
  addSavedLocation: mockAddSavedLocation,
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

vi.mock("@/lib/services/connections-service", () => ({
  ConnectionsService: {
    searchDirectory: mockSearchConnectionDirectory,
    listConnections: mockListConnections,
    sendRequest: mockSendConnectionRequest,
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
import { toast } from "sonner";

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

async function openLocationFeatureStep() {
  expect(
    await screen.findByRole("heading", {
      name: "Share your location easily with anyone.",
    }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Get started" }));
  expect(
    await screen.findByRole("heading", {
      name: "Stay connected when you need it.",
    }),
  ).toBeTruthy();
}

async function openLocationPeopleStep() {
  await openLocationFeatureStep();
  const continueButton = screen.getByRole("button", {
    name: /Continue|Allow location/,
  });
  await waitFor(() => expect(continueButton).toBeEnabled());
  fireEvent.click(continueButton);
  expect(
    await screen.findByRole("heading", { name: "Add people" }),
  ).toBeTruthy();
}

async function enterLocationCircleStep(options: { fakeTimers?: boolean } = {}) {
  await openLocationPeopleStep();
  const continueButton = screen.getByRole("button", { name: "Continue" });
  await waitFor(() => expect(continueButton).toBeEnabled());
  if (options.fakeTimers) vi.useFakeTimers();
  fireEvent.click(continueButton);
  expect(
    screen.getByRole("heading", {
      name: "Your circle is ready.",
    }),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Go back" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Skip" })).toBeNull();
}

async function skipLocationEntryFlow(options: { expectMain?: boolean } = {}) {
  await enterLocationCircleStep({ fakeTimers: true });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(4000);
  });
  vi.useRealTimers();

  if (options.expectMain !== false) {
    expect(
      await screen.findByRole("heading", { name: "Location Agent" }),
    ).toBeTruthy();
  }
}

async function openLocationPermissionsStep() {
  await openLocationFeatureStep();
}

async function switchLocationTab(
  name: "Now" | "People" | "Links",
  expectedHeading: string,
) {
  fireEvent.click(screen.getByRole("button", { name }));
  expect(
    await screen.findByRole("heading", { name: expectedHeading }),
  ).toBeTruthy();
}

async function openSharePersonStep() {
  fireEvent.click(screen.getByRole("button", { name: /^Share location$/i }));
  expect(
    await screen.findByRole("heading", { name: "Who can see you?" }),
  ).toBeTruthy();
}

async function openShareDetailsStep() {
  await openSharePersonStep();
  // No recipient is auto-selected anymore — the user must pick someone before
  // Continue is enabled. Select the first ready recipient (the action button's
  // accessible name is the aria-label "Select <name> for private sharing").
  fireEvent.click(
    screen.getByRole("button", {
      name: /Select Trusted B for private sharing/i,
    }),
  );

  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(
    await screen.findByRole("heading", { name: "What are you sharing?" }),
  ).toBeTruthy();
}

async function openShareReviewStep() {
  await openShareDetailsStep();
  fireEvent.click(screen.getByRole("button", { name: /Review share/i }));
  expect(
    await screen.findByRole("heading", { name: "Before you start" }),
  ).toBeTruthy();
}

async function openAskFlow() {
  fireEvent.click(screen.getByRole("button", { name: "People" }));
  fireEvent.click(
    await screen.findByRole("button", { name: /Ask someone to share/i }),
  );
  expect(
    await screen.findByRole("heading", { name: "Make it comfortable" }),
  ).toBeTruthy();
}

async function openTemporaryLinkFlow() {
  fireEvent.click(screen.getByRole("button", { name: "Links" }));
  fireEvent.click(
    await screen.findByRole("button", { name: /Create a new link/i }),
  );
  expect(
    await screen.findByRole("heading", { name: "Share outside your Circle" }),
  ).toBeTruthy();
}

describe("OneLocationAgentPage", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
    window.localStorage.clear();
    // Legacy page-flow tests are not about the optional saved-place prompt.
    // A dedicated integration test below clears this flag and proves that flow.
    window.localStorage.setItem(
      "one_location_saved_location_prompt_v1:user_a",
      "1",
    );
    // The workspace now seeds from the memory-only OneLocationStateResource
    // (CacheService singleton); clear it so a prior test's server-state
    // snapshot cannot leak into the next test's initial render.
    const { CacheService } = await import("@/lib/services/cache-service");
    CacheService.getInstance().clear();
    mockSearchParams.toString = () => "";
    mockSearchParamsGet.mockReturnValue(null);
    mockUseRequireAuth.mockReturnValue({
      loading: false,
      isAuthenticated: true,
      userId: "user_a",
      user: {
        uid: "user_a",
        displayName: "Test User",
        email: "test@example.com",
        photoURL: null,
        getIdToken: vi.fn().mockResolvedValue("id-token"),
      },
    });
    mockUseVault.mockReturnValue({
      isVaultUnlocked: true,
      vaultKey: "vault-key",
      vaultOwnerToken: "vault-token",
    });
    mockEnsureKey.mockResolvedValue({
      keyId: "key_a",
      publicKeyJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
      algorithm: "ECDH-P256-AES256-GCM",
    });
    mockRegisterKey.mockResolvedValue({});
    mockGetPermissionState.mockReset();
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
    mockReverseGeocode.mockResolvedValue({
      name: "India Gate",
      formattedAddress: "Kartavya Path, New Delhi, Delhi 110001, India",
      countryCode: "IN",
    });
    mockAddSavedLocation.mockResolvedValue([
      {
        id: "home",
        category: "home",
        label: "Home",
        latitude: 28.6139,
        longitude: 77.209,
        address: "Kartavya Path, New Delhi, Delhi 110001, India",
        savedAt: "2026-05-20T07:30:00.000Z",
      },
    ]);
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
    mockSearchConnectionDirectory.mockResolvedValue({
      items: [
        {
          userId: "user_b",
          displayName: "Trusted B",
          photoUrl: null,
          email: "trusted@example.com",
          relationship: "connected",
        },
        {
          userId: "user_c",
          displayName: "Advisor C",
          photoUrl: null,
          email: "advisor@example.com",
          relationship: "none",
        },
      ],
      page: 1,
      hasMore: false,
    });
    mockListConnections.mockResolvedValue([
      {
        connectionId: "connection_b",
        userId: "user_b",
        displayName: "Trusted B",
        photoUrl: null,
        createdAt: "2026-05-20T07:00:00.000Z",
      },
    ]);
    mockSendConnectionRequest.mockResolvedValue(undefined);
  });

  it("renders the One-owned encrypted location control surface", async () => {
    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();

    expect(
      await screen.findByRole("heading", { name: "Location Agent" }),
    ).toBeTruthy();
    const pageShell = document.querySelector<HTMLElement>(
      '[data-app-shell-width="reading"]',
    );
    expect(pageShell).toBeTruthy();
    expect(pageShell?.className).not.toContain("--app-bottom-fixed-ui");
    expect(pageShell?.className).not.toMatch(/\b(?:sm:|md:)?pb-/u);
    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: /Active shares/i })).toBeTruthy();
    expect(
      screen.queryByRole("heading", { name: "Proximity alerts" }),
    ).toBeNull();
    expect(screen.queryByText("Advisor meetup")).toBeNull();
    // Now is intentionally compact: capture happens only from Your Map's
    // explicit Locate me control, never from a dashboard toggle.
    expect(screen.getByRole("button", { name: "Your Map" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /^Share location$/i }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Active shares/i }));
    expect(await screen.findByText("Trusted B")).toBeTruthy();
    expect(screen.queryByText(/8012|9911/)).toBeNull();
    expect(mockRegisterKey).toHaveBeenCalledWith({
      vaultOwnerToken: "vault-token",
      keyId: "key_a",
      publicKeyJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
      algorithm: "ECDH-P256-AES256-GCM",
    });
    expect(mockSyncCurrentUser).toHaveBeenCalledWith(
      expect.objectContaining({ uid: "user_a" }),
    );
  });

  it("keeps the location preview switch and refresh action grouped in the header", async () => {
    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();

    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    const headerActions = screen.getByRole("group", {
      name: "Location preview controls",
    });
    expect(headerActions.className).toContain("ml-auto");
    expect(headerActions.className).toContain("justify-end");

    const refreshCallsBeforeClick = mockGetState.mock.calls.length;
    fireEvent.click(
      screen.getByRole("button", { name: "Refresh location" }),
    );
    await waitFor(() =>
      expect(mockGetState.mock.calls.length).toBeGreaterThan(
        refreshCallsBeforeClick,
      ),
    );

    mockCaptureCurrentPosition.mockClear();
    const locationOffSwitch = screen.getByRole("switch", {
      name: "Turn location on",
    });
    expect(locationOffSwitch).toHaveAttribute("aria-checked", "false");

    fireEvent.click(locationOffSwitch);
    await waitFor(() => expect(mockCaptureCurrentPosition).toHaveBeenCalled());
    const locationOnSwitch = screen.getByRole("switch", {
      name: "Turn location off",
    });
    expect(locationOnSwitch).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("Location on")).toBeTruthy();

    fireEvent.click(locationOnSwitch);
    await waitFor(() =>
      expect(
        screen.getByRole("switch", { name: "Turn location on" }),
      ).toHaveAttribute("aria-checked", "false"),
    );
    expect(screen.getByText("Location off")).toBeTruthy();
    expect(mockRevokeGrant).not.toHaveBeenCalled();
  });

  it("renders a focused, validated share flow with a 15-minute default", async () => {
    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();

    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    await openSharePersonStep();

    expect(screen.queryByText("Ready for private sharing")).toBeNull();
    expect(screen.getByText("Invite first to enable sharing")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", {
        name: /Select Trusted B for private sharing/i,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(
      await screen.findByRole("heading", { name: "What are you sharing?" }),
    ).toBeTruthy();
    expect(
      screen.getByText("Better for privacy and battery life"),
    ).toBeTruthy();
    expect(
      screen.getByText("Updates while you move for your loved ones"),
    ).toBeTruthy();
    expect(screen.queryByText("Private by design")).toBeNull();

    const duration = screen.getByRole("combobox", { name: "Duration" });
    expect(duration.textContent).toContain("15 min");
    fireEvent.click(duration);
    const options = await screen.findAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "15 min",
      "30 min",
      "1 hour",
      "4 hours",
      "24 hours",
    ]);
    fireEvent.click(screen.getByRole("option", { name: "4 hours" }));
    expect(duration.textContent).toContain("4 hours");

    const note = screen.getByRole("textbox", { name: "Optional note" });
    const reviewButton = screen.getByRole("button", { name: "Review share" });
    expect(screen.getByText("0/140")).toBeTruthy();

    fireEvent.change(note, { target: { value: "a".repeat(140) } });
    expect(screen.getByText("140/140")).toBeTruthy();
    expect(reviewButton).toBeEnabled();
    expect(screen.queryByText("character limit exceed")).toBeNull();

    fireEvent.change(note, { target: { value: "a".repeat(141) } });
    expect(screen.getByText("141/140")).toBeTruthy();
    expect(screen.getByText("character limit exceed")).toBeTruthy();
    expect(reviewButton).toBeDisabled();

    fireEvent.change(note, { target: { value: "On my way" } });
    expect(screen.getByText("9/140")).toBeTruthy();
    expect(screen.queryByText("character limit exceed")).toBeNull();
    expect(reviewButton).toBeEnabled();

    fireEvent.click(reviewButton);
    expect(
      await screen.findByRole("heading", { name: "Before you start" }),
    ).toBeTruthy();
    expect(screen.getByText("4 hours")).toBeTruthy();
    expect(
      screen.queryByText("Access ends automatically after expiry"),
    ).toBeNull();
    const people = screen.getByRole("list", {
      name: "People who can see your location",
    });
    expect(within(people).getByText("Trusted B")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Start sharing" }));
    await waitFor(() => expect(mockCreateGrant).toHaveBeenCalledTimes(1));
    expect(mockCreateGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        durationHours: 4,
        reason: "On my way",
        shareKind: "share",
      }),
    );
  });

  it("opens the canonical Location Settings URL and owns Saved Locations there", async () => {
    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();

    fireEvent.click(screen.getByRole("button", { name: /^Settings$/i }));

    expect(
      await screen.findByRole("heading", { name: "Settings" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("region", { name: "Saved Locations" }),
    ).toBeTruthy();
    expect(mockRouterPush).toHaveBeenCalledWith(
      "/one/location?action=settings",
      { scroll: false },
    );
  });

  it("canonicalizes the legacy Location privacy URL without losing its origin", async () => {
    window.localStorage.setItem("one_location_onboarding_v2:user_a", "1");
    mockSearchParams.toString = () => "from=%2Fone%2Fprofile&action=privacy";
    mockSearchParamsGet.mockImplementation((name: string) => {
      if (name === "from") return "/one/profile";
      if (name === "action") return "privacy";
      return null;
    });

    render(<OneLocationAgentPage />);

    expect(
      await screen.findByRole("heading", { name: "Settings" }),
    ).toBeTruthy();
    expect(mockRouterReplace).toHaveBeenCalledWith(
      "/one/location?from=%2Fone%2Fprofile&action=settings",
      { scroll: false },
    );
  });

  it("resolves a fresh local emergency number as Save My Soul opens", async () => {
    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();
    mockCaptureCurrentPosition.mockClear();
    const envelopeWritesBeforeOpen = mockStoreEnvelope.mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: /SMS.*Save my soul/i }));

    expect(
      await screen.findByRole("heading", { name: /Save my soul/i }),
    ).toBeTruthy();
    await waitFor(() =>
      expect(mockCaptureCurrentPosition).toHaveBeenCalledTimes(1),
    );
    expect(mockReverseGeocode).toHaveBeenCalledWith({
      vaultOwnerToken: "vault-token",
      lat: 28.6139,
      lng: 77.209,
    });
    expect(
      await screen.findByRole("link", {
        name: /Call 112 emergency services \(India\)/i,
      }),
    ).toHaveAttribute("href", "tel:112");
    expect(mockStoreEnvelope).toHaveBeenCalledTimes(envelopeWritesBeforeOpen);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      await screen.findByRole("heading", { name: "Location Agent" }),
    ).toBeTruthy();

    mockCaptureCurrentPosition.mockResolvedValueOnce({
      latitude: 40.7128,
      longitude: -74.006,
      accuracyM: 12,
      capturedAt: "2026-05-20T07:35:00.000Z",
      sourcePlatform: "web",
    });
    let resolveReopenedLookup:
      | ((value: {
          name: string | null;
          formattedAddress: string | null;
          countryCode: string | null;
        }) => void)
      | null = null;
    mockReverseGeocode.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveReopenedLookup = resolve;
        }),
    );

    fireEvent.click(screen.getByRole("button", { name: /SMS.*Save my soul/i }));

    expect(
      await screen.findByRole("button", {
        name: "Finding local emergency number",
      }),
    ).toBeDisabled();
    expect(screen.queryByRole("link", { name: /Call 112/i })).toBeNull();

    await act(async () => {
      resolveReopenedLookup?.({
        name: "Times Square",
        formattedAddress: "Manhattan, NY, USA",
        countryCode: "US",
      });
    });
    expect(
      await screen.findByRole("link", {
        name: /Call 911 emergency services \(United States\)/i,
      }),
    ).toHaveAttribute("href", "tel:911");
  });

  it("resolves the local emergency number on a direct SOS link and hides unverified numbers", async () => {
    window.localStorage.setItem("one_location_onboarding_v2:user_a", "1");
    mockSearchParams.toString = () => "action=sos";
    mockSearchParamsGet.mockImplementation((name: string) =>
      name === "action" ? "sos" : null,
    );

    let resolveReverseGeocode:
      | ((value: {
          name: string | null;
          formattedAddress: string | null;
          countryCode: string | null;
        }) => void)
      | null = null;
    mockReverseGeocode.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveReverseGeocode = resolve;
        }),
    );

    render(<OneLocationAgentPage />);

    expect(
      await screen.findByRole("heading", { name: /Save my soul/i }),
    ).toBeTruthy();
    expect(
      await screen.findByRole("button", {
        name: "Finding local emergency number",
      }),
    ).toBeDisabled();
    expect(
      screen.queryByRole("link", { name: /emergency services/i }),
    ).toBeNull();

    await act(async () => {
      resolveReverseGeocode?.({
        name: "Times Square",
        formattedAddress: "Manhattan, NY, USA",
        countryCode: "US",
      });
    });

    expect(
      await screen.findByRole("link", {
        name: /Call 911 emergency services \(United States\)/i,
      }),
    ).toHaveAttribute("href", "tel:911");
    expect(mockCaptureCurrentPosition).toHaveBeenCalled();
    expect(mockReverseGeocode).toHaveBeenCalledTimes(1);
  });

  it("leaves setup with browser Back without marking onboarding complete or skipped", async () => {
    const onSetupComplete = vi.fn();
    const onSetupSkip = vi.fn();
    window.localStorage.setItem("one_location_onboarding_v2:user_a", "1");

    render(
      <OneLocationAgentPage
        mode="setup"
        onSetupComplete={onSetupComplete}
        onSetupSkip={onSetupSkip}
      />,
    );

    expect(
      await screen.findByRole("heading", {
        name: "Share your location easily with anyone.",
      }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Go back" }));
    expect(mockRouterBack).toHaveBeenCalledTimes(1);
    expect(onSetupSkip).not.toHaveBeenCalled();
    expect(onSetupComplete).not.toHaveBeenCalled();
    expect(
      window.localStorage.getItem("one_location_onboarding_v2:user_a"),
    ).toBe("1");
  });

  it("does not replay Location onboarding after setup completes into the workspace", async () => {
    const onSetupComplete = vi.fn();
    const setup = render(
      <OneLocationAgentPage mode="setup" onSetupComplete={onSetupComplete} />,
    );

    await enterLocationCircleStep({ fakeTimers: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    vi.useRealTimers();

    expect(onSetupComplete).toHaveBeenCalledTimes(1);
    expect(
      window.localStorage.getItem("one_location_onboarding_v2:user_a"),
    ).toBe("1");

    setup.unmount();
    render(<OneLocationAgentPage />);

    expect(
      await screen.findByRole("heading", { name: "Location Agent" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("heading", {
        name: "Share your location easily with anyone.",
      }),
    ).toBeNull();
  });

  it("keeps Location setup inert while durable completion is settling", async () => {
    let resolveCompletion: (() => void) | undefined;
    const onSetupComplete = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveCompletion = resolve;
        }),
    );

    render(
      <OneLocationAgentPage mode="setup" onSetupComplete={onSetupComplete} />,
    );

    await enterLocationCircleStep({ fakeTimers: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });

    expect(screen.queryByRole("button", { name: "Go back" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Skip" })).toBeNull();
    expect(onSetupComplete).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(8000);
    });
    expect(onSetupComplete).toHaveBeenCalledTimes(1);

    resolveCompletion?.();
    vi.useRealTimers();
  });

  it("does not finish web Location setup while permission is denied", async () => {
    const onSetupComplete = vi.fn();
    mockGetPermissionState.mockResolvedValue({
      state: "denied",
      precise: false,
      background: "restricted",
      locationServicesEnabled: true,
    });
    mockRequestLocationPermission.mockResolvedValue({
      state: "denied",
      precise: false,
      background: "restricted",
      locationServicesEnabled: true,
    });

    render(
      <OneLocationAgentPage mode="setup" onSetupComplete={onSetupComplete} />,
    );

    await openLocationPermissionsStep();
    expect(screen.getByTestId("one-location-onboarding-features")).toBeTruthy();
    await waitFor(() => expect(mockOpenAppSettings).toHaveBeenCalled());
    expect(
      screen.getByRole("button", { name: "Continue" }),
    ).toBeEnabled();
    expect(onSetupComplete).not.toHaveBeenCalled();
  });

  it("keeps setup onboarding available when the workspace state fetch fails", async () => {
    mockGetState.mockRejectedValue(new Error("Workspace state unavailable"));

    render(<OneLocationAgentPage mode="setup" />);

    expect(
      await screen.findByTestId("one-location-onboarding-welcome"),
    ).toBeTruthy();
    expect(screen.queryByText("Workspace state unavailable")).toBeNull();
  });

  it("keeps contact prefetch alive across steps and renders the first available source", async () => {
    type DirectoryResult = {
      items: Array<{
        userId: string;
        displayName: string;
        photoUrl: null;
        email: string;
        relationship: "connected" | "none";
      }>;
      page: number;
      hasMore: boolean;
    };
    type ConnectionResult = Array<{
      connectionId: string;
      userId: string;
      displayName: string;
      photoUrl: null;
      createdAt: string;
    }>;
    let resolveDirectory!: (value: DirectoryResult) => void;
    let resolveConnections!: (value: ConnectionResult) => void;
    mockGetState.mockResolvedValue({
      ...locationState(),
      recipients: [],
    });
    mockSearchConnectionDirectory.mockReturnValueOnce(
      new Promise<DirectoryResult>((resolve) => {
        resolveDirectory = resolve;
      }),
    );
    mockListConnections.mockReturnValueOnce(
      new Promise<ConnectionResult>((resolve) => {
        resolveConnections = resolve;
      }),
    );

    render(<OneLocationAgentPage mode="setup" />);
    await openLocationPeopleStep();
    expect(screen.getByText("Finding your people")).toBeTruthy();

    await act(async () => {
      resolveConnections([
        {
          connectionId: "connection_b",
          userId: "user_b",
          displayName: "Trusted B",
          photoUrl: null,
          createdAt: "2026-05-20T07:00:00.000Z",
        },
      ]);
    });

    expect(await screen.findByText("Trusted B")).toBeTruthy();
    expect(screen.queryByText("Finding your people")).toBeNull();

    await act(async () => {
      resolveDirectory({
        items: [
          {
            userId: "user_b",
            displayName: "Trusted B",
            photoUrl: null,
            email: "trusted@example.com",
            relationship: "connected",
          },
          {
            userId: "user_c",
            displayName: "Advisor C",
            photoUrl: null,
            email: "advisor@example.com",
            relationship: "none",
          },
        ],
        page: 1,
        hasMore: false,
      });
    });

    expect(await screen.findByText("Advisor C")).toBeTruthy();
  });

  it("uses Location recipients when the Connections directory is empty", async () => {
    mockSearchConnectionDirectory.mockResolvedValueOnce({
      items: [],
      page: 1,
      hasMore: false,
    });
    mockListConnections.mockResolvedValueOnce([]);

    render(<OneLocationAgentPage mode="setup" />);
    await openLocationPeopleStep();

    expect(await screen.findByText("Trusted B")).toBeTruthy();
    expect(screen.getByText("Advisor C")).toBeTruthy();
    expect(screen.getByText("Investor D")).toBeTruthy();
    expect(screen.queryByText(/No recommendations yet/)).toBeNull();
  });

  it("suppresses the stale-token banner while vault re-unlock is requested", async () => {
    mockGetState.mockRejectedValue(
      Object.assign(new Error("Token validation failed."), { status: 401 }),
    );

    render(<OneLocationAgentPage />);

    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    expect(screen.queryByText(/Token validation failed/i)).toBeNull();
  });

  it("scrolls Active shares only when more than three shares are present", async () => {
    const baseGrant = locationState().ownerGrants[0]!;
    mockGetState.mockResolvedValue({
      ...locationState(),
      ownerGrants: Array.from({ length: 4 }, (_, index) => ({
        ...baseGrant,
        id: `grant_${index + 1}`,
        recipientUserId: `user_${index + 1}`,
        recipientDisplayName: `Trusted ${index + 1}`,
      })),
    });

    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();

    fireEvent.click(screen.getByRole("button", { name: /Active shares/i }));
    expect(
      await screen.findByRole("heading", { name: "Active shares" }),
    ).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Stop" })).toHaveLength(4);
  });

  it("does not render the removed onboarding tour", async () => {
    render(<OneLocationAgentPage />);

    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    expect(
      screen.queryByRole("button", { name: /Show onboarding tour/i }),
    ).toBeNull();
    expect(
      screen.queryByRole("dialog", { name: /One Location guided tour/i }),
    ).toBeNull();
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
    mockGetState.mockResolvedValue({
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
    await openLocationPermissionsStep();
    expect(mockCaptureCurrentPosition).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(mockRequestLocationPermission).toHaveBeenCalledTimes(1),
    );
    expect(toast.success).toHaveBeenCalledWith("Location access enabled.");
    expect(mockCaptureCurrentPosition).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(
      await screen.findByRole("heading", { name: "Add people" }),
    ).toBeTruthy();
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    vi.useRealTimers();
    expect(
      await screen.findByRole("heading", { name: "Location Agent" }),
    ).toBeTruthy();
    // Completing onboarding persists the one-time intro flag so the marketing
    // intro never shows again for this user.
    expect(
      window.localStorage.getItem("one_location_onboarding_v2:user_a"),
    ).toBe("1");
  });

  it("offers to save the granted location into encrypted PKM before onboarding continues", async () => {
    window.localStorage.removeItem(
      "one_location_saved_location_prompt_v1:user_a",
    );
    mockGetState.mockResolvedValue({
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
    await openLocationPermissionsStep();
    expect(
      await screen.findByRole("dialog", { name: "Save this place" }),
    ).toBeTruthy();
    await waitFor(() =>
      expect(mockReverseGeocode).toHaveBeenCalledWith({
        vaultOwnerToken: "vault-token",
        lat: 28.6139,
        lng: 77.209,
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Home" }));
    fireEvent.click(screen.getByRole("button", { name: "Save location" }));

    await waitFor(() =>
      expect(mockAddSavedLocation).toHaveBeenCalledWith({
        context: {
          userId: "user_a",
          vaultKey: "vault-key",
          vaultOwnerToken: "vault-token",
        },
        input: {
          category: "home",
          label: "",
          latitude: 28.6139,
          longitude: 77.209,
          address: "Kartavya Path, New Delhi, Delhi 110001, India",
        },
      }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Save this place" }),
      ).toBeNull(),
    );
    expect(
      window.localStorage.getItem(
        "one_location_saved_location_prompt_v1:user_a",
      ),
    ).toBe("1");

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(
      await screen.findByRole("heading", { name: "Add people" }),
    ).toBeTruthy();
  });

  it("shows the location entry flow even when foreground permission is already granted", async () => {
    mockGetState.mockResolvedValue({
      ...locationState(),
      ownerGrants: [],
    });

    render(<OneLocationAgentPage />);

    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    await openLocationPermissionsStep();
    expect(mockRequestLocationPermission).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(
      await screen.findByRole("heading", { name: "Add people" }),
    ).toBeTruthy();
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    vi.useRealTimers();
    expect(
      await screen.findByRole("heading", { name: "Location Agent" }),
    ).toBeTruthy();
    expect(mockCaptureCurrentPosition).not.toHaveBeenCalled();
    // Completing onboarding persists the one-time intro flag.
    expect(
      window.localStorage.getItem("one_location_onboarding_v2:user_a"),
    ).toBe("1");
  });

  it.each(["v1", "v2"])(
    "does not reopen completed %s onboarding when location is blocked",
    async (version) => {
      window.localStorage.setItem(
        `one_location_onboarding_${version}:user_a`,
        "1",
      );
      mockGetPermissionState.mockResolvedValue({
        state: "denied",
        precise: false,
        background: "restricted",
        locationServicesEnabled: true,
      });

      render(<OneLocationAgentPage />);

      expect(
        await screen.findByRole("heading", { name: "Location Agent" }),
      ).toBeTruthy();
      expect(
        screen.queryByRole("heading", {
          name: "Stay connected when you need it.",
        }),
      ).toBeNull();
      expect(
        screen.queryByRole("heading", {
          name: "Share your location easily with anyone.",
        }),
      ).toBeNull();
    },
  );

  it("renders People recommendation metadata without phone-derived labels", async () => {
    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();

    await waitFor(() => expect(mockGetState).toHaveBeenCalled());

    // Populated People tab: no "Trusted Circle" heading — search + person cards shown.
    fireEvent.click(screen.getByRole("button", { name: "People" }));
    expect(await screen.findByText("Trusted B")).toBeTruthy();
    expect(screen.queryByText(/8012|4455|9911/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Now" }));
    expect(screen.getByRole("button", { name: /Active shares/i })).toBeTruthy();
    await openSharePersonStep();
    fireEvent.change(screen.getByPlaceholderText("Search trusted people"), {
      target: { value: "advisor" },
    });

    expect(screen.getAllByText("Advisor C").length).toBeGreaterThan(0);
    expect(
      screen.getAllByText("Invite first to enable sharing").length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText(/8012|4455|9911/)).toBeNull();
  });

  it("shows the entry flow before the main-page loader while state refresh is loading", async () => {
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
        name: "Share your location easily with anyone.",
      }),
    ).toBeTruthy();
    const onboardingShellClass =
      screen.getByRole("main").getAttribute("class") || "";
    expect(onboardingShellClass).toContain("fixed");
    expect(onboardingShellClass).toContain("inset-0");
    expect(onboardingShellClass).toContain("z-[540]");
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBe(0);

    await skipLocationEntryFlow({ expectMain: false });
    // The location page now uses the shared HushhLoader (a pulsing "Loading..."
    // status) instead of the bespoke skeleton, matching every other /one/* page.
    expect(await screen.findByText("Loading location...")).toBeTruthy();
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBe(0);

    resolveState(locationState());

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /^Share location$/i }),
      ).toBeTruthy(),
    );
  });

  it("renders public and private invite controls", async () => {
    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();

    await waitFor(() => expect(mockGetState).toHaveBeenCalled());

    // Populated People tab shows a search bar; invite buttons only appear in the
    // empty state. Invite button assertions are covered by the empty-state test.
    fireEvent.click(screen.getByRole("button", { name: "People" }));
    expect(
      await screen.findByPlaceholderText("Search trusted people"),
    ).toBeTruthy();
    expect(
      screen.queryByRole("heading", { name: "Pending invites" }),
    ).toBeNull();
    // Links tab: "Active links" list + a single "Create a new link" CTA. The
    // mock has no active links, so the empty state shows.
    fireEvent.click(screen.getByRole("button", { name: "Links" }));
    expect(
      await screen.findByRole("button", { name: /Create a new link/i }),
    ).toBeTruthy();
    expect(screen.getByText("Active links")).toBeTruthy();
    expect(screen.getByText("No active links")).toBeTruthy();
    expect(screen.queryByText("Public link responses")).toBeNull();
    expect(screen.queryByText(/Share a public location link/i)).toBeNull();
    expect(screen.queryByText(/whatsapp/i)).toBeNull();
  });

  it("keeps location activity hidden in the compact mobile flow", async () => {
    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();

    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    expect(
      screen.queryByRole("heading", { name: "Location activity" }),
    ).toBeNull();
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
    window.localStorage.setItem("one_location_onboarding_v2:user_b", "1");
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
    expect(
      await screen.findByRole("heading", { name: "Location Agent" }),
    ).toBeTruthy();

    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: /Shared with me/i }));
    expect(
      screen.getByRole("heading", { name: "Shared with me" }),
    ).toBeTruthy();
    await waitFor(() => expect(mockViewEnvelope).toHaveBeenCalled());
    expect(
      await screen.findByText(
        "Location update may be stale. Ask them to refresh sharing.",
      ),
    ).toBeTruthy();

    const mapPreview = screen.getByTitle("Live location map preview");
    expect(mapPreview.getAttribute("src")).toContain(
      "https://www.google.com/maps?q=28.613900%2C77.209000",
    );
    expect(screen.queryAllByText(/Paused · last seen/)).toHaveLength(1);
    expect(screen.queryAllByText(/^Updated /)).toHaveLength(1);
    expect(screen.getByText(/Accuracy \+\/- 18 m/)).toBeTruthy();
    expect(screen.queryByText("Lat")).toBeNull();
    expect(screen.queryByText("Lng")).toBeNull();

    expect(
      screen.queryByRole("link", {
        name: "Open Google Maps directions to shared live location",
      }),
    ).toBeNull();

    const openMapLink = screen.getByRole("link", {
      name: "Open shared location in Google Maps",
    });
    expect(openMapLink.getAttribute("target")).toBe("_blank");
    expect(openMapLink.getAttribute("rel")).toBe("noopener noreferrer");
    expect(openMapLink.getAttribute("href")).toContain(
      "https://www.google.com/maps/search/?api=1&query=28.613900%2C77.209000",
    );

    const viewCallsBeforeCollapse = mockViewEnvelope.mock.calls.length;
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();

    const collapseButton = screen.getByRole("button", {
      name: "Collapse shared location from Trusted A",
    });
    expect(collapseButton.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(collapseButton);

    expect(screen.queryByTitle("Live location map preview")).toBeNull();
    expect(screen.getByText("Trusted A is sharing with you")).toBeTruthy();
    expect(screen.getByRole("button", { name: "View location" })).toBeTruthy();
    const expandButton = screen.getByRole("button", {
      name: "Expand shared location from Trusted A",
    });
    expect(expandButton.getAttribute("aria-expanded")).toBe("false");
    expect(
      window.localStorage.getItem("one_location_unwatched_grants_v1:user_b"),
    ).toBeNull();

    fireEvent.click(expandButton);
    expect(await screen.findByTitle("Live location map preview")).toBeTruthy();
    expect(mockViewEnvelope).toHaveBeenCalledTimes(viewCallsBeforeCollapse);

    // Inline navigation CTAs are omitted from received-share previews. The
    // single "Open map" action remains the deliberate provider handoff.
    expect(
      screen.queryByRole("link", {
        name: "Start Google Maps navigation to shared live location",
      }),
    ).toBeNull();
  });

  it("tracks public location link creation without analytics identity payloads", async () => {
    const longPublicUrl =
      "https://uat.one.hushh.ai/one/location/request/aQluqHFAdgETh91oLTmG6o7v8A6TAB7PmZjrOJwPcIA";
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
    await openTemporaryLinkFlow();
    fireEvent.click(
      screen.getByRole("button", { name: /Review public location link/i }),
    );

    await waitFor(() =>
      expect(mockCreatePublicInvite).toHaveBeenCalledTimes(1),
    );
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
    expect(
      await screen.findByRole("heading", {
        name: "Public location link active",
      }),
    ).toBeTruthy();
    expect(JSON.stringify(mockTrackEvent.mock.calls)).not.toMatch(
      /8012|9911|latitude|longitude|28\.6139|77\.209/u,
    );
  });

  it("creates one encrypted share without exposing phone-derived labels", async () => {
    mockGetState.mockResolvedValue({
      ...locationState(),
      ownerGrants: [],
    });

    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();

    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    await openShareReviewStep();
    fireEvent.click(screen.getByRole("button", { name: /Start sharing/i }));

    await waitFor(() => expect(mockCreateGrant).toHaveBeenCalledTimes(1));
    expect(mockCreateGrant).toHaveBeenCalledWith({
      vaultOwnerToken: "vault-token",
      recipientUserId: "user_b",
      recipientKeyId: "key_b",
      durationHours: 0.25,
      reason: undefined,
      shareKind: "share",
    });
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
        duration_bucket: "15m",
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
    // After a successful share the flow closes and returns to the main hub.
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Active shares/i }),
      ).toBeTruthy(),
    );
    expect(
      screen.queryByRole("heading", { name: "Before you start" }),
    ).toBeNull();
    expect(
      screen.queryByRole("heading", { name: "What are you sharing?" }),
    ).toBeNull();
  });

  it("retries transient foreground publish failures and tracks backoff metadata", async () => {
    mockGetState.mockResolvedValue({
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
    await openShareReviewStep();
    fireEvent.click(screen.getByRole("button", { name: /Start sharing/i }));

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
    await openSharePersonStep();
    // No recipient is auto-selected anymore — select Trusted B explicitly first
    // so the multi-select ordering remains ["user_b", "user_d"].
    fireEvent.click(
      screen.getByRole("button", {
        name: /Select Trusted B for private sharing/i,
      }),
    );
    expect(
      await screen.findByRole("button", {
        name: /Deselect Trusted B for private sharing/i,
      }),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", {
        name: /Select Investor D for private sharing/i,
      }),
    );
    expect(
      await screen.findByRole("button", {
        name: /Deselect Investor D for private sharing/i,
      }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(
      await screen.findByRole("heading", { name: "What are you sharing?" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Review share/i }));
    expect(
      await screen.findByRole("heading", { name: "Before you start" }),
    ).toBeTruthy();
    const people = screen.getByRole("list", {
      name: "People who can see your location",
    });
    expect(within(people).getByText("Trusted B")).toBeTruthy();
    expect(within(people).getByText("Investor D")).toBeTruthy();
    expect(
      screen.queryByText("Access ends automatically after expiry"),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Start sharing/i }));

    await waitFor(() => expect(mockCreateGrant).toHaveBeenCalledTimes(2));
    expect(mockCaptureCurrentPosition).toHaveBeenCalledTimes(1);
    expect(
      mockCreateGrant.mock.calls.map(([payload]) => payload.recipientUserId),
    ).toEqual(["user_b", "user_d"]);
    expect(
      mockCreateGrant.mock.calls.map(([payload]) => payload.durationHours),
    ).toEqual([0.25, 0.25]);
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
    await openSharePersonStep();
    expect(screen.getByText("Advisor C")).toBeTruthy();
    expect(screen.getByText("Invite first to enable sharing")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /Select Advisor C/i }),
    ).toBeNull();
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
    await openAskFlow();
    // No owner is auto-selected anymore — pick Trusted B explicitly first.
    fireEvent.click(
      screen.getByRole("button", {
        name: /Select Trusted B for location request/i,
      }),
    );
    fireEvent.change(
      screen.getByPlaceholderText(
        "Hey, can you share your location until we meet?",
      ),
      {
        target: { value: "Need pickup coordination" },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: /Send request/i }));

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
        screen.getByRole("heading", { name: "Location Agent" }),
      ).toBeTruthy(),
    );
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
    fireEvent.click(screen.getByRole("button", { name: "People" }));
    expect(
      await screen.findByRole("heading", { name: "Requests sent" }),
    ).toBeTruthy();
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
    await openAskFlow();
    // No owner is auto-selected anymore — select Trusted B explicitly first so
    // the multi-select ordering remains ["user_b", "user_d"].
    fireEvent.click(
      screen.getByRole("button", {
        name: /Select Trusted B for location request/i,
      }),
    );
    expect(
      await screen.findByRole("button", {
        name: /Deselect Trusted B for location request/i,
      }),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", {
        name: /Select Investor D for location request/i,
      }),
    );
    expect(
      await screen.findByRole("button", {
        name: /Deselect Investor D for location request/i,
      }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Send request/i }));

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

  it("syncs mobile contact matches without showing phone digits", async () => {
    mockUseRequireAuth.mockReturnValue({
      loading: false,
      isAuthenticated: true,
      userId: "user_a",
      user: {
        uid: "user_a",
        getIdToken: vi.fn().mockResolvedValue("id-token"),
      },
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
    // The populated People tab exposes a compact "Sync contacts" circle action.
    fireEvent.click(screen.getByRole("button", { name: "People" }));
    expect(
      await screen.findByRole("button", { name: /Add Connections/i }),
    ).toBeTruthy();
    fireEvent.click(
      await screen.findByRole("button", { name: /Sync contacts/i }),
    );

    await waitFor(() =>
      expect(mockSyncOneLocationContactSignals).toHaveBeenCalledWith({
        idToken: "id-token",
      }),
    );
    expect(screen.getByText("Investor D")).toBeTruthy();
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
    // The populated People tab exposes a compact "Share to contacts" action.
    fireEvent.click(screen.getByRole("button", { name: "People" }));
    fireEvent.click(
      await screen.findByRole("button", { name: /Share to contacts/i }),
    );

    await waitFor(() =>
      expect(mockCreatePublicInvite).toHaveBeenCalledTimes(1),
    );
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
    mockGetPermissionState.mockResolvedValue({
      state: "denied",
      precise: false,
      background: "unavailable",
      locationServicesEnabled: true,
    });
    mockGetState.mockResolvedValue({
      ...locationState(),
      ownerGrants: [],
    });

    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();

    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    await openShareDetailsStep();
    const shareButton = screen.getByRole("button", {
      name: /Review share/i,
    }) as HTMLButtonElement;
    expect(shareButton.disabled).toBe(true);
    await waitFor(() =>
      expect(mockCaptureCurrentPosition).not.toHaveBeenCalled(),
    );
    expect(mockCreateGrant).not.toHaveBeenCalled();
  });

  it("blocks sharing and opens settings when phone location services are off", async () => {
    mockGetPermissionState.mockResolvedValue({
      state: "unavailable",
      precise: false,
      background: "foreground-only",
      locationServicesEnabled: false,
    });
    mockGetState.mockResolvedValue({
      ...locationState(),
      ownerGrants: [],
    });

    render(<OneLocationAgentPage />);

    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    await openLocationPermissionsStep();
    await waitFor(() => expect(mockOpenLocationSettings).toHaveBeenCalled());
    expect(
      screen.getByText(/adjust permissions later in Location Settings/i),
    ).toBeTruthy();
    expect(mockCreateGrant).not.toHaveBeenCalled();
    expect(mockStoreEnvelope).not.toHaveBeenCalled();
  });

  it("keeps People empty states visible when no candidates exist", async () => {
    mockGetState.mockResolvedValue({
      ...locationState(),
      recipients: [],
      ownerGrants: [],
    });

    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();

    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    await switchLocationTab("People", "Trusted Circle");
    // Empty state keeps connection management and invite/sync/share actions.
    // "Ask someone to share" is populated-state-only, and the redundant
    // approval explainer must not add another card below these actions.
    expect(
      screen.getByRole("button", { name: /Add Connections/i }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Invite trusted person/i }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /Sync contacts/i })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Share to contacts/i }),
    ).toBeTruthy();
    expect(screen.queryByText(/Ask someone to share/)).toBeNull();
    expect(
      screen.queryByText(/Private sharing starts after approval/i),
    ).toBeNull();

    mockRouterPush.mockClear();
    fireEvent.click(
      screen.getByRole("button", { name: /Add Connections/i }),
    );
    expect(mockRouterPush).toHaveBeenCalledWith("/one/connect");

    fireEvent.click(screen.getByRole("button", { name: "Links" }));
    expect(
      await screen.findByRole("button", { name: /Create a new link/i }),
    ).toBeTruthy();
  });

  it("defers a missing vault owner token to the canonical route gate", async () => {
    mockUseVault.mockReturnValue({
      isVaultUnlocked: false,
      vaultOwnerToken: null,
    });

    render(<OneLocationAgentPage />);

    await waitFor(() => {
      expect(
        screen.queryByText(
          /unlock your vault before loading location sharing/i,
        ),
      ).toBeNull();
      expect(mockRegisterKey).not.toHaveBeenCalled();
      expect(mockGetState).not.toHaveBeenCalled();
    });
  });
});
