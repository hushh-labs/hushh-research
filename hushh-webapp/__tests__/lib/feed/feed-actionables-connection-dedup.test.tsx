/**
 * A pending connection request reaches the Feed's "Needs you" zone twice: once
 * from ConnectionsService directly, and once from the Consent Center, which
 * folds incoming connection requests into its `pending` surface from that very
 * same service. Rendering both showed the user one request as two rows — a
 * chevron-only consent row stacked on the real Confirm/Decline row.
 *
 * The connections lane owns them. These tests hold that line.
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const CONNECTION_ID = "conn-req-1";

const platform = vi.hoisted(() => ({ android: false }));
vi.mock("@/lib/capacitor/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/capacitor/platform")>()),
  isAndroid: () => platform.android,
}));

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  consentItems: [] as Array<Record<string, unknown>>,
  connectionRequests: [] as Array<Record<string, unknown>>,
  circleMemberInvites: [] as Array<Record<string, unknown>>,
  appTasks: [] as Array<Record<string, unknown>>,
  dismissTask: vi.fn(),
  pendingCount: 0,
  update: {} as Record<string, unknown>,
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
            : mocks.connectionRequests;
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
    getState: () => ({ tasks: mocks.appTasks }),
    subscribe: () => () => {},
    dismissTask: mocks.dismissTask,
  },
  isAppBackgroundTaskVisible: () => true,
}));

vi.mock("@/lib/services/consent-center-service", () => ({
  CONSENT_CENTER_PAGE_SIZE: 20,
  ConsentCenterService: { getSummary: vi.fn(), listEntries: vi.fn() },
}));

vi.mock("@/lib/services/connections-service", () => ({
  ConnectionsService: {
    listRequests: vi.fn(),
    accept: vi.fn(),
    reject: vi.fn(),
  },
}));

vi.mock("@/lib/consent/consent-sheet-route", () => ({
  buildConsentCenterHref: (
    view: string,
    options?: { requestId?: string; from?: string },
  ) => {
    const params = new URLSearchParams({ tab: view });
    if (options?.requestId) params.set("requestId", options.requestId);
    if (options?.from) params.set("from", options.from);
    return `/one/consent?${params.toString()}`;
  },
}));

vi.mock("@/lib/consent/consent-display", () => ({
  resolveConsentRequesterLabel: ({
    counterpartLabel,
  }: {
    counterpartLabel?: string | null;
  }) => counterpartLabel || "Someone",
}));

vi.mock("@/lib/navigation/routes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/navigation/routes")>()),
  buildKaiMarketRoute: () => "/one/kai",
}));

vi.mock("@/lib/feed/use-agent-deployment-follow", () => ({
  useAgentDeploymentFollow: () => ({ update: mocks.update }),
}));

import { useFeedActionables } from "@/lib/feed/use-feed-actionables";

/** The Consent Center's projection of an incoming connection request. */
const consentConnectionEntry = {
  id: CONNECTION_ID,
  request_id: CONNECTION_ID,
  kind: "connection_request",
  status: "pending",
  action: "connection_request",
  counterpart_type: "self",
  counterpart_label: "Divya Rajendran",
};

/** The same request as ConnectionsService returns it. */
const incomingConnection = {
  id: CONNECTION_ID,
  status: "pending",
  counterpartDisplayName: "Divya Rajendran",
  counterpartPhotoUrl: "https://example.test/divya.png",
  scopes: [],
};

describe("useFeedActionables — connection request de-duplication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platform.android = false;
    mocks.consentItems = [];
    mocks.connectionRequests = [];
    mocks.circleMemberInvites = [];
    mocks.appTasks = [];
    mocks.pendingCount = 0;
    mocks.update = {};
  });

  it.each(["scheduled", "updating", "blocked"])("keeps %s updates visible without offering another install", (presentationState) => {
    mocks.update = { available: true, offerable: false, releaseId: "rel_existing", presentationState };
    const { result } = renderHook(() => useFeedActionables());
    const card = result.current.actionables.find((item) => item.id === "personal-agent-update:rel_existing");
    expect(card).toBeDefined();
    expect(card?.actions).toEqual([]);
  });

  it("renders one row when a connection request arrives on both lanes", () => {
    mocks.pendingCount = 1;
    mocks.consentItems = [consentConnectionEntry];
    mocks.connectionRequests = [incomingConnection];

    const { result } = renderHook(() => useFeedActionables());

    expect(result.current.actionables).toHaveLength(1);
    expect(result.current.count).toBe(1);
  });

  it("keeps the connections row, which carries the inline actions", () => {
    mocks.pendingCount = 1;
    mocks.consentItems = [consentConnectionEntry];
    mocks.connectionRequests = [incomingConnection];

    const { result } = renderHook(() => useFeedActionables());
    const [row] = result.current.actionables;

    expect(row.id).toBe(`connection:${CONNECTION_ID}`);
    expect(row.person?.photoUrl).toBe("https://example.test/divya.png");
    expect(row.actions.map((action) => action.key)).toEqual([
      "decline",
      "confirm",
    ]);
  });

  it("adds Report before Decline on Android only (Google Play UGC policy)", () => {
    platform.android = true;
    mocks.pendingCount = 1;
    mocks.consentItems = [consentConnectionEntry];
    mocks.connectionRequests = [incomingConnection];

    const { result } = renderHook(() => useFeedActionables());
    const [row] = result.current.actionables;

    expect(row.actions.map((action) => action.key)).toEqual([
      "report",
      "decline",
      "confirm",
    ]);
    // A report is irreversible for the sender, so it needs a second tap.
    expect(row.actions.find((action) => action.key === "report")?.confirm).toBe(true);
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

  it("keeps a user's consent-request photo on the Feed card", () => {
    mocks.pendingCount = 1;
    mocks.consentItems = [{
      id: "consent-with-photo",
      kind: "incoming_request",
      status: "pending",
      action: "REQUESTED",
      counterpart_type: "ria",
      counterpart_id: "advisor-1",
      counterpart_label: "Meena Rao",
      counterpart_image_url: "https://example.test/meena.png",
    }];

    const { result } = renderHook(() => useFeedActionables());

    expect(result.current.actionables[0].person).toEqual({
      displayName: "Meena Rao",
      photoUrl: "https://example.test/meena.png",
    });
  });

  it("shows an older person consent photo even without a counterpart id", () => {
    mocks.pendingCount = 1;
    mocks.consentItems = [{
      id: "legacy-person-consent",
      kind: "incoming_request",
      status: "pending",
      action: "REQUESTED",
      counterpart_type: "person",
      counterpart_label: "Kunal",
      counterpart_image_url: "https://example.test/kunal.png",
    }];

    const { result } = renderHook(() => useFeedActionables());

    expect(result.current.actionables[0].person).toEqual({
      displayName: "Kunal",
      photoUrl: "https://example.test/kunal.png",
    });
  });

  it("uses the Circle inviter photo already returned by Location state", () => {
    mocks.circleMemberInvites = [{
      id: "circle-invite-1",
      circleId: "circle-1",
      circleName: "Family",
      inviterUserId: "friend-1",
      inviterDisplayName: "Priya Nair",
      inviterPhotoUrl: "https://example.test/priya.png",
      inviteeUserId: "user-1",
      status: "pending",
    }];

    const { result } = renderHook(() => useFeedActionables());

    expect(result.current.actionables[0].person).toEqual({
      displayName: "Priya Nair",
      photoUrl: "https://example.test/priya.png",
    });
  });

  it("links to the full Consent Center when pending requests exceed the loaded page", () => {
    mocks.pendingCount = 21;
    mocks.consentItems = Array.from({ length: 20 }, (_, index) => ({
      id: `consent-${index + 1}`,
      request_id: `consent-${index + 1}`,
      kind: "incoming_request",
      status: "pending",
      action: "REQUESTED",
      counterpart_type: "ria",
      counterpart_label: `Advisor ${index + 1}`,
      scope_description: "your holdings",
    }));

    const { result } = renderHook(() => useFeedActionables());
    const overflow = result.current.actionables.find(
      (item) => item.id === "consent:overflow",
    );

    expect(result.current.actionables).toHaveLength(21);
    expect(overflow).toMatchObject({
      title: "View all pending requests",
      description: "1 more pending request is waiting in Consent Center.",
      href: "/one/consent?tab=pending&from=%2Fone%2Ffeed",
      chevron: true,
      actions: [],
    });
  });

  it("never presents outgoing or directionless document requests as Needs You", () => {
    mocks.pendingCount = 3;
    mocks.consentItems = ["incoming", "outgoing", null].map((direction, index) => ({
      id: `document_share_request:11111111-1111-4111-8111-11111111111${index}`,
      request_id: `11111111-1111-4111-8111-11111111111${index}`,
      kind: direction === "outgoing" ? "outgoing_request" : "incoming_request",
      status: "pending", scope: null, counterpart_label: "Document request",
      metadata: { request_source: "drive_document_share_request", direction },
    }));
    const { result } = renderHook(() => useFeedActionables());
    const documents = result.current.actionables.filter((row) => row.id.startsWith("consent:document_share_request:"));
    expect(documents).toHaveLength(1);
    expect(documents[0].id).toBe(`consent:${mocks.consentItems[0].id}`);
    expect(documents[0].actions).toEqual([]);
    expect(documents[0].href).toContain("document_share_request%3A");
  });

  it("routes only incoming Drive questions to their own card, with no inline actions", () => {
    mocks.pendingCount = 3;
    mocks.consentItems = ["incoming", "outgoing", null].map((direction, index) => ({
      id: `drive_query_request:11111111-1111-4111-8111-11111111111${index}`,
      request_id: `11111111-1111-4111-8111-11111111111${index}`,
      kind: direction === "outgoing" ? "outgoing_request" : "incoming_request",
      status: "pending", action: "DRIVE_QUERY_REVIEW", scope: null,
      scope_description: "Google Drive question", counterpart_label: "Drive question",
      metadata: { request_source: "drive_live_query_request", direction },
    }));
    const { result } = renderHook(() => useFeedActionables());
    const questions = result.current.actionables.filter((row) => row.id.startsWith("consent:drive_query_request:"));
    expect(questions).toHaveLength(1);
    expect(questions[0].id).toBe(`consent:${mocks.consentItems[0].id}`);
    expect(questions[0].actions).toEqual([]);
    expect(questions[0].href).toContain(encodeURIComponent(mocks.consentItems[0].id));
  });

  it("keeps failed background work visible with recovery and dismiss actions", () => {
    mocks.appTasks = [
      {
        taskId: "import-1",
        userId: "user-1",
        kind: "portfolio_import",
        title: "Portfolio import",
        description: "Importing your portfolio",
        status: "failed",
        routeHref: "/one/kai/portfolio",
        startedAt: "2026-08-26T08:00:00.000Z",
        updatedAt: "2026-08-26T08:01:00.000Z",
        completedAt: "2026-08-26T08:01:00.000Z",
        error: "Import needs your attention.",
        dismissedAt: null,
        metadata: null,
        visibility: "passive",
        groupLabel: null,
        visibleAfterMs: 0,
        autoClearAfterMs: 0,
        runningStaleAfterMs: 0,
      },
    ];

    const { result } = renderHook(() => useFeedActionables());
    const failedTask = result.current.actionables.find(
      (item) => item.id === "task:import-1",
    );

    expect(failedTask).toMatchObject({
      description: "Import needs your attention.",
      spinning: false,
    });
    expect(failedTask?.actions.map((action) => action.key)).toEqual([
      "open",
      "dismiss",
    ]);

    act(() => {
      failedTask?.actions.find((action) => action.key === "dismiss")?.run();
    });
    expect(mocks.dismissTask).toHaveBeenCalledWith("import-1");
  });
});
