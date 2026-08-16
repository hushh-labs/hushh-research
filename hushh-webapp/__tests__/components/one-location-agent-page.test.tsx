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

import { ApiError } from "@/lib/services/api-client";

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
  mockBusGetState,
  mockBusEnsure,
  mockReverseGeocode,
  mockPlacesAutocomplete,
  mockPlaceDetails,
  mockGetMapState,
  mockGetMapPreferences,
  mockUpdateMapPreferences,
  mockAddSavedLocation,
  mockLoadSavedLocations,
  mockStageSavedLocation,
  mockClearSavedLocation,
  mockClearPreVaultForUser,
  mockCreateGrant,
  mockStoreEnvelope,
  mockViewEnvelope,
  mockRevokeGrant,
  mockShortenGrant,
  mockRequestAccess,
  mockCreatePublicInvite,
  mockCreateCircleInvite,
  mockGetActivity,
  mockGetState,
  mockGetNearbyPresence,
  mockCheckoutNearby,
  mockSyncCurrentUser,
  mockSyncOneLocationContactSignals,
  mockSearchConnectionDirectory,
  mockListConnections,
  mockSendConnectionRequest,
  mockTrackEvent,
  mockRouterPush,
  mockRouterReplace,
  mockRouterBack,
  mockUseSearchParams,
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
  mockBusGetState: vi.fn(),
  mockBusEnsure: vi.fn(),
  mockReverseGeocode: vi.fn(),
  mockPlacesAutocomplete: vi.fn(),
  mockPlaceDetails: vi.fn(),
  mockGetMapState: vi.fn(),
  mockGetMapPreferences: vi.fn(),
  mockUpdateMapPreferences: vi.fn(),
  mockAddSavedLocation: vi.fn(),
  mockLoadSavedLocations: vi.fn(),
  mockStageSavedLocation: vi.fn(),
  mockClearSavedLocation: vi.fn(),
  mockClearPreVaultForUser: vi.fn(),
  mockCreateGrant: vi.fn(),
  mockStoreEnvelope: vi.fn(),
  mockViewEnvelope: vi.fn(),
  mockRevokeGrant: vi.fn(),
  mockShortenGrant: vi.fn(),
  mockRequestAccess: vi.fn(),
  mockCreatePublicInvite: vi.fn(),
  mockCreateCircleInvite: vi.fn(),
  mockGetActivity: vi.fn(),
  mockGetState: vi.fn(),
  mockGetNearbyPresence: vi.fn(),
  mockCheckoutNearby: vi.fn(),
  mockSyncCurrentUser: vi.fn(),
  mockSyncOneLocationContactSignals: vi.fn(),
  mockSearchConnectionDirectory: vi.fn(),
  mockListConnections: vi.fn(),
  mockSendConnectionRequest: vi.fn(),
  mockTrackEvent: vi.fn(),
  mockRouterPush: vi.fn(),
  mockRouterReplace: vi.fn(),
  mockRouterBack: vi.fn(),
  mockUseSearchParams: vi.fn(),
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
  useSearchParams: mockUseSearchParams,
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

vi.mock("@/components/one-location/onboarding/location-picker-map", () => ({
  LocationPickerMap: ({
    onConfirm,
    onCancel,
    confirmLabel,
    cancelLabel,
  }: {
    onConfirm: (picked: {
      latitude: number;
      longitude: number;
      address: string;
    }) => void;
    onCancel: () => void;
    confirmLabel: string;
    cancelLabel: string;
  }) => (
    <div aria-label="Mock location picker">
      <button
        type="button"
        onClick={() =>
          onConfirm({
            latitude: 28.6139,
            longitude: 77.209,
            address: "Kartavya Path, New Delhi, Delhi 110001, India",
          })
        }
      >
        {confirmLabel}
      </button>
      <button type="button" onClick={onCancel}>
        {cancelLabel}
      </button>
    </div>
  ),
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
    viewportMinHeight,
    heightMode,
  }: {
    children: ReactNode;
    options: readonly { label: string; value: string }[];
    activeValue: string;
    onSelectionChange?: (value: string) => void;
    viewportMinHeight?: string;
    heightMode?: "max" | "active";
  }) => {
    const activeIndex = options.findIndex(({ value }) => value === activeValue);
    const activeChild = Children.toArray(children)[activeIndex];

    return (
      <div
        data-testid="location-swipe-views"
        data-viewport-min-height={viewportMinHeight}
        data-height-mode={heightMode ?? "max"}
      >
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
  // Mirrors the real export. The page reads this constant inside its view-error
  // handler, so omitting it made every recipient-side failure path throw a
  // vitest "no export is defined" error from inside the catch block — which
  // Promise.allSettled then swallowed, hiding the whole branch from these tests.
  RECIPIENT_KEY_UNAVAILABLE_MESSAGE:
    "Recipient key unavailable for this location share.",
  ensureVaultSyncedRecipientKey: vi.fn(async () => {}),
}));

// The live publisher reads the shared position store rather than reaching the
// device itself, so the store is what these tests have to stand up. Left
// permanently "ready" with a fix measured now: that is the state a session with
// a running movement watch is in, and it is the precondition for every publish
// assertion below.
vi.mock("@/lib/one-location/location-bus", () => ({
  LocationBus: {
    getState: mockBusGetState,
    ensure: mockBusEnsure,
    subscribe: vi.fn(() => () => {}),
    watch: vi.fn().mockResolvedValue(() => {}),
    attachUser: vi.fn().mockResolvedValue(undefined),
    syncPermission: vi.fn().mockResolvedValue("granted"),
    request: vi.fn(),
    invalidate: vi.fn(),
    getLastCaptureError: vi.fn(() => null),
    __resetForTests: vi.fn(),
  },
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
    getNearbyPresence: mockGetNearbyPresence,
    checkoutNearby: mockCheckoutNearby,
    createGrant: mockCreateGrant,
    storeEnvelope: mockStoreEnvelope,
    captureCurrentPosition: mockCaptureCurrentPosition,
    reverseGeocode: mockReverseGeocode,
    placesAutocomplete: mockPlacesAutocomplete,
    placeDetails: mockPlaceDetails,
    getMapState: mockGetMapState,
    getMapPreferences: mockGetMapPreferences,
    updateMapPreferences: mockUpdateMapPreferences,
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
    shortenGrant: mockShortenGrant,
    requestAccess: mockRequestAccess,
    approveRequest: vi.fn(),
    denyRequest: vi.fn(),
    referRecipient: vi.fn(),
    createPublicInvite: mockCreatePublicInvite,
    createCircleInvite: mockCreateCircleInvite,
    revokePublicInvite: vi.fn(),
    revokeCircleInvite: vi.fn(),
    // Named-circle surface: the mandatory onboarding invite screen
    // find-or-creates the user's first owned Circle and issues its
    // member-visible invite code before the people step opens.
    listCircles: vi.fn().mockResolvedValue([]),
    getCircle: vi.fn(),
    createNamedCircle: vi.fn().mockResolvedValue({
      id: "circle_onboarding",
      name: "Test's Circle",
      kind: "family",
      role: "owner",
      memberCount: 1,
      memberLimit: 8,
      members: [],
      activeInviteCode: null,
    }),
    updateNamedCircle: vi.fn(),
    deleteNamedCircle: vi.fn(),
    createNamedCircleInviteCode: vi.fn().mockResolvedValue({
      id: "invite_code_1",
      circleId: "circle_onboarding",
      code: "HUSHH123",
      expiresAt: "2026-05-23T07:30:00.000Z",
    }),
    revokeNamedCircleInviteCode: vi.fn(),
    resolveNamedCircleCode: vi.fn(),
    joinNamedCircle: vi.fn(),
    leaveNamedCircle: vi.fn(),
    removeNamedCircleMember: vi.fn(),
    listNamedCircleEligibleConnections: vi.fn(),
    createNamedCircleMemberInvites: vi.fn(),
    listNamedCircleMemberInvites: vi.fn().mockResolvedValue([]),
    acceptNamedCircleMemberInvite: vi.fn(),
    declineNamedCircleMemberInvite: vi.fn(),
    cancelNamedCircleMemberInvite: vi.fn(),
    addSmsContact: vi.fn(),
    removeSmsContact: vi.fn(),
    routeEta: vi.fn(),
    createGrantWithEnvelope: vi.fn(),
  },
}));

vi.mock("@/lib/one-location/saved-locations", () => ({
  DuplicateSavedLocationError: class extends Error {},
  addSavedLocation: mockAddSavedLocation,
  loadSavedLocations: mockLoadSavedLocations,
  // Real behaviour, not a stub: the save sheet opens on whatever this returns,
  // and a stub would hide a label being pre-selected over a saved place.
  defaultSavedLocationCategory: (
    existing: ReadonlyArray<{ category: string }> = [],
  ) => {
    const taken = new Set(existing.map((location) => location.category));
    if (!taken.has("home")) return "home";
    if (!taken.has("work")) return "work";
    return "other";
  },
}));

vi.mock("@/lib/services/pre-vault-sensitive-draft-service", () => ({
  PreVaultSensitiveDraftService: {
    stageSavedLocation: mockStageSavedLocation,
    clearSavedLocation: mockClearSavedLocation,
    clearForUser: mockClearPreVaultForUser,
  },
}));

vi.mock("@/lib/one-location/contact-signals", () => ({
  OneLocationContactSyncError: class OneLocationContactSyncError extends Error {
    failure: unknown;

    constructor(failure: unknown) {
      super("Contact sync failed");
      this.failure = failure;
    }
  },
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
import { appInteractionCoordinator } from "@/lib/interaction/interaction-intent-coordinator";
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
      name: "Need to keep people updated?",
    }),
  ).toBeTruthy();
}

/** Assert the invite screen is showing. It is the last screen now. */
async function expectLocationInviteStep() {
  expect(
    await screen.findByRole("heading", { name: /You're on the map/ }),
  ).toBeTruthy();
}

/** The terminal CTA. Its label names the destination, which differs by mode. */
function locationFinishButton() {
  return screen.findByRole("button", { name: /Open One Location|Finish/ });
}

/** welcome -> features (clearing the save-place modal) -> invite. */
async function reachLocationOnboardingFinalStep() {
  await openLocationFeatureStep();
  await waitFor(() => {
    const savePrompt = screen.queryByTestId("save-location-modal");
    const continueButton = screen.queryByRole("button", {
      name: /Find my people|Allow location/,
    });
    expect(savePrompt || continueButton).toBeTruthy();
  });
  const savePrompt = screen.queryByTestId("save-location-modal");
  if (savePrompt) {
    fireEvent.click(
      within(savePrompt).getByRole("button", { name: "Skip for now" }),
    );
  }
  const continueButton = await screen.findByRole("button", {
    name: /Find my people|Allow location/,
  });
  await waitFor(() => expect(continueButton).toBeEnabled());
  fireEvent.click(continueButton);
  // No contacts step here: jsdom has no Contact Picker, so the capability check
  // reports "unavailable" and the flow skips it -- exactly what a desktop
  // browser does. The engaged path is covered in the flow component's tests.
  await expectLocationInviteStep();
  expect(screen.getByRole("button", { name: "Go back" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Skip" })).toBeEnabled();
}

/**
 * Walk welcome -> features and press the CTA, clearing the save-place modal,
 * without asserting where it lands. Used by tests that care about whether the
 * contacts step appears at all.
 */
async function leaveLocationFeatureStep() {
  await openLocationFeatureStep();
  await waitFor(() => {
    const savePrompt = screen.queryByTestId("save-location-modal");
    const continueButton = screen.queryByRole("button", {
      name: /Find my people|Allow location/,
    });
    expect(savePrompt || continueButton).toBeTruthy();
  });
  const savePrompt = screen.queryByTestId("save-location-modal");
  if (savePrompt) {
    fireEvent.click(
      within(savePrompt).getByRole("button", { name: "Skip for now" }),
    );
  }
  const continueButton = await screen.findByRole("button", {
    name: /Find my people|Allow location/,
  });
  await waitFor(() => expect(continueButton).toBeEnabled());
  fireEvent.click(continueButton);
}

/** Reach the last screen and press the CTA that settles onboarding. */
async function finishLocationOnboarding() {
  await reachLocationOnboardingFinalStep();
  const finish = await locationFinishButton();
  await waitFor(() => expect(finish).toBeEnabled());
  fireEvent.click(finish);
}

async function skipLocationEntryFlow(options: { expectMain?: boolean } = {}) {
  await finishLocationOnboarding();

  // Completion settles asynchronously now that it is driven by a press rather
  // than a timer. Wait for the overlay to actually unmount, or callers assert
  // against a workspace that is still behind it.
  if (options.expectMain !== false) {
    await waitFor(() =>
      expect(screen.queryByTestId("one-location-onboarding")).toBeNull(),
    );
  }

  if (options.expectMain !== false) {
    expect(
      await screen.findByRole("heading", { name: "Location Agent" }),
    ).toBeTruthy();
  }

  // Tests after this helper exercise workspace actions. Ignore the deliberate
  // onboarding picker capture so their assertions count only the action under
  // test (share, request, Nearby, emergency, and public-link flows).
  mockCaptureCurrentPosition.mockClear();
}

/**
 * Hold the next device fix open and hand back its release. Lets a test assert
 * what the UI does DURING the capture — the window the Location switch used to
 * spend frozen. Call it after `skipLocationEntryFlow`, which needs a real fix
 * of its own to get through the entry picker.
 */
function holdNextCapture(): () => void {
  let release: (() => void) | null = null;
  mockCaptureCurrentPosition.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = () =>
          resolve({
            latitude: 28.6139,
            longitude: 77.209,
            accuracyM: 12,
            capturedAt: "2026-07-31T00:00:00.000Z",
            sourcePlatform: "web",
          });
      }),
  );
  return () => {
    if (!release) throw new Error("No capture was in flight to release.");
    release();
  };
}

async function expectEmergencyAction(
  number: string,
  countryName: string,
): Promise<HTMLElement> {
  const linkName = new RegExp(
    `Call ${number} emergency services \\(${countryName}\\)`,
    "i",
  );
  const copyName = new RegExp(
    `Copy ${number} emergency services \\(${countryName}\\)`,
    "i",
  );

  await waitFor(() => {
    expect(
      screen.queryByRole("link", { name: linkName }) ||
        screen.queryByRole("button", { name: copyName }),
    ).not.toBeNull();
  });

  const link = screen.queryByRole("link", { name: linkName });
  if (link) {
    expect(link).toHaveAttribute("href", `tel:${number}`);
    return link;
  }

  const copyButton = screen.getByRole("button", { name: copyName });
  expect(copyButton).toBeEnabled();
  return copyButton;
}

async function openLocationPermissionsStep() {
  await openLocationFeatureStep();
}

async function switchLocationTab(
  name: "Menu" | "People" | "Links",
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

// Details and the old separate consent check are ONE step now: "Ready to
// share?" carries the duration, the note, and the live read-back of who can see
// you, so there is no navigation between setting a value and confirming it.
async function openShareConfirmStep() {
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
    await screen.findByRole("heading", { name: "Ready to share?" }),
  ).toBeTruthy();
}

async function openAskFlow() {
  fireEvent.click(screen.getByRole("button", { name: /Request location/i }));
  expect(
    await screen.findByRole("heading", { name: "Request location" }),
  ).toBeTruthy();
}

async function openTemporaryLinkFlow() {
  fireEvent.click(screen.getByRole("button", { name: "Links" }));
  fireEvent.click(
    await screen.findByRole("button", { name: /Create link/i }),
  );
  expect(
    await screen.findByRole("heading", { name: "Share outside your Circle" }),
  ).toBeTruthy();
}

describe("OneLocationAgentPage", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // The shared store, holding a fix measured now — what a session with a
    // live movement watch looks like, and the precondition for the publisher.
    const busSnapshot = {
      latitude: 28.6139,
      longitude: 77.209,
      accuracyM: 12,
      capturedAt: new Date().toISOString(),
      sourcePlatform: "web" as const,
    };
    mockBusGetState.mockReturnValue({
      status: "ready",
      permission: "granted",
      snapshot: busSnapshot,
      snapshotOrigin: "fresh",
      error: null,
    });
    mockBusEnsure.mockResolvedValue(busSnapshot);
    Element.prototype.scrollIntoView = vi.fn();
    window.localStorage.clear();
    // Most page-flow tests are not about the optional saved-place prompt.
    // A dedicated integration test below clears this outcome and proves it.
    window.localStorage.setItem(
      "one_location_saved_location_prompt_v1:user_a",
      "1",
    );
    window.localStorage.setItem(
      "one_location_saved_location_prompt_v2:user_a",
      "skipped",
    );
    // The workspace now seeds from the memory-only OneLocationStateResource
    // (CacheService singleton); clear it so a prior test's server-state
    // snapshot cannot leak into the next test's initial render.
    const { CacheService } = await import("@/lib/services/cache-service");
    CacheService.getInstance().clear();
    const { forgetOneLocationControlPreference } =
      await import("@/lib/one-location/location-control-state");
    forgetOneLocationControlPreference("user_a");
    // The workspace's decrypted points and last self fix live in a module-level
    // store too, and it was the one the reset above missed: a coarse point left
    // by an earlier test carried into the next one's first render and showed as
    // that test's own state.
    const { clearAllLocationWorkspaceMemory } =
      await import("@/lib/one-location/location-workspace-memory");
    clearAllLocationWorkspaceMemory();
    mockSearchParams.toString = () => "";
    mockSearchParamsGet.mockReturnValue(null);
    mockUseSearchParams.mockReturnValue(mockSearchParams);
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
    mockPlacesAutocomplete.mockResolvedValue([
      {
        placeId: "hushh-office",
        text: "Hushh Office, Bengaluru",
      },
    ]);
    mockPlaceDetails.mockResolvedValue({
      placeId: "hushh-office",
      label: "Hushh Office, Bengaluru, Karnataka, India",
      latitude: 12.9716,
      longitude: 77.5946,
    });
    mockGetMapState.mockResolvedValue({
      preferences: {
        presenceMode: "ghost",
        rendererConsentVersion: "google-maps-renderer-v1",
      },
      freshnessSeconds: 60,
      markers: [],
    });
    mockGetMapPreferences.mockResolvedValue({
      presenceMode: "ghost",
      rendererConsentVersion: "google-maps-renderer-v1",
    });
    mockUpdateMapPreferences.mockResolvedValue({
      presenceMode: "ghost",
      rendererConsentVersion: "google-maps-renderer-v1",
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
    mockLoadSavedLocations.mockResolvedValue([
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
    mockShortenGrant.mockResolvedValue({});
    mockRequestAccess.mockResolvedValue({});
    mockCopyToClipboard.mockResolvedValue(true);
    mockCreatePublicInvite.mockResolvedValue({
      publicUrl: "/one/location/request/invite_1",
    });
    mockGetState.mockResolvedValue(locationState());
    mockGetNearbyPresence.mockResolvedValue({
      presence: null,
      attendees: [],
    });
    mockCheckoutNearby.mockResolvedValue({
      presence: null,
      attendees: [],
    });
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
    // "agent", not "reading": the workspace shell was widened in the component
    // and this selector was never updated, so it has been failing on main
    // independently of this change. The assertions below are the point of the
    // test and are unchanged.
    const pageShell = document.querySelector<HTMLElement>(
      '[data-app-shell-width="agent"]',
    );
    expect(pageShell).toBeTruthy();
    expect(pageShell?.className).not.toContain("--app-bottom-fixed-ui");
    expect(pageShell?.className).not.toMatch(/\b(?:sm:|md:)?pb-/u);
    expect(screen.getByTestId("location-swipe-views")).toHaveAttribute(
      "data-viewport-min-height",
      "0px",
    );
    expect(screen.getByTestId("location-swipe-views")).toHaveAttribute(
      "data-height-mode",
      "active",
    );
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

  it("keeps every counted Now-hub row neutral while its count is zero", async () => {
    // State beats category. Colour on these three rows means "there is
    // something here", never "this row exists" — an empty Location screen
    // reporting 0, 0, 0 in three saturated tiles spends colour on nothing and
    // leaves none for the rows that do carry state.
    mockGetState.mockResolvedValue({
      ...locationState(),
      ownerGrants: [],
      receivedGrants: [],
      requests: [],
    });
    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();
    await waitFor(() => expect(mockGetState).toHaveBeenCalled());

    const toneOf = async (title: string) => {
      const row = (await screen.findByText(title)).closest(
        '[data-slot="settings-row"], button, a, div[role="button"]',
      );
      return row
        ?.querySelector('[data-slot="settings-row-icon"]')
        ?.getAttribute("data-icon-tone");
    };

    expect(await toneOf("Active shares")).toBe("gray");
    expect(await toneOf("Shared with me")).toBe("gray");
    expect(await toneOf("Needs my review")).toBe("gray");
  });

  it("colours each counted Now-hub row by its own state once it is non-zero", async () => {
    // Green = sharing is live (same family as the header switch and Check-In),
    // indigo = other people, orange = something is waiting on you. Each row
    // reads its OWN count, so one being populated must not colour the others.
    mockGetState.mockResolvedValue({
      ...locationState(),
      receivedGrants: [
        {
          id: "grant_in",
          ownerUserId: "user_b",
          recipientUserId: "user_a",
          ownerDisplayName: "Trusted B",
          recipientKeyId: "key_a",
          status: "active",
          consentScope: "cap.location.live.view",
          capabilityScopes: ["cap.location.live.view"],
          durationHours: 1,
          expiresAt: "2099-05-20T08:00:00.000Z",
        },
      ],
      requests: [
        {
          id: "request_1",
          ownerUserId: "user_a",
          requesterUserId: "user_b",
          status: "pending",
          requestedAt: "2026-05-20T07:30:00.000Z",
        },
      ],
    });
    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();
    await waitFor(() => expect(mockGetState).toHaveBeenCalled());

    const toneOf = async (title: string) => {
      const row = (await screen.findByText(title)).closest(
        '[data-slot="settings-row"], button, a, div[role="button"]',
      );
      return row
        ?.querySelector('[data-slot="settings-row-icon"]')
        ?.getAttribute("data-icon-tone");
    };

    // locationState() already carries one active ownerGrant.
    expect(await toneOf("Active shares")).toBe("green");
    expect(await toneOf("Shared with me")).toBe("indigo");
    expect(await toneOf("Needs my review")).toBe("orange");
  });

  it("keeps the heading and location toggle inline as the only header action", async () => {
    mockGetState.mockResolvedValue({
      ...locationState(),
      ownerGrants: [],
    });
    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();

    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    const headerActions = screen.getByRole("group", {
      name: "Location",
    });
    expect(headerActions.className).toContain("ml-auto");
    expect(headerActions.className).toContain("justify-end");
    expect(headerActions.className).toContain("max-w-full");
    expect(
      screen.queryByRole("button", { name: "Refresh location" }),
    ).toBeNull();

    const heading = screen.getByRole("heading", { name: "Location Agent" });
    const headerRow = heading.closest('[data-slot="page-header-row"]');
    expect(headerRow).toBeTruthy();
    expect(headerRow).toHaveClass("flex", "items-start", "justify-between");
    expect(heading).toHaveClass("ui-text-agent-title");
    expect(
      headerRow?.contains(
        screen.getByRole("switch", { name: "Turn location on" }),
      ),
    ).toBe(true);
    expect(
      screen.getByRole("switch", { name: "Turn location on" }),
    ).toHaveAttribute("data-size", "ios");
    // The status text is the ONLY thing on this screen that says what the
    // switch is for, so it has to render at every width. It used to be
    // `hidden … sm:inline` + aria-hidden, i.e. present on a desktop browser and
    // absent from every iPhone and from VoiceOver — which is exactly what QA
    // hit ("location toggle kis liye hai? iOS pe how user gonna find that?").
    const locationStatus = screen.getByTestId("one-location-header-status");
    expect(locationStatus.className).not.toContain("hidden");
    // Two forms of the same state, one per breakpoint, and NEITHER is hidden at
    // every width the way the old single `hidden … sm:inline` span was. Phones
    // get the one-word form because the 28px title has no width to spare there
    // (the full string measured two title lines at 320/360/375/390); from `sm`
    // up the full string renders inline exactly as it does today.
    const compact = locationStatus.querySelector(".sm\\:hidden");
    const full = locationStatus.querySelector(".hidden.sm\\:inline");
    expect(compact?.textContent).toBe("Off");
    expect(full?.textContent).toBe("Location off");
    expect(locationStatus).not.toHaveAttribute("aria-hidden");
    expect(
      screen.getByRole("switch", { name: "Turn location on" }),
    ).toHaveAttribute("aria-describedby", locationStatus.id);
    expect(locationStatus.className).toContain(
      "text-[color:var(--app-secondary-label)]",
    );
    expect(headerActions.innerHTML).not.toContain("--app-neutral-fill");

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
    expect(screen.getByText("Location paused")).toBeTruthy();
    expect(mockRevokeGrant).not.toHaveBeenCalled();
  });

  it("keeps the header, Pause setting, and active Nearby presence synchronized", async () => {
    mockGetState.mockResolvedValue({
      ...locationState(),
      ownerGrants: [],
    });
    mockGetNearbyPresence.mockResolvedValue({
      presence: {
        status: "active",
        audience: "all_opted_in",
        radiusMeters: 500,
        allowConnectionRequests: true,
        consentVersion: "one-location-nearby-presence-v3",
        checkedInAt: "2026-07-31T00:00:00.000Z",
        expiresAt: "2026-07-31T01:00:00.000Z",
        placeLabel: "Event venue",
      },
      attendees: [],
    });

    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();

    await waitFor(() =>
      expect(
        screen.getByRole("switch", { name: "Turn location off" }),
      ).toHaveAttribute("aria-checked", "true"),
    );

    fireEvent.click(screen.getByRole("button", { name: /^Settings$/i }));
    const pauseSwitch = await screen.findByRole("switch", {
      name: "Pause my location",
    });
    const autoApproveSwitch = screen.getByRole("switch", {
      name: "Auto-approve requests",
    });
    expect(pauseSwitch).toHaveAttribute("aria-checked", "false");
    // Off until asked for: approving a location request is consent, and a
    // default may not give it.
    expect(autoApproveSwitch).toHaveAttribute("aria-checked", "false");

    fireEvent.click(autoApproveSwitch);
    expect(autoApproveSwitch).toHaveAttribute("aria-checked", "true");

    fireEvent.click(pauseSwitch);
    await waitFor(() => expect(mockCheckoutNearby).toHaveBeenCalled());
    await waitFor(() =>
      expect(pauseSwitch).toHaveAttribute("aria-checked", "true"),
    );
    expect(autoApproveSwitch).toHaveAttribute("aria-checked", "true");

    mockCaptureCurrentPosition.mockClear();
    fireEvent.click(pauseSwitch);
    await waitFor(() => expect(mockCaptureCurrentPosition).toHaveBeenCalled());
    await waitFor(() =>
      expect(pauseSwitch).toHaveAttribute("aria-checked", "false"),
    );
    expect(autoApproveSwitch).toHaveAttribute("aria-checked", "true");
  });

  it("does not claim Location is paused when Nearby checkout fails", async () => {
    mockGetState.mockResolvedValue({
      ...locationState(),
      ownerGrants: [],
    });
    mockGetNearbyPresence.mockResolvedValue({
      presence: {
        status: "active",
        audience: "all_opted_in",
        radiusMeters: 500,
        allowConnectionRequests: true,
        consentVersion: "one-location-nearby-presence-v3",
        checkedInAt: "2026-07-31T00:00:00.000Z",
        expiresAt: "2026-07-31T01:00:00.000Z",
        placeLabel: "Event venue",
      },
      attendees: [],
    });
    mockCheckoutNearby.mockRejectedValue(new Error("checkout unavailable"));

    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();
    await waitFor(() =>
      expect(
        screen.getByRole("switch", { name: "Turn location off" }),
      ).toHaveAttribute("aria-checked", "true"),
    );

    fireEvent.click(screen.getByRole("button", { name: /^Settings$/i }));
    const pauseSwitch = await screen.findByRole("switch", {
      name: "Pause my location",
    });
    fireEvent.click(pauseSwitch);

    await waitFor(() => expect(mockCheckoutNearby).toHaveBeenCalled());
    // The optimistic toggle reverts a render after the rejection resolves, so
    // this has to be waited for rather than read on the same tick. It passed
    // before only because onboarding left fake timers draining behind it.
    await waitFor(() =>
      expect(pauseSwitch).toHaveAttribute("aria-checked", "false"),
    );
  });

  it("keeps Pause enabled when resuming cannot capture a fresh point", async () => {
    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();
    await waitFor(() =>
      expect(
        screen.getByRole("switch", { name: "Turn location off" }),
      ).toHaveAttribute("aria-checked", "true"),
    );

    fireEvent.click(screen.getByRole("switch", { name: "Turn location off" }));
    await waitFor(() =>
      expect(screen.getByText("Location paused")).toBeTruthy(),
    );

    mockCaptureCurrentPosition.mockClear();
    mockCaptureCurrentPosition.mockRejectedValue(
      new Error("fresh location unavailable"),
    );
    fireEvent.click(screen.getByRole("button", { name: /^Settings$/i }));
    const pauseSwitch = await screen.findByRole("switch", {
      name: "Pause my location",
    });
    fireEvent.click(pauseSwitch);

    await waitFor(() => expect(mockCaptureCurrentPosition).toHaveBeenCalled());
    expect(pauseSwitch).toHaveAttribute("aria-checked", "true");
  });

  it("shows a limited status when the captured point is too approximate for Nearby", async () => {
    mockGetState.mockResolvedValue({
      ...locationState(),
      ownerGrants: [],
    });
    mockCaptureCurrentPosition.mockResolvedValue({
      latitude: 28.6139,
      longitude: 77.209,
      accuracyM: 240,
      capturedAt: "2026-07-31T00:00:00.000Z",
      sourcePlatform: "web",
    });

    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();

    fireEvent.click(screen.getByRole("switch", { name: "Turn location on" }));
    await waitFor(() =>
      expect(screen.getByText("Location limited")).toBeTruthy(),
    );
    expect(
      screen.getByRole("switch", { name: "Turn location off" }),
    ).toHaveAttribute("aria-checked", "true");
  });

  // The Location on/off control is a preference over LOCAL state. Every one of
  // these tests holds the slow half — the device fix, the nearby write — open
  // and asserts the switch has already moved. Turning any of them back into
  // "await the network, then render" is the regression they exist to catch.
  it("moves the switch on tap instead of waiting for the device fix", async () => {
    mockGetState.mockResolvedValue({ ...locationState(), ownerGrants: [] });

    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();

    // Held open only from here: entry onboarding needs a real capture first.
    const releaseFix = holdNextCapture();
    fireEvent.click(
      await screen.findByRole("switch", { name: "Turn location on" }),
    );

    // The fix is still outstanding here. The switch is on regardless, and the
    // status — not a disabled control — carries the fact that we are waiting.
    await waitFor(() =>
      expect(
        screen.getByRole("switch", { name: "Turn location off" }),
      ).toHaveAttribute("aria-checked", "true"),
    );
    expect(screen.getByText("Finding you…")).toBeTruthy();
    expect(
      screen.getByRole("switch", { name: "Turn location off" }),
    ).not.toBeDisabled();

    await act(async () => {
      releaseFix();
    });
    await waitFor(() => expect(screen.getByText("Location on")).toBeTruthy());
  });

  it("does not let a late fix undo a pause made while it was in flight", async () => {
    mockGetState.mockResolvedValue({ ...locationState(), ownerGrants: [] });

    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();

    const releaseFix = holdNextCapture();
    fireEvent.click(
      await screen.findByRole("switch", { name: "Turn location on" }),
    );
    const onSwitch = await screen.findByRole("switch", {
      name: "Turn location off",
    });
    fireEvent.click(onSwitch);
    await waitFor(() =>
      expect(screen.getByText("Location paused")).toBeTruthy(),
    );

    // The fix belongs to an intent the person has already replaced. Applying it
    // would silently turn location back on after they turned it off.
    await act(async () => {
      releaseFix();
    });
    expect(
      screen.getByRole("switch", { name: "Turn location on" }),
    ).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText("Location paused")).toBeTruthy();
  });

  it("pauses the device without waiting on, or first probing, nearby presence", async () => {
    mockGetState.mockResolvedValue({ ...locationState(), ownerGrants: [] });
    mockGetNearbyPresence.mockResolvedValue({
      presence: {
        status: "active",
        audience: "all_opted_in",
        radiusMeters: 500,
        allowConnectionRequests: true,
        consentVersion: "one-location-nearby-presence-v3",
        checkedInAt: "2026-07-31T00:00:00.000Z",
        expiresAt: "2026-07-31T01:00:00.000Z",
        placeLabel: "Event venue",
      },
      attendees: [],
    });

    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();
    const onSwitch = await screen.findByRole("switch", {
      name: "Turn location off",
    });
    await waitFor(() => expect(mockGetNearbyPresence).toHaveBeenCalled());

    // Any further presence read hangs. The pause used to read presence and only
    // then check out — two serialized round trips in front of the switch — so a
    // hanging read would strand it. It must not depend on one.
    mockGetNearbyPresence.mockImplementation(() => new Promise(() => {}));
    let releaseCheckout: (() => void) | null = null;
    mockCheckoutNearby.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseCheckout = () => resolve({ presence: null, attendees: [] });
        }),
    );

    fireEvent.click(onSwitch);

    await waitFor(() =>
      expect(screen.getByText("Location paused")).toBeTruthy(),
    );
    await waitFor(() => expect(mockCheckoutNearby).toHaveBeenCalledTimes(1));
    // Still in flight while the device already reads as paused.
    expect(releaseCheckout).not.toBeNull();

    await act(async () => {
      (releaseCheckout as unknown as () => void)();
    });
  });

  it("renders a focused, validated share flow with a 15-minute default", async () => {
    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();

    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    await openSharePersonStep();

    expect(screen.queryByText("Ready for private sharing")).toBeNull();
    expect(screen.getByText("Invite them first")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", {
        name: /Select Trusted B for private sharing/i,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(
      await screen.findByRole("heading", { name: "Ready to share?" }),
    ).toBeTruthy();
    // The precision options are gone: nothing behind them ever coarsened the
    // point, so offering the choice made a privacy promise the share did not
    // keep. Asserting their absence is what stops the dead control returning
    // before there is a real precision mode to attach it to.
    expect(screen.queryByText("Better for privacy and battery life")).toBeNull();
    expect(
      screen.queryByText("Updates while you move for your loved ones"),
    ).toBeNull();
    expect(screen.queryByText("Private by design")).toBeNull();

    // Details and consent now share one screen: the recipient read-back is
    // visible while the duration is still being chosen, so there is no step
    // where the person can set a value they have not seen confirmed.
    const people = screen.getByRole("list", {
      name: "People who can see your location",
    });
    expect(within(people).getByText("Trusted B")).toBeTruthy();

    const duration = screen.getByRole("combobox", { name: "Duration" });
    expect(duration.textContent).toContain("15 min");
    fireEvent.click(duration);
    const options = await screen.findAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "15 min",
      "1 hour",
      "Today",
      "Until I stop",
    ]);
    fireEvent.click(screen.getByRole("option", { name: "1 hour" }));
    expect(duration.textContent).toContain("1 hour");
    // The duration reads back as a clock time on the same screen that set it.
    expect(screen.getByText(/^Sharing ends at /)).toBeTruthy();

    const note = screen.getByRole("textbox", { name: "Optional note" });
    const startButton = screen.getByRole("button", { name: "Start sharing" });
    expect(screen.getByText("0/140")).toBeTruthy();

    fireEvent.change(note, { target: { value: "a".repeat(140) } });
    expect(screen.getByText("140/140")).toBeTruthy();
    expect(startButton).toBeEnabled();
    expect(screen.queryByText("Note is too long")).toBeNull();

    fireEvent.change(note, { target: { value: "a".repeat(141) } });
    expect(screen.getByText("141/140")).toBeTruthy();
    expect(screen.getByText("Note is too long")).toBeTruthy();
    expect(startButton).toBeDisabled();

    fireEvent.change(note, { target: { value: "On my way" } });
    expect(screen.getByText("9/140")).toBeTruthy();
    expect(screen.queryByText("Note is too long")).toBeNull();
    expect(startButton).toBeEnabled();

    expect(
      screen.queryByText("Access ends automatically after expiry"),
    ).toBeNull();

    fireEvent.click(startButton);
    await waitFor(() => expect(mockCreateGrant).toHaveBeenCalledTimes(1));
    expect(mockCreateGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        durationHours: 1,
        durationMode: "timed",
        reason: "On my way",
        shareKind: "share",
      }),
    );
  });

  it("keeps the selected people and count in sync during one batched share interaction", async () => {
    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();

    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    await openSharePersonStep();

    const trustedButton = screen.getByRole("button", {
      name: /Select Trusted B for private sharing/i,
    });
    const investorButton = screen.getByRole("button", {
      name: /Select Investor D for private sharing/i,
    });

    act(() => {
      fireEvent.click(trustedButton);
      fireEvent.click(investorButton);
    });

    expect(
      screen.getByRole("button", {
        name: /Deselect Trusted B for private sharing/i,
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: /Deselect Investor D for private sharing/i,
      }),
    ).toBeTruthy();
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "one_location_recommendation_selected",
      expect.objectContaining({
        action: "share",
        selection_surface: "section_list",
        selected_count: 2,
      }),
      expect.any(Object),
    );
  });

  it("resets every abandoned share field and ignores a late review preflight", async () => {
    const { rerender } = render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();
    await waitFor(() => expect(mockGetState).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "People" }));
    fireEvent.change(
      await screen.findByPlaceholderText("Search trusted people"),
      { target: { value: "Investor" } },
    );
    fireEvent.click(
      screen.getByRole("button", { name: /Share with Investor D/i }),
    );
    expect(
      await screen.findByRole("heading", { name: "Who can see you?" }),
    ).toBeTruthy();
    expect(screen.getByPlaceholderText("Search trusted people")).toHaveValue(
      "",
    );
    expect(
      screen.getByRole("button", {
        name: /Deselect Investor D for private sharing/i,
      }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "one_location_recommendation_selected",
      expect.objectContaining({
        action: "share",
        selection_surface: "section_list",
        selected_count: 1,
      }),
      expect.any(Object),
    );

    const shareParams = new URLSearchParams("action=share");
    mockUseSearchParams.mockReturnValue(shareParams);
    rerender(<OneLocationAgentPage />);

    fireEvent.change(screen.getByPlaceholderText("Search trusted people"), {
      target: { value: "Trusted" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(
      await screen.findByRole("heading", { name: "Ready to share?" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("combobox", { name: "Duration" }));
    fireEvent.click(screen.getByRole("option", { name: "1 hour" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Optional note" }), {
      target: { value: "Meet me by the entrance" },
    });

    // Back to the people step so the pending permission below is attached to
    // Continue — the one control that now runs the device pre-flight.
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(
      await screen.findByRole("heading", { name: "Who can see you?" }),
    ).toBeTruthy();

    let resolvePermission:
      | ((value: {
          state: "granted";
          precise: true;
          background: "foreground-only";
          locationServicesEnabled: true;
        }) => void)
      | null = null;
    mockGetPermissionState.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePermission = resolve;
        }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    const hubParams = new URLSearchParams();
    mockUseSearchParams.mockReturnValue(hubParams);
    rerender(<OneLocationAgentPage />);
    expect(
      await screen.findByRole("heading", { name: "Location Agent" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "People" }));
    expect(
      await screen.findByPlaceholderText("Search trusted people"),
    ).toHaveValue("Investor");
    fireEvent.click(screen.getByRole("button", { name: "Menu" }));
    fireEvent.click(screen.getByRole("button", { name: /^Share location$/i }));
    expect(
      await screen.findByRole("heading", { name: "Who can see you?" }),
    ).toBeTruthy();

    await act(async () => {
      resolvePermission?.({
        state: "granted",
        precise: true,
        background: "foreground-only",
        locationServicesEnabled: true,
      });
    });
    expect(
      screen.getByRole("heading", { name: "Who can see you?" }),
    ).toBeTruthy();
    expect(screen.getByPlaceholderText("Search trusted people")).toHaveValue(
      "",
    );
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    expect(
      screen.getByRole("button", {
        name: /Select Trusted B for private sharing/i,
      }),
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", {
        name: /Select Trusted B for private sharing/i,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(
      await screen.findByRole("heading", { name: "Ready to share?" }),
    ).toBeTruthy();
    // No precision radios to reset — the reopened flow offers only the fields
    // that actually carry through to the share.
    expect(
      screen.queryByRole("radio", { name: /Precise live location/i }),
    ).toBeNull();
    expect(
      screen.queryByRole("radio", { name: /Approximate area/i }),
    ).toBeNull();
    expect(
      screen.getByRole("combobox", { name: "Duration" }).textContent,
    ).toContain("15 min");
    expect(screen.getByRole("textbox", { name: "Optional note" })).toHaveValue(
      "",
    );
    expect(screen.getByText("0/140")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: /^Share location$/i }));
    expect(
      await screen.findByRole("heading", { name: "Who can see you?" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    expect(mockCreateGrant).not.toHaveBeenCalled();
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
    expect(screen.queryByRole("button", { name: "Manage sharing" })).toBeNull();
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
      await screen.findByRole("heading", { name: "Save my Soul", level: 1 }),
    ).toBeTruthy();
    await waitFor(() =>
      expect(mockCaptureCurrentPosition).toHaveBeenCalledTimes(1),
    );
    expect(mockReverseGeocode).toHaveBeenCalledWith({
      vaultOwnerToken: "vault-token",
      lat: 28.6139,
      lng: 77.209,
    });
    await expectEmergencyAction("112", "India");
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
    await expectEmergencyAction("911", "United States");
  });

  it("shows a locally-confirmed number immediately instead of a spinner", async () => {
    // The whole point of caching WHERE a country was confirmed: arriving at the
    // same place must not re-run "Finding local number" on the one screen where
    // seconds matter. The authoritative lookup still runs behind this.
    window.localStorage.setItem("one_location_onboarding_v2:user_a", "1");
    window.localStorage.setItem(
      "one_location_emergency_info_v1",
      // Exactly where mockCaptureCurrentPosition puts the user.
      JSON.stringify({ countryCode: "IN", lat: 28.6139, lng: 77.209 }),
    );
    mockSearchParams.toString = () => "action=sos";
    mockSearchParamsGet.mockImplementation((name: string) =>
      name === "action" ? "sos" : null,
    );
    // Never resolves: anything on screen came from the cache, not the network.
    mockReverseGeocode.mockImplementation(() => new Promise(() => {}));

    render(<OneLocationAgentPage />);

    expect(
      await screen.findByRole("heading", { name: "Save my Soul", level: 1 }),
    ).toBeTruthy();
    await expectEmergencyAction("112", "India");
    expect(
      screen.queryByRole("button", { name: "Finding local emergency number" }),
    ).toBeNull();
  });

  it("ignores a cached number from a country the user has since left", async () => {
    // Cached in Delhi, standing in New York. Showing 112 here is the failure
    // the origin check exists to prevent: the spinner is the correct state
    // until the authoritative lookup answers.
    window.localStorage.setItem("one_location_onboarding_v2:user_a", "1");
    window.localStorage.setItem(
      "one_location_emergency_info_v1",
      JSON.stringify({ countryCode: "IN", lat: 28.6139, lng: 77.209 }),
    );
    mockCaptureCurrentPosition.mockResolvedValue({
      latitude: 40.7128,
      longitude: -74.006,
      accuracyM: 12,
      capturedAt: "2026-05-20T07:35:00.000Z",
      sourcePlatform: "web",
    });
    mockSearchParams.toString = () => "action=sos";
    mockSearchParamsGet.mockImplementation((name: string) =>
      name === "action" ? "sos" : null,
    );

    let resolveLookup:
      | ((value: {
          name: string | null;
          formattedAddress: string | null;
          countryCode: string | null;
        }) => void)
      | null = null;
    mockReverseGeocode.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveLookup = resolve;
        }),
    );

    render(<OneLocationAgentPage />);

    expect(
      await screen.findByRole("heading", { name: "Save my Soul", level: 1 }),
    ).toBeTruthy();
    expect(
      await screen.findByRole("button", {
        name: "Finding local emergency number",
      }),
    ).toBeDisabled();
    expect(screen.queryByText("112")).toBeNull();

    await act(async () => {
      resolveLookup?.({
        name: "Times Square",
        formattedAddress: "Manhattan, NY, USA",
        countryCode: "US",
      });
    });
    await expectEmergencyAction("911", "United States");
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
      await screen.findByRole("heading", { name: "Save my Soul", level: 1 }),
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

    await expectEmergencyAction("911", "United States");
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

    await finishLocationOnboarding();

    await waitFor(() => expect(onSetupComplete).toHaveBeenCalledTimes(1));
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

    await finishLocationOnboarding();

    await waitFor(() => expect(onSetupComplete).toHaveBeenCalledTimes(1));

    // Pressing again while the first settlement is still in flight must not
    // settle a second time.
    fireEvent.click(await locationFinishButton());
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
    // A genuinely denied device refuses the capture too. Setup now confirms by
    // attempting rather than trusting the reported state, because that state is
    // unreadable on Safari — so the refusal has to come from the attempt for
    // this to still be a denial at all.
    const denied = new Error("Location permission was not granted.");
    denied.name = "LocationPermissionDeniedError";
    mockCaptureCurrentPosition.mockRejectedValue(denied);

    render(
      <OneLocationAgentPage mode="setup" onSetupComplete={onSetupComplete} />,
    );

    await openLocationPermissionsStep();
    expect(screen.getByTestId("one-location-onboarding-features")).toBeTruthy();
    await waitFor(() => expect(mockOpenAppSettings).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "Find my people" })).toBeEnabled();
    expect(onSetupComplete).not.toHaveBeenCalled();
  });

  it("refreshes Location after returning from Settings and opens the saved-place prompt in the unlocked workspace", async () => {
    window.localStorage.removeItem(
      "one_location_saved_location_prompt_v2:user_a",
    );
    mockLoadSavedLocations.mockResolvedValue([]);
    const deniedPermission = {
      state: "denied" as const,
      precise: false,
      background: "restricted" as const,
      locationServicesEnabled: true,
    };
    const grantedPermission = {
      state: "granted" as const,
      precise: true,
      background: "foreground-only" as const,
      locationServicesEnabled: true,
    };
    mockGetPermissionState.mockResolvedValue(deniedPermission);
    // The request reports the same refusal the read did — otherwise the device
    // is not actually denied and routing to Settings would be wrong.
    mockRequestLocationPermission.mockResolvedValue(deniedPermission);
    // A genuinely denied device refuses the capture too. Setup now confirms a
    // denial by attempting rather than trusting the reported state — that state
    // is unreadable on Safari — so the refusal has to come from the attempt.
    const refused = new Error("Location permission was not granted.");
    refused.name = "LocationPermissionDeniedError";
    mockCaptureCurrentPosition.mockRejectedValue(refused);
    mockGetState.mockResolvedValue({
      ...locationState(),
      ownerGrants: [],
    });

    render(<OneLocationAgentPage />);

    await openLocationPermissionsStep();
    await waitFor(() => expect(mockOpenAppSettings).toHaveBeenCalled());
    // Asked first, and only then routed to Settings once the device said no.
    expect(mockCaptureCurrentPosition).toHaveBeenCalled();

    const attemptsWhileDenied = mockCaptureCurrentPosition.mock.calls.length;
    mockGetPermissionState.mockResolvedValue(grantedPermission);
    mockCaptureCurrentPosition.mockResolvedValue({
      latitude: 28.6139,
      longitude: 77.209,
      accuracyM: 18,
      capturedAt: "2026-05-20T07:30:00.000Z",
      sourcePlatform: "web",
    });
    act(() => {
      appInteractionCoordinator.handleLifecycle("background");
      appInteractionCoordinator.handleLifecycle("active");
    });

    expect(await screen.findByTestId("save-location-modal")).toBeTruthy();
    expect(mockCaptureCurrentPosition.mock.calls.length).toBeGreaterThan(
      attemptsWhileDenied,
    );
  });

  it("keeps setup onboarding available when the workspace state fetch fails", async () => {
    mockGetState.mockRejectedValue(new Error("Workspace state unavailable"));

    render(<OneLocationAgentPage mode="setup" />);

    expect(
      await screen.findByTestId("one-location-onboarding-welcome"),
    ).toBeTruthy();
    expect(screen.queryByText("Workspace state unavailable")).toBeNull();
  });

  it("stages the onboarding location in memory when vault authority is not ready", async () => {
    mockUseVault.mockReturnValue({
      isVaultUnlocked: false,
      vaultKey: null,
      vaultOwnerToken: null,
    });

    render(<OneLocationAgentPage mode="setup" />);

    expect(
      await screen.findByTestId("one-location-onboarding-welcome"),
    ).toBeTruthy();
    expect(mockRegisterKey).not.toHaveBeenCalled();
    expect(mockGetState).not.toHaveBeenCalled();

    await openLocationPermissionsStep();
    expect(await screen.findByTestId("save-location-modal")).toBeTruthy();
    expect(mockReverseGeocode).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Confirm pin" }));
    fireEvent.change(screen.getByLabelText(/House, flat, floor or block/), {
      target: { value: "Flat 4B" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Home" }));
    fireEvent.click(screen.getByRole("button", { name: "Save location" }));

    await waitFor(() =>
      expect(mockStageSavedLocation).toHaveBeenCalledWith("user_a", {
        category: "home",
        label: "",
        latitude: 28.6139,
        longitude: 77.209,
        address: "Flat 4B, Kartavya Path, New Delhi, Delhi 110001, India",
      }),
    );
    expect(mockAddSavedLocation).not.toHaveBeenCalled();
    expect(screen.queryByTestId("save-location-modal")).toBeNull();
  });

  it("never carries an in-flight location capture across an account switch", async () => {
    let resolveUserACapture:
      | ((value: {
          latitude: number;
          longitude: number;
          accuracyM: number;
          capturedAt: string;
          sourcePlatform: "web";
        }) => void)
      | undefined;
    mockUseVault.mockReturnValue({
      isVaultUnlocked: false,
      vaultKey: null,
      vaultOwnerToken: null,
    });
    mockCaptureCurrentPosition
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveUserACapture = resolve;
          }),
      )
      .mockResolvedValueOnce({
        latitude: 12.9716,
        longitude: 77.5946,
        accuracyM: 15,
        capturedAt: "2026-08-04T01:00:00.000Z",
        sourcePlatform: "web",
      });

    const view = render(<OneLocationAgentPage mode="setup" />);
    await openLocationPermissionsStep();
    await waitFor(() =>
      expect(mockCaptureCurrentPosition).toHaveBeenCalledTimes(1),
    );

    mockUseRequireAuth.mockReturnValue({
      loading: false,
      isAuthenticated: true,
      userId: "user_b",
      user: {
        uid: "user_b",
        displayName: "Second User",
        email: "second@example.com",
        photoURL: null,
        getIdToken: vi.fn().mockResolvedValue("id-token-b"),
      },
    });
    view.rerender(<OneLocationAgentPage mode="setup" />);

    await waitFor(() =>
      expect(mockClearPreVaultForUser).toHaveBeenCalledWith("user_a"),
    );
    await openLocationPermissionsStep();
    await waitFor(() =>
      expect(mockCaptureCurrentPosition).toHaveBeenCalledTimes(2),
    );
    expect(await screen.findByTestId("save-location-modal")).toBeTruthy();

    await act(async () => {
      resolveUserACapture?.({
        latitude: 40.7128,
        longitude: -74.006,
        accuracyM: 10,
        capturedAt: "2026-08-04T00:59:00.000Z",
        sourcePlatform: "web",
      });
      await Promise.resolve();
    });

    fireEvent.click(screen.getByRole("button", { name: "Confirm pin" }));
    fireEvent.change(screen.getByLabelText(/House, flat, floor or block/), {
      target: { value: "Second user's home" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Home" }));
    fireEvent.click(screen.getByRole("button", { name: "Save location" }));

    await waitFor(() =>
      expect(mockStageSavedLocation).toHaveBeenCalledWith(
        "user_b",
        expect.objectContaining({
          category: "home",
          address: expect.stringContaining("Second user's home"),
        }),
      ),
    );
    expect(mockStageSavedLocation).not.toHaveBeenCalledWith(
      "user_a",
      expect.anything(),
    );
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
    mockLoadSavedLocations.mockResolvedValue([]);
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
    await waitFor(() =>
      expect(mockCaptureCurrentPosition).toHaveBeenCalledTimes(1),
    );
    expect(await screen.findByTestId("save-location-modal")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    fireEvent.click(screen.getByRole("button", { name: "Find my people" }));
    await expectLocationInviteStep();
    fireEvent.click(await locationFinishButton());
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
    window.localStorage.removeItem(
      "one_location_saved_location_prompt_v2:user_a",
    );
    mockLoadSavedLocations.mockResolvedValue([]);
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
    expect(await screen.findByTestId("save-location-modal")).toBeTruthy();
    await waitFor(() =>
      expect(mockReverseGeocode).toHaveBeenCalledWith({
        vaultOwnerToken: "vault-token",
        lat: 28.6139,
        lng: 77.209,
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Confirm pin" }));
    fireEvent.change(screen.getByLabelText(/House, flat, floor or block/), {
      target: { value: "Flat 4B" },
    });
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
          address: "Flat 4B, Kartavya Path, New Delhi, Delhi 110001, India",
        },
      }),
    );
    await waitFor(() =>
      expect(screen.queryByTestId("save-location-modal")).toBeNull(),
    );
    expect(
      window.localStorage.getItem(
        "one_location_saved_location_prompt_v1:user_a",
      ),
    ).toBeNull();
    expect(
      window.localStorage.getItem(
        "one_location_saved_location_prompt_v2:user_a",
      ),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Find my people" }));
    await expectLocationInviteStep();
  });

  it("retries current-location capture in the unlocked workspace", async () => {
    window.localStorage.removeItem(
      "one_location_saved_location_prompt_v2:user_a",
    );
    mockLoadSavedLocations.mockResolvedValue([]);
    mockCaptureCurrentPosition.mockRejectedValueOnce(
      new Error("Position unavailable"),
    );
    mockGetState.mockResolvedValue({
      ...locationState(),
      ownerGrants: [],
    });

    render(<OneLocationAgentPage />);

    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    await openLocationPermissionsStep();
    expect(
      await screen.findByRole("button", { name: "Try again" }),
    ).toBeEnabled();
    expect(toast.error).toHaveBeenCalledWith(
      "Check permission and try again.",
    );
    expect(mockCaptureCurrentPosition).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByTestId("save-location-modal")).toBeTruthy();
    expect(mockCaptureCurrentPosition).toHaveBeenCalledTimes(2);
  });

  it("reopens the location picker after dismissing it and returning to the feature step", async () => {
    window.localStorage.removeItem(
      "one_location_saved_location_prompt_v1:user_a",
    );
    window.localStorage.removeItem(
      "one_location_saved_location_prompt_v2:user_a",
    );

    mockLoadSavedLocations.mockResolvedValue([]);
    mockGetState.mockResolvedValue({
      ...locationState(),
      ownerGrants: [],
    });
    mockGetPermissionState.mockResolvedValue({
      state: "granted",
      precise: true,
      background: "foreground-only",
      locationServicesEnabled: true,
    });

    render(<OneLocationAgentPage />);

    await waitFor(() => expect(mockGetState).toHaveBeenCalled());

    await openLocationPermissionsStep();

    expect(await screen.findByTestId("save-location-modal")).toBeTruthy();
    expect(mockCaptureCurrentPosition).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));

    await waitFor(() =>
      expect(screen.queryByTestId("save-location-modal")).toBeNull(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Go back" }));

    expect(
      await screen.findByRole("heading", {
        name: "Share your location easily with anyone.",
      }),
    ).toBeTruthy();

    await openLocationPermissionsStep();

    expect(await screen.findByTestId("save-location-modal")).toBeTruthy();
    expect(mockCaptureCurrentPosition).toHaveBeenCalledTimes(2);
  });
  it("retires a legacy skipped outcome and still opens the onboarding picker", async () => {
    window.localStorage.setItem(
      "one_location_saved_location_prompt_v2:user_a",
      "skipped",
    );
    mockGetState.mockResolvedValue({
      ...locationState(),
      ownerGrants: [],
    });

    render(<OneLocationAgentPage />);

    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    await openLocationPermissionsStep();

    expect(await screen.findByTestId("save-location-modal")).toBeTruthy();
    expect(
      window.localStorage.getItem(
        "one_location_saved_location_prompt_v1:user_a",
      ),
    ).toBeNull();
    expect(
      window.localStorage.getItem(
        "one_location_saved_location_prompt_v2:user_a",
      ),
    ).toBeNull();
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
    expect(await screen.findByTestId("save-location-modal")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    fireEvent.click(screen.getByRole("button", { name: "Find my people" }));
    await expectLocationInviteStep();
    fireEvent.click(await locationFinishButton());
    expect(
      await screen.findByRole("heading", { name: "Location Agent" }),
    ).toBeTruthy();
    expect(mockCaptureCurrentPosition).toHaveBeenCalledTimes(1);
    // Completing onboarding persists the one-time intro flag.
    expect(
      window.localStorage.getItem("one_location_onboarding_v2:user_a"),
    ).toBe("1");
  });

  it("reoffers the two-step saved-place flow when Location is already granted", async () => {
    window.localStorage.removeItem(
      "one_location_saved_location_prompt_v2:user_a",
    );
    mockLoadSavedLocations.mockResolvedValue([]);
    expect(
      window.localStorage.getItem(
        "one_location_saved_location_prompt_v1:user_a",
      ),
    ).toBe("1");
    mockGetState.mockResolvedValue({
      ...locationState(),
      ownerGrants: [],
    });

    render(<OneLocationAgentPage />);

    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    await openLocationPermissionsStep();

    expect(mockRequestLocationPermission).not.toHaveBeenCalled();
    expect(await screen.findByTestId("save-location-modal")).toBeTruthy();
    expect(mockCaptureCurrentPosition).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Confirm pin" }));
    fireEvent.change(screen.getByLabelText(/House, flat, floor or block/), {
      target: { value: "Tower 2, Floor 4" },
    });
    fireEvent.change(screen.getByLabelText(/Building colour/), {
      target: { value: "White gate" },
    });
    fireEvent.change(screen.getByLabelText(/Nearby landmark/), {
      target: { value: "India Gate" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Work" }));
    fireEvent.click(screen.getByRole("button", { name: "Save location" }));

    await waitFor(() =>
      expect(mockAddSavedLocation).toHaveBeenCalledWith({
        context: {
          userId: "user_a",
          vaultKey: "vault-key",
          vaultOwnerToken: "vault-token",
        },
        input: {
          category: "work",
          label: "",
          latitude: 28.6139,
          longitude: 77.209,
          address:
            "Tower 2, Floor 4, White gate, Near India Gate, Kartavya Path, New Delhi, Delhi 110001, India",
        },
      }),
    );
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
          name: "Need to keep people updated?",
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
    expect(screen.queryByText(/Request location/)).toBeNull();
    expect(screen.getByText("TB").className).toContain(
      "bg-[color:var(--app-accent-surface)]",
    );
    expect(screen.getByText("TB").className).toContain(
      "text-[color:var(--app-accent-deep)]",
    );
    expect(screen.queryByText(/8012|4455|9911/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Menu" }));
    expect(screen.getByRole("button", { name: /Active shares/i })).toBeTruthy();
    await openSharePersonStep();
    fireEvent.change(screen.getByPlaceholderText("Search trusted people"), {
      target: { value: "advisor" },
    });

    expect(screen.getAllByText("Advisor C").length).toBeGreaterThan(0);
    expect(
      screen.getAllByText("Invite them first").length,
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
    // Above the agent bar's elevated z-540, not merely above its resting
    // z-118. The bar raises itself for a pending confirmation or an
    // interactive voice layer, and at 540 it tied with this overlay and won on
    // DOM order -- drawing "Talk to One" across the primary CTA.
    const shellZ = Number(
      /z-\[(\d+)\]/u.exec(onboardingShellClass ?? "")?.[1] ?? "0",
    );
    expect(shellZ).toBeGreaterThan(540);
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
    // Links tab: "Active links" list + a single "Create link" CTA. The
    // mock has no active links, so the empty state shows.
    fireEvent.click(screen.getByRole("button", { name: "Links" }));
    expect(
      await screen.findByRole("button", { name: /Create link/i }),
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

  /**
   * Recipient-side polling. The page reads every visible received share on an
   * interval so a shared dot moves in near real time. These cover the states
   * that used to make that loop misbehave: a live share with nothing published
   * yet (which the backend reported as 404 on every single tick), a share that
   * keeps failing, and a read that never settles.
   */
  describe("received-share polling", () => {
    const waitingGrant = {
      id: "grant_waiting",
      ownerUserId: "user_a",
      recipientUserId: "user_b",
      ownerDisplayName: "Trusted A",
      recipientKeyId: "key_b",
      status: "active",
      consentScope: "cap.location.live.view",
      capabilityScopes: ["cap.location.live.view"],
      durationHours: 1,
      expiresAt: "2099-05-20T08:00:00.000Z",
      latestEnvelopeId: null,
    };

    const renderAsRecipient = async () => {
      mockUseRequireAuth.mockReturnValue({
        loading: false,
        isAuthenticated: true,
        userId: "user_b",
        user: { uid: "user_b" },
      });
      window.localStorage.setItem(
        "one_location_opened_grants_v1:user_b",
        JSON.stringify(["grant_waiting"]),
      );
      window.localStorage.setItem("one_location_onboarding_v2:user_b", "1");
      mockGetState.mockResolvedValue({
        ...locationState(),
        ownerGrants: [],
        receivedGrants: [waitingGrant],
      });

      render(<OneLocationAgentPage />);
      expect(
        await screen.findByRole("heading", { name: "Location Agent" }),
      ).toBeTruthy();
      await waitFor(() => expect(mockGetState).toHaveBeenCalled());
      fireEvent.click(screen.getByRole("button", { name: /Shared with me/i }));
      await waitFor(() => expect(mockViewEnvelope).toHaveBeenCalled());
    };

    it("treats a null envelope as a normal state, not a failure", async () => {
      // The backend answers 200 with a null envelope (allow_empty) rather than
      // 404 LOCATION_ENVELOPE_MISSING. Nothing failed, so nothing may be handed
      // to the crypto layer and nothing may be shouted at the user.
      mockViewEnvelope.mockResolvedValue({
        grant: waitingGrant,
        envelope: null,
        status: "awaiting_first_publish",
      });

      await renderAsRecipient();

      expect(mockDecryptLocationEnvelope).not.toHaveBeenCalled();
      expect(toast.error).not.toHaveBeenCalled();
    });

    it("paces a legacy 404 as waiting, not as a failure", async () => {
      // During a rollout the webapp can reach a Python service that predates
      // allow_empty and still answers 404. That must map to the slow waiting
      // cadence (30s), NOT the error backoff (10s after one failure) — the
      // difference proves the legacy branch is still classified correctly.
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        // Verbatim message from the pre-allow_empty backend. `apiErrorCode`
        // only reads a real ApiError, so a legacy 404 surfaced through any
        // other error shape is classified by this string — which is exactly the
        // fallback path this test needs to hold.
        mockViewEnvelope.mockRejectedValue(
          new Error(
            "The owner has not published an encrypted location envelope yet.",
          ),
        );

        await renderAsRecipient();
        const afterFirstRead = mockViewEnvelope.mock.calls.length;

        // An error-classified grant would have retried by now; a waiting one
        // must not.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(20_000);
        });
        expect(mockViewEnvelope).toHaveBeenCalledTimes(afterFirstRead);
        expect(toast.error).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("drops a waiting share off the live cadence instead of asking every tick", async () => {
      // The bug this fixes: 5s polling for an answer only the owner can change,
      // which produced a request (and a console line) every tick, forever.
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        mockViewEnvelope.mockResolvedValue({
          grant: waitingGrant,
          envelope: null,
          status: "awaiting_first_publish",
        });

        await renderAsRecipient();
        const afterFirstRead = mockViewEnvelope.mock.calls.length;

        // Four live ticks pass. A waiting share must not be re-read on any of
        // them; it is parked on the 30s heartbeat.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(20_000);
        });
        expect(mockViewEnvelope).toHaveBeenCalledTimes(afterFirstRead);

        // Past the slow heartbeat it is asked exactly once more.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(15_000);
        });
        expect(mockViewEnvelope.mock.calls.length).toBe(afterFirstRead + 1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("backs a repeatedly failing share off exponentially", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        mockViewEnvelope.mockRejectedValue(new Error("backend unavailable"));

        await renderAsRecipient();
        const afterFirstRead = mockViewEnvelope.mock.calls.length;

        // First failure parks the grant for 10s (5s * 2^1), so the 5s tick in
        // between is skipped rather than retried at full rate.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(6_000);
        });
        expect(mockViewEnvelope).toHaveBeenCalledTimes(afterFirstRead);

        await act(async () => {
          await vi.advanceTimersByTimeAsync(6_000);
        });
        expect(mockViewEnvelope.mock.calls.length).toBe(afterFirstRead + 1);

        // Second failure doubles again to 20s: 12s of ticks buys no retry.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(12_000);
        });
        expect(mockViewEnvelope.mock.calls.length).toBe(afterFirstRead + 1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("returns a recovered share to the live cadence", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        mockViewEnvelope.mockRejectedValueOnce(new Error("transient"));
        mockViewEnvelope.mockResolvedValue({
          grant: waitingGrant,
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
            capturedAt: "2099-01-01T00:00:00.000Z",
            sourcePlatform: "web",
          },
          status: "published",
        });

        await renderAsRecipient();

        // Clear the one failure's backoff, then confirm the share is read on
        // consecutive live ticks again — backoff must not be sticky.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(11_000);
        });
        const afterRecovery = mockViewEnvelope.mock.calls.length;

        await act(async () => {
          await vi.advanceTimersByTimeAsync(5_500);
        });
        expect(mockViewEnvelope.mock.calls.length).toBeGreaterThan(
          afterRecovery,
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("recovers polling after a read that never settles", async () => {
      // Without the watchdog the in-flight guard latches forever and live
      // tracking dies silently for the rest of the session.
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        mockViewEnvelope.mockImplementation(() => new Promise(() => {}));

        await renderAsRecipient();
        const wedged = mockViewEnvelope.mock.calls.length;

        // Ticks during the watchdog window are correctly suppressed.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(20_000);
        });
        expect(mockViewEnvelope).toHaveBeenCalledTimes(wedged);

        // Past the watchdog the guard is released and polling resumes.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(20_000);
        });
        expect(mockViewEnvelope.mock.calls.length).toBeGreaterThan(wedged);
      } finally {
        warn.mockRestore();
        vi.useRealTimers();
      }
    });
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
      await screen.findByText("Location may be stale."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ask to refresh" })).toBeTruthy();

    expect(screen.getByText("Active")).toBeTruthy();
    expect(screen.getByText(/^Access until /)).toBeTruthy();
    expect(screen.queryByText(/^Live$/)).toBeNull();
    expect(screen.queryByText(/^Live until /)).toBeNull();

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
    const recenterButton = screen.getByRole("button", {
      name: "Recenter map on Trusted A's location",
    });
    fireEvent.click(recenterButton);
    expect(screen.getByTitle("Live location map preview")).not.toBe(mapPreview);
    expect(mockViewEnvelope).toHaveBeenCalledTimes(viewCallsBeforeCollapse);
    expect(collapseButton.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(collapseButton);

    expect(screen.queryByTitle("Live location map preview")).toBeNull();
    expect(screen.getByText("Trusted A")).toBeTruthy();
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

    // A received share must be removable by the recipient, not just the
    // owner: revoke is symmetric on the backend, but until now no control in
    // "Shared with me" ever called it, so the only way off this list was
    // waiting for expiry or asking the owner to stop it themselves.
    const removeButton = screen.getByRole("button", {
      name: "Remove Trusted A from Shared with me",
    });
    fireEvent.click(removeButton);
    await waitFor(() =>
      expect(mockRevokeGrant).toHaveBeenCalledWith({
        vaultOwnerToken: "vault-token",
        grantId: "grant_stale",
      }),
    );
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
      screen.getByRole("button", { name: /^Create link$/i }),
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
    await openShareConfirmStep();
    fireEvent.click(screen.getByRole("button", { name: /Start sharing/i }));

    await waitFor(() => expect(mockCreateGrant).toHaveBeenCalledTimes(1));
    expect(mockCreateGrant).toHaveBeenCalledWith({
      vaultOwnerToken: "vault-token",
      recipientUserId: "user_b",
      recipientKeyId: "key_b",
      durationHours: 0.25,
      durationMode: "timed",
      reason: undefined,
      shareKind: "share",
      sourceCircleId: undefined,
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
      screen.queryByRole("heading", { name: "Ready to share?" }),
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
    await openShareConfirmStep();
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

  it("keeps publishing to the other recipients when one of them fails", async () => {
    // "Share with several people doesn't work": the live publisher used to hold
    // one try/catch OUTSIDE its loop, so the first recipient that threw aborted
    // the whole tick. Grant order is stable, so the SAME recipient threw every
    // tick and everyone after them in the list was starved permanently — the
    // first person's dot kept moving, nobody else ever updated again.
    const base = locationState().ownerGrants[0]!;
    mockGetState.mockResolvedValue({
      ...locationState(),
      ownerGrants: [
        { ...base, id: "grant_b", recipientUserId: "user_b", recipientKeyId: "key_b" },
        {
          ...base,
          id: "grant_d",
          recipientUserId: "user_d",
          recipientDisplayName: "Investor D",
          recipientKeyId: "key_d",
        },
      ],
    });
    mockEncryptLocationForRecipient.mockImplementation(
      async ({ recipientKeyId }: { recipientKeyId: string }) => ({
        recipientKeyId,
        ciphertext: "cipher",
        iv: "iv",
        ephemeralPublicKeyJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
      }),
    );
    // The first recipient in the list is the one that fails.
    mockStoreEnvelope.mockImplementation(
      async ({ envelope }: { envelope: { recipientKeyId: string } }) => {
        if (envelope.recipientKeyId === "key_b") {
          throw new Error("LOCATION_ENVELOPE_KEY_MISMATCH");
        }
        return {};
      },
    );

    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();

    await waitFor(() => {
      const publishedKeyIds = mockStoreEnvelope.mock.calls.map(
        (call) => call[0]?.envelope?.recipientKeyId,
      );
      // The second recipient must still be reached despite the first throwing.
      expect(publishedKeyIds).toContain("key_d");
    });
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
      await screen.findByRole("heading", { name: "Ready to share?" }),
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
    expect(screen.getByText("Invite them first")).toBeTruthy();
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
      message: "Safety check-in — Need pickup coordination",
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
      expect(screen.getByRole("status")).toHaveTextContent("Request sent."),
    );
  });

  // Reported from the field: "can't send req to rest after 1 cycle". Asking
  // three people left the Send button latched to a disabled green "Sent", so the
  // rest of the list could be ticked but never actually asked -- the only way
  // out was to leave the screen and come back.
  it("lets you ask more people after a request has already been sent", async () => {
    mockGetState.mockResolvedValue({
      ...locationState(),
      ownerGrants: [],
    });

    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();
    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    await openAskFlow();

    fireEvent.click(
      screen.getByRole("button", {
        name: /Select Trusted B for location request/i,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /Send request/i }));
    await waitFor(() => expect(mockRequestAccess).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Request sent."),
    );

    // Sending clears the composer, so with nobody chosen there is nothing to
    // send -- but the button must be a live control, not a spent one.
    const sendButton = screen.getByRole("button", { name: /Send request/i });
    expect(sendButton.hasAttribute("disabled")).toBe(true);

    // Choosing the next person re-arms Send and retires the previous
    // confirmation, which described a request that is no longer on screen.
    fireEvent.click(
      screen.getByRole("button", {
        name: /Select Advisor C for location request/i,
      }),
    );
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: /Send request/i })
          .hasAttribute("disabled"),
      ).toBe(false),
    );
    expect(screen.queryByRole("status")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Send request/i }));
    await waitFor(() => expect(mockRequestAccess).toHaveBeenCalledTimes(2));
    expect(mockRequestAccess).toHaveBeenLastCalledWith(
      expect.objectContaining({ ownerUserId: "user_c" }),
    );
  });

  // Sending takes several round trips. Anyone tapped while they were in flight
  // used to be erased by the blanket composer reset that ran when the send
  // landed -- the pick just disappeared, with no request and no error.
  it("keeps a person picked while the send is still in flight", async () => {
    mockGetState.mockResolvedValue({
      ...locationState(),
      ownerGrants: [],
    });

    let releaseFirstRequest: (() => void) | null = null;
    mockRequestAccess.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseFirstRequest = () => resolve();
        }),
    );

    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();
    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    await openAskFlow();

    fireEvent.click(
      screen.getByRole("button", {
        name: /Select Trusted B for location request/i,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /Send request/i }));
    await waitFor(() => expect(mockRequestAccess).toHaveBeenCalledTimes(1));

    // Mid-flight, the user lines up the next person.
    fireEvent.click(
      screen.getByRole("button", {
        name: /Select Advisor C for location request/i,
      }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: /Deselect Advisor C for location request/i,
        }),
      ).toBeTruthy(),
    );

    await act(async () => {
      releaseFirstRequest?.();
      await Promise.resolve();
    });

    // Trusted B was asked and is gone from the composer; Advisor C survives and
    // can still be sent, with no confirmation claiming their request went out.
    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: /Deselect Advisor C for location request/i,
        }),
      ).toBeTruthy(),
    );
    expect(
      screen.getByRole("button", { name: /Send request/i }).hasAttribute("disabled"),
    ).toBe(false);
    expect(screen.queryByRole("status")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Send request/i }));
    await waitFor(() => expect(mockRequestAccess).toHaveBeenCalledTimes(2));
    expect(mockRequestAccess).toHaveBeenLastCalledWith(
      expect.objectContaining({ ownerUserId: "user_c" }),
    );
  });

  // The confirmation used to latch the instant the button was tapped, so a send
  // that failed still reported "Request sent."
  it("does not claim a request was sent when the send fails", async () => {
    mockGetState.mockResolvedValue({
      ...locationState(),
      ownerGrants: [],
    });
    mockRequestAccess.mockRejectedValueOnce(new Error("network down"));

    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();
    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    await openAskFlow();

    fireEvent.click(
      screen.getByRole("button", {
        name: /Select Trusted B for location request/i,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /Send request/i }));

    await waitFor(() => expect(mockRequestAccess).toHaveBeenCalledTimes(1));
    // No confirmation, and the composer stays usable so the ask can be retried.
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: /Send request/i })
          .hasAttribute("disabled"),
      ).toBe(false),
    );
    expect(screen.queryByRole("status")).toBeNull();
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

  it("lets the requester delete a live (approved) request they sent", async () => {
    mockGetState.mockResolvedValue({
      ...locationState(),
      ownerGrants: [],
      requests: [
        {
          id: "request_live",
          ownerUserId: "user_b",
          requesterUserId: "user_a",
          status: "approved",
          approvedGrantId: "grant_from_request_live",
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
    // A live request shows a real stop action, not a static "Active" label
    // with no way off the list. The label is "Stop", not "Delete": it is the
    // same vm.onStopGrant handler the other two revoke buttons use, and it ends
    // access rather than erasing anything.
    expect(screen.queryByText("Active")).toBeNull();
    const deleteButton = screen.getByRole("button", { name: "Stop" });
    fireEvent.click(deleteButton);
    await waitFor(() =>
      expect(mockRevokeGrant).toHaveBeenCalledWith({
        vaultOwnerToken: "vault-token",
        grantId: "grant_from_request_live",
      }),
    );
  });

  it("shortens a live request's duration immediately, with no re-approval", async () => {
    mockGetState.mockResolvedValue({
      ...locationState(),
      ownerGrants: [],
      requests: [
        {
          id: "request_live",
          ownerUserId: "user_b",
          requesterUserId: "user_a",
          status: "approved",
          approvedGrantId: "grant_from_request_live",
          requestedAt: "2026-05-20T07:30:00.000Z",
        },
      ],
    });

    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();

    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "People" }));
    await screen.findByRole("heading", { name: "Requests sent" });

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(mockShortenGrant).toHaveBeenCalledWith({
        vaultOwnerToken: "vault-token",
        grantId: "grant_from_request_live",
        durationHours: 1,
      }),
    );
    // Shortening never needs the owner's approval -- no new request goes out.
    expect(mockRequestAccess).not.toHaveBeenCalled();
  });

  it("falls back to re-asking the owner when the new duration would extend access", async () => {
    // shorten_grant's whole reason to exist is refusing to move expiry
    // later. The UI has no idea what the current expiry is, so it always
    // tries shorten first and lets this rejection decide whether a fresh,
    // owner-approved request goes out instead.
    mockShortenGrant.mockRejectedValueOnce(
      new ApiError("shorten only", 422, {
        code: "LOCATION_GRANT_SHORTEN_ONLY",
      }),
    );
    mockGetState.mockResolvedValue({
      ...locationState(),
      ownerGrants: [],
      requests: [
        {
          id: "request_live",
          ownerUserId: "user_b",
          requesterUserId: "user_a",
          status: "approved",
          approvedGrantId: "grant_from_request_live",
          requestedAt: "2026-05-20T07:30:00.000Z",
        },
      ],
    });

    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();

    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "People" }));
    await screen.findByRole("heading", { name: "Requests sent" });

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(mockRequestAccess).toHaveBeenCalledWith({
        vaultOwnerToken: "vault-token",
        ownerUserId: "user_b",
        message: "Requesting more time.",
      }),
    );
  });

  it("removes an already-live person's access from the Ask flow's own list", async () => {
    // Ask's person list already showed "Live" for someone sharing with you --
    // it just gave you nothing to do about that but leave the screen and
    // hunt through Shared with me / Requests sent instead.
    mockGetState.mockResolvedValue({
      ...locationState(),
      ownerGrants: [],
      receivedGrants: [
        {
          id: "grant_live_ask",
          ownerUserId: "user_b",
          recipientUserId: "user_a",
          ownerDisplayName: "Trusted B",
          recipientKeyId: "key_a",
          status: "active",
          consentScope: "cap.location.live.view",
          capabilityScopes: ["cap.location.live.view"],
          durationHours: 1,
          expiresAt: "2099-05-20T08:00:00.000Z",
        },
      ],
    });

    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();
    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    await openAskFlow();

    fireEvent.click(
      screen.getByRole("button", { name: "Remove Trusted B's access" }),
    );
    await waitFor(() =>
      expect(mockRevokeGrant).toHaveBeenCalledWith({
        vaultOwnerToken: "vault-token",
        grantId: "grant_live_ask",
      }),
    );
  });

  /**
   * A live received share, expiring `minutes` from the real clock so the
   * inline duration editor is judged against a time that is actually left --
   * which is the whole question it has to answer.
   */
  function liveReceivedGrant(minutes: number) {
    return {
      id: "grant_live_ask",
      ownerUserId: "user_b",
      recipientUserId: "user_a",
      ownerDisplayName: "Trusted B",
      recipientKeyId: "key_a",
      status: "active",
      consentScope: "cap.location.live.view",
      capabilityScopes: ["cap.location.live.view"],
      durationHours: minutes / 60,
      expiresAt: new Date(Date.now() + minutes * 60_000).toISOString(),
    };
  }

  it("edits an already-live person's duration from the Ask flow's own list", async () => {
    mockGetState.mockResolvedValue({
      ...locationState(),
      ownerGrants: [],
      receivedGrants: [liveReceivedGrant(4 * 60)],
    });

    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();
    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    await openAskFlow();

    fireEvent.click(
      screen.getByRole("button", { name: "Edit access for Trusted B" }),
    );
    fireEvent.click(screen.getByRole("combobox", { name: "New duration" }));
    fireEvent.click(screen.getByRole("option", { name: "30 min" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(mockShortenGrant).toHaveBeenCalledWith({
        vaultOwnerToken: "vault-token",
        grantId: "grant_live_ask",
        durationHours: 0.5,
      }),
    );
    // Shortening is the recipient's own call to make -- nobody is asked.
    expect(mockRequestAccess).not.toHaveBeenCalled();
  });

  it("opens the duration editor on what the share actually has left", async () => {
    // It opened on "1 hour" every time, one line under "Sharing with you,
    // 4 more hours". So the field was never the current duration, and Save on
    // the untouched default asked for MORE time instead of changing anything.
    mockGetState.mockResolvedValue({
      ...locationState(),
      ownerGrants: [],
      receivedGrants: [liveReceivedGrant(4 * 60)],
    });

    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();
    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    await openAskFlow();

    fireEvent.click(
      screen.getByRole("button", { name: "Edit access for Trusted B" }),
    );

    expect(
      screen.getByRole("combobox", { name: "New duration" }).textContent,
    ).toContain("4 hours");
  });

  it("does nothing at all when Save is pressed on an untouched duration", async () => {
    // A one-hour share a minute old reads "59 more min" and the picker opens
    // on "1 hour", because that is what it is. Pressing Save there is not a
    // request for one more minute of somebody's location: it used to spend a
    // refused shorten, then ask the owner, then report "Asked Trusted B for
    // more time" over a row whose time never moved.
    mockGetState.mockResolvedValue({
      ...locationState(),
      ownerGrants: [],
      receivedGrants: [liveReceivedGrant(59)],
    });

    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();
    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    await openAskFlow();

    fireEvent.click(
      screen.getByRole("button", { name: "Edit access for Trusted B" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // The editor closes, and no call goes anywhere.
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Save" })).toBeNull(),
    );
    expect(mockShortenGrant).not.toHaveBeenCalled();
    expect(mockRequestAccess).not.toHaveBeenCalled();
  });

  it("asks the owner for more time without first spending a refused shorten", async () => {
    // Every ask-for-more-time used to call shorten_grant, wait for the 422,
    // and only then send the request the user was always going to need. Two
    // round trips to change nothing on screen is the "Save is slow" report;
    // the expiry needed to skip the first one is already rendered as
    // "12 more min" one line above the picker.
    mockGetState.mockResolvedValue({
      ...locationState(),
      ownerGrants: [],
      receivedGrants: [liveReceivedGrant(12)],
    });

    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();
    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    await openAskFlow();

    fireEvent.click(
      screen.getByRole("button", { name: "Edit access for Trusted B" }),
    );
    fireEvent.click(screen.getByRole("combobox", { name: "New duration" }));
    fireEvent.click(screen.getByRole("option", { name: "4 hours" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(mockRequestAccess).toHaveBeenCalledWith({
        vaultOwnerToken: "vault-token",
        ownerUserId: "user_b",
        message: "Requesting more time.",
      }),
    );
    expect(mockShortenGrant).not.toHaveBeenCalled();
  });

  it("says what to do when shortening fails, and lets the row be tried again", async () => {
    // A toast that only names the failure ("Could not update access.") leaves
    // the person with no idea whether to wait, retry, or go elsewhere.
    mockGetState.mockResolvedValue({
      ...locationState(),
      ownerGrants: [],
      receivedGrants: [liveReceivedGrant(4 * 60)],
    });
    // Not an Error instance, so no backend-curated message exists to prefer.
    mockShortenGrant.mockRejectedValueOnce({ code: "BOOM" });

    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();
    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    await openAskFlow();

    fireEvent.click(
      screen.getByRole("button", { name: "Edit access for Trusted B" }),
    );
    fireEvent.click(screen.getByRole("combobox", { name: "New duration" }));
    fireEvent.click(screen.getByRole("option", { name: "30 min" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Couldn't change the time. Try again.",
      ),
    );
    // A failed save is not a reason to strand the row: the editor stays open
    // on what was picked, and Save is pressable again.
    const retry = await screen.findByRole("button", { name: "Save" });
    expect(retry.hasAttribute("disabled")).toBe(false);
  });

  it("says what to do when asking the owner for more time fails", async () => {
    mockGetState.mockResolvedValue({
      ...locationState(),
      ownerGrants: [],
      receivedGrants: [liveReceivedGrant(12)],
    });
    mockRequestAccess.mockRejectedValueOnce({ code: "BOOM" });

    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();
    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    await openAskFlow();

    fireEvent.click(
      screen.getByRole("button", { name: "Edit access for Trusted B" }),
    );
    fireEvent.click(screen.getByRole("combobox", { name: "New duration" }));
    fireEvent.click(screen.getByRole("option", { name: "4 hours" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Couldn't ask Trusted B for more time. Try again.",
      ),
    );
    const retry = await screen.findByRole("button", { name: "Save" });
    expect(retry.hasAttribute("disabled")).toBe(false);
  });

  it("leaves the row usable after a duration save, instead of stuck busy", async () => {
    // The save flag was the revoke flag, and the shorten path returned
    // without clearing it. So one successful save disabled that person's
    // Remove button for good, and the next Edit opened with Save already
    // spinning and permanently disabled -- the "save button taking more time
    // after edit time" report.
    mockGetState.mockResolvedValue({
      ...locationState(),
      ownerGrants: [],
      receivedGrants: [liveReceivedGrant(4 * 60)],
    });

    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();
    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    await openAskFlow();

    fireEvent.click(
      screen.getByRole("button", { name: "Edit access for Trusted B" }),
    );
    fireEvent.click(screen.getByRole("combobox", { name: "New duration" }));
    fireEvent.click(screen.getByRole("option", { name: "30 min" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mockShortenGrant).toHaveBeenCalled());

    // Remove never belonged to the save in the first place.
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Remove Trusted B's access" })
          .hasAttribute("disabled"),
      ).toBe(false),
    );

    // And the same person can be edited again straight away.
    fireEvent.click(
      screen.getByRole("button", { name: "Edit access for Trusted B" }),
    );
    const saveAgain = await screen.findByRole("button", { name: "Save" });
    expect(saveAgain.hasAttribute("disabled")).toBe(false);
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
    // The populated People tab exposes a compact "Find contacts" circle action.
    fireEvent.click(screen.getByRole("button", { name: "People" }));
    expect(
      await screen.findByRole("button", { name: /Add people/i }),
    ).toBeTruthy();
    fireEvent.click(
      await screen.findByRole("button", { name: /Find contacts/i }),
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
    // Public links live on the Links tab. The People tab used to carry a
    // duplicate "Share to contacts" that minted the same artifact; this is the
    // one remaining path, and it must still create the invite.
    fireEvent.click(screen.getByRole("button", { name: "Links" }));
    // Links hub CTA opens the flow; the flow's own CTA creates the invite.
    // Both are labelled "Create link", so take the one on screen each time.
    fireEvent.click(
      await screen.findByRole("button", { name: /^Create link$/i }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /^Create link$/i }),
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

  it("puts the search directly above the list it filters and drops the public-link CTA", async () => {
    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();

    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    await switchLocationTab("People", "Circles");

    const search = await screen.findByPlaceholderText("Search trusted people");
    const person = await screen.findByText("Trusted B");
    expect(screen.getByTestId("one-location-people-list")).toHaveClass(
      "max-h-[50vh]",
      "overflow-y-auto",
      "overflow-x-hidden",
    );

    // The search input used to be separated from its own results by four
    // buttons, which read as page search rather than list search. Nothing
    // focusable may sit between the field and the list it filters.
    expect(
      search.compareDocumentPosition(person) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const between = Array.from(
      document.querySelectorAll("button, a[href], input, textarea, select"),
    ).filter(
      (el) =>
        el !== search &&
        search.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING &&
        person.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING,
    );
    expect(between).toHaveLength(0);

    // "Share to contacts" minted a PUBLIC link — the Links tab's artifact, not
    // something that belongs beside named, trusted people.
    expect(
      screen.queryByRole("button", { name: /Share to contacts/i }),
    ).toBeNull();
    // The three that remain each carry a different weight, so the common one
    // reads as the default rather than one of four equal choices.
    const addPeople = screen.getByRole("button", { name: /Add people/i });
    const syncContacts = screen.getByRole("button", {
      name: /Find contacts/i,
    });
    expect(addPeople).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Invite$/i })).toBeTruthy();
    expect(syncContacts).toBeTruthy();
    expect(
      syncContacts.compareDocumentPosition(search) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      person.compareDocumentPosition(addPeople) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: /Stop sharing with Trusted B/i,
      }),
    ).toBeTruthy();
  });

  it("keeps desktop People actions in the same visual and keyboard order", async () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === "(min-width: 640px)",
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    try {
      render(<OneLocationAgentPage />);
      await skipLocationEntryFlow();
      await waitFor(() => expect(mockGetState).toHaveBeenCalled());
      await switchLocationTab("People", "Circles");

      const addPeople = screen.getByRole("button", { name: /Add people/i });
      const search = await screen.findByPlaceholderText("Search trusted people");
      const syncContacts = screen.getByRole("button", {
        name: /Find contacts/i,
      });
      const invite = screen.getByRole("button", { name: /^Invite$/i });

      expect(
        syncContacts.compareDocumentPosition(invite) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(
        invite.compareDocumentPosition(addPeople) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(
        addPeople.compareDocumentPosition(search) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  it("offers New circle and Join with code beside the circles heading", async () => {
    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();

    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    await switchLocationTab("People", "Circles");

    const section = screen.getByTestId("one-location-named-circles");
    const heading = within(section).getByRole("heading", {
      name: "Circles",
    });
    const create = within(section).getByRole("button", {
      name: /^New circle$/i,
    });
    const join = within(section).getByRole("button", {
      name: /Join with code/i,
    });

    // Structural, not "somewhere after": the compact heading row owns both
    // actions, so a long circle list cannot strand them below the fold.
    expect(section.children[0]).toContainElement(heading);
    expect(section.children[0]).toContainElement(create);
    expect(section.children[0]).toContainElement(join);
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

  it("still offers to share when a permission read claims denied", async () => {
    // A read-back "denied" is not proof. Safari cannot report the value at all,
    // and browsers and Android both re-prompt, so disabling the control here is
    // what left users staring at "Allow location permission before sharing" on
    // a phone whose location worked. The share stays available; the capture
    // attempt is what asks, and a real refusal is what stops it.
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
    await openShareConfirmStep();
    const shareButton = screen.getByRole("button", {
      name: /Start sharing/i,
    }) as HTMLButtonElement;
    expect(shareButton.disabled).toBe(false);
  });

  it("blocks share actions once the OS location switch is off", async () => {
    // This one genuinely cannot be fixed by asking, so it must still block.
    mockGetPermissionState.mockResolvedValue({
      state: "denied",
      precise: false,
      background: "unavailable",
      locationServicesEnabled: false,
    });
    mockGetState.mockResolvedValue({
      ...locationState(),
      ownerGrants: [],
    });

    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();

    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    await openShareConfirmStep();
    const shareButton = screen.getByRole("button", {
      name: /Start sharing/i,
    }) as HTMLButtonElement;
    expect(shareButton.disabled).toBe(true);
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
    await switchLocationTab("People", "Circles");
    // Empty state keeps connection management and invite/sync/share actions.
    // Request-location affordances are populated-state-only, and the redundant
    // approval explainer must not add another card below these actions.
    expect(screen.getByRole("button", { name: /Add people/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Invite$/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Find contacts/i })).toBeTruthy();
    // "Share to contacts" is deliberately absent: it minted a PUBLIC link,
    // which is the Links tab's job, not a control belonging beside named
    // trusted people.
    expect(
      screen.queryByRole("button", { name: /Share to contacts/i }),
    ).toBeNull();
    expect(screen.queryByText(/Request location/)).toBeNull();
    expect(
      screen.queryByText(/Private sharing starts after approval/i),
    ).toBeNull();

    mockRouterPush.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /Add people/i }));
    expect(mockRouterPush).toHaveBeenCalledWith("/one/connect");

    fireEvent.click(screen.getByRole("button", { name: "Links" }));
    expect(
      await screen.findByRole("button", { name: /Create link/i }),
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

  it("keeps the contacts step on a mobile browser that exposes the Contact Picker", async () => {
    // Chrome on Android has no native plugin but does expose the Contact
    // Picker, so the step must survive there. Skipping is only for surfaces
    // with no address book at all -- desktop browsers and Safari.
    Object.defineProperty(navigator, "contacts", {
      value: { select: vi.fn() },
      configurable: true,
    });
    try {
      render(<OneLocationAgentPage />);
      await leaveLocationFeatureStep();

      expect(
        await screen.findByTestId("one-location-onboarding-contacts"),
      ).toBeTruthy();
      expect(
        screen.getByRole("button", { name: "Check my contacts" }),
      ).toBeTruthy();
    } finally {
      Reflect.deleteProperty(navigator, "contacts");
    }
  });

  it("skips the contacts step in a browser with no Contact Picker", async () => {
    // jsdom is that browser, and so is every desktop Chrome and Safari. The
    // step used to render here as an apology over an empty panel.
    render(<OneLocationAgentPage />);
    await leaveLocationFeatureStep();

    await expectLocationInviteStep();
    expect(
      screen.queryByTestId("one-location-onboarding-contacts"),
    ).toBeNull();
  });
});
