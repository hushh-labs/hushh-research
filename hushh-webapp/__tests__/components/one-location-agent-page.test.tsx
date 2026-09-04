import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  Children,
  type ReactNode,
  type Ref,
  useEffect,
  useImperativeHandle,
  useMemo,
} from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The rungs themselves, not a copy of their labels: Ask and Share must offer
// the same ladder, so the test reads the same list the component does.
import { ROUTES } from "@/lib/navigation/routes";
import { INTERNAL_APP_NAVIGATION_REQUEST_EVENT } from "@/lib/utils/browser-navigation";
import {
  clearTabSwitchHistory,
  readPreviousTabHref,
} from "@/lib/navigation/tab-switch-history";

function openDropdownMenu(trigger: HTMLElement) {
  fireEvent.keyDown(trigger, { key: "Enter", code: "Enter" });
}

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
  mockSetGrantDuration,
  mockRequestAccess,
  mockApproveRequest,
  mockWithdrawRequest,
  mockUpdateAutoApprovePreference,
  mockCreatePublicInvite,
  mockCreateCircleInvite,
  mockListCircles,
  mockGetCircle,
  mockListCircleMembersPage,
  mockGetActivity,
  mockGetState,
  mockGetNearbyPresence,
  mockCheckoutNearby,
  mockSyncCurrentUser,
  mockSyncOneLocationContactSignals,
  mockSearchConnectionDirectory,
  mockListConnections,
  mockListRecipientsPage,
  mockSendConnectionRequest,
  mockTrackEvent,
  mockRouterPush,
  mockRouterReplace,
  mockRouterBack,
  mockUseSearchParams,
  mockSearchParamsGet,
  mockSearchParams,
  mockCopyToClipboard,
  mockRequestContactCheck,
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
  mockSetGrantDuration: vi.fn(),
  mockRequestAccess: vi.fn(),
  mockApproveRequest: vi.fn(),
  mockWithdrawRequest: vi.fn(),
  mockUpdateAutoApprovePreference: vi.fn(),
  mockCreatePublicInvite: vi.fn(),
  mockCreateCircleInvite: vi.fn(),
  mockListCircles: vi.fn(),
  mockGetCircle: vi.fn(),
  mockListCircleMembersPage: vi.fn(),
  mockGetActivity: vi.fn(),
  mockGetState: vi.fn(),
  mockGetNearbyPresence: vi.fn(),
  mockCheckoutNearby: vi.fn(),
  mockSyncCurrentUser: vi.fn(),
  mockSyncOneLocationContactSignals: vi.fn(),
  mockSearchConnectionDirectory: vi.fn(),
  mockListConnections: vi.fn(),
  mockListRecipientsPage: vi.fn(),
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
  mockRequestContactCheck: vi.fn(() => true),
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

vi.mock("@/lib/contacts/use-contact-discoverability-consent", () => ({
  useContactDiscoverabilityConsent: () => ({
    requestContactCheck: mockRequestContactCheck,
    preference: { status: "decided", enabled: false, ruleVersion: 1 },
    dialogProps: {
      open: false,
      ready: false,
      loading: false,
      savingChoice: null,
      error: null,
      actionLabel: "Find contacts",
      onOpenChange: vi.fn(),
      onChoose: vi.fn(),
      onRetry: vi.fn(),
    },
  }),
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
    ref,
    onConfirm,
    onCancel,
    onSelectionChange,
    onReadyChange,
    confirmLabel,
    cancelLabel,
  }: {
    ref?: Ref<{ confirm: () => boolean }>;
    onConfirm: (picked: {
      latitude: number;
      longitude: number;
      address: string;
    }) => void;
    onCancel: () => void;
    onSelectionChange?: (picked: {
      latitude: number;
      longitude: number;
      address: string;
    }) => void;
    onReadyChange?: (ready: boolean) => void;
    confirmLabel?: string;
    cancelLabel?: string;
  }) => {
    const picked = useMemo(
      () => ({
        latitude: 28.6139,
        longitude: 77.209,
        address: "Kartavya Path, New Delhi, Delhi 110001, India",
      }),
      [],
    );

    useImperativeHandle(ref, () => ({
      confirm: () => {
        onConfirm(picked);
        return true;
      },
    }), [onConfirm, picked]);
    useEffect(() => {
      onSelectionChange?.(picked);
      onReadyChange?.(true);
      return () => onReadyChange?.(false);
    }, [onReadyChange, onSelectionChange, picked]);

    return (
      <div aria-label="Mock location picker">
        {confirmLabel ? (
          <button type="button" onClick={() => onConfirm(picked)}>
            {confirmLabel}
          </button>
        ) : null}
        {cancelLabel ? (
          <button type="button" onClick={onCancel}>
            {cancelLabel}
          </button>
        ) : null}
      </div>
    );
  },
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
    listRecipientsPage: mockListRecipientsPage,
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
    setGrantDuration: mockSetGrantDuration,
    requestAccess: mockRequestAccess,
    updateAutoApprovePreference: mockUpdateAutoApprovePreference,
    approveRequest: mockApproveRequest,
    withdrawRequest: mockWithdrawRequest,
    denyRequest: vi.fn(),
    referRecipient: vi.fn(),
    createPublicInvite: mockCreatePublicInvite,
    createCircleInvite: mockCreateCircleInvite,
    revokePublicInvite: vi.fn(),
    revokeCircleInvite: vi.fn(),
    // Named-circle surface: the mandatory onboarding invite screen
    // find-or-creates the user's first owned Circle and issues its
    // member-visible invite code before the people step opens.
    listCircles: mockListCircles,
    getCircle: mockGetCircle,
    getCircleOverview: mockGetCircle,
    listCircleMembersPage: mockListCircleMembersPage,
    ensureSmsSystemCircle: vi.fn().mockResolvedValue({ members: [] }),
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

// Google Contacts is the fallback for browsers with no address book. Both
// modules stay inert by default -- `mockGoogleAvailability` returns
// "unconfigured", which is what a build without NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID
// reports, so every test in this file behaves exactly as it did before unless it
// opts in.
let mockGoogleAvailability: () => string = () => "unconfigured";
const mockPreloadGoogleContactsAuth = vi.fn(async () => undefined);
const mockRequestGoogleContactsToken = vi.fn(async () => "google-token");
const mockGooglePeopleContactSource = vi.fn(() => vi.fn());

vi.mock("@/lib/contacts/google-people-source", () => ({
  googleContactsAvailability: () => mockGoogleAvailability(),
  googlePeopleContactSource: (...args: unknown[]) =>
    mockGooglePeopleContactSource(...(args as [])),
}));

// Only the part that talks to Google is replaced. `isGoogleContactsConsentCancelled`
// comes through untouched on purpose: it IS the contract under test, and a
// hand-written copy here would keep passing after the real one broke.
vi.mock("@/lib/contacts/google-contacts-token", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/contacts/google-contacts-token")
  >()),
  preloadGoogleContactsAuth: () => mockPreloadGoogleContactsAuth(),
  requestGoogleContactsToken: () => mockRequestGoogleContactsToken(),
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
import { resolveLocalOnboardingHandler } from "@/lib/agent/local-onboarding-actions";
import { appInteractionCoordinator } from "@/lib/interaction/interaction-intent-coordinator";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
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
    autoApprovePreference: {
      enabled: false,
      scope: null,
      enabledAt: null,
      ruleVersion: 0,
    },
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
      name: "Keep your people updated.",
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

/** welcome -> features -> save place (skipped) -> ready. */
async function reachLocationOnboardingFinalStep() {
  await openLocationPermissionsStep();
  const savePrompt = await screen.findByTestId("save-location-modal");
  fireEvent.click(
    within(savePrompt).getByRole("button", {
      name: /Skip saving this place|Skip for now/,
    }),
  );
  await expectLocationInviteStep();
  expect(screen.getByRole("button", { name: "Go back" })).toBeEnabled();
  expect(await locationFinishButton()).toBeEnabled();
}

/**
 * Walk welcome -> features -> save place, then take the non-persisting path to
 * Ready without asserting the final content.
 */
async function leaveLocationFeatureStep() {
  await openLocationPermissionsStep();
  const savePrompt = await screen.findByTestId("save-location-modal");
  fireEvent.click(
    within(savePrompt).getByRole("button", {
      name: /Skip saving this place|Skip for now/,
    }),
  );
}

async function openReadyContactsPanel() {
  const disclosure = await screen.findByRole("button", {
    name: "Find contacts",
  });
  fireEvent.click(disclosure);
  return screen.findByTestId("one-location-onboarding-contacts-surface");
}

/** Reach the last screen and press the CTA that settles onboarding. */
async function finishLocationOnboarding() {
  await reachLocationOnboardingFinalStep();
  const finish = await locationFinishButton();
  await waitFor(() => expect(finish).toBeEnabled());
  fireEvent.click(finish);
}

async function skipLocationEntryFlow(options: { expectMain?: boolean } = {}) {
  // There is not always an entry flow to skip.
  //
  // A URL that names a destination -- any `?action=` -- no longer gets the
  // first-run takeover, because arriving ON a screen is not a first run and
  // the greeting was rendering in front of the thing the link pointed at.
  // Callers that set an action therefore have nothing to dismiss, and this
  // helper's job is "get past the entry flow", which is already true.
  const onboardingShowing = screen.queryByTestId("one-location-onboarding");
  if (onboardingShowing) {
    await finishLocationOnboarding();
  }

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
      await screen.findByRole("heading", { name: "Location" }),
    ).toBeTruthy();
  }

  // Tests after this helper exercise workspace actions. Ignore the deliberate
  // onboarding picker capture so their assertions count only the action under
  // test (share, request, Nearby, emergency, and public-link flows).
  mockCaptureCurrentPosition.mockClear();
}

function mockLocationSearchParams(query: string) {
  const params = new URLSearchParams(query);
  mockSearchParams.toString = () => params.toString();
  mockSearchParamsGet.mockImplementation((name: string) => params.get(name));
  mockUseSearchParams.mockReturnValue(mockSearchParams);
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
  const setupButton = await screen.findByRole("button", {
    name: /Set up my location|Try again|Open settings/,
  });
  await waitFor(() => expect(setupButton).toBeEnabled());
  fireEvent.click(setupButton);
}

async function saveOnboardingPlace() {
  const saveButton = await screen.findByRole("button", {
    name: "Save & continue",
  });
  await waitFor(() => expect(saveButton).toBeEnabled());
  fireEvent.click(saveButton);
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
  fireEvent.click(
    screen.queryByRole("button", { name: /^Share location$/i }) ??
      screen.getByRole("button", { name: /^Share with more$/i }),
  );
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
  fireEvent.click(screen.getByRole("button", { name: /Ask for location/i }));
  expect(
    await screen.findByRole("heading", { name: "Ask for location" }),
  ).toBeTruthy();
}

async function openPeoplePersonActions(name: string) {
  fireEvent.click(
    await screen.findByRole("button", {
      name: new RegExp(`Open Location actions for ${name}`, "i"),
    }),
  );
  expect(await screen.findByRole("dialog", { name })).toBeTruthy();
}

async function selectAskRecipient(name: RegExp) {
  fireEvent.click(
    screen.getByRole("button", {
      name,
    }),
  );
}

async function continueAskFlow() {
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  // "Ready to ask?" asked whether the reader was ready, on a screen whose job
  // is to collect two answers. The title names them, in the order the section
  // labels under it do.
  expect(
    await screen.findByRole("heading", { name: "Who, then how long?" }),
  ).toBeTruthy();
}

/**
 * The Links tab IS the create-a-link screen now.
 *
 * This used to click "Create link" to reach a separate `?action=temp-link`
 * screen, whose own "Create link" was the one that actually created. The
 * duration question and the create button are on the tab itself, so opening
 * the tab is the whole of it -- and the helper asserts the duration control is
 * there, which is what proves the screen collapsed rather than disappeared.
 */
async function openTemporaryLinkFlow() {
  fireEvent.click(screen.getByRole("button", { name: "Links" }));
  expect(await screen.findByText("Temporary link")).toBeTruthy();
  expect(screen.getByText("Duration")).toBeTruthy();
}

describe("OneLocationAgentPage", () => {
  afterEach(() => {
    // A test that installs fake timers and then fails leaves them installed,
    // and every test after it hangs on a clock that never moves -- three
    // unrelated failures from one. Cheap to make impossible.
    vi.useRealTimers();
  });

  beforeEach(async () => {
    mockRequestContactCheck.mockReturnValue(true);
    vi.clearAllMocks();
    // Module-level state written by TopShellTabs -- a "People"/"Links" click
    // in an earlier test otherwise leaks into this one and changes what Back
    // resolves to (module-singleton state has no per-test isolation).
    clearTabSwitchHistory();
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
    window.sessionStorage.clear();
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
    // Clearing the cache does not clear the resource's in-flight map. A test
    // that leaves a request pending would otherwise hand its dead promise to
    // the next test, which then never calls getState at all.
    const { OneLocationStateResource } =
      await import("@/lib/one-location/one-location-state-resource");
    OneLocationStateResource.invalidate("user_a");
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
      phoneNumber: "+919000000001",
      resolveVerifiedPhoneNumber: vi
        .fn()
        .mockResolvedValue("+919000000001"),
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
    // Back to what a build with no NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID reports,
    // so one opted-in test cannot leak the Google branch into the next.
    mockGoogleAvailability = () => "unconfigured";
    mockPreloadGoogleContactsAuth.mockReset();
    mockPreloadGoogleContactsAuth.mockResolvedValue(undefined);
    mockRequestGoogleContactsToken.mockReset();
    mockRequestGoogleContactsToken.mockResolvedValue("google-token");
    mockGooglePeopleContactSource.mockReset();
    mockGooglePeopleContactSource.mockReturnValue(vi.fn());
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
    mockSetGrantDuration.mockResolvedValue({});
    mockRequestAccess.mockResolvedValue({});
    mockWithdrawRequest.mockResolvedValue({});
    mockCopyToClipboard.mockResolvedValue(true);
    mockCreatePublicInvite.mockResolvedValue({
      publicUrl: "/one/location/view/invite_1",
    });
    mockListCircles.mockResolvedValue([]);
    mockGetCircle.mockResolvedValue(undefined);
    mockListCircleMembersPage.mockResolvedValue({
      items: [],
      page: 1,
      hasMore: false,
      totalCount: 0,
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
      readContactCount: 0,
      checkedContactCount: 0,
      matchedContactCount: 0,
      unmatchedContactCount: 0,
      uncheckableContactCount: 0,
      excludedSelfContactCount: 0,
      unknownContactCount: 0,
      mutationOutcomeUnknown: false,
      uncheckedContactCount: 0,
      autoConnectedCount: 0,
      alreadyConnectedCount: 0,
      requestRequiredCount: 0,
      suppressedCount: 0,
      completedBatchCount: 0,
      totalBatchCount: 0,
      partial: false,
      region: null,
      limited: false,
      truncated: false,
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
    // Most tests exercise the bounded local state fallback. Paging-specific
    // tests override this with a server page; a successful static page here
    // would overwrite each test's custom state with unrelated fixture rows.
    mockListRecipientsPage.mockRejectedValue(
      new Error("recipient page unavailable in this fixture"),
    );
    mockSendConnectionRequest.mockResolvedValue(undefined);
  });

  it("resolves and shares with a spoken recipient beyond the initial recipient page", async () => {
    mockListRecipientsPage.mockImplementation(async ({ query }) => ({
      items: query
        ? [
            {
              userId: "user_beyond_50",
              displayName: "Beyond Fifty",
              maskedPhone: "******5050",
              phoneVerified: true,
              keyId: "key_beyond_50",
              publicKeyJwk: {
                kty: "EC",
                crv: "P-256",
                x: "x50",
                y: "y50",
              },
              keyAlgorithm: "ECDH-P256-AES256-GCM", // gitleaks:allow
              canReceiveLocation: true,
              recommendationScore: 10,
              recommendationRank: 51,
              recommendationTier: "connected",
              recommendationCategory: "connections",
              recommendationCategoryLabel: "Connections",
              recommendationSummary: "Connected",
              recommendationReasons: [],
            },
          ]
        : [],
      page: 1,
      hasMore: false,
      totalCount: query ? 1 : 0,
    }));

    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();
    await waitFor(() => expect(mockGetState).toHaveBeenCalled());

    const select = resolveLocalOnboardingHandler(
      "location.select_share_recipient",
    );
    const share = resolveLocalOnboardingHandler("location.share_selected");
    expect(select).toBeTruthy();
    expect(share).toBeTruthy();

    let selectionResult: Awaited<ReturnType<NonNullable<typeof select>>>;
    await act(async () => {
      selectionResult = await select!({ person: "Beyond Fifty" });
    });
    expect(selectionResult!).toMatchObject({ status: "succeeded" });
    expect(mockListRecipientsPage).toHaveBeenCalledWith({
      vaultOwnerToken: "vault-token",
      page: 1,
      limit: 50,
      query: "Beyond Fifty",
    });

    let shareResult: Awaited<ReturnType<NonNullable<typeof share>>>;
    await act(async () => {
      shareResult = await share!({ duration_hours: "1" });
    });
    expect(shareResult!).toMatchObject({ status: "succeeded" });
    expect(mockCreateGrant).toHaveBeenCalledWith(
      expect.objectContaining({ recipientUserId: "user_beyond_50" }),
    );
  });

  it("renders the One-owned encrypted location control surface", async () => {
    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();

    expect(
      await screen.findByRole("heading", { name: "Location" }),
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
    expect(screen.queryByRole("button", { name: /Active shares/i })).toBeNull();
    expect(
      screen.queryByRole("heading", { name: "Proximity alerts" }),
    ).toBeNull();
    expect(screen.queryByText("Advisor meetup")).toBeNull();
    expect(screen.queryByRole("button", { name: "Your Map" })).toBeNull();
    expect(screen.getByRole("button", { name: /^Map$/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Settings$/i })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /^Share location$/i }),
    ).toBeTruthy();
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
  }, 15000);

  it("hides the Activity menu when every Activity count is zero", async () => {
    // Empty Activity rows are visual noise on the Now screen. Keep the real
    // destinations wired when counts exist, but remove the whole group when
    // nothing needs attention.
    mockGetState.mockResolvedValue({
      ...locationState(),
      ownerGrants: [],
      receivedGrants: [],
      requests: [],
    });
    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();
    await waitFor(() => expect(mockGetState).toHaveBeenCalled());

    expect(screen.queryByTestId("one-location-now-activity")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Activity" })).toBeNull();
    expect(screen.queryByText("0")).toBeNull();
  });

  it("keeps Activity rows visually quiet even when counts are non-zero", async () => {
    // Activity is a status list, not an action palette. Colour belongs to the
    // Actions grid and real alerts; counts alone should not make these rows
    // compete with the primary tasks on the screen.
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

    expect(screen.queryByText("Active shares")).toBeNull();
    expect(await toneOf("Sharing with you")).toBeUndefined();
    expect(await toneOf("Needs review")).toBeUndefined();
  });

  it("renders Needs review with compact request cards and clear approval copy", async () => {
    mockGetState.mockResolvedValue({
      ...locationState(),
      ownerGrants: [],
      receivedGrants: [],
      requests: [
        {
          id: "request_review",
          ownerUserId: "user_a",
          requesterUserId: "user_b",
          requesterDisplayName: "Trusted B",
          status: "pending",
          message: "School pickup",
          requestedAt: "2026-05-20T07:30:00.000Z",
          requestedDurationHours: 1,
          requestedDurationMode: "timed",
        },
      ],
    });

    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();
    await waitFor(() => expect(mockGetState).toHaveBeenCalled());

    fireEvent.click(
      await screen.findByRole("button", { name: /Needs review/i }),
    );

    const flow = await screen.findByTestId("one-location-needs-review");
    expect(
      within(flow).getByRole("heading", { name: "Needs review" }),
    ).toBeTruthy();
    expect(
      within(flow).getByText("Nothing is shared until you approve."),
    ).toBeTruthy();
    expect(within(flow).queryByText(/^Location$/)).toBeNull();
    expect(within(flow).getByText("Trusted B")).toBeTruthy();
    expect(within(flow).getByText("Reason")).toBeTruthy();
    expect(within(flow).getByText("School pickup")).toBeTruthy();
    expect(
      within(flow).getByRole("button", { name: "Approve 1 hour" }),
    ).toBeTruthy();
    // The single hard-coded "Allow 1 hour" is gone. A one-hour ask still has
    // shorter answers -- the two below it -- and they are offered by name
    // rather than not at all, which was the reported gap.
    expect(
      within(flow).queryByRole("button", { name: "Allow 1 hour" }),
    ).toBeNull();
    expect(
      within(within(flow).getByTestId("one-location-approve-shorter"))
        .getAllByRole("button")
        .map((button) => button.textContent?.trim()),
    ).toEqual(["15 min", "30 min"]);
    expect(within(flow).getByRole("button", { name: "Decline" })).toBeTruthy();
  });

  it("lets Needs review approve a longer request for any shorter amount", async () => {
    const request = {
      id: "request_review_four_hours",
      ownerUserId: "user_a",
      requesterUserId: "user_b",
      requesterDisplayName: "Trusted B",
      status: "pending" as const,
      message: "Running late",
      requestedAt: "2026-05-20T07:30:00.000Z",
      requestedDurationHours: 4,
      requestedDurationMode: "timed",
    };
    const requester = locationState().recipients[0]!;
    mockGetState.mockResolvedValue({
      ...locationState(),
      ownerGrants: [],
      receivedGrants: [],
      requests: [request],
    });
    mockApproveRequest.mockResolvedValueOnce({
      request: {
        ...request,
        status: "approved",
        approvedGrantId: "grant_one_hour",
      },
      grant: {
        id: "grant_one_hour",
        ownerUserId: "user_a",
        recipientUserId: "user_b",
        recipientKeyId: "key_b",
        status: "active",
        consentScope: "cap.location.live.view",
        capabilityScopes: ["cap.location.live.view"],
        durationHours: 1,
        durationMode: "timed",
        expiresAt: "2026-05-20T08:30:00.000Z",
      },
      recipient: requester,
    });

    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();
    await waitFor(() => expect(mockGetState).toHaveBeenCalled());

    fireEvent.click(
      await screen.findByRole("button", { name: /Needs review/i }),
    );

    const flow = await screen.findByTestId("one-location-needs-review");
    expect(
      within(flow).getByRole("button", { name: "Approve 4 hours" }),
    ).toBeTruthy();

    // Four shorter answers for a four-hour ask, not one fixed step.
    expect(
      within(within(flow).getByTestId("one-location-approve-shorter"))
        .getAllByRole("button")
        .map((button) => button.textContent?.trim()),
    ).toEqual(["15 min", "30 min", "1 hour", "2 hours"]);

    fireEvent.click(
      within(flow).getByRole("button", { name: "Approve for 1 hour instead" }),
    );

    await waitFor(() => expect(mockApproveRequest).toHaveBeenCalledTimes(1));
    expect(mockApproveRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "request_review_four_hours",
        approvalMode: "manual",
        durationHours: 1,
        durationMode: "timed",
      }),
    );
    await waitFor(() => expect(mockStoreEnvelope).toHaveBeenCalledTimes(1));
    expect(within(flow).getByRole("status")).toHaveTextContent("Approved");
  });

  it("uses a compact sharing-first Now composition without dashboard groups", async () => {
    // Now is a sharing surface, not a management dashboard. Idle state leads
    // with Share location, then secondary actions, then only the positive-count
    // activity rows that need attention.
    mockGetState.mockResolvedValue({
      ...locationState(),
      ownerGrants: [],
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

    const primary = await screen.findByTestId("one-location-now-primary");
    expect(
      within(primary).getByRole("button", { name: "Share location" }),
    ).toBeTruthy();
    expect(within(primary).getByText("You're not sharing")).toBeTruthy();
    expect(
      within(primary).getByText("Choose a Circle or contact."),
    ).toBeTruthy();

    const actions = await screen.findByTestId("one-location-now-actions");
    expect(actions.className).toContain("pt-1");
    expect(actions.className).not.toContain("max-w-[282px]");
    expect(
      within(actions).queryByRole("heading", { name: "Actions" }),
    ).toBeNull();
    expect(
      within(actions).getByRole("button", { name: "Ask for location" }),
    ).toBeTruthy();
    expect(
      within(actions).getByRole("button", {
        name: "Save My Soul emergency alert",
      }),
    ).toBeTruthy();
    expect(within(actions).getByText("Ask for location")).toBeTruthy();
    expect(within(actions).getByText("Check in")).toBeTruthy();
    const retiredActionLabel = ["Their", "Location"].join(" ");
    expect(actions.textContent).not.toContain(retiredActionLabel);
    expect(within(actions).queryByText("Confirm Arrival")).toBeNull();
    expect(within(actions).getByText("Save My Soul")).toBeTruthy();
    expect(within(actions).getByText("Emergency alert")).toBeTruthy();

    const actionGrid = actions.querySelector("[data-one-location-action-grid]");
    expect(actionGrid?.className).toContain("grid-cols-1");
    expect(actionGrid?.className).toContain("min-[360px]:grid-cols-2");

    const actionCells = actionGrid?.querySelectorAll(
      "[data-one-location-action-cell]",
    );
    expect(actionCells).toHaveLength(2);
    actionCells?.forEach((cell) => {
      expect(cell.className).toContain("items-center");
      expect(cell.className).toContain("text-center");
      expect(cell.className).toContain("rounded-[16px]");
      expect(cell.className).toContain("min-h-[96px]");
      expect(cell.className).toContain("px-5");
    });
    expect(
      actionGrid?.querySelector("[data-one-location-action-icon]")?.className,
    ).toContain("text-[color:var(--app-accent)]");
    expect(
      actionGrid?.querySelector("[data-one-location-action-icon]")?.className,
    ).toContain("[&>svg]:h-8");
    expect(
      actionGrid?.querySelectorAll("[data-one-location-action-icon] svg"),
    ).toHaveLength(2);
    expect(
      actionGrid?.querySelector('[data-location-menu-icon="ask"]'),
    ).toBeTruthy();
    expect(
      actionGrid?.querySelector('[data-location-menu-icon="checkIn"]'),
    ).toBeTruthy();
    expect(
      actions.querySelector("[data-one-location-emergency-cell]"),
    ).toBeTruthy();
    expect(actions.textContent).not.toContain("near_me");
    expect(actions.textContent).not.toContain("location_on");
    expect(actions.textContent).not.toContain("where_to_vote");
    expect(actions.querySelector("[data-one-location-sms-row]")).toBeTruthy();

    const activity = screen.getByTestId("one-location-now-activity");
    expect(within(activity).getByText("Sharing with you")).toBeTruthy();
    expect(within(activity).getByText("Needs review")).toBeTruthy();
    expect(within(activity).queryByText("Active shares")).toBeNull();

    expect(within(activity).queryByText("Share")).toBeNull();
    const more = screen.getByTestId("one-location-now-more");
    expect(within(more).getByText("Map")).toBeTruthy();
    expect(within(more).getByText("Settings")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Activity" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "More" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Your Map" })).toBeNull();
    expect(screen.getByRole("button", { name: /^Map$/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Settings$/i })).toBeTruthy();
    expect(screen.queryByText("Check-In")).toBeNull();
    expect(screen.queryByText("Quick actions")).toBeNull();
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
    expect(headerActions.className).toContain("items-end");
    expect(headerActions.className).toContain("justify-center");
    // The actions column owns the switch and its compact visible status.
    const status = screen.getByTestId("one-location-header-status");
    expect(headerActions.contains(status)).toBe(true);
    // The status must not become a separate row under the header.
    const headerRowForStatus = status.closest('[data-slot="page-header-row"]');
    expect(headerRowForStatus, "the status escaped the toggle group").toBe(
      headerActions.closest('[data-slot="page-header-row"]'),
    );
    expect(status).toHaveClass(
      "mt-1",
      "w-full",
      "whitespace-nowrap",
      "text-right",
      "text-[13px]",
      "leading-[18px]",
      "font-normal",
    );
    expect(status.textContent).toBe("Location off");
    // Still the switch's description wherever it renders.
    expect(
      screen
        .getByRole("switch", { name: "Turn location on" })
        .getAttribute("aria-describedby"),
    ).toBe(status.id);
    expect(
      screen.queryByRole("button", { name: "Refresh location" }),
    ).toBeNull();

    const heading = screen.getByRole("heading", { name: "Location" });
    const headerRow = heading.closest('[data-slot="page-header-row"]');
    expect(headerRow).toBeTruthy();
    expect(headerRow).toHaveClass("flex", "justify-between");
    expect(screen.getByTestId("page-header").className).toContain(
      "[&_[data-slot=page-header-row]]:!items-center",
    );
    expect(heading).toHaveClass("ui-text-agent-title");
    expect(screen.getByTestId("one-location-header-icon")).toBeTruthy();
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
    // ONE form now, at every width, naming the thing it switches.
    //
    // This used to be two breakpoint spans: the full string from `sm` up and a
    // one-word form on phones, because the full string in the actions column
    // wrapped the 28px title at 320-390px. That fit, and it cost iOS the
    // meaning — the device showed a bare green switch over the word "On". The
    // status now stays directly under the switch as one compact caption, so it
    // keeps meaning visible without wrapping the title.
    expect(locationStatus.querySelector(".sm\\:hidden")).toBeNull();
    expect(locationStatus.querySelector(".hidden.sm\\:inline")).toBeNull();
    expect(locationStatus.textContent).toBe("Location off");
    expect(locationStatus).not.toHaveAttribute("aria-hidden");
    expect(
      screen.getByRole("switch", { name: "Turn location on" }),
    ).toHaveAttribute("aria-describedby", locationStatus.id);
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
    expect(screen.getByText("Location off")).toBeTruthy();
    expect(mockRevokeGrant).not.toHaveBeenCalled();
  });

  it("keeps Settings focused on auto approval and Saved Locations", async () => {
    let serverPreference = {
      enabled: false,
      scope: null as { kind: "all_contacts" } | null,
      enabledAt: null as string | null,
      ruleVersion: 0,
    };
    mockGetState.mockImplementation(async () => ({
      ...locationState(),
      ownerGrants: [],
      autoApprovePreference: serverPreference,
    }));
    mockUpdateAutoApprovePreference.mockImplementation(async ({ enabled }) => {
      serverPreference = enabled
        ? {
            enabled: true,
            scope: { kind: "all_contacts" },
            enabledAt: "2026-08-24T09:00:00.000Z",
            ruleVersion: 1,
          }
        : {
            enabled: false,
            scope: null,
            enabledAt: null,
            ruleVersion: 2,
          };
      return serverPreference;
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

    mockLocationSearchParams("action=settings");
    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow({ expectMain: false });

    expect(
      await screen.findByRole("heading", { name: "Settings" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("region", { name: "Saved Locations" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("switch", { name: "Pause my location" }),
    ).toBeNull();

    const autoApproveSwitch = screen.getByRole("switch", {
      name: "Auto-approve requests",
    });
    // Off until asked for: approving a location request is consent, and a
    // default may not give it.
    expect(autoApproveSwitch).toHaveAttribute("aria-checked", "false");

    fireEvent.click(autoApproveSwitch);
    // Standing permission never defaults to the broadest scope. The setting
    // remains off until the person chooses who it covers and confirms.
    expect(autoApproveSwitch).toHaveAttribute("aria-checked", "false");
    expect(
      screen.getByRole("heading", { name: "Auto-approve for" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "All contacts" }));
    fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
    await waitFor(() =>
      expect(mockUpdateAutoApprovePreference).toHaveBeenCalledWith({
        vaultOwnerToken: "vault-token",
        enabled: true,
        scope: { kind: "all_contacts" },
      }),
    );
    await waitFor(() =>
      expect(autoApproveSwitch).toHaveAttribute("aria-checked", "true"),
    );
  });

  it("#6468: saves a multi-Circle auto-approve scope via Select all", async () => {
    const circleFamily = {
      id: "circle_family",
      name: "Family",
      kind: "family" as const,
      role: "owner" as const,
      memberCount: 3,
      memberLimit: 20,
    };
    const circleFriends = {
      id: "circle_friends",
      name: "Friends",
      kind: "friends" as const,
      role: "owner" as const,
      memberCount: 4,
      memberLimit: 20,
    };
    let serverPreference = {
      enabled: false,
      scope: null as { kind: "circles"; circleIds: string[] } | null,
      enabledAt: null as string | null,
      ruleVersion: 0,
    };
    mockGetState.mockImplementation(async () => ({
      ...locationState(),
      ownerGrants: [],
      circles: [circleFamily, circleFriends],
      autoApprovePreference: serverPreference,
    }));
    mockUpdateAutoApprovePreference.mockImplementation(async ({ enabled, scope }) => {
      serverPreference = enabled
        ? {
            enabled: true,
            scope,
            enabledAt: "2026-08-24T09:00:00.000Z",
            ruleVersion: 1,
          }
        : { enabled: false, scope: null, enabledAt: null, ruleVersion: 2 };
      return serverPreference;
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

    mockLocationSearchParams("action=settings");
    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow({ expectMain: false });
    expect(
      await screen.findByRole("heading", { name: "Settings" }),
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole("switch", { name: "Auto-approve requests" }),
    );
    expect(
      screen.getByRole("heading", { name: "Auto-approve for" }),
    ).toBeTruthy();

    // Two owned Circles render as checkboxes, not radios -- both may be
    // selected at once.
    const familyCheckbox = screen.getByRole("checkbox", { name: /^Family/ });
    const friendsCheckbox = screen.getByRole("checkbox", {
      name: /^Friends/,
    });
    expect(familyCheckbox).toHaveAttribute("aria-checked", "false");
    expect(friendsCheckbox).toHaveAttribute("aria-checked", "false");

    fireEvent.click(screen.getByRole("button", { name: "Select all" }));
    expect(familyCheckbox).toHaveAttribute("aria-checked", "true");
    expect(friendsCheckbox).toHaveAttribute("aria-checked", "true");

    fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
    await waitFor(() =>
      expect(mockUpdateAutoApprovePreference).toHaveBeenCalledWith({
        vaultOwnerToken: "vault-token",
        enabled: true,
        scope: {
          kind: "circles",
          circleIds: ["circle_family", "circle_friends"],
        },
      }),
    );

    // The saved scope reads back as a count, not one Circle's name.
    await waitFor(() =>
      expect(screen.getByText("2 Circles")).toBeInTheDocument(),
    );

    // Reopening and clicking "Clear all" empties the selection and disables
    // the primary action -- an empty scope is not a savable state.
    fireEvent.click(
      screen
        .getByTestId("one-location-auto-approve-row")
        .querySelector("button")!,
    );
    expect(
      await screen.findByRole("heading", { name: "Auto-approve for" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect(
      screen.getByRole("checkbox", { name: /^Family/ }),
    ).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("stops the automatic queue when the server rule is turned off", async () => {
    let ruleEnabled = true;
    const requests = [
      {
        id: "request_auto_1",
        ownerUserId: "user_a",
        requesterUserId: "user_b",
        requesterDisplayName: "Trusted B",
        status: "pending",
        requestedAt: "2026-08-24T09:01:00.000Z",
        requestedDurationHours: 1,
        requestedDurationMode: "timed",
      },
      {
        id: "request_auto_2",
        ownerUserId: "user_a",
        requesterUserId: "user_d",
        requesterDisplayName: "Investor D",
        status: "pending",
        requestedAt: "2026-08-24T09:02:00.000Z",
        requestedDurationHours: 1,
        requestedDurationMode: "timed",
      },
    ];
    const preference = () =>
      ruleEnabled
        ? {
            enabled: true,
            scope: { kind: "all_contacts" as const },
            enabledAt: "2026-08-24T09:00:00.000Z",
            ruleVersion: 7,
          }
        : {
            enabled: false,
            scope: null,
            enabledAt: null,
            ruleVersion: 8,
          };
    mockGetState.mockImplementation(async () => ({
      ...locationState(),
      ownerGrants: [],
      requests,
      autoApprovePreference: preference(),
    }));
    mockUpdateAutoApprovePreference.mockImplementation(async () => {
      ruleEnabled = false;
      return preference();
    });
    let resolveApproval: ((value: unknown) => void) | null = null;
    mockApproveRequest.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveApproval = resolve;
      }),
    );

    mockLocationSearchParams("action=settings");
    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow({ expectMain: false });

    await waitFor(() => expect(mockApproveRequest).toHaveBeenCalledTimes(1));
    expect(mockApproveRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "request_auto_1",
        approvalMode: "automatic",
        durationHours: undefined,
        durationMode: undefined,
        autoApproveRuleVersion: 7,
      }),
    );

    const autoApproveSwitch = await screen.findByRole("switch", {
      name: "Auto-approve requests",
    });
    expect(autoApproveSwitch).toHaveAttribute("aria-checked", "true");
    fireEvent.click(autoApproveSwitch);
    await waitFor(() =>
      expect(mockUpdateAutoApprovePreference).toHaveBeenCalledWith({
        vaultOwnerToken: "vault-token",
        enabled: false,
        scope: null,
      }),
    );

    resolveApproval?.({
      request: { ...requests[0], status: "approved" },
      grant: {
        id: "grant_auto_1",
        ownerUserId: "user_a",
        recipientUserId: "user_b",
        recipientKeyId: "key_b",
        status: "active",
        consentScope: "cap.location.live.view",
        capabilityScopes: ["cap.location.live.view"],
        durationHours: 1,
        durationMode: "timed",
        expiresAt: "2026-08-24T10:01:00.000Z",
      },
      recipient: locationState().recipients[0],
    });

    await waitFor(() => expect(mockStoreEnvelope).toHaveBeenCalledTimes(1));
    expect(mockApproveRequest).toHaveBeenCalledTimes(1);
  });

  it("does not publish an automatic grant after this device is paused", async () => {
    const request = {
      id: "request_auto_paused",
      ownerUserId: "user_a",
      requesterUserId: "user_b",
      requesterDisplayName: "Trusted B",
      status: "pending",
      requestedAt: "2026-08-24T09:01:00.000Z",
      requestedDurationHours: 1,
      requestedDurationMode: "timed",
    };
    mockGetState.mockResolvedValue({
      ...locationState(),
      ownerGrants: [],
      requests: [request],
      autoApprovePreference: {
        enabled: true,
        scope: { kind: "all_contacts" },
        enabledAt: "2026-08-24T09:00:00.000Z",
        ruleVersion: 7,
      },
    });
    let resolveApproval: ((value: unknown) => void) | null = null;
    mockApproveRequest.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveApproval = resolve;
      }),
    );
    const { updateOneLocationControlState } =
      await import("@/lib/one-location/location-control-state");
    updateOneLocationControlState("user_a", (current) => ({
      ...current,
      selfPreviewEnabled: true,
    }));

    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();
    await waitFor(() => expect(mockApproveRequest).toHaveBeenCalledTimes(1));

    fireEvent.click(
      await screen.findByRole("switch", { name: "Turn location off" }),
    );
    await waitFor(() => expect(screen.getByText("Location off")).toBeTruthy());

    await act(async () => {
      resolveApproval?.({
        request: { ...request, status: "approved" },
        grant: {
          id: "grant_auto_paused",
          ownerUserId: "user_a",
          recipientUserId: "user_b",
          recipientKeyId: "key_b",
          status: "active",
          consentScope: "cap.location.live.view",
          capabilityScopes: ["cap.location.live.view"],
          durationHours: 1,
          durationMode: "timed",
          expiresAt: "2026-08-24T10:01:00.000Z",
        },
        recipient: locationState().recipients[0],
      });
    });

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "Approved. Location stays paused.",
      ),
    );
    expect(mockStoreEnvelope).not.toHaveBeenCalled();
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
    await waitFor(() => expect(screen.getByText("Location off")).toBeTruthy());

    // The fix belongs to an intent the person has already replaced. Applying it
    // would silently turn location back on after they turned it off.
    await act(async () => {
      releaseFix();
    });
    expect(
      screen.getByRole("switch", { name: "Turn location on" }),
    ).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText("Location off")).toBeTruthy();
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

    await waitFor(() => expect(screen.getByText("Location off")).toBeTruthy());
    await waitFor(() => expect(mockCheckoutNearby).toHaveBeenCalledTimes(1));
    // Still in flight while the device already reads as paused.
    expect(releaseCheckout).not.toBeNull();

    await act(async () => {
      (releaseCheckout as unknown as () => void)();
    });
  });

  it("separates people who can already see you from people who cannot", async () => {
    // Reported from UAT: "3 logon ko location share kiya… phir revisit kiya
    // share location page par toh abhi bhi yeh same hi list dekha rha… long
    // list hoga toh user struggle karega." The picker rendered every trusted
    // person as an identical row with an identical Select control, so the
    // screen you reach straight after sharing with three people looked exactly
    // like the one where you had shared with nobody.
    //
    // It is not only a display problem. Picking someone who already holds an
    // active grant does not extend it — the backend revokes the old row and
    // inserts a new one — so a re-pick silently restarts a timer that was
    // already running. The remaining time on the row is what makes that
    // consequence visible before it is chosen.
    const sharing = locationState();
    const trustedB = {
      ...sharing.recipients[0]!,
      connectedFromContacts: true,
    };
    mockGetState.mockResolvedValue({
      ...sharing,
      recipients: [
        trustedB,
        {
          ...trustedB,
          userId: "user_c",
          displayName: "Trusted C",
          keyId: "key_c",
        },
      ],
      // Only Trusted B is live. Trusted C is reachable but not yet shared with.
      ownerGrants: [
        {
          ...sharing.ownerGrants[0],
          durationMode: "until_stopped",
          expiresAt: null,
        },
      ],
    });
    const pagedRecipients = [
      trustedB,
      {
        ...trustedB,
        userId: "user_c",
        displayName: "Trusted C",
        keyId: "key_c",
      },
    ];
    mockListRecipientsPage.mockResolvedValue({
      items: pagedRecipients,
      page: 1,
      hasMore: false,
      totalCount: pagedRecipients.length,
    });

    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();
    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    await openSharePersonStep();

    const alreadySharing = await screen.findByTestId(
      "one-location-share-already-sharing",
    );
    expect(within(alreadySharing).getByText("Already sharing")).toBeTruthy();
    expect(within(alreadySharing).getByText("1")).toBeTruthy();
    expect(within(alreadySharing).getByText("Trusted B")).toBeTruthy();
    expect(
      within(alreadySharing).getByLabelText("Connected from your contacts"),
    ).toBeTruthy();
    // The same words the Active shares screen uses for the same grant. Two
    // screens describing one share must not disagree about how long is left.
    expect(within(alreadySharing).getByText("Until you stop")).toBeTruthy();
    expect(within(alreadySharing).queryByText("Trusted C")).toBeNull();

    const notSharing = screen.getByTestId("one-location-share-people");
    expect(within(notSharing).getByText("Trusted C")).toBeTruthy();
    expect(within(notSharing).queryByText("Trusted B")).toBeNull();

    // Still selectable — you may genuinely want to restart a share. The row
    // states what is already true; it does not take the choice away.
    expect(
      screen.getByRole("button", {
        name: /Select Trusted B for private sharing/i,
      }),
    ).toBeTruthy();
  });

  it("keeps one flat list when nobody can see you yet", async () => {
    // The grouping must appear only when it is carrying information. An
    // "Already sharing (0)" heading over an empty group is noise on the most
    // common state of this screen.
    mockGetState.mockResolvedValue({ ...locationState(), ownerGrants: [] });

    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();
    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    await openSharePersonStep();

    expect(await screen.findByTestId("one-location-share-people")).toBeTruthy();
    expect(
      screen.queryByTestId("one-location-share-already-sharing"),
    ).toBeNull();
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
    expect(
      screen.queryByText("Better for privacy and battery life"),
    ).toBeNull();
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

    // Duration is a preset ladder now, not a scroll wheel: the wheel cost
    // 200px and two coordinated drags to reach a length almost everyone
    // picks off a list. It is still there behind "Custom", but it must not
    // be mounted until asked for -- that is the whole saving.
    expect(screen.queryByRole("spinbutton", { name: "Hours" })).toBeNull();
    expect(screen.queryByRole("spinbutton", { name: "Minutes" })).toBeNull();
    expect(screen.getByRole("button", { name: "15 min" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // Exactly one rung reads as chosen. Two pressed cells is the failure the
    // wheel had in a different form -- state and highlight disagreeing.
    const pressedRungs = screen
      .getAllByRole("button")
      .filter((node) => node.getAttribute("aria-pressed") === "true");
    expect(pressedRungs).toHaveLength(1);

    // The founder's literal complaint: "when choosing hours, people are
    // unable to choose 1 hour, 2 hours". One tap, exactly one hour, no
    // rounding to 1h15m.
    fireEvent.click(screen.getByRole("button", { name: "1 hour" }));
    expect(screen.getByRole("button", { name: "1 hour" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // The duration reads back as a clock time on the same screen that set it.
    expect(screen.getByText(/^Ends /)).toBeTruthy();

    const note = screen.getByRole("textbox", { name: "Optional note" });
    const startButton = screen.getByRole("button", { name: "Start sharing" });
    expect(screen.queryByText("0/140")).toBeNull();
    fireEvent.focus(note);
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
        // Exactly 1, not the 1.25 the wheel used to round a single Hours
        // step up to.
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

  it("keeps a selected Circle count scoped to its members when extra people are added", async () => {
    const readyRecipient = locationState().recipients[0]!;
    const makeReadyRecipient = (userId: string, displayName: string) => ({
      ...readyRecipient,
      userId,
      displayName,
      keyId: `${userId}-key`,
    });
    const circleMemberOne = makeReadyRecipient(
      "circle_member_one",
      "Circle Member One",
    );
    const circleMemberTwo = makeReadyRecipient(
      "circle_member_two",
      "Circle Member Two",
    );
    const outsiderOne = makeReadyRecipient("outside_one", "Outside One");
    const outsiderTwo = makeReadyRecipient("outside_two", "Outside Two");
    const circleSummary = {
      id: "circle_family",
      name: "Family",
      kind: "family" as const,
      role: "owner" as const,
      // Circle summaries include the viewer; the UI count intentionally does
      // not. Two shareable people plus the current owner therefore means 3.
      memberCount: 3,
      memberLimit: 20,
    };

    mockGetState.mockResolvedValue({
      ...locationState(),
      recipients: [
        circleMemberOne,
        circleMemberTwo,
        outsiderOne,
        outsiderTwo,
      ],
      circles: [circleSummary],
      ownerGrants: [],
    });
    mockGetCircle.mockResolvedValue({
      ...circleSummary,
      members: [
        {
          userId: "user_a",
          displayName: "Me",
          role: "owner" as const,
          phoneVerified: true,
          secureLocationReady: true,
          canReceiveLocation: true,
          keyId: "owner-key",
          publicKeyJwk: { kty: "EC" },
        },
        ...[circleMemberOne, circleMemberTwo].map((recipient) => ({
          userId: recipient.userId,
          displayName: recipient.displayName,
          role: "member" as const,
          phoneVerified: true,
          secureLocationReady: true,
          canReceiveLocation: true,
          keyId: recipient.keyId,
          publicKeyJwk: recipient.publicKeyJwk,
        })),
      ],
    });

    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();
    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    await openSharePersonStep();
    const shareHeader = screen
      .getByRole("heading", { name: "Who can see you?" })
      .closest("header");
    if (!shareHeader) throw new Error("Share flow header was not rendered.");

    fireEvent.click(
      screen.getByRole("button", {
        name: "Select the Family Circle, 2 members",
      }),
    );

    const selectedCircleRow = await screen.findByRole("button", {
      name: "Deselect the Family Circle, 2 selected",
    });
    expect(within(shareHeader).getByText("2 selected")).toBeTruthy();
    expect(within(selectedCircleRow).getByText("2 selected")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Select Outside One for private sharing",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Select Outside Two for private sharing",
      }),
    );

    expect(within(shareHeader).getByText("4 selected")).toBeTruthy();
    expect(
      within(
        screen.getByRole("button", {
          name: "Deselect the Family Circle, 2 selected",
        }),
      ).getByText("2 selected"),
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Deselect Outside Two for private sharing",
      }),
    );
    expect(within(shareHeader).getByText("3 selected")).toBeTruthy();
    expect(
      within(
        screen.getByRole("button", {
          name: "Deselect the Family Circle, 2 selected",
        }),
      ).getByText("2 selected"),
    ).toBeTruthy();
  });

  it("resets every abandoned share field and ignores a late review preflight", async () => {
    const { rerender } = render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();
    await waitFor(() => expect(mockGetState).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "People" }));
    fireEvent.change(await screen.findByPlaceholderText(/Search people/i), {
      target: { value: "Investor" },
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Share with Investor D" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Ready to share?" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("heading", { name: "Who can see you?" }),
    ).toBeNull();
    expect(
      within(
        screen.getByRole("list", {
          name: "People who can see your location",
        }),
      ).getByText("Investor D"),
    ).toBeTruthy();
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

    fireEvent.click(
      screen.getByRole("button", { name: "Change who can see you" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Who can see you?" }),
    ).toBeTruthy();
    expect(screen.getByPlaceholderText("Search people")).toHaveValue("");
    fireEvent.change(screen.getByPlaceholderText("Search people"), {
      target: { value: "Trusted" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(
      await screen.findByRole("heading", { name: "Ready to share?" }),
    ).toBeTruthy();
    // Move the duration off its default so the reset below has something to
    // actually reset.
    fireEvent.click(screen.getByRole("button", { name: "1 hour" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Optional note" }), {
      target: { value: "Meet me by the entrance" },
    });

    // Back to the people step so the pending permission below is attached to
    // Continue — the one control that now runs the device pre-flight.
    fireEvent.click(
      screen.getByRole("button", { name: "Change who can see you" }),
    );
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
      await screen.findByRole("heading", { name: "Location" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "People" }));
    expect(await screen.findByPlaceholderText(/Search people/i)).toHaveValue(
      "Investor",
    );
    fireEvent.click(screen.getByRole("button", { name: "Now" }));
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
    expect(screen.getByPlaceholderText("Search people")).toHaveValue("");
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
    // Back to the 15-minute default, and back to the collapsed ladder — a
    // reopened flow that kept "1 hour" pressed would be offering a length
    // this share never chose.
    expect(screen.getByRole("button", { name: "15 min" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "1 hour" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByRole("textbox", { name: "Optional note" })).toHaveValue(
      "",
    );
    expect(screen.queryByText("0/140")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: /^Share location$/i }));
    expect(
      await screen.findByRole("heading", { name: "Who can see you?" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    expect(mockCreateGrant).not.toHaveBeenCalled();
  }, 10000);

  it("opens Circle member Share directly on the details step with that member selected", async () => {
    const circle = {
      id: "circle-1",
      name: "Family",
      kind: "family" as const,
      role: "owner" as const,
      memberCount: 2,
      memberLimit: 20,
      viewerCapabilities: {
        canInviteMembers: true,
        canViewInviteCode: true,
        canRotateInviteCode: true,
        canManageCircle: true,
        canModerateInvites: true,
      },
      members: [
        {
          userId: "user_a",
          displayName: "Test User",
          role: "owner" as const,
          phoneVerified: true,
          secureLocationReady: true,
          canReceiveLocation: true,
          keyId: "key_a",
          publicKeyJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
        },
        {
          userId: "user_abdul",
          displayName: "Abdul Rashid",
          role: "member" as const,
          phoneVerified: true,
          secureLocationReady: true,
          canReceiveLocation: true,
          keyId: "key_abdul",
          publicKeyJwk: { kty: "EC", crv: "P-256", x: "xa", y: "ya" },
        },
      ],
    };
    mockListCircles.mockResolvedValue([circle]);
    mockGetCircle.mockResolvedValue(circle);
    mockListCircleMembersPage.mockResolvedValue({
      items: circle.members,
      page: 1,
      hasMore: false,
      totalCount: circle.members.length,
    });
    const { rerender } = render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();
    mockUseSearchParams.mockReturnValue(
      new URLSearchParams("action=circle-detail&circleId=circle-1"),
    );
    rerender(<OneLocationAgentPage />);

    await screen.findByText("Abdul Rashid");
    const menuTrigger = screen.getByRole("button", {
      name: "Actions for Abdul Rashid",
    });
    fireEvent.keyDown(menuTrigger, { key: "Enter" });
    fireEvent.click(
      await screen.findByRole("menuitem", { name: /Share location/i }),
    );

    expect(
      await screen.findByRole("heading", { name: "Ready to share?" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("heading", { name: "Who can see you?" }),
    ).toBeNull();
    await waitFor(() => expect(screen.getByText("Can see you")).toBeTruthy());
    expect(screen.getByText("Abdul Rashid")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start sharing" })).toBeEnabled();
  });

  it("renders the canonical Location Settings URL and owns Saved Locations there", async () => {
    mockLocationSearchParams("action=settings");
    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow({ expectMain: false });

    expect(
      await screen.findByRole("heading", { name: "Settings" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("region", { name: "Saved Locations" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Manage sharing" })).toBeNull();
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
    const { unmount } = render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();
    mockCaptureCurrentPosition.mockClear();
    const envelopeWritesBeforeOpen = mockStoreEnvelope.mock.calls.length;

    fireEvent.click(
      screen.getByRole("button", {
        name: "Save My Soul emergency alert",
      }),
    );

    expect(
      await screen.findByRole("heading", { name: "Save My Soul", level: 1 }),
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

    // The app shell owns Back. The emergency body must not add a second,
    // misleading Cancel action that only closes the screen while sharing can
    // remain live.
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    unmount();
    mockLocationSearchParams("");
    render(<OneLocationAgentPage />);
    expect(
      await screen.findByRole("heading", { name: "Location" }),
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

    fireEvent.click(
      screen.getByRole("button", {
        name: "Save My Soul emergency alert",
      }),
    );

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
      await screen.findByRole("heading", { name: "Save My Soul", level: 1 }),
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
      await screen.findByRole("heading", { name: "Save My Soul", level: 1 }),
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
      await screen.findByRole("heading", { name: "Save My Soul", level: 1 }),
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

  it("leaves setup through the shared top-shell back resolver, not browser history, without marking onboarding complete or skipped", async () => {
    // Was router.back(): WKWebView has no native history stack for Next
    // routes (lib/navigation/top-shell-back.ts), so leaving the onboarding
    // takeover that way could strand a native user on it (issue #5921).
    const onSetupComplete = vi.fn();
    const onSetupSkip = vi.fn();
    window.localStorage.setItem("one_location_onboarding_v2:user_a", "1");
    const onNavigationRequest = vi.fn();
    window.addEventListener(
      INTERNAL_APP_NAVIGATION_REQUEST_EVENT,
      onNavigationRequest,
    );

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
    expect(mockRouterBack).not.toHaveBeenCalled();
    expect(onNavigationRequest).toHaveBeenCalledTimes(1);
    expect(
      (onNavigationRequest.mock.calls[0][0] as CustomEvent).detail,
    ).toMatchObject({ href: ROUTES.ONE_HOME, replace: false });
    expect(onSetupSkip).not.toHaveBeenCalled();
    expect(onSetupComplete).not.toHaveBeenCalled();
    expect(
      window.localStorage.getItem("one_location_onboarding_v2:user_a"),
    ).toBe("1");
    window.removeEventListener(
      INTERNAL_APP_NAVIGATION_REQUEST_EVENT,
      onNavigationRequest,
    );
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
      await screen.findByRole("heading", { name: "Location" }),
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

  it("still knows where you are on the finale after the save-place prompt closes", async () => {
    // THE REGRESSION. The last onboarding screen -- "You're on the map." -- took
    // its camera from the save-place modal's DRAFT point, and both of that
    // modal's exits null it. The modal runs two screens earlier, so the finale
    // was handed null on every single run, `useGoogleMaps` was never enabled,
    // and the screen always drew its stylised fallback. The map feature shipped
    // and nobody, on any platform or in any environment, ever saw it.
    //
    // `reachLocationOnboardingFinalStep` dismisses that prompt with
    // "Skip for now" -- precisely the exit that used to destroy the point.
    render(<OneLocationAgentPage mode="setup" onSetupComplete={vi.fn()} />);

    await reachLocationOnboardingFinalStep();

    const map = screen.getByTestId("onboarding-live-map");
    // `data-map-state` cannot answer this: jsdom has no Google Maps, so it
    // reads "stylised" whether or not a point survived. That ambiguity is what
    // hid the bug, which is why the component reports the two separately.
    expect(map.getAttribute("data-map-point")).toBe("ready");
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
    expect(screen.getByRole("button", { name: "Open settings" })).toBeEnabled();
    expect(onSetupComplete).not.toHaveBeenCalled();
  });

  it("refreshes Location after returning from Settings and waits for the explicit saved-place CTA", async () => {
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
    expect(mockCaptureCurrentPosition).not.toHaveBeenCalled();

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

    const retry = await screen.findByRole("button", {
      name: "Set up my location",
    });
    expect(screen.queryByTestId("save-location-modal")).toBeNull();
    fireEvent.click(retry);
    expect(await screen.findByTestId("save-location-modal")).toBeTruthy();
    expect(mockCaptureCurrentPosition).toHaveBeenCalledTimes(1);
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

    fireEvent.change(screen.getByLabelText(/House or flat/), {
      target: { value: "Flat 4B" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Home" }));
    await saveOnboardingPlace();

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

    fireEvent.change(screen.getByLabelText(/House or flat/), {
      target: { value: "Second user's home" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Home" }));
    await saveOnboardingPlace();

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

  it("opens Manage sharing when more than three shares are present", async () => {
    const baseGrant = locationState().ownerGrants[0]!;
    const baseRecipient = locationState().recipients[0]!;
    mockGetState.mockResolvedValue({
      ...locationState(),
      recipients: Array.from({ length: 4 }, (_, index) => ({
        ...baseRecipient,
        userId: `user_${index + 1}`,
        displayName: `Trusted ${index + 1}`,
        keyId: `key_${index + 1}`,
      })),
      ownerGrants: Array.from({ length: 4 }, (_, index) => ({
        ...baseGrant,
        id: `grant_${index + 1}`,
        recipientUserId: `user_${index + 1}`,
        recipientKeyId: `key_${index + 1}`,
        recipientDisplayName: `Trusted ${index + 1}`,
        expiresAt: "2099-05-20T08:00:00.000Z",
      })),
    });

    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();

    fireEvent.click(screen.getByRole("button", { name: "Manage" }));
    expect(
      await screen.findByRole("heading", { name: "Manage sharing" }),
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
    await waitFor(
      () => expect(mockRequestLocationPermission).toHaveBeenCalledTimes(1),
      { timeout: 5_000 },
    );
    expect(toast.success).toHaveBeenCalledWith("Location access enabled.");
    await waitFor(() =>
      expect(mockCaptureCurrentPosition).toHaveBeenCalledTimes(1),
    );
    // The real rule is an ORDER — ask before you read — not a moment. This was
    // `expect(mockCaptureCurrentPosition).not.toHaveBeenCalled()` on the line
    // straight after the step opened, which is a negative assertion made at an
    // unsynchronised instant: when the grant and the capture happened to flush
    // inside `openLocationPermissionsStep`, a correct run failed. Measured at
    // roughly one run in four on untouched main. Invocation order states the
    // same contract and cannot race.
    expect(
      mockRequestLocationPermission.mock.invocationCallOrder[0],
      "the device was read before permission was asked for",
    ).toBeLessThan(mockCaptureCurrentPosition.mock.invocationCallOrder[0]!);
    expect(await screen.findByTestId("save-location-modal")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", {
        name: /Skip saving this place|Skip for now/,
      }),
    );
    await expectLocationInviteStep();
    fireEvent.click(await locationFinishButton());
    expect(
      await screen.findByRole("heading", { name: "Location" }),
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

    fireEvent.change(screen.getByLabelText(/House or flat/), {
      target: { value: "Flat 4B" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Home" }));
    await saveOnboardingPlace();

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
    expect(toast.error).toHaveBeenCalledWith("Check permission and try again.");
    expect(mockCaptureCurrentPosition).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByTestId("save-location-modal")).toBeTruthy();
    expect(mockCaptureCurrentPosition).toHaveBeenCalledTimes(2);
  });

  it("reopens the location picker from Ready and reuses the captured point", async () => {
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

    fireEvent.click(
      screen.getByRole("button", {
        name: /Skip saving this place|Skip for now/,
      }),
    );

    await waitFor(() =>
      expect(screen.queryByTestId("save-location-modal")).toBeNull(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Go back" }));

    const reopenedPrompt = await screen.findByTestId("save-location-modal");
    expect(mockCaptureCurrentPosition).toHaveBeenCalledTimes(1);
    fireEvent.click(
      within(reopenedPrompt).getByRole("button", {
        name: "Back to what One Location does",
      }),
    );

    expect(
      await screen.findByRole("heading", { name: "Keep your people updated." }),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Set up my location" }),
    );

    expect(await screen.findByTestId("save-location-modal")).toBeTruthy();
    expect(mockCaptureCurrentPosition).toHaveBeenCalledTimes(1);
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
    fireEvent.click(
      screen.getByRole("button", {
        name: /Skip saving this place|Skip for now/,
      }),
    );
    await expectLocationInviteStep();
    fireEvent.click(await locationFinishButton());
    expect(
      await screen.findByRole("heading", { name: "Location" }),
    ).toBeTruthy();
    expect(mockCaptureCurrentPosition).toHaveBeenCalledTimes(1);
    // Completing onboarding persists the one-time intro flag.
    expect(
      window.localStorage.getItem("one_location_onboarding_v2:user_a"),
    ).toBe("1");
  });

  it("turns location on once a place is confirmed in onboarding", async () => {
    // Reported from UAT: "onboarding mein mera location save ho rha, i could
    // able to confirm the location as home office others — then after
    // redirecting to this main page why location off..."
    //
    // Onboarding captured a position directly instead of going through
    // `ensureForegroundLocationReady`, so it never reached `activateMyLocation`
    // and never set `selfPreviewEnabled`. A brand-new owner also has no grants
    // and no nearby presence, so all three disjuncts behind `locationEnabled`
    // were false and the hub greeted them with "Location off" — seconds after
    // they granted permission, took a fix, dragged a pin and tagged it Home.
    //
    // Every other hub test reaches the hub through `skipLocationEntryFlow`,
    // which presses "Skip for now" on this modal, so the save path never once
    // reached an assertion about the header. That is why this shipped.
    window.localStorage.removeItem(
      "one_location_saved_location_prompt_v2:user_a",
    );
    mockLoadSavedLocations.mockResolvedValue([]);
    mockGetState.mockResolvedValue({ ...locationState(), ownerGrants: [] });

    render(<OneLocationAgentPage />);
    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    await openLocationPermissionsStep();

    expect(await screen.findByTestId("save-location-modal")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Home" }));
    await saveOnboardingPlace();
    await waitFor(() => expect(mockAddSavedLocation).toHaveBeenCalled());

    await expectLocationInviteStep();
    fireEvent.click(await locationFinishButton());
    expect(
      await screen.findByRole("heading", { name: "Location" }),
    ).toBeTruthy();

    // The header agrees with what the person just did.
    await waitFor(() =>
      expect(screen.getByTestId("one-location-header-status").textContent).toBe(
        "Location on",
      ),
    );
    expect(
      screen.getByRole("switch", { name: "Turn location off" }),
    ).toHaveAttribute("aria-checked", "true");
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

    fireEvent.change(screen.getByLabelText(/House or flat/), {
      target: { value: "Tower 2, Floor 4" },
    });
    fireEvent.change(screen.getByLabelText(/Landmark/), {
      target: { value: "India Gate" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Work" }));
    await saveOnboardingPlace();

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
          // No building colour: the form no longer asks for one. The PIN is
          // still in the line because it was derived from the address rather
          // than typed.
          address:
            "Tower 2, Floor 4, Near India Gate, Kartavya Path, New Delhi, Delhi 110001, India",
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
        await screen.findByRole("heading", { name: "Location" }),
      ).toBeTruthy();
      expect(
        screen.queryByRole("heading", {
          name: "Keep your people updated.",
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
    expect(screen.getByText("TB")).toBeTruthy();
    expect(screen.queryByText(/8012|4455|9911/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Now" }));
    expect(screen.queryByRole("button", { name: /Active shares/i })).toBeNull();
    await openSharePersonStep();
    fireEvent.change(screen.getByPlaceholderText("Search people"), {
      target: { value: "advisor" },
    });

    expect(screen.getAllByText("Advisor C").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Invite them first").length).toBeGreaterThan(0);
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
    expect(await screen.findByPlaceholderText(/Search people/i)).toBeTruthy();
    expect(
      screen.queryByRole("heading", { name: "Pending invites" }),
    ).toBeNull();
    // Links tab: with no link live, the tab IS the create form -- heading,
    // duration, and the button that creates. There is no separate screen and
    // no "No active links" placeholder standing in for one; the form is the
    // empty state.
    fireEvent.click(screen.getByRole("button", { name: "Links" }));
    expect(
      await screen.findByRole("button", { name: /Create link/i }),
    ).toBeTruthy();
    expect(screen.getByText("Temporary link")).toBeTruthy();
    expect(
      screen.getByText(
        "Anyone with this link can see your location until it expires.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Duration")).toBeTruthy();
    expect(screen.getByRole("radio", { name: "30 min" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "1 hour" })).toBeTruthy();
    expect(screen.queryByText("Active links")).toBeNull();
    expect(screen.queryByText("Link stays live for")).toBeNull();
    // The paragraph that used to sit under the heading is gone.
    expect(screen.queryByText(/Links you can send to anyone/i)).toBeNull();
    expect(screen.queryByText("No active links")).toBeNull();
    expect(screen.queryByText("Public link responses")).toBeNull();
    expect(screen.queryByText(/Share a public location link/i)).toBeNull();
    expect(screen.queryByText(/whatsapp/i)).toBeNull();
  });

  it("#6286/back-button: records each Now/People/Links switch for Back to undo", async () => {
    // TopShellTabs is the one place that writes tab-switch-history -- if this
    // wiring silently breaks, the fix in top-shell-back.ts (which reads it)
    // becomes a dead branch that never fires. (Cleared fresh by the file's
    // own beforeEach above.)
    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();
    await waitFor(() => expect(mockGetState).toHaveBeenCalled());

    expect(readPreviousTabHref("location")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "People" }));
    await waitFor(() =>
      expect(readPreviousTabHref("location")).toBe("/one/location"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Links" }));
    await waitFor(() =>
      expect(readPreviousTabHref("location")).toBe(
        "/one/location?view=people",
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Now" }));
    await waitFor(() =>
      expect(readPreviousTabHref("location")).toBe(
        "/one/location?view=links",
      ),
    );
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
        await screen.findByRole("heading", { name: "Location" }),
      ).toBeTruthy();
      await waitFor(() => expect(mockGetState).toHaveBeenCalled());
      fireEvent.click(
        screen.getByRole("button", { name: /Sharing with you/i }),
      );
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
      await screen.findByRole("heading", { name: "Location" }),
    ).toBeTruthy();

    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: /Sharing with you/i }));
    expect(
      screen.getByRole("heading", { name: "Shared with me" }),
    ).toBeTruthy();
    await waitFor(() => expect(mockViewEnvelope).toHaveBeenCalled());
    expect(await screen.findByText("Location may be stale.")).toBeTruthy();
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
    const expandButton = screen.getByRole("button", {
      name: "View shared location from Trusted A",
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
      "https://uat.one.hushh.ai/one/location/view/aQluqHFAdgETh91oLTmG6o7v8A6TAB7PmZjrOJwPcIA";
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
    fireEvent.click(screen.getByRole("button", { name: /^Create link$/i }));

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
    // The result replaces the form in place, on the same tab -- no third
    // screen, and no "Done" to dismiss back to where you already are.
    expect(await screen.findByText("Temporary link")).toBeTruthy();
    expect(
      screen.getByText("Anyone with this link can see your location."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Share$/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Copy link/i })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Revoking|Revoke link/i }),
    ).toBeTruthy();
    // And no way to make a second while this one is live.
    expect(screen.queryByRole("button", { name: /^Create link$/i })).toBeNull();
    expect(screen.queryByText("Duration")).toBeNull();
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
      expect(screen.getByTestId("one-location-now-actions")).toBeTruthy(),
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
        {
          ...base,
          id: "grant_b",
          recipientUserId: "user_b",
          recipientKeyId: "key_b",
        },
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

  // Lives here, with the other Request-flow tests, and not up beside the share
  // tests where it was first written. It used to be the earliest test in the
  // file to mount the duration WHEEL, and Embla measures asynchronously;
  // opening the Ask flow hundreds of tests earlier leaked that work into the
  // onboarding permission test, which then failed about one run in two. Ask no
  // longer mounts a wheel at all (see the ladder test below), but the placement
  // stays: the flake was about where the Ask flow opens, not only about Embla.
  it("never offers an open-ended duration when asking someone else", async () => {
    // Reported from UAT: "request location mein bhi 'Until I stop' hain. main
    // dusron se req karungi, and duration 'until i stop' meaningful rahega??"
    // Asking to watch someone until *I* stop is not a thing you can ask for:
    // it is location, so only they can stop it, and the request lane has
    // no open-ended mode server-side at all.
    //
    // The prop that removes it (`allowUntilStop={false}`) landed with the
    // duration-ladder change and had no test of its own, on either half — so
    // the screen was one prop deletion away from offering it again, and the
    // value it emits is a non-numeric sentinel this lane later runs Number()
    // over. That would post NaN to a `gt=0` field.
    mockGetState.mockResolvedValue({ ...locationState(), ownerGrants: [] });

    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();
    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    await openAskFlow();
    await selectAskRecipient(/Select Trusted B for location request/i);
    await continueAskFlow();

    expect(screen.queryByRole("button", { name: "Until I stop" })).toBeNull();
    expect(screen.queryByText("Until you stop")).toBeNull();
    // The timed control itself is still there — this removes one option, not
    // the ability to say how long.
    expect(screen.getByRole("button", { name: "15 min" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Custom" })).toBeTruthy();
  });

  it("asks for a duration with the same control the Share screen uses", async () => {
    // Reported from UAT: "share location mein jaise time ka div aayega, request
    // mein bhi same aana chahiye". Ask put a two-column scroll wheel in a
    // settings-row trailing slot — a 260px control pinned to the right edge of
    // a row, which is why it overlapped the row it sat in and looked nothing
    // like the screen people reach it from. Share had already moved to the
    // preset ladder; Ask had not.
    mockGetState.mockResolvedValue({ ...locationState(), ownerGrants: [] });

    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();
    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    await openAskFlow();
    await selectAskRecipient(/Select Trusted B for location request/i);
    await continueAskFlow();

    // Request uses the same compact ladder pattern as Share, but it cannot ask
    // for open-ended access to someone else's location.
    for (const label of ["15 min", "1 hour", "Custom"]) {
      expect(
        screen.getByRole("button", { name: label }),
        `Ask is missing the "${label}" rung`,
      ).toBeTruthy();
    }
    expect(screen.queryByRole("button", { name: "Until I stop" })).toBeNull();
    // And no wheel: the spinbuttons only exist inside the wheel, and mounting
    // one here is what the report was about.
    expect(screen.queryByRole("spinbutton", { name: "Hours" })).toBeNull();
    expect(screen.queryByRole("spinbutton", { name: "Minutes" })).toBeNull();
  }, 10_000);

  it("offers four durations when asking, and reaches the rest through Custom", async () => {
    // Reported: the ask ladder carried five rungs plus Custom. Six cells is
    // three rows of a card that also holds four Reason chips, a recipient rail
    // and two stacked actions, so the duration question alone was half the
    // screen. The three that stay are the ones an ask is made in -- "where are
    // you now", the default hour, and an afternoon.
    //
    // Asserted as an exact ordered list, not as "these are present": a rung
    // creeping back is the whole thing this guards, and `getByRole` would not
    // notice.
    mockGetState.mockResolvedValue({ ...locationState(), ownerGrants: [] });

    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();
    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    await openAskFlow();
    await selectAskRecipient(/Select Trusted B for location request/i);
    await continueAskFlow();

    const ladder = screen.getByRole("group", { name: "How long" });
    expect(
      within(ladder)
        .getAllByRole("button")
        .map((cell) => cell.textContent?.trim()),
    ).toEqual(["15 min", "1 hour", "2 hours", "Custom"]);

    // Removed from the face of the ladder, not from the lane.
    expect(within(ladder).queryByRole("button", { name: "4 hours" })).toBeNull();
    expect(within(ladder).queryByRole("button", { name: "8 hours" })).toBeNull();

    // And Custom still reaches them: one deliberate tap, then the wheel.
    fireEvent.click(within(ladder).getByRole("button", { name: "Custom" }));
    expect(screen.getByRole("spinbutton", { name: "Hours" })).toBeTruthy();
  }, 10_000);

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
    await selectAskRecipient(/Select Trusted B for location request/i);
    await continueAskFlow();
    expect(
      screen.queryByPlaceholderText(
        "Hey, can you share your location until we meet?",
      ),
    ).toBeNull();
    expect(screen.queryByPlaceholderText("What should they know?")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Send request/i }));

    await waitFor(() => expect(mockRequestAccess).toHaveBeenCalledTimes(1));
    // The picked duration travels WITH the request. The Ask screen has
    // always shown a "Duration requested" control; it used to be dropped at
    // this boundary, so the owner approved from their own unrelated one.
    expect(mockRequestAccess).toHaveBeenCalledWith({
      vaultOwnerToken: "vault-token",
      ownerUserId: "user_b",
      message: "Safety check-in",
      requestedDurationHours: 1,
      requestedDurationMode: "timed",
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
        has_note: false,
      }),
    );
    // The confirmation is a toast, not a banner. It used to be both, on a
    // screen whose rows already say "Asked just now ... waiting on them" --
    // three tellings of one fact, one of them holding permanent layout to say
    // something that stopped being news a second later.
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        expect.stringContaining("Request sent."),
      ),
    );
    expect(screen.queryByText("Request sent.")).toBeNull();
  });

  it("returns to My Location after a complete request and reopens cleanly", async () => {
    mockGetState.mockResolvedValue({
      ...locationState(),
      ownerGrants: [],
    });

    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();
    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    await openAskFlow();

    await selectAskRecipient(/Select Trusted B for location request/i);
    await continueAskFlow();
    fireEvent.click(screen.getByRole("button", { name: /Send request/i }));
    await waitFor(() => expect(mockRequestAccess).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        expect.stringContaining("Request sent."),
      ),
    );

    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Ask for location" })).toBeNull(),
    );

    await openAskFlow();
    await selectAskRecipient(/Select Advisor C for location request/i);
    await continueAskFlow();
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

  it("closes only after an in-flight request completes", async () => {
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

    await selectAskRecipient(/Select Trusted B for location request/i);
    await continueAskFlow();
    fireEvent.click(screen.getByRole("button", { name: /Send request/i }));
    await waitFor(() => expect(mockRequestAccess).toHaveBeenCalledTimes(1));

    await act(async () => {
      releaseFirstRequest?.();
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        expect.stringContaining("Request sent."),
      ),
    );
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Ask for location" })).toBeNull(),
    );

    await openAskFlow();
    await selectAskRecipient(/Select Advisor C for location request/i);
    await continueAskFlow();
    fireEvent.click(screen.getByRole("button", { name: /Send request/i }));
    await waitFor(() => expect(mockRequestAccess).toHaveBeenCalledTimes(2));
    expect(mockRequestAccess).toHaveBeenLastCalledWith(
      expect.objectContaining({ ownerUserId: "user_c" }),
    );
  });

  it("keeps only failed recipients selected after a partial request failure", async () => {
    mockGetState.mockResolvedValue({
      ...locationState(),
      ownerGrants: [],
    });
    mockRequestAccess
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("network down"));

    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();
    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    await openAskFlow();

    await selectAskRecipient(/Select Trusted B for location request/i);
    await selectAskRecipient(/Select Advisor C for location request/i);
    await continueAskFlow();
    fireEvent.click(screen.getByRole("button", { name: /Send request/i }));

    await waitFor(() => expect(mockRequestAccess).toHaveBeenCalledTimes(2));
    expect(toast.error).toHaveBeenCalled();
    expect(
      await screen.findByRole("heading", { name: "Who, then how long?" }),
    ).toBeTruthy();
    await waitFor(() =>
      expect(
        within(
          screen.getByRole("list", {
            name: "People you are asking for location",
          }),
        ).queryByText("Trusted B"),
      ).toBeNull(),
    );
    expect(
      within(
        screen.getByRole("list", {
          name: "People you are asking for location",
        }),
      ).getByText("Advisor C"),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send request" })).toBeEnabled();
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

    await selectAskRecipient(/Select Trusted B for location request/i);
    await continueAskFlow();
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
    // Asserted on the toast, not on the absence of a banner: with the banner
    // gone, `queryByRole("status")` is null whether the send worked or not, so
    // it would pass for the wrong reason. The channel that DOES carry a
    // success is the one that has to stay silent.
    expect(toast.success).not.toHaveBeenCalledWith(
      expect.stringContaining("Request sent."),
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
    expect(screen.queryByRole("heading", { name: "Requests sent" })).toBeNull();
    expect(await screen.findByText("Trusted B")).toBeTruthy();
    expect(screen.getByText("Waiting for response")).toBeTruthy();
    await openPeoplePersonActions("Trusted B");
    fireEvent.click(screen.getByRole("button", { name: "Cancel request" }));
    await waitFor(() =>
      expect(mockWithdrawRequest).toHaveBeenCalledWith({
        requestId: "request_1",
        vaultOwnerToken: "vault-token",
      }),
    );
    expect(screen.getAllByText("Trusted B").length).toBeGreaterThan(0);
    expect(screen.queryByText("user_b")).toBeNull();
    expect(screen.queryByText("request_1")).toBeNull();
  });

  it("moves received-location management out of People and into Shared with me", async () => {
    mockGetState.mockResolvedValue({
      ...locationState(),
      ownerGrants: [],
      receivedGrants: [liveReceivedGrant(60)],
    });

    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();

    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "People" }));
    expect(screen.queryByRole("heading", { name: "Requests sent" })).toBeNull();
    expect(await screen.findByText(/Sharing with you/i)).toBeTruthy();
    await openPeoplePersonActions("Trusted B");
    fireEvent.click(
      screen.getByRole("button", { name: "View their location" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Shared with me" }),
    ).toBeTruthy();
  });

  it("keeps 30-minute extension requests in the Ask flow", async () => {
    mockGetState.mockResolvedValue({
      ...locationState(),
      ownerGrants: [],
      receivedGrants: [liveReceivedGrant(60)],
    });

    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();

    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    await openAskFlow();
    fireEvent.change(screen.getByPlaceholderText(/search/i), {
      target: { value: "Trusted B" },
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Edit access for Trusted B" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Ask Trusted B for 30 min more" }),
    );

    await waitFor(() =>
      expect(mockRequestAccess).toHaveBeenCalledWith({
        vaultOwnerToken: "vault-token",
        ownerUserId: "user_b",
        message: "Requesting 30 min more of your live location.",
        requestedDurationHours: 0.5,
        requestedDurationMode: "timed",
        extendsGrantId: "grant_live_ask",
      }),
    );
    expect(mockShortenGrant).not.toHaveBeenCalled();
  });

  it("keeps 2-hour extension requests in the Ask flow", async () => {
    mockGetState.mockResolvedValue({
      ...locationState(),
      ownerGrants: [],
      receivedGrants: [liveReceivedGrant(60)],
    });

    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();

    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    await openAskFlow();
    fireEvent.change(screen.getByPlaceholderText(/search/i), {
      target: { value: "Trusted B" },
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Edit access for Trusted B" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Ask Trusted B for 2 hours more" }),
    );

    await waitFor(() =>
      expect(mockRequestAccess).toHaveBeenCalledWith({
        vaultOwnerToken: "vault-token",
        ownerUserId: "user_b",
        message: "Requesting 2 hours more of your live location.",
        requestedDurationHours: 2,
        requestedDurationMode: "timed",
        extendsGrantId: "grant_live_ask",
      }),
    );
    expect(mockShortenGrant).not.toHaveBeenCalled();
  });

  it("shows the selected count once and reads back recipients before Send", async () => {
    // Step 1 owns the count while the user is choosing. Step 2 owns the
    // recipient read-back. Repeating the same count beside Send was noise.
    mockGetState.mockResolvedValue(locationState());

    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();
    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    await openAskFlow();

    // Nothing chosen: the bar is there, the count is not -- an empty line
    // announcing zero is noise.
    expect(screen.queryByTestId("one-location-ask-send-bar")).toBeNull();
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    expect(
      screen.queryByTestId("one-location-ask-selection-summary"),
    ).toBeNull();

    await selectAskRecipient(/Select Trusted B/i);
    expect(screen.getByText("1 selected")).toBeTruthy();
    await continueAskFlow();

    expect(
      within(
        screen.getByRole("list", {
          name: "People you are asking for location",
        }),
      ).getByText("Trusted B"),
    ).toBeTruthy();
    expect(
      screen.queryByTestId("one-location-ask-selection-summary"),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Send request" }),
    ).toBeEnabled();
  });

  it("drops the arrangement while a query is active", async () => {
    // A search result is ordered by how well each person matches. Headings over
    // that would name an order the list does not have, so the sections go and
    // the caller's ranking passes through untouched.
    mockGetState.mockResolvedValue(locationState());

    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();
    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    await openAskFlow();

    fireEvent.change(screen.getByPlaceholderText(/search/i), {
      target: { value: "Tru" },
    });

    await waitFor(() => {
      expect(
        screen.queryByTestId("one-location-ask-section-header:recent"),
      ).toBeNull();
      expect(
        screen.queryByTestId("one-location-ask-section-header:all"),
      ).toBeNull();
    });
  });

  it("keeps Ask for location as one compact list of people who can receive a new ask", async () => {
    // The roster carries `role="list"`, and every entry in it is wrapped as a
    // `listitem`. The new compact treatment removes section headers entirely,
    // so a screen reader never reads "Recent" as a person between two names.
    const state = locationState();
    mockGetState.mockResolvedValue({
      ...state,
      recipients: state.recipients.map((recipient) =>
        recipient.userId === "user_d"
          ? {
              ...recipient,
              photoUrl: "https://cdn.example.test/investor-d-avatar.jpg",
              isRia: true,
            }
          : recipient,
      ),
      // The page derives `requestedByMe` from `requests`, filtered to the ones
      // this viewer sent, so the fixture has to seed the field the API returns.
      requests: [
        {
          id: "req_recent",
          ownerUserId: "user_b",
          requesterUserId: "user_a",
          status: "pending",
          requestedAt: new Date().toISOString(),
        },
      ],
    });

    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();
    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    await openAskFlow();

    const list = await screen.findByTestId("one-location-ask-recipients");
    expect(
      screen.queryByTestId("one-location-ask-section-header:recent"),
    ).toBeNull();
    expect(
      screen.queryByTestId("one-location-ask-section-header:all"),
    ).toBeNull();
    expect(within(list).getAllByRole("listitem").length).toBeGreaterThanOrEqual(
      1,
    );
    expect(
      within(list).getByRole("button", { name: /Select Advisor C/i }),
    ).toBeTruthy();
    expect(within(list).queryByText("Trusted B")).toBeNull();
    expect(
      screen.getByTestId("one-location-ask-waiting-summary"),
    ).toHaveTextContent("Waiting for 1 response");
    expect(
      list.querySelector(
        '[data-photo-url="https://cdn.example.test/investor-d-avatar.jpg"]',
      ),
    ).toBeTruthy();
    expect(within(list).getByLabelText("Verified advisor")).toBeTruthy();
  });

  it("offers contextual Connect recovery when the person being looked for is not on the list", async () => {
    // This roster is everyone you are already connected to, so "they are not
    // here" has exactly one answer and it lives on another screen. Without
    // this the empty state was a dead end, and a search that found nobody was
    // worse: it proved the person was missing and offered nothing to do next.
    mockGetState.mockResolvedValue({ ...locationState(), recipients: [] });

    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();
    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    await openAskFlow();

    fireEvent.change(screen.getByPlaceholderText(/search/i), {
      target: { value: "Parth" },
    });

    const link = await screen.findByTestId("one-location-ask-find-or-invite");
    const href = link.getAttribute("href") ?? "";
    const params = new URLSearchParams(href.split("?")[1] ?? "");
    expect(href.startsWith(`${ROUTES.CONNECT}?`)).toBe(true);
    expect(params.get("tab")).toBe("all");
    expect(params.get("q")).toBe("Parth");
    expect(params.get("return_to")).toBe(
      `${ROUTES.ONE_LOCATION}?view=now&action=ask`,
    );
    expect(link).toHaveTextContent("Find or invite someone");
  });

  it("keeps typing local so the roster is not refiltered on every keystroke", async () => {
    // `setRecipientSearch` drives `visibleRecipients`, which re-runs the filter
    // over the whole roster and re-renders every row. Wired straight to
    // onChange that ran once per keystroke. The field now reads local state and
    // only the debounced value reaches the view model -- so the character is on
    // screen immediately while the work waits.
    mockGetState.mockResolvedValue(locationState());

    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();
    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    await openAskFlow();

    const field = screen.getByPlaceholderText(/search/i);
    fireEvent.change(field, { target: { value: "Tru" } });

    // The character is visible at once; the filter has not run yet.
    expect((field as HTMLInputElement).value).toBe("Tru");
    expect(screen.getByText("Trusted B")).toBeInTheDocument();
  });

  it("shows live access controls only after an exact Ask search", async () => {
    // The default Ask list is a new-request chooser. A live person is not mixed
    // into that list, but a direct search can still explain and manage the
    // exact state the user is looking for.
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

    expect(
      screen.queryByRole("button", { name: "Remove Trusted B's access" }),
    ).toBeNull();

    fireEvent.change(screen.getByPlaceholderText(/search/i), {
      target: { value: "Trusted B" },
    });

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Remove Trusted B's access",
      }),
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

  it("asks for MORE time from the Ask flow's own list, never an absolute one", async () => {
    /**
     * Reported: "4 hours ke liye approval maine le liya toh neeche ke time
     * duration edit mein aana illogical ... agar deni hain toh user can ask
     * for more time, let's say pehle 2 hours ka toh 30 minutes more ya 1 hour".
     *
     * This row used to expand a `Select` labelled "New duration" holding
     * ABSOLUTE lengths, preselected to whatever the share had left. Its
     * obvious reading -- "this share is 4 hours, pick a new total" -- was the
     * wrong one twice over: picking under what was left silently SHORTENED the
     * share, and picking over it sent `extendsGrantId`, which makes the server
     * read the number as time ON TOP. One field, two opposite operations, and
     * nothing on screen saying which.
     *
     * It is the control the People tab already used for the same decision.
     */
    mockGetState.mockResolvedValue({
      ...locationState(),
      ownerGrants: [],
      receivedGrants: [liveReceivedGrant(4 * 60)],
    });

    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();
    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    await openAskFlow();

    fireEvent.change(screen.getByPlaceholderText(/search/i), {
      target: { value: "Trusted B" },
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Edit access for Trusted B" }),
    );

    // The absolute picker and its Save are gone.
    expect(screen.queryByRole("combobox", { name: "New duration" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();

    // Four additive amounts, ascending, every label saying "more" -- the same
    // list, from the same module, the People tab renders.
    expect(screen.getByText("Ask for more time")).toBeTruthy();
    expect(
      within(screen.getByTestId("one-location-more-time-options"))
        .getAllByRole("button")
        .map((button) => button.textContent?.trim()),
    ).toEqual(["15 min more", "30 min more", "1 hour more", "2 hours more"]);
    expect(screen.getByText("They’ll need to approve.")).toBeTruthy();
  }, 10_000);

  it("sends the amount as time on top of the live share, and never shortens", async () => {
    // The reporter's own example: a share already running, asked for an hour
    // more. `extendsGrantId` is what makes `requestedDurationHours` additive,
    // so the two must always travel together.
    mockGetState.mockResolvedValue({
      ...locationState(),
      ownerGrants: [],
      receivedGrants: [liveReceivedGrant(2 * 60)],
    });

    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();
    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    await openAskFlow();

    fireEvent.change(screen.getByPlaceholderText(/search/i), {
      target: { value: "Trusted B" },
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Edit access for Trusted B" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Ask Trusted B for 1 hour more" }),
    );

    await waitFor(() =>
      expect(mockRequestAccess).toHaveBeenCalledWith({
        vaultOwnerToken: "vault-token",
        ownerUserId: "user_b",
        message: "Requesting 1 hour more of your live location.",
        requestedDurationHours: 1,
        requestedDurationMode: "timed",
        extendsGrantId: "grant_live_ask",
      }),
    );
    // No shorten, ever: there is no amount on this control that could mean it.
    expect(mockShortenGrant).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "Asked Trusted B for 1 hour more.",
      ),
    );
  }, 10_000);

  it("carries the smallest amount too, for a share about to run out", async () => {
    // 15 minutes is the backend's floor (`MIN_DURATION_HOURS`), which makes it
    // the smallest thing anyone can ask for -- and the right top-up for a
    // share with minutes left. The old control's shortest option was 15 min
    // ABSOLUTE, which on a 4-hour share cut it instead.
    mockGetState.mockResolvedValue({
      ...locationState(),
      ownerGrants: [],
      receivedGrants: [liveReceivedGrant(8)],
    });

    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();
    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    await openAskFlow();

    fireEvent.change(screen.getByPlaceholderText(/search/i), {
      target: { value: "Trusted B" },
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Edit access for Trusted B" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Ask Trusted B for 15 min more" }),
    );

    await waitFor(() =>
      expect(mockRequestAccess).toHaveBeenCalledWith(
        expect.objectContaining({
          requestedDurationHours: 0.25,
          extendsGrantId: "grant_live_ask",
          message: "Requesting 15 min more of your live location.",
        }),
      ),
    );
    expect(mockShortenGrant).not.toHaveBeenCalled();
  }, 10_000);

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

    fireEvent.change(screen.getByPlaceholderText(/search/i), {
      target: { value: "Trusted B" },
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Edit access for Trusted B" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Ask Trusted B for 2 hours more" }),
    );

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Couldn't ask Trusted B for more time. Try again.",
      ),
    );
    // A failed ask is not a reason to strand the row: the amounts come back
    // live, and Remove was never the save's to disable.
    const retry = await screen.findByRole("button", {
      name: "Ask Trusted B for 2 hours more",
    });
    expect(retry.hasAttribute("disabled")).toBe(false);
    expect(
      screen
        .getByRole("button", { name: "Remove Trusted B's access" })
        .hasAttribute("disabled"),
    ).toBe(false);
  }, 10_000);

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
    await selectAskRecipient(/Select Trusted B for location request/i);
    expect(
      await screen.findByRole("button", {
        name: /Deselect Trusted B for location request/i,
      }),
    ).toBeTruthy();
    await selectAskRecipient(/Select Investor D for location request/i);
    expect(
      await screen.findByRole("button", {
        name: /Deselect Investor D for location request/i,
      }),
    ).toBeTruthy();
    await continueAskFlow();
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

  it("gates the Location hub before opening a contact source", async () => {
    mockRequestContactCheck.mockReturnValue(false);
    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();
    await waitFor(() => expect(mockGetState).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "People" }));
    openDropdownMenu(
      await screen.findByRole("button", { name: /Add or manage people/i }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: /Find contacts/i }));

    expect(mockRequestContactCheck).toHaveBeenCalledTimes(1);
    expect(mockRequestGoogleContactsToken).not.toHaveBeenCalled();
    expect(mockSyncOneLocationContactSignals).not.toHaveBeenCalled();
  });

  it("syncs mobile contact matches without showing phone digits", async () => {
    mockUseRequireAuth.mockReturnValue({
      loading: false,
      isAuthenticated: true,
      userId: "user_a",
      // Native UAT verification hydrates this AuthContext value without
      // necessarily changing Firebase User.phoneNumber.
      phoneNumber: "+919000000001",
      user: {
        uid: "user_a",
        getIdToken: vi.fn().mockResolvedValue("id-token"),
      },
    });
    let contactSyncCompleted = false;
    const oldRecipient = locationState().recipients[0];
    const matchedRecipient = {
      ...locationState().recipients[2],
      connectedFromContacts: true,
    };
    mockListRecipientsPage.mockImplementation(async () => ({
      items: contactSyncCompleted
        ? [oldRecipient, matchedRecipient]
        : [oldRecipient],
      page: 1,
      hasMore: false,
      totalCount: contactSyncCompleted ? 2 : 1,
    }));
    mockSyncOneLocationContactSignals.mockImplementationOnce(async () => {
      contactSyncCompleted = true;
      return {
        matches: [
          {
            lookupId: "lookup_1",
            userId: "user_d",
            displayName: "Investor D",
            photoUrl: null,
            outcome: "auto_connected",
          },
        ],
        matchedUserIds: ["user_d"],
        totalContacts: 8,
        inviteCandidateCount: 7,
        readContactCount: 8,
        checkedContactCount: 8,
        matchedContactCount: 1,
        unmatchedContactCount: 7,
        uncheckableContactCount: 0,
        excludedSelfContactCount: 0,
        unknownContactCount: 0,
        mutationOutcomeUnknown: false,
        uncheckedContactCount: 0,
        autoConnectedCount: 1,
        alreadyConnectedCount: 0,
        requestRequiredCount: 0,
        suppressedCount: 0,
        completedBatchCount: 1,
        totalBatchCount: 1,
        partial: false,
        region: "IN",
        limited: false,
        truncated: false,
        sourcePlatform: "ios",
      };
    });
    const view = render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();

    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    await waitFor(() =>
      expect(mockListRecipientsPage.mock.calls.length).toBeGreaterThanOrEqual(
        2,
      ),
    );
    // The populated People tab exposes one compact Add action; contact sync is
    // still the same handler behind that menu.
    fireEvent.click(screen.getByRole("button", { name: "People" }));
    expect(
      within(await screen.findByTestId("one-location-people-list")).getByText(
        "Trusted B",
      ),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("one-location-people-list")).queryByText(
        "Investor D",
      ),
    ).toBeNull();
    // Isolate the mutation-triggered fetch from the two debounced initial
    // recipient pickers. A later Investor row must be caused by contact sync,
    // not by an initial timer that happened to fire after the test toggled its
    // mock state.
    mockListRecipientsPage.mockClear();
    expect(
      await screen.findByRole("button", { name: /Add or manage people/i }),
    ).toBeTruthy();
    openDropdownMenu(
      await screen.findByRole("button", { name: /Add or manage people/i }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: /Find contacts/i }));

    await waitFor(() =>
      expect(mockSyncOneLocationContactSignals).toHaveBeenCalledWith(
        expect.objectContaining({
          accountPhoneNumber: "+919000000001",
          resolveAccountPhoneNumber: expect.any(Function),
          resolveIdToken: expect.any(Function),
        }),
      ),
    );
    await expect(
      mockSyncOneLocationContactSignals.mock.calls[0]?.[0].resolveIdToken?.(),
    ).resolves.toBe("id-token");
    await waitFor(() =>
      expect(mockListRecipientsPage).toHaveBeenCalledWith({
        vaultOwnerToken: "vault-token",
        page: 1,
        limit: 50,
        query: undefined,
      }),
    );
    // The matched identity remains visible in the persistent result sheet and
    // in People once its paged/fallback row settles.
    expect(
      (await screen.findAllByText("Investor D")).length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      await within(screen.getByTestId("one-location-people-list")).findByText(
        "Investor D",
      ),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("one-location-people-list")).queryByLabelText(
        "Connected from your contacts",
      ),
    ).toBeNull();
    expect(screen.queryByText(/9911|8012|4455/)).toBeNull();
    // The People directory stays calm after sync: matched people may move into
    // the list, but the contact-source badge and long permanent sync subtitle
    // do not crowd the main hub.
    expect(screen.queryByText("In your contacts")).toBeNull();
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

    mockUseRequireAuth.mockReturnValue({
      loading: false,
      isAuthenticated: true,
      userId: "user_b",
      phoneNumber: "+919000000002",
      user: {
        uid: "user_b",
        getIdToken: vi.fn().mockResolvedValue("id-token-b"),
      },
    });
    view.rerender(<OneLocationAgentPage />);
    await waitFor(() =>
      expect(screen.queryByText("Contact sync results")).toBeNull(),
    );
  });

  it("reconciles the connection graph when a contact-sync mutation outcome is unknown", async () => {
    const graphMutation = vi.spyOn(
      CacheSyncService,
      "onConnectionGraphMutated",
    );
    mockSyncOneLocationContactSignals.mockResolvedValueOnce({
      matches: [],
      matchedUserIds: [],
      totalContacts: 1500,
      inviteCandidateCount: 0,
      readContactCount: 1500,
      checkedContactCount: 0,
      matchedContactCount: 0,
      unmatchedContactCount: 0,
      uncheckableContactCount: 0,
      excludedSelfContactCount: 0,
      unknownContactCount: 1000,
      mutationOutcomeUnknown: true,
      uncheckedContactCount: 500,
      autoConnectedCount: 0,
      alreadyConnectedCount: 0,
      requestRequiredCount: 0,
      suppressedCount: 0,
      completedBatchCount: 0,
      totalBatchCount: 2,
      partial: true,
      partialFailureMessage:
        "A sync request may have completed even though its response was lost.",
      region: "IN",
      limited: false,
      truncated: false,
      sourcePlatform: "ios",
    });

    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();
    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "People" }));
    openDropdownMenu(
      await screen.findByRole("button", { name: /Add or manage people/i }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: /Find contacts/i }));

    await waitFor(() => expect(graphMutation).toHaveBeenCalledWith("user_a"));
    expect(mockSyncOneLocationContactSignals).toHaveBeenCalledTimes(1);
    // Unknown-count presentation is owned by ContactSyncResultsSheet and is
    // covered directly in contact-sync-results-sheet.test.tsx. This test pins
    // the higher-risk integration contract: an uncertain mutation invalidates
    // the graph even when no matched identity can be rendered here.
  });

  it("treats a closed Google consent sheet as a shrug, not a failure", async () => {
    // The Google fallback is the only contact source on desktop and iOS Safari,
    // and it is reached through a consent sheet the person can simply close.
    // That path had no handling: the rejection fell into the same catch as a
    // real failure, so changing your mind produced a red error toast, left the
    // card stuck on "scanning", and recorded an analytics row saying the sync
    // had failed. The device picker has read AbortError as a shrug since it
    // shipped; this makes the two agree.
    mockGoogleAvailability = () => "connectable";
    const cancelled = new Error("Google contact access was cancelled.");
    cancelled.name = "AbortError";
    mockRequestGoogleContactsToken.mockRejectedValueOnce(cancelled);

    render(<OneLocationAgentPage />);
    await leaveLocationFeatureStep();
    await expectLocationInviteStep();
    fireEvent.click(await locationFinishButton());
    await waitFor(() =>
      expect(screen.queryByTestId("one-location-onboarding")).toBeNull(),
    );
    await waitFor(() => expect(mockGetState).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "People" }));
    openDropdownMenu(
      await screen.findByRole("button", { name: /Add or manage people/i }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: /Find contacts/i }));

    await waitFor(() =>
      expect(mockRequestGoogleContactsToken).toHaveBeenCalled(),
    );

    // Nothing was read, so nothing may be sent -- a cancelled consent sheet
    // must not fall through to a device read that would also fail here.
    expect(mockSyncOneLocationContactSignals).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    // Not reported as a failed sync either. An analytics row that counts every
    // dismissal as an error makes the feature look broken in the dashboard.
    expect(mockTrackEvent).not.toHaveBeenCalledWith(
      "one_location_contact_signal_synced",
      expect.objectContaining({ result: "error" }),
    );
    // And the button is usable again rather than stuck mid-scan.
    openDropdownMenu(
      await screen.findByRole("button", { name: /Add or manage people/i }),
    );
    expect(
      screen.getByRole("menuitem", { name: /Find contacts/i }),
    ).toBeTruthy();
  });

  it("waits for verified phone hydration before syncing Google People", async () => {
    mockGoogleAvailability = () => "connectable";
    let finishPhoneHydration: ((phone: string) => void) | null = null;
    const getIdToken = vi.fn(async () => "id-token");
    const resolveVerifiedPhoneNumber = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finishPhoneHydration = resolve;
        }),
    );
    mockUseRequireAuth.mockReturnValue({
      loading: false,
      isAuthenticated: true,
      userId: "user_a",
      phoneNumber: null,
      resolveVerifiedPhoneNumber,
      user: {
        uid: "user_a",
        displayName: "Test User",
        getIdToken,
      },
    });
    mockRequestGoogleContactsToken.mockResolvedValueOnce("google-token");
    const googleSource = vi.fn();
    mockGooglePeopleContactSource.mockReturnValue(googleSource);
    const defaultSyncImplementation =
      mockSyncOneLocationContactSignals.getMockImplementation();
    mockSyncOneLocationContactSignals.mockImplementationOnce(async (options) => {
      const resolvedPhone = await options.resolveAccountPhoneNumber?.();
      expect(resolvedPhone).toBe("+919876543210");
      await expect(options.resolveIdToken?.()).resolves.toBe("id-token");
      return defaultSyncImplementation!(options);
    });

    render(<OneLocationAgentPage />);
    await leaveLocationFeatureStep();
    const contactsPanel = await openReadyContactsPanel();
    fireEvent.click(
      within(contactsPanel).getByRole("button", {
        name: "Check my contacts",
      }),
    );
    await waitFor(() =>
      expect(resolveVerifiedPhoneNumber).toHaveBeenCalledTimes(1),
    );
    expect(mockSyncOneLocationContactSignals).toHaveBeenCalledWith(
      expect.objectContaining({
        source: googleSource,
        accountPhoneNumber: null,
        resolveAccountPhoneNumber: expect.any(Function),
        resolveIdToken: expect.any(Function),
      }),
    );
    await act(async () => {
      finishPhoneHydration?.("+919876543210");
    });

    await waitFor(() => expect(getIdToken).toHaveBeenCalledTimes(1));
  });

  it("keeps contact sync single-flight from the People menu", async () => {
    let finishSync: (() => void) | null = null;
    mockSyncOneLocationContactSignals.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSync = () =>
            resolve({
              matches: [],
              matchedUserIds: [],
              totalContacts: 0,
              inviteCandidateCount: 0,
              readContactCount: 0,
              checkedContactCount: 0,
              matchedContactCount: 0,
              unmatchedContactCount: 0,
              uncheckableContactCount: 0,
              excludedSelfContactCount: 0,
              unknownContactCount: 0,
              mutationOutcomeUnknown: false,
              uncheckedContactCount: 0,
              autoConnectedCount: 0,
              alreadyConnectedCount: 0,
              requestRequiredCount: 0,
              suppressedCount: 0,
              completedBatchCount: 0,
              totalBatchCount: 0,
              partial: false,
              region: null,
              limited: false,
              truncated: false,
              sourcePlatform: "ios",
            });
        }),
    );

    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();
    await waitFor(() => expect(mockGetState).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "People" }));
    const addPeople = await screen.findByRole("button", {
      name: /Add or manage people/i,
    });
    openDropdownMenu(addPeople);
    fireEvent.click(screen.getByRole("menuitem", { name: /Find contacts/i }));

    await waitFor(() =>
      expect(mockSyncOneLocationContactSignals).toHaveBeenCalledTimes(1),
    );
    openDropdownMenu(addPeople);
    const busyFindContacts = screen.getByRole("menuitem", {
      name: /Finding contacts/i,
    });
    expect(busyFindContacts).toHaveAttribute("aria-busy", "true");
    fireEvent.click(busyFindContacts);
    expect(mockSyncOneLocationContactSignals).toHaveBeenCalledTimes(1);

    await act(async () => {
      finishSync?.();
    });
  }, 10_000);

  it("creates an approval-first invite path for contacts who are not One users", async () => {
    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();

    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    // Public links live on the Links tab. The People tab used to carry a
    // duplicate "Share to contacts" that minted the same artifact; this is the
    // one remaining path, and it must still create the invite.
    fireEvent.click(screen.getByRole("button", { name: "Links" }));
    // One button, one press. There used to be two, both labelled "Create
    // link": the tab's, which only navigated, and the flow screen's, which
    // created. The first is gone.
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
    await switchLocationTab("People", "People");

    const search = await screen.findByPlaceholderText(/Search people/i);
    const person = await screen.findByText("Trusted B");
    expect(screen.getByTestId("one-location-people-list")).not.toHaveClass(
      "overflow-y-auto",
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
        !el.contains(person) &&
        search.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING &&
        person.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING,
    );
    expect(between).toHaveLength(0);

    // "Share to contacts" minted a PUBLIC link — the Links tab's artifact, not
    // something that belongs beside named, trusted people.
    expect(
      screen.queryByRole("button", { name: /Share to contacts/i }),
    ).toBeNull();
    const addPeople = screen.getByRole("button", {
      name: /Add or manage people/i,
    });
    expect(addPeople).toBeTruthy();
    expect(
      addPeople.compareDocumentPosition(search) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    openDropdownMenu(addPeople);
    expect(
      screen.getByRole("menuitem", { name: /Find contacts/i }),
    ).toBeTruthy();
    expect(
      screen.getByRole("menuitem", { name: /Invite to One/i }),
    ).toBeTruthy();
    expect(
      screen.getByRole("menuitem", { name: /Manage connections/i }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", {
        name: /Stop sharing with Trusted B/i,
      }),
    ).toBeNull();
    await openPeoplePersonActions("Trusted B");
    expect(screen.getByRole("button", { name: "Manage my sharing" })).toBeTruthy();
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
      await switchLocationTab("People", "People");

      const search = await screen.findByPlaceholderText(/Search people/i);
      const addPeople = screen.getByRole("button", {
        name: /Add or manage people/i,
      });

      expect(
        addPeople.compareDocumentPosition(search) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      openDropdownMenu(addPeople);
      expect(
        screen.getByRole("menuitem", { name: /Find contacts/i }),
      ).toBeTruthy();
      expect(
        screen.getByRole("menuitem", { name: /Invite to One/i }),
      ).toBeTruthy();
      expect(
        screen.getByRole("menuitem", { name: /Manage connections/i }),
      ).toBeTruthy();
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  it("opens the canonical Connect Circles manager from the compact Circles summary", async () => {
    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();

    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    await switchLocationTab("People", "People");

    const section = screen.getByTestId("one-location-circles-summary");
    fireEvent.click(within(section).getByRole("button", { name: /Circles/i }));
    expect(mockRouterPush).toHaveBeenCalledWith(
      "/one/connect?tab=circles&return_to=%2Fone%2Flocation%3Fview%3Dpeople",
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
    window.localStorage.setItem("one_location_onboarding_v2:user_a", "1");

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
    window.localStorage.setItem("one_location_onboarding_v2:user_a", "1");

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
      screen.getByText(/Location access is off.*Turn it on to set up/i),
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
    mockListRecipientsPage.mockResolvedValue({
      items: [],
      page: 1,
      hasMore: false,
      totalCount: 0,
    });

    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();

    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    await switchLocationTab("People", "People");
    // Empty state keeps a direct recovery CTA, while the header menu keeps
    // connection management, invite, and sync actions without scattering them.
    const addPeopleMenu = screen.getByRole("button", {
      name: /Add or manage people/i,
    });
    const addPeopleCta = screen.getByRole("button", {
      name: /Find or invite someone/i,
    });
    expect(
      addPeopleCta.textContent?.includes("Find or invite someone"),
    ).toBe(true);
    expect(addPeopleCta).toBeTruthy();
    openDropdownMenu(addPeopleMenu);
    expect(
      screen.getByRole("menuitem", { name: /Find contacts/i }),
    ).toBeTruthy();
    expect(
      screen.getByRole("menuitem", { name: /Invite to One/i }),
    ).toBeTruthy();
    expect(
      screen.getByRole("menuitem", { name: /Manage connections/i }),
    ).toBeTruthy();
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
    fireEvent.click(addPeopleCta);
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

  it("offers collapsed contact sync on Ready when the Contact Picker is available", async () => {
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

      await expectLocationInviteStep();
      const disclosure = screen.getByRole("button", { name: "Find contacts" });
      expect(disclosure).toHaveAttribute("aria-expanded", "false");
      expect(
        screen.queryByTestId("one-location-onboarding-contacts-surface"),
      ).toBeNull();
    } finally {
      Reflect.deleteProperty(navigator, "contacts");
    }
  });

  it("gates Location onboarding before Google or device contact access", async () => {
    mockGoogleAvailability = () => "connectable";
    mockRequestContactCheck.mockReturnValue(false);
    render(<OneLocationAgentPage />);
    await leaveLocationFeatureStep();

    const contactsPanel = await openReadyContactsPanel();
    const checkContacts = within(contactsPanel).getByRole("button", {
      name: "Check my contacts",
    });
    fireEvent.click(checkContacts);

    expect(mockRequestContactCheck).toHaveBeenCalledTimes(1);
    expect(mockRequestGoogleContactsToken).not.toHaveBeenCalled();
    expect(mockSyncOneLocationContactSignals).not.toHaveBeenCalled();
    expect(checkContacts).toBeEnabled();
  });

  it("omits the contact disclosure when no contact source is available", async () => {
    // jsdom is that browser, and so is every desktop Chrome and Safari. The
    // step used to render here as an apology over an empty panel.
    render(<OneLocationAgentPage />);
    await leaveLocationFeatureStep();

    await expectLocationInviteStep();
    expect(screen.queryByTestId("onboarding-contacts-disclosure")).toBeNull();
  });

  it("uses the preloaded Google source during desktop onboarding", async () => {
    const order: string[] = [];
    let finishPhoneHydration: ((phone: string) => void) | null = null;
    const getIdToken = vi.fn(async () => {
      order.push("firebase");
      return "id-token";
    });
    const resolveVerifiedPhoneNumber = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finishPhoneHydration = resolve;
        }),
    );
    mockUseRequireAuth.mockReturnValue({
      loading: false,
      isAuthenticated: true,
      userId: "user_a",
      phoneNumber: null,
      resolveVerifiedPhoneNumber,
      user: {
        uid: "user_a",
        displayName: "Test User",
        getIdToken,
      },
    });
    mockGoogleAvailability = () => "connectable";
    mockRequestGoogleContactsToken.mockImplementation(async () => {
      order.push("google");
      return "google-token";
    });
    const googleSource = vi.fn();
    mockGooglePeopleContactSource.mockReturnValue(googleSource);
    const defaultSyncImplementation =
      mockSyncOneLocationContactSignals.getMockImplementation();
    mockSyncOneLocationContactSignals.mockImplementationOnce(async (options) => {
      const resolvedPhone = await options.resolveAccountPhoneNumber?.();
      expect(resolvedPhone).toBe("+919876543210");
      await expect(options.resolveIdToken?.()).resolves.toBe("id-token");
      return defaultSyncImplementation!(options);
    });

    render(<OneLocationAgentPage />);
    await waitFor(() =>
      expect(mockPreloadGoogleContactsAuth).toHaveBeenCalledTimes(1),
    );
    await leaveLocationFeatureStep();

    const contactsPanel = await openReadyContactsPanel();
    const connect = within(contactsPanel).getByRole("button", {
      name: "Check my contacts",
    });
    order.length = 0;
    getIdToken.mockClear();
    fireEvent.click(connect);

    await waitFor(() =>
      expect(resolveVerifiedPhoneNumber).toHaveBeenCalledTimes(1),
    );
    expect(mockSyncOneLocationContactSignals).toHaveBeenCalledWith(
      expect.objectContaining({
        source: googleSource,
        accountPhoneNumber: null,
        resolveAccountPhoneNumber: expect.any(Function),
        resolveIdToken: expect.any(Function),
      }),
    );
    await act(async () => {
      finishPhoneHydration?.("+919876543210");
    });

    await waitFor(() => expect(getIdToken).toHaveBeenCalledTimes(1));
    expect(order.slice(0, 2)).toEqual(["google", "firebase"]);
  });

  it("restores desktop onboarding after Google consent is closed", async () => {
    mockGoogleAvailability = () => "connectable";
    const cancelled = new Error("Google contact access was cancelled.");
    cancelled.name = "AbortError";
    mockRequestGoogleContactsToken.mockRejectedValueOnce(cancelled);

    render(<OneLocationAgentPage />);
    await leaveLocationFeatureStep();
    const contactsPanel = await openReadyContactsPanel();
    fireEvent.click(
      within(contactsPanel).getByRole("button", { name: "Check my contacts" }),
    );

    await waitFor(() =>
      expect(mockRequestGoogleContactsToken).toHaveBeenCalledTimes(1),
    );
    expect(mockSyncOneLocationContactSignals).not.toHaveBeenCalled();
    expect(
      within(contactsPanel).getByRole("button", { name: "Check my contacts" }),
    ).toBeEnabled();
    expect(screen.queryByText(/couldn't check your contacts/i)).toBeNull();
  });

  it("offers a user-gesture retry when Google sign-in is still loading", async () => {
    mockGoogleAvailability = () => "connectable";
    mockRequestGoogleContactsToken
      .mockRejectedValueOnce(
        new Error("Google Contacts is still getting ready. Try again."),
      )
      .mockResolvedValueOnce("google-token");

    render(<OneLocationAgentPage />);
    await leaveLocationFeatureStep();
    const contactsPanel = await openReadyContactsPanel();
    fireEvent.click(
      within(contactsPanel).getByRole("button", { name: "Check my contacts" }),
    );

    expect(
      await screen.findByText(/Google Contacts is still getting ready/i),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() =>
      expect(mockRequestGoogleContactsToken).toHaveBeenCalledTimes(2),
    );
    await waitFor(() =>
      expect(mockSyncOneLocationContactSignals).toHaveBeenCalledTimes(1),
    );
  });

  it("keeps Ready completion available while optional contact processing is busy", async () => {
    mockGoogleAvailability = () => "connectable";
    let finishSync: (() => void) | null = null;
    mockSyncOneLocationContactSignals.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSync = () =>
            resolve({
              matches: [],
              matchedUserIds: [],
              totalContacts: 0,
              inviteCandidateCount: 0,
              readContactCount: 0,
              checkedContactCount: 0,
              matchedContactCount: 0,
              unmatchedContactCount: 0,
              uncheckableContactCount: 0,
              excludedSelfContactCount: 0,
              unknownContactCount: 0,
              mutationOutcomeUnknown: false,
              uncheckedContactCount: 0,
              autoConnectedCount: 0,
              alreadyConnectedCount: 0,
              requestRequiredCount: 0,
              suppressedCount: 0,
              completedBatchCount: 0,
              totalBatchCount: 0,
              partial: false,
              region: null,
              limited: false,
              truncated: false,
              sourcePlatform: "google",
            });
        }),
    );

    render(<OneLocationAgentPage />);
    await leaveLocationFeatureStep();
    const contactsPanel = await openReadyContactsPanel();
    fireEvent.click(
      within(contactsPanel).getByRole("button", { name: "Check my contacts" }),
    );

    expect(await screen.findByText(/Checking your contacts/i)).toBeTruthy();
    expect(await locationFinishButton()).toBeEnabled();

    await act(async () => {
      finishSync?.();
    });
  });

  /* ------------------------------------------------------------------ *
   * Live share continuity
   *
   * Choosing "1 hour" is a promise, and the screen has to keep showing it
   * being kept. Before this, the Now screen reported "Active shares: 1" and
   * nothing else — and for the first second or two after re-entering the
   * route, with the memory-only state snapshot expired, it reported 0.
   * ------------------------------------------------------------------ */

  /** Fixture grant `grant_1` ends at 08:00, so this leaves exactly 30 minutes. */
  const DURING_A_LIVE_SHARE = "2026-05-20T07:30:00.000Z";

  function countdownSeconds(): number {
    const text =
      screen.getByTestId("one-location-live-share-countdown").textContent ?? "";
    const [minutes = "0", seconds = "0"] = text.split(":");
    return Number(minutes) * 60 + Number(seconds);
  }

  it("keeps a running share on screen with a countdown that moves", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(DURING_A_LIVE_SHARE));
    try {
      render(<OneLocationAgentPage />);
      await skipLocationEntryFlow();
      await waitFor(() => expect(mockGetState).toHaveBeenCalled());

      const card = await screen.findByTestId("one-location-live-share");
      expect(within(card).getByText("Sharing with Trusted B")).toBeTruthy();

      const first = countdownSeconds();
      expect(first).toBeGreaterThan(29 * 60);
      expect(first).toBeLessThanOrEqual(30 * 60);

      await act(async () => {
        vi.advanceTimersByTime(5_000);
      });
      expect(countdownSeconds()).toBeLessThanOrEqual(first - 5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets the owner change a running share's time without stopping it", async () => {
    // The report: "I can only stop, can't increase or decrease the duration".
    // This is the whole path -- the control on the card, the editor it opens,
    // and the one call it makes -- against the same grant, which is the part
    // that matters: the share is edited, not ended and restarted.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(DURING_A_LIVE_SHARE));
    try {
      render(<OneLocationAgentPage />);
      await skipLocationEntryFlow();
      await waitFor(() => expect(mockGetState).toHaveBeenCalled());

      const card = await screen.findByTestId("one-location-live-share");
      const change = within(card).getByTestId(
        "one-location-live-share-change-time",
      );

      await act(async () => {
        fireEvent.click(change);
      });

      const editor = await screen.findByTestId(
        "one-location-live-share-duration-editor",
      );

      await act(async () => {
        fireEvent.click(
          within(editor).getByTestId("one-location-live-share-duration-save"),
        );
      });

      // The wheel opened on the 30 minutes this share has left and nothing was
      // touched, so there is nothing to save -- an untouched picker must not
      // spend a call or push the recipient an alert.
      expect(mockSetGrantDuration).not.toHaveBeenCalled();
      expect(mockRevokeGrant).not.toHaveBeenCalled();
      await waitFor(() =>
        expect(
          screen.queryByTestId("one-location-live-share-duration-editor"),
        ).toBeNull(),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends the new time on the same grant, and never a stop", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(DURING_A_LIVE_SHARE));
    try {
      render(<OneLocationAgentPage />);
      await skipLocationEntryFlow();
      await waitFor(() => expect(mockGetState).toHaveBeenCalled());

      const card = await screen.findByTestId("one-location-live-share");
      await act(async () => {
        fireEvent.click(
          within(card).getByTestId("one-location-live-share-change-time"),
        );
      });
      const editor = await screen.findByTestId(
        "one-location-live-share-duration-editor",
      );

      // "Until I stop" is the largest increase there is, and the direction the
      // shorten-only endpoint refused outright. It is also a plain button
      // rather than a carousel slide, so this drives the real control and not
      // a scroll position JSDOM cannot lay out.
      await act(async () => {
        fireEvent.click(
          within(editor).getByRole("button", { name: "Until I stop" }),
        );
      });
      await act(async () => {
        fireEvent.click(
          within(editor).getByTestId("one-location-live-share-duration-save"),
        );
      });

      await waitFor(() =>
        expect(mockSetGrantDuration).toHaveBeenCalledWith(
          expect.objectContaining({
            grantId: "grant_1",
            durationHours: null,
            durationMode: "until_stopped",
          }),
        ),
      );
      // Extending must never go out as end-and-recreate: that hands the
      // recipient a new grant id and a share-ended alert.
      expect(mockRevokeGrant).not.toHaveBeenCalled();
      expect(mockCreateGrant).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  }, 15000);

  it("offers four common lengths and the open-ended row, one tap each", async () => {
    // The report (issue #6228): Change time showed too many near-identical
    // choices -- 15 min / 1 hour / 2 hours / 4 hours / 8 hours / Custom /
    // Until I stop -- wrapped and left-hugging under the live clock. It is
    // trimmed to the four common lengths plus the open-ended row; `8 hours`
    // and the `Custom` wheel are gone.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(DURING_A_LIVE_SHARE));
    try {
      render(<OneLocationAgentPage />);
      await skipLocationEntryFlow();
      await waitFor(() => expect(mockGetState).toHaveBeenCalled());

      const card = await screen.findByTestId("one-location-live-share");
      await act(async () => {
        fireEvent.click(
          within(card).getByTestId("one-location-live-share-change-time"),
        );
      });
      const editor = await screen.findByTestId(
        "one-location-live-share-duration-editor",
      );

      for (const label of [
        "15 min",
        "1 hour",
        "2 hours",
        "4 hours",
        "Until I stop",
      ]) {
        expect(
          within(editor).getByRole("button", { name: label }),
        ).toBeInTheDocument();
      }
      // The two choices the issue asked to drop.
      expect(
        within(editor).queryByRole("button", { name: "8 hours" }),
      ).toBeNull();
      expect(
        within(editor).queryByRole("button", { name: "Custom" }),
      ).toBeNull();

      // One tap on a rung is the whole interaction -- no drag, no confirm
      // step of its own before Save.
      await act(async () => {
        fireEvent.click(within(editor).getByRole("button", { name: "2 hours" }));
      });
      await act(async () => {
        fireEvent.click(
          within(editor).getByTestId("one-location-live-share-duration-save"),
        );
      });

      await waitFor(() =>
        expect(mockSetGrantDuration).toHaveBeenCalledWith(
          expect.objectContaining({
            grantId: "grant_1",
            durationHours: 2,
          }),
        ),
      );
      // Same grant, still. Changing a length must not read as end-and-restart.
      expect(mockRevokeGrant).not.toHaveBeenCalled();
      expect(mockCreateGrant).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  }, 15000);

  it("remembers the running share on the device, and only ids and times", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(DURING_A_LIVE_SHARE));
    try {
      render(<OneLocationAgentPage />);
      await skipLocationEntryFlow();
      await waitFor(() => expect(mockGetState).toHaveBeenCalled());

      await waitFor(() => {
        const raw = window.localStorage.getItem(
          "one_location_live_share_v1:user_a",
        );
        expect(raw).toBeTruthy();
        // Still only ids and times. `recipientUserId` joins the record
        // because the count on the status card is a HEADCOUNT and a headcount
        // needs the head -- one person holding both an ordinary share and an
        // SOS share is one person. It is an opaque id the device already
        // holds, which is exactly the standard `grantId` meets: no name, no
        // number, no coordinates, no token.
        expect(JSON.parse(raw ?? "[]")).toEqual([
          {
            grantId: "grant_1",
            recipientUserId: "user_b",
            shareKind: "share",
            startedAt: expect.any(String),
            expiresAt: "2026-05-20T08:00:00.000Z",
          },
        ]);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the running share on re-entry before the network answers", async () => {
    // The regression this fixes: the state snapshot is memory-only and expires
    // after a minute, so coming back to Location a few minutes later rendered a
    // screen that believed nothing was live until getState resolved.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(DURING_A_LIVE_SHARE));
    try {
      window.localStorage.setItem("one_location_onboarding_v2:user_a", "1");
      window.localStorage.setItem(
        "one_location_live_share_v1:user_a",
        JSON.stringify([
          {
            grantId: "grant_1",
            startedAt: "2026-05-20T07:00:00.000Z",
            expiresAt: "2026-05-20T08:00:00.000Z",
          },
        ]),
      );
      mockGetState.mockImplementation(() => new Promise(() => {}));

      render(<OneLocationAgentPage />);

      const card = await screen.findByTestId("one-location-live-share");
      // No server state means no names — the count still has to be true.
      expect(within(card).getByText("Sharing with 1 person")).toBeTruthy();
      expect(countdownSeconds()).toBeGreaterThan(29 * 60);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not resurrect a share the server has already stopped", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(DURING_A_LIVE_SHARE));
    try {
      window.localStorage.setItem("one_location_onboarding_v2:user_a", "1");
      window.localStorage.setItem(
        "one_location_live_share_v1:user_a",
        JSON.stringify([
          {
            grantId: "grant_1",
            startedAt: "2026-05-20T07:00:00.000Z",
            expiresAt: "2026-05-20T08:00:00.000Z",
          },
        ]),
      );
      mockGetState.mockResolvedValue({ ...locationState(), ownerGrants: [] });

      render(<OneLocationAgentPage />);
      await waitFor(() => expect(mockGetState).toHaveBeenCalled());

      await waitFor(() =>
        expect(screen.queryByTestId("one-location-live-share")).toBeNull(),
      );
      await waitFor(() =>
        expect(
          window.localStorage.getItem("one_location_live_share_v1:user_a"),
        ).toBeNull(),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The Links tab after a reload.
   *
   * The share token used to be returned exactly once, at creation, and nothing
   * could recover it -- so a returning session knew a link was live and had
   * nothing to copy. Copy and Share early-returned with no toast, and the tab
   * shipped a button that did nothing. The server now derives the token from
   * the invite's own id and hands the URL back on every read.
   */
  function activePublicInvite(overrides: Record<string, unknown> = {}) {
    return {
      id: "public-invite-1",
      ownerUserId: "user_a",
      status: "active",
      durationHours: 1,
      expiresAt: new Date(Date.now() + 45 * 60 * 1000).toISOString(),
      createdAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      publicUrl: "/one/location/view/derived-token-abc",
      ...overrides,
    };
  }

  it("hands back a link made in an earlier session", async () => {
    mockGetState.mockResolvedValue({
      ...locationState(),
      publicInvites: [activePublicInvite()],
    });

    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();
    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Links" }));

    expect(await screen.findByText("Temporary link")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Copy link/i }));

    await waitFor(() => expect(mockCopyToClipboard).toHaveBeenCalled());
    // The whole point: something real reaches the clipboard, and it is the
    // token the server derived rather than an empty string.
    expect(String(mockCopyToClipboard.mock.calls[0][0])).toContain(
      "derived-token-abc",
    );
  });

  it("does not say copied when clipboard denies the public link", async () => {
    mockCopyToClipboard.mockResolvedValueOnce(false);
    mockGetState.mockResolvedValue({
      ...locationState(),
      publicInvites: [activePublicInvite()],
    });

    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();
    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Links" }));

    expect(await screen.findByText("Temporary link")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Copy link/i }));

    await waitFor(() => expect(mockCopyToClipboard).toHaveBeenCalled());
    expect(toast.error).toHaveBeenCalledWith(
      "Could not copy the public location link.",
    );
    expect(screen.getByRole("button", { name: /Copy link/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Copied/i })).toBeNull();
  });

  it("shares the link as a live location, not as an invitation", async () => {
    // The share sheet used to carry "Join my Location circle" — copy for a
    // different object entirely (a Circle invite asks a named person to join
    // something, and lasts a day). This link asks for nothing: it shows the
    // recipient where the sender is, right now.
    mockGetState.mockResolvedValue({
      ...locationState(),
      publicInvites: [activePublicInvite()],
    });

    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();
    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Links" }));

    expect(await screen.findByText("Temporary link")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Share/i }));

    // jsdom has no navigator.share and is not a native platform, so the
    // ladder lands on the clipboard — which is where the whole composed
    // message (copy + URL) is observable.
    await waitFor(() => expect(mockCopyToClipboard).toHaveBeenCalled());
    const shared = String(
      mockCopyToClipboard.mock.calls[
        mockCopyToClipboard.mock.calls.length - 1
      ][0],
    );
    expect(shared).toContain("View my live location on One");
    expect(shared).not.toContain("Join my Location circle");
    expect(shared).toContain("/one/location/view/derived-token-abc");
    expect(shared).not.toContain("/one/location/request/");
  });

  it("rewrites a pre-rename link before it is shared again", async () => {
    // A row minted before the path moved still carries /request. Copying it
    // verbatim would put the old shape back into circulation long after the
    // app stopped producing it.
    mockGetState.mockResolvedValue({
      ...locationState(),
      publicInvites: [
        activePublicInvite({
          publicUrl: "/one/location/request/legacy-token-xyz",
        }),
      ],
    });

    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();
    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Links" }));

    expect(await screen.findByText("Temporary link")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Copy link/i }));

    await waitFor(() => expect(mockCopyToClipboard).toHaveBeenCalled());
    const copied = String(mockCopyToClipboard.mock.calls[0][0]);
    expect(copied).toContain("/one/location/view/legacy-token-xyz");
    expect(copied).not.toContain("/one/location/request/");
  });

  it("offers no way to make a second link while one is live", async () => {
    // Two are independently resolvable, revoking the visible one leaves the
    // other watching, and the tab can only ever show the newest. Ending this
    // one is the way to a different one.
    mockGetState.mockResolvedValue({
      ...locationState(),
      publicInvites: [activePublicInvite()],
    });

    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();
    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Links" }));

    expect(await screen.findByText("Temporary link")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Create link$/i })).toBeNull();
    expect(screen.queryByText("Duration")).toBeNull();
    // Ending it stays reachable -- that is the only exit.
    expect(screen.getByRole("button", { name: /Revoke link/i })).toBeTruthy();
  });

  it("lets a link whose URL cannot be recovered be stopped", async () => {
    // Minted before the token was derivable. Copy and Share would be dead
    // controls, so they are not offered -- but the link is still out there
    // watching, so ending it cannot be a dead end.
    mockGetState.mockResolvedValue({
      ...locationState(),
      publicInvites: [activePublicInvite({ publicUrl: undefined })],
    });

    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();
    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Links" }));

    expect(await screen.findByText("Temporary link")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Stop link/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Copy link$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Share$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Create link$/i })).toBeNull();
  });

  it("brings a bookmarked temp-link URL to the Links tab", async () => {
    // The screen did not go away, it became the tab. "That's no longer there."
    // would be a lie, and a confusing one on the screen that now owns it.
    mockSearchParams.toString = () => "action=temp-link";
    mockSearchParamsGet.mockImplementation((key: string) =>
      key === "action" ? "temp-link" : null,
    );

    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();
    await waitFor(() => expect(mockGetState).toHaveBeenCalled());

    await waitFor(() =>
      expect(mockRouterReplace).toHaveBeenCalledWith(
        expect.stringContaining("view=links"),
        expect.anything(),
      ),
    );
    const replaced = String(mockRouterReplace.mock.calls.at(-1)?.[0] ?? "");
    expect(replaced).not.toContain("action=temp-link");
  });

  it("brings the create form back when the link runs out", async () => {
    // The tab hides its create control whenever a link is live, and expiry is
    // written server-side only when a row is READ -- nothing here refetches on
    // a timer. Without a clock check the state this session already holds says
    // "active" forever, so a link that ran out five minutes ago left the person
    // looking at a dead card with no way past it until they reloaded.
    mockGetState.mockResolvedValue({
      ...locationState(),
      publicInvites: [
        activePublicInvite({
          expiresAt: new Date(Date.now() + 250).toISOString(),
        }),
      ],
    });

    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();
    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Links" }));
    expect(await screen.findByText("Temporary link")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Create link$/i })).toBeNull();

    // Real time, not fake. This suite's setup awaits real promises, and fake
    // timers -- even advancing ones -- leave `waitFor` running on a clock the
    // test controls, which hangs rather than fails. The expiry above is a few
    // hundred milliseconds out, so waiting it out for real is cheaper than the
    // machinery to pretend.
    //
    // `visibilitychange` is the same hook a phone uses coming back from
    // background, and the page listens for it precisely so a screen that has
    // been away does not wait out the next 30s tick.
    await new Promise((resolve) => setTimeout(resolve, 400));
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(screen.getByText("Duration")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Create link$/i })).toBeTruthy();
  });

  it("does not expire a link the server sent without an expiry", async () => {
    // A missing timestamp is not evidence the link has run out. Treating it as
    // expired would hide a working link and offer to make a second.
    mockGetState.mockResolvedValue({
      ...locationState(),
      publicInvites: [activePublicInvite({ expiresAt: undefined })],
    });

    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();
    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Links" }));

    expect(await screen.findByText("Temporary link")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Create link$/i })).toBeNull();
  });

  it("treats a link that expired before the tab opened as gone", async () => {
    mockGetState.mockResolvedValue({
      ...locationState(),
      publicInvites: [
        activePublicInvite({
          // Still "active" server-side: the row has not been read since.
          expiresAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
        }),
      ],
    });

    render(<OneLocationAgentPage />);
    await skipLocationEntryFlow();
    await waitFor(() => expect(mockGetState).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Links" }));

    expect(await screen.findByText("Temporary link")).toBeTruthy();
    expect(screen.getByText("Duration")).toBeTruthy();
  });
});
