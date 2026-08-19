/**
 * A pending Location Circle invitation reaches the Feed's "Needs you" zone
 * twice: once from OneLocationCenterContributor, which folds every pending
 * circleMemberInvites row into the Consent Center's `pending` surface (so
 * the investor Consent Manager can discover it too), and once from the same
 * circleMemberInvites array read directly, which the actionables loop
 * renders with its own inline Decline/Accept. Rendering both showed the user
 * one invitation as two rows — a chevron-only consent row ("Invitation
 * waiting for your approval.") stacked on the real actionable one ("Invited
 * you to join <Circle>.").
 *
 * The circle-invite lane owns them, mirroring the existing connection_request
 * skip in feed-actionables-connection-dedup.test.tsx.
 */
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const INVITE_ID = "circle-invite-1";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  consentItems: [] as Array<Record<string, unknown>>,
  circleMemberInvites: [] as Array<Record<string, unknown>>,
  pendingCount: 0,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { uid: "user-1", getIdToken: async () => "id-token" },
  }),
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ vaultOwnerToken: "vault-token" }),
}));

vi.mock("@/lib/services/cache-service", () => ({
  CACHE_KEYS: {
    CONSENT_CENTER_SUMMARY: () => "summary",
    CONSENT_CENTER_LIST: () => "list",
    ONE_LOCATION_STATE: () => "location",
    CONNECTIONS_INCOMING: () => "connections",
  },
  CACHE_TTL: { SHORT: 1000 },
  CacheService: { getInstance: () => ({ set: vi.fn(), get: vi.fn() }) },
}));

// Stand in for the SWR wrapper so each lane yields fixture data by cache key.
vi.mock("@/lib/cache/use-stale-resource", () => ({
  useStaleResource: ({ cacheKey }: { cacheKey: string }) => {
    const data =
      cacheKey === "summary"
        ? { counts: { pending: mocks.pendingCount } }
        : cacheKey === "list"
          ? { items: mocks.consentItems }
          : cacheKey === "location"
            ? { requests: [], circleMemberInvites: mocks.circleMemberInvites }
            : [];
    return { data, loading: false, refresh: mocks.refresh };
  },
}));

vi.mock("@/lib/cache/cache-sync-service", () => ({
  CacheSyncService: { onConnectionCapabilityMutated: vi.fn() },
}));

vi.mock("@/lib/one-location/one-location-state-resource", () => ({
  OneLocationStateResource: { write: vi.fn(), invalidate: vi.fn() },
}));

vi.mock("@/lib/one-location/service", () => ({
  OneLocationService: {
    getState: vi.fn(),
    approveRequest: vi.fn(),
    denyRequest: vi.fn(),
    declineNamedCircleMemberInvite: vi.fn(),
    acceptNamedCircleMemberInvite: vi.fn(),
  },
}));

vi.mock("@/lib/services/debate-run-manager", () => ({
  DebateRunManagerService: {
    getState: () => ({ tasks: [] }),
    subscribe: () => () => {},
    cancelRun: vi.fn(),
    retryTaskPersistence: vi.fn(),
    dismissTask: vi.fn(),
  },
}));

vi.mock("@/lib/services/app-background-task-service", () => ({
  AppBackgroundTaskService: {
    getState: () => ({ tasks: [] }),
    subscribe: () => () => {},
  },
  isAppBackgroundTaskVisible: () => true,
}));

vi.mock("@/lib/services/consent-center-service", () => ({
  CONSENT_CENTER_PAGE_SIZE: 20,
  ConsentCenterService: { getSummary: vi.fn(), listEntries: vi.fn() },
}));

vi.mock("@/lib/services/connections-service", () => ({
  ConnectionsService: { listRequests: vi.fn(), accept: vi.fn(), reject: vi.fn() },
}));

vi.mock("@/lib/consent/consent-sheet-route", () => ({
  buildConsentCenterHref: () => "/one/consent?surface=pending",
}));

vi.mock("@/lib/consent/consent-display", () => ({
  resolveConsentRequesterLabel: ({
    counterpartLabel,
  }: {
    counterpartLabel?: string | null;
  }) => counterpartLabel || "Someone",
}));

vi.mock("@/lib/navigation/routes", () => ({
  buildKaiMarketRoute: () => "/one/kai",
}));

import { useFeedActionables } from "@/lib/feed/use-feed-actionables";

/** The Consent Center's projection of a pending circle-member invite. */
const consentCircleInviteEntry = {
  id: `one_location_circle_member_invite:${INVITE_ID}`,
  kind: "invite",
  status: "pending",
  action: "circle_member_invite",
  counterpart_type: "self",
  counterpart_label: "Sharuk Khan",
  metadata: {
    request_source: "one_location_circle_member_invite",
    invite_id: INVITE_ID,
  },
};

/** The same invite as OneLocationStateResource's circleMemberInvites returns it. */
const pendingCircleInvite = {
  id: INVITE_ID,
  inviteeUserId: "user-1",
  status: "pending",
  inviterDisplayName: "Sharuk Khan",
  circleName: "Family Circle",
  createdAt: "2026-08-19T03:11:00.000Z",
};

describe("useFeedActionables — circle invite de-duplication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.consentItems = [];
    mocks.circleMemberInvites = [];
    mocks.pendingCount = 0;
  });

  it("renders one row when an invite arrives on both lanes", () => {
    mocks.pendingCount = 1;
    mocks.consentItems = [consentCircleInviteEntry];
    mocks.circleMemberInvites = [pendingCircleInvite];

    const { result } = renderHook(() => useFeedActionables());

    expect(result.current.actionables).toHaveLength(1);
    expect(result.current.count).toBe(1);
  });

  it("keeps the circle-invite row, which carries the inline Decline/Accept", () => {
    mocks.pendingCount = 1;
    mocks.consentItems = [consentCircleInviteEntry];
    mocks.circleMemberInvites = [pendingCircleInvite];

    const { result } = renderHook(() => useFeedActionables());
    const [row] = result.current.actionables;

    expect(row.id).toBe(`circle-invite:${INVITE_ID}`);
    expect(row.description).toBe("Invited you to join Family Circle.");
    expect(row.actions.map((action) => action.key)).toEqual([
      "decline",
      "accept",
    ]);
  });

  it("still renders ordinary consent requests from the consent lane", () => {
    mocks.pendingCount = 1;
    mocks.consentItems = [
      {
        id: "consent-1",
        request_id: "consent-1",
        kind: "incoming_request",
        status: "pending",
        action: "REQUESTED",
        counterpart_type: "ria",
        counterpart_label: "Acme Advisors",
        scope_description: "your holdings",
      },
    ];

    const { result } = renderHook(() => useFeedActionables());

    expect(result.current.actionables).toHaveLength(1);
    expect(result.current.actionables[0].id).toBe("consent:consent-1");
    expect(result.current.actionables[0].description).toBe("your holdings");
  });
});
