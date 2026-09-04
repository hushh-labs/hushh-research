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

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  consentItems: [] as Array<Record<string, unknown>>,
  connectionRequests: [] as Array<Record<string, unknown>>,
  appTasks: [] as Array<Record<string, unknown>>,
  dismissTask: vi.fn(),
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
            ? { requests: [] }
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

vi.mock("@/lib/navigation/routes", () => ({
  buildKaiMarketRoute: () => "/one/kai",
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
  scopes: [],
};

describe("useFeedActionables — connection request de-duplication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.consentItems = [];
    mocks.connectionRequests = [];
    mocks.appTasks = [];
    mocks.pendingCount = 0;
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
    expect(row.actions.map((action) => action.key)).toEqual([
      "decline",
      "confirm",
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
