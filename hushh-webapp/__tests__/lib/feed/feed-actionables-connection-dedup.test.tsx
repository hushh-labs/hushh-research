/**
 * A pending connection request reaches the Feed's "Needs you" zone twice: once
 * from ConnectionsService directly, and once from the Consent Center, which
 * folds incoming connection requests into its `pending` surface from that very
 * same service. Rendering both showed the user one request as two rows — a
 * chevron-only consent row stacked on the real Confirm/Decline row.
 *
 * The connections lane owns them. These tests hold that line.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const CONNECTION_ID = "conn-req-1";

// Row actions and checkout callbacks are tested independently of wall-clock
// polling. Keep mount/event refresh real; cadence has its own Feed hook tests.
vi.mock("@/lib/perf/idle-scheduler", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/perf/idle-scheduler")>()),
  registerPeriodicTask: () => () => undefined,
}));

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
  userId: "user-1",
  realConsentResources: false,
  vaultToken: "vault-token" as string | null,
  allow: vi.fn(),
  setRequestPrice: vi.fn(),
  decide: vi.fn(),
  review: vi.fn(),
  account: vi.fn(),
  consentMutated: vi.fn(),
  answerCheckout: vi.fn(),
  answerDecline: vi.fn(),
  idToken: vi.fn(),
  driveCheckout: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/lib/services/drive-request-payment-service", async (original) => ({
  ...(await original<typeof import("@/lib/services/drive-request-payment-service")>()),
  DriveRequestPaymentService: { checkout: mocks.driveCheckout },
}));
vi.mock("@/lib/morphy-ux/morphy", async (original) => {
  const actual = await original<typeof import("@/lib/morphy-ux/morphy")>();
  return { ...actual, morphyToast: { ...actual.morphyToast, error: mocks.toastError } };
});

vi.mock("@/lib/services/answer-request-service", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/services/answer-request-service")
  >()),
  AnswerRequestService: {
    checkout: mocks.answerCheckout,
    decline: mocks.answerDecline,
  },
}));

vi.mock("@/lib/services/auth-service", () => ({
  AuthService: { getIdToken: mocks.idToken },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { uid: mocks.userId, getIdToken: async () => "id-token" },
  }),
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({
    vaultOwnerToken: mocks.vaultToken,
    getVaultOwnerToken: () => mocks.vaultToken,
  }),
}));

vi.mock("@/lib/services/drive-sharing-service", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/services/drive-sharing-service")
  >()),
  DriveSharingService: {
    allow: mocks.allow,
    setRequestPrice: mocks.setRequestPrice,
    decide: mocks.decide,
    review: mocks.review,
    // Payment rows read private request text; these rows stay metadata-only.
    requesterContext: vi.fn().mockRejectedValue(new Error("not in this test")),
  },
}));
vi.mock("@/lib/services/document-payout-service", () => ({
  DocumentPayoutService: { account: mocks.account },
}));

vi.mock("@/lib/services/cache-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/services/cache-service")>()),
  CACHE_KEYS: {
    CONSENT_CENTER_SUMMARY: (userId: string) => `summary:${userId}`,
    CONSENT_CENTER_LIST: (
      userId: string,
      actor: string,
      surface: string,
      _query: string,
      _page: number,
      limit: number,
    ) => `list:${userId}:${actor}:${surface}:${limit}`,
    ONE_LOCATION_STATE: () => "location",
    CONNECTIONS_INCOMING: () => "connections",
  },
}));

// Most cases use fixed fixtures; the invalidation case runs the real SWR hook.
vi.mock("@/lib/cache/use-stale-resource", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/lib/cache/use-stale-resource")
  >();
  return {
    useStaleResource: (options: Parameters<typeof actual.useStaleResource>[0]) => {
      const { cacheKey } = options;
      if (
        mocks.realConsentResources &&
        (cacheKey.startsWith("summary:") || cacheKey.startsWith("list:"))
      ) {
        return actual.useStaleResource(options);
      }
      if (options.enabled === false) return { data: undefined, loading: false, refresh: mocks.refresh };
      const data =
        cacheKey.startsWith("summary:")
          ? { counts: { pending: mocks.pendingCount } }
          : cacheKey.startsWith("list:")
            ? { items: mocks.consentItems }
            : cacheKey === "location"
              ? { requests: [], circleMemberInvites: mocks.circleMemberInvites }
              : mocks.connectionRequests;
      return { data, loading: false, refresh: mocks.refresh };
    },
  };
});

vi.mock("@/lib/cache/cache-sync-service", () => ({
  CacheSyncService: {
    onConnectionCapabilityMutated: vi.fn(),
    onConsentMutated: mocks.consentMutated,
  },
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
  ROUTES: {
    ONE_FEED: "/one/feed",
    PROFILE_PAYOUTS: "/one/profile/payouts",
    PROFILE_REQUEST_PRICING: "/one/profile/request-pricing",
  },
}));

vi.mock("@/lib/feed/use-agent-deployment-follow", () => ({
  useAgentDeploymentFollow: () => ({ update: mocks.update }),
}));

import {
  useFeedActionables,
  type FeedActionable,
} from "@/lib/feed/use-feed-actionables";
import { DriveSharingError } from "@/lib/services/drive-sharing-service";
import { CacheService, CACHE_KEYS } from "@/lib/services/cache-service";
import { ConsentCenterService } from "@/lib/services/consent-center-service";
import { CONSENT_STATE_CHANGED_EVENT } from "@/lib/consent/consent-events";
import { advanceVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { noteConsentMutated } from "@/lib/cache/consent-read-after-write";

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

beforeEach(() => {
  CacheService.getInstance().clear();
  vi.clearAllMocks();
  platform.android = false;
  mocks.consentItems = [];
  mocks.connectionRequests = [];
  mocks.circleMemberInvites = [];
  mocks.appTasks = [];
  mocks.pendingCount = 0;
  mocks.userId = "user-1";
  mocks.realConsentResources = false;
  mocks.update = {};
  mocks.vaultToken = "vault-token";
  mocks.account.mockResolvedValue({ account: null });
});

describe("useFeedActionables — connection request de-duplication", () => {
  it.each(["scheduled", "updating", "blocked"])("keeps %s updates visible without offering another install", (presentationState) => {
    mocks.update = { available: true, offerable: false, releaseId: "rel_existing", presentationState };
    const { result } = renderHook(() => useFeedActionables());
    const card = result.current.actionables.find((item) => item.id === "personal-agent-update:rel_existing");
    expect(card).toBeDefined();
    expect(card?.actions).toEqual([]);
  });

  it("keeps warm consent rows visible during invalidation and replaces them on fresh resolution", async () => {
    mocks.realConsentResources = true;
    const cache = CacheService.getInstance();
    const summaryKey = CACHE_KEYS.CONSENT_CENTER_SUMMARY(
      "user-1",
      "one:consents",
    );
    const pendingKey = CACHE_KEYS.CONSENT_CENTER_LIST(
      "user-1",
      "one:consents",
      "pending",
      "",
      1,
      20,
    );
    const oldEntry = {
      id: "consent-old",
      request_id: "consent-old",
      kind: "incoming_request",
      status: "pending",
      action: "REQUESTED",
      counterpart_type: "ria",
      counterpart_label: "Old advisor",
      scope_description: "your holdings",
    };
    const newEntry = {
      ...oldEntry,
      id: "consent-new",
      request_id: "consent-new",
      counterpart_label: "New advisor",
    };
    cache.set(summaryKey, { counts: { pending: 1 } });
    cache.set(pendingKey, { items: [oldEntry] });
    const progressKeys = ([
      ["one:consents", "pending"],
      ["one:consents", "active"],
      ["one:consents:sent", "pending"],
    ] as const).map(([actor, surface]) =>
      CACHE_KEYS.CONSENT_CENTER_LIST("user-1", actor, surface, "", 1, 100),
    );
    for (const key of progressKeys) {
      cache.set(key, { items: [], has_more: true });
    }

    let resolveSummary!: (value: { counts: { pending: number } }) => void;
    let resolvePending!: (value: { items: typeof oldEntry[] }) => void;
    const resolveProgress: Array<
      (value: { items: unknown[]; has_more: boolean }) => void
    > = [];
    vi.mocked(ConsentCenterService.getSummary).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSummary = resolve;
        }),
    );
    vi.mocked(ConsentCenterService.listEntries).mockImplementation(
      ({ limit }) =>
        limit === 20
          ? new Promise((resolve) => {
              resolvePending = resolve;
            })
          : new Promise((resolve) => {
              resolveProgress.push(resolve);
            }),
    );

    const { result, rerender } = renderHook(() => useFeedActionables());
    expect(result.current.actionables.map((row) => row.id)).toContain(
      "consent:consent-old",
    );
    expect(result.current.progressOverflow).toHaveLength(3);

    act(() => {
      cache.invalidateMany([summaryKey, pendingKey, ...progressKeys]);
      window.dispatchEvent(
        new CustomEvent(CONSENT_STATE_CHANGED_EVENT, {
          detail: { source: "sse" },
        }),
      );
    });
    await waitFor(() => {
      expect(ConsentCenterService.getSummary).toHaveBeenCalled();
      expect(ConsentCenterService.listEntries).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 20, force: true }),
      );
    });
    expect(cache.peek(summaryKey)).toBeNull();
    expect(cache.peek(pendingKey)).toBeNull();
    expect(result.current.actionables.map((row) => row.id)).toContain(
      "consent:consent-old",
    );
    expect(result.current.progressOverflow).toHaveLength(3);

    await act(async () => {
      resolveSummary({ counts: { pending: 1 } });
      resolvePending({ items: [newEntry] });
      for (const resolve of resolveProgress) {
        resolve({ items: [], has_more: false });
      }
    });
    await waitFor(() => {
      expect(result.current.actionables.map((row) => row.id)).toContain(
        "consent:consent-new",
      );
    });
    expect(result.current.actionables.map((row) => row.id)).not.toContain(
      "consent:consent-old",
    );
    await waitFor(() => expect(result.current.progressOverflow).toHaveLength(0));

    act(() => {
      for (const source of ["hydrated_pending", "fcm_opened"]) {
        window.dispatchEvent(
          new CustomEvent(CONSENT_STATE_CHANGED_EVENT, { detail: { source } }),
        );
      }
    });
    expect(ConsentCenterService.getSummary).toHaveBeenCalledTimes(1);

    cache.set(CACHE_KEYS.CONSENT_CENTER_SUMMARY("user-2", "one:consents"), {
      counts: { pending: 0 },
    });
    mocks.userId = "user-2";
    rerender();
    expect(result.current.actionables.map((row) => row.id)).not.toContain(
      "consent:consent-new",
    );
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
    expect(row.phoneActions?.map(action => action.key)).toEqual(["report", "review"]);
    expect(row.phoneActions?.[0]).toBe(row.actions[0]);
    row.phoneActions?.[1]?.run();
    expect(mocks.push).toHaveBeenCalledWith(expect.stringContaining("requestId=conn-req-1"));
    // A report is irreversible for the sender, so it needs a second tap.
    expect(row.actions.find((action) => action.key === "report")?.confirm).toBe(
      true,
    );
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
    mocks.consentItems = [
      {
        id: "consent-with-photo",
        kind: "incoming_request",
        status: "pending",
        action: "REQUESTED",
        counterpart_type: "ria",
        counterpart_id: "advisor-1",
        counterpart_label: "Meena Rao",
        counterpart_image_url: "https://example.test/meena.png",
      },
    ];

    const { result } = renderHook(() => useFeedActionables());

    expect(result.current.actionables[0].person).toEqual({
      displayName: "Meena Rao",
      photoUrl: "https://example.test/meena.png",
    });
  });

  it("shows an older person consent photo even without a counterpart id", () => {
    mocks.pendingCount = 1;
    mocks.consentItems = [
      {
        id: "legacy-person-consent",
        kind: "incoming_request",
        status: "pending",
        action: "REQUESTED",
        counterpart_type: "person",
        counterpart_label: "Kunal",
        counterpart_image_url: "https://example.test/kunal.png",
      },
    ];

    const { result } = renderHook(() => useFeedActionables());

    expect(result.current.actionables[0].person).toEqual({
      displayName: "Kunal",
      photoUrl: "https://example.test/kunal.png",
    });
  });

  it("uses the Circle inviter photo already returned by Location state", () => {
    mocks.circleMemberInvites = [
      {
        id: "circle-invite-1",
        circleId: "circle-1",
        circleName: "Family",
        inviterUserId: "friend-1",
        inviterDisplayName: "Priya Nair",
        inviterPhotoUrl: "https://example.test/priya.png",
        inviteeUserId: "user-1",
        status: "pending",
      },
    ];

    const { result } = renderHook(() => useFeedActionables());

    expect(result.current.actionables[0].person).toEqual({
      displayName: "Priya Nair",
      photoUrl: "https://example.test/priya.png",
    });
    const row = result.current.actionables[0];
    expect(row.actions.map(action => action.key)).toEqual(["decline", "accept"]);
    expect(row.phoneActions?.map(action => action.key)).toEqual(["review"]);
    row.phoneActions?.[0]?.run();
    expect(mocks.push).toHaveBeenCalledWith(row.todo?.href);
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
    mocks.consentItems = ["incoming", "outgoing", null].map(
      (direction, index) => ({
        id: `document_share_request:11111111-1111-4111-8111-11111111111${index}`,
        request_id: `11111111-1111-4111-8111-11111111111${index}`,
        kind:
          direction === "outgoing" ? "outgoing_request" : "incoming_request",
        status: "pending",
        scope: null,
        counterpart_label: "Document request",
        scope_description:
          index === 0 ? "Enable background Drive access" : "Google Drive files",
        metadata: { request_source: "drive_document_share_request", direction },
      }),
    );
    const { result } = renderHook(() => useFeedActionables());
    const documents = result.current.actionables.filter((row) =>
      row.id.startsWith("consent:document_share_request:"),
    );
    expect(documents).toHaveLength(1);
    expect(documents[0].id).toBe(`consent:${mocks.consentItems[0].id}`);
    expect(documents[0].description).toBe("Enable background Drive access");
    expect(documents[0].actions).toEqual([]);
    expect(documents[0].href).toContain("document_share_request%3A");
  });

  it("routes only incoming Drive questions to their own card, with no inline actions", () => {
    mocks.pendingCount = 3;
    mocks.consentItems = ["incoming", "outgoing", null].map(
      (direction, index) => ({
        id: `drive_query_request:11111111-1111-4111-8111-11111111111${index}`,
        request_id: `11111111-1111-4111-8111-11111111111${index}`,
        kind:
          direction === "outgoing" ? "outgoing_request" : "incoming_request",
        status: "pending",
        action: "DRIVE_QUERY_REVIEW",
        scope: null,
        scope_description: "Google Drive question",
        counterpart_label: "Drive question",
        metadata: { request_source: "drive_live_query_request", direction },
      }),
    );
    const { result } = renderHook(() => useFeedActionables());
    const questions = result.current.actionables.filter((row) =>
      row.id.startsWith("consent:drive_query_request:"),
    );
    expect(questions).toHaveLength(1);
    expect(questions[0].id).toBe(`consent:${mocks.consentItems[0].id}`);
    expect(questions[0].actions).toEqual([]);
    expect(questions[0].href).toContain(
      encodeURIComponent(mocks.consentItems[0].id),
    );
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

    const { result, unmount } = renderHook(() => useFeedActionables());
    const failedTask = result.current.actionables.find(
      (item) => item.id === "task:import-1",
    );

    expect(failedTask).toMatchObject({
      description: "Import needs your attention.",
      spinning: false,
      todo: { source: "agent", title: "Review Portfolio import", href: "/one/kai/portfolio" },
    });
    expect(failedTask?.actions.map((action) => action.key)).toEqual([
      "open",
      "dismiss",
    ]);

    act(() => {
      failedTask?.actions.find((action) => action.key === "dismiss")?.run();
    });
    expect(mocks.dismissTask).toHaveBeenCalledWith("import-1");
    const firstRun = failedTask?.todo?.key;
    mocks.appTasks = [{ ...mocks.appTasks[0], startedAt: "2026-08-27T08:00:00.000Z" }];
    unmount();
    const nextRun = renderHook(() => useFeedActionables());
    expect(nextRun.result.current.actionables.find((item) => item.id === "task:import-1")?.todo?.key).not.toBe(firstRun);
  });

  it("publishes explicit connection follow-ups but no tasks while the consumer is locked", () => {
    mocks.connectionRequests = [{ id: CONNECTION_ID, status: "pending", counterpartDisplayName: "Alex" }];
    const { result, rerender } = renderHook(({ enabled }) => useFeedActionables({ enabled }), { initialProps: { enabled: true } });
    expect(result.current.actionables.find((item) => item.id === `connection:${CONNECTION_ID}`)?.todo).toMatchObject({ source: "connections", title: "Review Alex's connection request" });
    rerender({ enabled: false });
    expect(result.current.actionables).toEqual([]);
  });
});

/**
 * A document request from someone outside the owner's Trusted circle. The
 * server marks the ones the owner can answer now (`owner_decision_available`);
 * only those get Deny and Allow inline, and Allow asks for a price before
 * anything is sent. Every answer goes out on this vault session's token.
 */
describe("useFeedActionables — document requests outside the Trusted circle", () => {
  const DOC_ID = "22222222-2222-4222-8222-222222222222";

  function documentEntry(
    id: string,
    metadata: Record<string, unknown> = {},
    overrides: Record<string, unknown> = {},
  ) {
    return {
      id: `document_share_request:${id}`,
      request_id: id,
      kind: "incoming_request",
      status: "pending",
      action: "DOCUMENT_SHARE_REVIEW",
      scope: null,
      scope_description: "Google Drive files",
      counterpart_type: "investor",
      counterpart_label: "Kushal Trivedi",
      issued_at: 1790000000000,
      metadata: {
        request_source: "drive_document_share_request",
        direction: "incoming",
        state: "pending",
        revision: 3,
        owner_attention_required: true,
        owner_decision_available: true,
        payment_required: true,
        ...metadata,
      },
      ...overrides,
    };
  }

  function documentRow(
    result: { current: ReturnType<typeof useFeedActionables> },
    id = DOC_ID,
  ): FeedActionable | undefined {
    return result.current.actionables.find(
      (row) => row.id === `consent:document_share_request:${id}`,
    );
  }

  function actionOf(row: FeedActionable | undefined, key: string) {
    const found = row?.actions.find((candidate) => candidate.key === key);
    if (!found) throw new Error(`missing ${key} action`);
    return found;
  }

  function renderWith(...entries: Array<Record<string, unknown>>) {
    mocks.pendingCount = entries.length;
    mocks.consentItems = entries;
    return renderHook(() => useFeedActionables());
  }

  /** The owner's vault-protected review: the terms Allow is asked about. */
  function ownerReview(overrides: Record<string, unknown> = {}) {
    return {
      revision: 3,
      status: "pending",
      recipientEmail: "kushal@example.invalid",
      purpose: {
        purpose: "Tax returns and bank statements",
        periodStart: "2015-01-01",
        periodEnd: "2026-10-09",
      },
      files: [],
      coverage: null,
      reviewDigest: null,
      expiresAt: null,
      canApprove: false,
      canTrustFutureRequests: false,
      preparationError: null,
      ownerAllowed: false,
      allowAvailable: true,
      paymentRequired: true,
      priceCents: null,
      ...overrides,
    };
  }

  beforeEach(() => {
    mocks.review.mockReset();
    mocks.review.mockResolvedValue(ownerReview());
  });

  it("gives an answerable request a red Deny and a green Allow; its tap still opens the review", () => {
    const { result } = renderWith(documentEntry(DOC_ID));
    const row = documentRow(result)!;

    expect(
      row.actions.map(({ key, label, tone }) => ({ key, label, tone })),
    ).toEqual([
      { key: "deny", label: "Deny", tone: "danger" },
      { key: "allow", label: "Allow", tone: "success" },
    ]);
    expect(actionOf(row, "deny").confirm).toBe(true);
    expect(row.chevron).toBe(false);
    expect(row.href).toBe(
      `/one/consent?tab=pending&requestId=document_share_request%3A${DOC_ID}&from=%2Fone%2Ffeed`,
    );
    row.onSelect?.();
    expect(mocks.push).toHaveBeenCalledWith(row.href);
  });

  it("keeps every other document request on today's chevron row", () => {
    const entries = [
      documentEntry(
        "33333333-3333-4333-8333-333333333331",
        {
          owner_decision_available: false,
          payment_waiting_for_requester: true,
        },
        { scope_description: "Waiting for requester payment" },
      ),
      documentEntry(
        "33333333-3333-4333-8333-333333333332",
        { owner_decision_available: undefined },
        { scope_description: "Enable background Drive access" },
      ),
      documentEntry("33333333-3333-4333-8333-333333333333", { revision: "3" }),
    ];
    const { result } = renderWith(...entries);

    for (const entry of entries) {
      const row = documentRow(result, String(entry.request_id));
      expect(row).toMatchObject({ actions: [], chevron: true });
      expect(row?.onSelect).toBeUndefined();
      expect(row?.href).toContain(encodeURIComponent(entry.id));
    }
  });

  it.each([[{}, { agentPackage: { status: "ready" } }], [{ ownerPayoutAccountReady: true, owner_decision_available: false, owner_price_available: true }, { oneCopyRequested: true }]])(
    "opens the full review from Feed for a package, or a Trusted One copy request on Set price (%#)", async (row, review) => {
    mocks.review.mockResolvedValue(ownerReview(review));
    const { result } = renderWith(documentEntry(DOC_ID, row));
    act(() => { actionOf(documentRow(result), "allow").run(); });
    await waitFor(() => expect(mocks.push).toHaveBeenCalled());
    expect(mocks.push.mock.lastCall?.[0]).toContain(encodeURIComponent(`document_share_request:${DOC_ID}`));
    expect(result.current.documentPricePrompt.open).toBe(false);
    act(() => result.current.documentPricePrompt.submit(2000));
    expect(mocks.allow).not.toHaveBeenCalled();
    expect(mocks.setRequestPrice).not.toHaveBeenCalled();
  });

  it("Allow opens the price step at once and sends the owner's price on this vault session", async () => {
    mocks.allow.mockResolvedValue({
      requestId: DOC_ID,
      status: "pending",
      revision: 3,
    });
    const { result } = renderWith(documentEntry(DOC_ID));
    expect(result.current.documentPricePrompt.open).toBe(false);

    let returned: unknown = "not run";
    act(() => {
      returned = actionOf(documentRow(result), "allow").run();
    });
    // Nothing to await, so the row's action lock is released at once.
    expect(returned).toBeUndefined();
    expect(result.current.documentPricePrompt).toMatchObject({
      open: true,
      requesterLabel: "Kushal Trivedi",
      paymentRequired: true,
      busy: false,
      error: null,
    });
    // The owner reads the request's terms, from the review, before Allow.
    await waitFor(() =>
      expect(result.current.documentPricePrompt.detailsPending).toBe(false),
    );
    expect(mocks.review).toHaveBeenCalledExactlyOnceWith(
      "vault-token",
      DOC_ID,
      expect.any(Function),
    );
    expect(result.current.documentPricePrompt).toMatchObject({
      purpose: "Tax returns and bank statements",
      recipientEmail: "kushal@example.invalid",
      periodStart: "2015-01-01",
      periodEnd: "2026-10-09",
    });
    expect(mocks.allow).not.toHaveBeenCalled();

    act(() => result.current.documentPricePrompt.submit(2000));
    await waitFor(() =>
      expect(result.current.documentPricePrompt.open).toBe(false),
    );

    expect(mocks.allow).toHaveBeenCalledExactlyOnceWith(
      "vault-token",
      DOC_ID,
      { revision: 3, amountCents: 2000 },
      expect.any(Function),
    );
    expect(documentRow(result)).toBeUndefined();
    expect(mocks.consentMutated).toHaveBeenCalledWith("user-1");
    expect(mocks.refresh).toHaveBeenCalledWith({ force: true });

    // The answer is bound to the session that gave it.
    const guard = mocks.allow.mock.calls[0]![3] as () => void;
    expect(() => guard()).not.toThrow();
    mocks.vaultToken = "another-session-token";
    expect(() => guard()).toThrow(DriveSharingError);
  });

  // 2026-10-17: the Feed offered a cents price on a whole-dollar request and Allow got a 422.
  it("prices a whole-dollar request in whole dollars and never sends a cents price", async () => {
    mocks.review.mockResolvedValue(ownerReview({ wholeDollarPrice: true, priceCents: 100 }));
    mocks.allow.mockResolvedValue({ requestId: DOC_ID, status: "pending", revision: 3 });
    const { result } = renderWith(documentEntry(DOC_ID));
    act(() => { actionOf(documentRow(result), "allow").run(); });
    await waitFor(() => expect(result.current.documentPricePrompt.detailsPending).toBe(false));
    expect(result.current.documentPricePrompt).toMatchObject({
      moneyPolicy: "legacy_whole_dollars", initialAmountCents: 100 });

    act(() => result.current.documentPricePrompt.submit(50));
    await waitFor(() => expect(result.current.documentPricePrompt.error)
      .toBe("Choose a whole-dollar price from $1 to $500."));
    expect(mocks.allow).not.toHaveBeenCalled();
    expect(result.current.documentPricePrompt.open).toBe(true);

    act(() => result.current.documentPricePrompt.submit(100));
    await waitFor(() => expect(result.current.documentPricePrompt.open).toBe(false));
    expect(mocks.allow).toHaveBeenCalledExactlyOnceWith(
      "vault-token", DOC_ID, { revision: 3, amountCents: 100 }, expect.any(Function));
  });

  it.each([false, true])("keeps cents and accepts a One copy only when the review asks (2026-10-28 422; requested=%s)", async (oneCopyRequested) => {
    mocks.review.mockResolvedValue(ownerReview(oneCopyRequested ? { oneCopyRequested } : {}));
    mocks.allow.mockResolvedValue({ requestId: DOC_ID, status: "pending", revision: 3 });
    const { result } = renderWith(documentEntry(DOC_ID));
    act(() => { actionOf(documentRow(result), "allow").run(); });
    await waitFor(() => expect(result.current.documentPricePrompt).toMatchObject({ detailsPending: false, moneyPolicy: "drive_cents", oneCopyRequested }));
    act(() => result.current.documentPricePrompt.submit(50));
    await waitFor(() => expect(mocks.allow).toHaveBeenCalledExactlyOnceWith("vault-token", DOC_ID, { revision: 3, amountCents: 50, ...(oneCopyRequested ? { oneCopyAccepted: true } : {}) }, expect.any(Function)));
  });

  it("holds Allow until the request's terms load, and sends nothing without them", async () => {
    mocks.review.mockRejectedValue(
      new DriveSharingError("request_unavailable", 404),
    );
    const { result } = renderWith(documentEntry(DOC_ID));
    act(() => {
      actionOf(documentRow(result), "allow").run();
    });
    expect(result.current.documentPricePrompt.detailsPending).toBe(true);
    await waitFor(() =>
      expect(result.current.documentPricePrompt.error).toBe(
        "This request is no longer available.",
      ),
    );

    act(() => result.current.documentPricePrompt.submit(2000));
    expect(result.current.documentPricePrompt.detailsPending).toBe(true);
    expect(mocks.allow).not.toHaveBeenCalled();
  });

  it("re-reads a refused request: Allow answers its new revision, or the sheet closes", async () => {
    mocks.allow.mockRejectedValue(new DriveSharingError("review_changed", 409));
    mocks.review
      .mockResolvedValueOnce(ownerReview())
      .mockResolvedValueOnce(ownerReview({ revision: 4 }));
    const { result } = renderWith(documentEntry(DOC_ID));
    act(() => {
      actionOf(documentRow(result), "allow").run();
    });
    await waitFor(() =>
      expect(result.current.documentPricePrompt.detailsPending).toBe(false),
    );

    // An amount below the Drive minimum never leaves the device.
    act(() => result.current.documentPricePrompt.submit(49));
    expect(mocks.allow).not.toHaveBeenCalled();
    expect(result.current.documentPricePrompt.error).toBe(
      "Choose a price from $0.50 to $500.",
    );

    act(() => result.current.documentPricePrompt.submit(2000));
    await waitFor(() => expect(mocks.review).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(result.current.documentPricePrompt.detailsPending).toBe(false),
    );
    expect(result.current.documentPricePrompt).toMatchObject({
      open: true,
      busy: false,
      error: "This request changed. Check it and try again.",
    });
    expect(documentRow(result)).toBeDefined();

    // The retry answers the revision the owner is now reading. Its response
    // was lost after the server allowed it, so the re-read finds it allowed
    // and the row settles as an answered request.
    mocks.review.mockResolvedValueOnce(
      ownerReview({
        revision: 4,
        allowAvailable: false,
        ownerAllowed: true,
        priceCents: 3000,
      }),
    );
    act(() => result.current.documentPricePrompt.submit(3000));
    await waitFor(() =>
      expect(result.current.documentPricePrompt.open).toBe(false),
    );
    expect(mocks.allow).toHaveBeenLastCalledWith(
      "vault-token",
      DOC_ID,
      { revision: 4, amountCents: 3000 },
      expect.any(Function),
    );
    expect(documentRow(result)).toBeUndefined();
    expect(mocks.consentMutated).toHaveBeenCalledWith("user-1");
    expect(mocks.refresh).toHaveBeenCalledWith({ force: true });
  });

  it("does not publish a task when payments are unavailable", () => {
    const { result } = renderWith(documentEntry(DOC_ID, { paymentsReady: false }));
    expect(documentRow(result)?.todo).toBeUndefined();
  });

  it("shows the owner the estimate the requester saw, without fixing the price", async () => {
    mocks.allow.mockResolvedValue({
      requestId: DOC_ID,
      status: "pending",
      revision: 3,
    });
    mocks.review.mockResolvedValue(ownerReview({ estimateCents: 2500 }));
    const { result } = renderWith(documentEntry(DOC_ID));
    act(() => {
      actionOf(documentRow(result), "allow").run();
    });
    await waitFor(() =>
      expect(result.current.documentPricePrompt.detailsPending).toBe(false),
    );
    expect(result.current.documentPricePrompt).toMatchObject({
      estimateCents: 2500,
      lockedAmountCents: null,
      initialAmountCents: null,
    });

    // The owner still chooses: Allow sends their price, not the estimate.
    act(() => result.current.documentPricePrompt.submit(4000));
    await waitFor(() =>
      expect(result.current.documentPricePrompt.open).toBe(false),
    );
    expect(mocks.allow).toHaveBeenCalledExactlyOnceWith(
      "vault-token",
      DOC_ID,
      { revision: 3, amountCents: 4000 },
      expect.any(Function),
    );
  });

  it.each([
    ["missing", undefined],
    ["sub-cent", 1050.5],
    ["above the limit", 50_100],
    ["not a number", "2500"],
  ])("never lets a %s estimate block pricing", async (_label, estimateCents) => {
    mocks.allow.mockResolvedValue({
      requestId: DOC_ID,
      status: "pending",
      revision: 3,
    });
    mocks.review.mockResolvedValue(ownerReview({ estimateCents }));
    const { result } = renderWith(documentEntry(DOC_ID));
    act(() => {
      actionOf(documentRow(result), "allow").run();
    });
    await waitFor(() =>
      expect(result.current.documentPricePrompt.detailsPending).toBe(false),
    );
    expect(result.current.documentPricePrompt.estimateCents).toBeNull();

    act(() => result.current.documentPricePrompt.submit(2000));
    await waitFor(() =>
      expect(result.current.documentPricePrompt.open).toBe(false),
    );
    expect(mocks.allow).toHaveBeenCalledExactlyOnceWith(
      "vault-token",
      DOC_ID,
      { revision: 3, amountCents: 2000 },
      expect.any(Function),
    );
  });

  it("allows a free request without a price", async () => {
    mocks.allow.mockResolvedValue({
      requestId: DOC_ID,
      status: "pending",
      revision: 3,
    });
    mocks.review.mockResolvedValue(ownerReview({ paymentRequired: false }));
    const { result } = renderWith(
      documentEntry(DOC_ID, { payment_required: false }),
    );
    act(() => {
      actionOf(documentRow(result), "allow").run();
    });
    await waitFor(() =>
      expect(result.current.documentPricePrompt.detailsPending).toBe(false),
    );
    expect(result.current.documentPricePrompt.paymentRequired).toBe(false);

    act(() => result.current.documentPricePrompt.submit(null));
    await waitFor(() =>
      expect(result.current.documentPricePrompt.open).toBe(false),
    );
    expect(mocks.allow).toHaveBeenCalledExactlyOnceWith(
      "vault-token",
      DOC_ID,
      { revision: 3, amountCents: null },
      expect.any(Function),
    );
  });

  it("Deny declines at the shown revision and the row leaves", async () => {
    mocks.decide.mockResolvedValue({});
    const { result } = renderWith(documentEntry(DOC_ID));

    await act(async () => {
      await actionOf(documentRow(result), "deny").run();
    });

    expect(mocks.decide).toHaveBeenCalledExactlyOnceWith(
      "vault-token",
      DOC_ID,
      "decline",
      3,
      expect.any(Function),
    );
    expect(mocks.allow).not.toHaveBeenCalled();
    expect(documentRow(result)).toBeUndefined();
  });

  it("disables both answers without the vault owner token", async () => {
    mocks.vaultToken = null;
    const { result } = renderWith(documentEntry(DOC_ID));
    const row = documentRow(result);

    expect(row?.actions.map((action) => action.disabled)).toEqual([true, true]);
    await act(async () => {
      await actionOf(row, "deny").run();
    });
    expect(mocks.decide).not.toHaveBeenCalled();
  });

  it("labels the requester's Pay action with the order's price", () => {
    const paymentId = "44444444-4444-4444-8444-444444444444";
    mocks.consentItems = [
      {
        id: `document_share_request:${paymentId}`,
        request_id: paymentId,
        kind: "outgoing_request",
        status: "pending",
        action: "DOCUMENT_SHARE_REVIEW",
        scope: null,
        counterpart_type: "investor",
        counterpart_label: "Meena Rao",
        issued_at: 1790000000000,
        metadata: {
          request_source: "drive_document_share_request",
          direction: "outgoing",
          state: "pending",
          revision: 2,
          paymentStatus: "checkout_open",
          paymentAmountCents: 2000,
          paymentCurrency: "usd",
          checkoutExpiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
        },
      },
    ];
    const { result } = renderHook(() => useFeedActionables());

    const payment = result.current.actionables.find(
      (row) => row.id === `drive-payment:${paymentId}`,
    );
    expect(payment?.actions.map((action) => action.label)).toEqual(["Pay $20"]);
  });

  it("shows payout setup as waiting without a requester Pay action", () => {
    const paymentId = "44444444-4444-4444-8444-444444444444";
    mocks.consentItems = [
      {
        id: `document_share_request:${paymentId}`,
        request_id: paymentId,
        kind: "outgoing_request",
        status: "pending",
        action: "DOCUMENT_SHARE_REVIEW",
        scope: null,
        counterpart_type: "investor",
        counterpart_label: "Meena Rao",
        issued_at: 1790000000000,
        metadata: {
          request_source: "drive_document_share_request",
          direction: "outgoing",
          paymentStatus: "checkout_open",
          paymentAmountCents: 2000,
          paymentCurrency: "usd",
          checkoutExpiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
          ownerPayoutAccountReady: false,
        },
      },
    ];
    const { result } = renderHook(() => useFeedActionables());
    const payment = result.current.actionables.find(
      (row) => row.id === `drive-payment:${paymentId}`,
    );
    expect(payment).toMatchObject({
      title: "Waiting for owner setup",
      actions: [],
      chevron: true,
      href: expect.stringContaining("requestId="),
    });
  });

  it("shows payout setup first on each affected request and routes to Profile", async () => {
    const otherId = "33333333-3333-4333-8333-333333333333";
    const { result } = renderWith(
      documentEntry(DOC_ID, {
        ownerPayoutAccountReady: false,
        ownerPriceRequired: true,
      }),
      documentEntry(otherId, {
        ownerPayoutAccountReady: false,
        owner_decision_available: false,
      }),
    );
    for (const id of [DOC_ID, otherId]) {
      const row = documentRow(result, id)!;
      expect(row.todo).toMatchObject({ key: `consent:${row.id.slice(8)}:setup:payouts`, source: "drive", title: "Link payouts", href: "/one/profile/payouts?from=%2Fone%2Ftodos" });
      expect(row.description).toBe("Requested a document");
      expect(row.actions.map(({ label }) => label)).toEqual(["Link payouts"]);
      expect(
        result.current.actionables.filter((item) => item.id === row.id),
      ).toHaveLength(1);
    }
    // The row body takes the same step as its button. It used to do nothing:
    // a row with actions ignores `href`, and this row set no `onSelect`.
    act(() => documentRow(result)!.onSelect?.());
    await act(async () => actionOf(documentRow(result), "setup-payouts").run());
    expect(mocks.push.mock.calls).toEqual([
      ["/one/profile/payouts?from=%2Fone%2Ffeed"],
      ["/one/profile/payouts?from=%2Fone%2Ffeed"],
    ]);
    expect(mocks.account).not.toHaveBeenCalled();
  });

  it.each(["row", "button"] as const)(
    "asks for Google Drive first and opens it over the Feed from the %s",
    async (target) => {
      window.history.replaceState(null, "", "/one/feed");
      const pushState = vi.spyOn(window.history, "pushState");
      const { result } = renderWith(
        documentEntry(DOC_ID, {
          ownerDriveReady: false,
          ownerPayoutAccountReady: false,
        }),
      );
      const row = documentRow(result)!;
      expect(row).toMatchObject({
        title: "Kushal Trivedi",
        description: "Requested a document",
      });
      // One row: Drive comes before payouts and before Allow or Deny.
      expect(row.actions.map(({ label }) => label)).toEqual([
        "Connect Google Drive",
      ]);
      expect(
        result.current.actionables.filter((item) => item.id === row.id),
      ).toHaveLength(1);

      await act(async () => {
        if (target === "row") row.onSelect?.();
        else await actionOf(row, "setup-drive").run();
      });

      expect(pushState).toHaveBeenCalledOnce();
      const [state, , url] = pushState.mock.calls[0]!;
      expect(url).toBe(
        "/one/feed?profile_pane=1&profile_panel=connectors&profile_detail=connector%3Agoogle_drive",
      );
      // Closing Google Drive returns to the Feed, not to Connectors.
      expect((state as Record<string, unknown>).__hushhProfilePane).toEqual({
        depth: 1,
        returnsToOrigin: true,
      });
      expect(mocks.push).not.toHaveBeenCalled();
      pushState.mockRestore();
      window.history.replaceState(null, "", "/");
    },
  );

  it("replaces payout setup with price setup as the streamed projection changes", async () => {
    const { result, rerender } = renderWith(
      documentEntry(DOC_ID, {
        ownerPayoutAccountReady: false,
        ownerPriceRequired: true,
        owner_decision_available: false,
      }),
    );
    expect(documentRow(result)?.actions.map(({ label }) => label)).toEqual([
      "Link payouts",
    ]);
    mocks.consentItems = [
      documentEntry(DOC_ID, {
        ownerPayoutAccountReady: true,
        ownerPriceRequired: true,
        owner_decision_available: false,
      }),
    ];
    const payoutsKey = documentRow(result)?.todo?.key;
    rerender();
    expect(documentRow(result)?.todo?.key).toBe(`consent:document_share_request:${DOC_ID}:setup:price`);
    expect(documentRow(result)?.todo?.key).not.toBe(payoutsKey);
    expect(documentRow(result)?.actions.map(({ label }) => label)).toEqual([
      "Set price",
    ]);
    await act(async () => actionOf(documentRow(result), "setup-price").run());
    expect(mocks.push).toHaveBeenCalledWith(
      "/one/profile/request-pricing?from=%2Fone%2Ffeed",
    );
    mocks.consentItems = [
      documentEntry(DOC_ID, {
        ownerPayoutAccountReady: true,
        ownerPriceRequired: false,
        owner_decision_available: false,
      }),
    ];
    rerender();
    expect(documentRow(result)?.actions).toEqual([]);
    expect(mocks.account).not.toHaveBeenCalled();
  });

  it.each([null, 1200])(
    "uses a price-only command for a trusted request with draft price %s",
    async (draftPrice) => {
      mocks.review.mockResolvedValue(
        ownerReview({
          allowAvailable: false,
          priceOnlyAvailable: true,
          ownerPriceRequired: draftPrice === null,
          ownerPayoutAccountReady: true,
          trustedAuto: true,
          priceCents: draftPrice,
        }),
      );
      mocks.setRequestPrice.mockResolvedValue({
        requestId: DOC_ID,
        revision: 4,
        status: "pending",
      });
      const { result } = renderWith(
        documentEntry(DOC_ID, {
          ownerPayoutAccountReady: true,
          ownerPriceRequired: draftPrice === null,
          owner_decision_available: false,
          owner_price_available: true,
        }),
      );
      expect(documentRow(result)?.actions.map(({ label }) => label)).toEqual([
        "Set price",
      ]);
      await act(async () => actionOf(documentRow(result), "allow").run());
      await waitFor(() =>
        expect(result.current.documentPricePrompt.detailsPending).toBe(false),
      );
      expect(result.current.documentPricePrompt.priceOnly).toBe(true);
      expect(result.current.documentPricePrompt.initialAmountCents).toBe(
        draftPrice,
      );
      await act(async () => result.current.documentPricePrompt.submit(500));
      await waitFor(() =>
        expect(mocks.setRequestPrice).toHaveBeenCalledExactlyOnceWith(
          "vault-token",
          DOC_ID,
          { revision: 3, amountCents: 500 },
          expect.any(Function),
        ),
      );
      expect(mocks.allow).not.toHaveBeenCalled();
    },
  );

  it("keeps non-trusted price choice inside Allow once payouts are ready", () => {
    const { result } = renderWith(
      documentEntry(DOC_ID, {
        ownerPayoutAccountReady: true,
        ownerPriceRequired: true,
      }),
    );
    expect(documentRow(result)?.actions.map(({ label }) => label)).toEqual([
      "Deny",
      "Allow",
    ]);
  });

  it("keeps legacy requests out of Connect setup discovery", () => {
    const { result } = renderWith(documentEntry(DOC_ID));
    expect(
      result.current.actionables.find((row) => row.id === "drive-payout-setup"),
    ).toBeUndefined();
    expect(mocks.account).not.toHaveBeenCalled();
  });
});

const ANSWER_ID = "answer_request:11111111-2222-3333-4444-555555555555";
const answerEntry = (
  role: string,
  state: string,
  overrides: Record<string, unknown> = {},
) => ({
  id: ANSWER_ID,
  request_id: ANSWER_ID,
  kind: "incoming_request",
  status: state,
  action: "ANSWER_REQUEST_REVIEW",
  scope: null,
  counterpart_type: "person",
  counterpart_label: "Connected person",
  metadata: { request_source: "answer_request", request_status: state, role },
  ...overrides,
});
describe("Request scope Needs you", () => {
  // An approved request whose answer has not been prepared yet has its own
  // case below: it is neither priced nor declared missing.
  it.each([["owner", "answering", "Write answer"]])(
    "routes %s %s through its review card",
    async (role, state, label) => {
    mocks.pendingCount = 1;
    mocks.consentItems = [answerEntry(role, state)];
    const { result } = renderHook(() => useFeedActionables());
    const row = result.current.actionables.find(
      (item) => item.id === `consent:${ANSWER_ID}`,
    )!;
    expect(row.description).toBe(label);
    expect(row.actions.map((action) => action.key)).toEqual(["review-answer"]);
    await act(async () => {
      await row.actions[0].run();
    });
    expect(mocks.push).toHaveBeenCalledWith(
      expect.stringContaining(encodeURIComponent(ANSWER_ID)),
    );
      expect(mocks.allow).not.toHaveBeenCalled();
      expect(mocks.decide).not.toHaveBeenCalled();
    },
  );
  // The owner decides this question the way they decide a document request:
  // Deny on the row, and Allow on the review that shows what it would use and
  // what it costs. Approving binds both, so neither fits on a row.
  it("offers the owner Deny inline and Allow on the review", async () => {
    mocks.pendingCount = 1;
    mocks.consentItems = [
      answerEntry("owner", "awaiting_owner", {
        metadata: {
          request_source: "answer_request",
          request_status: "awaiting_owner",
          role: "owner",
          proposed_scope_count: 2,
        },
      }),
    ];
    const { result } = renderHook(() => useFeedActionables());
    const row = result.current.actionables.find(
      (item) => item.id === `consent:${ANSWER_ID}`,
    )!;
    expect(row.description).toBe("Set price");
    expect(row.actions.map((action) => action.key)).toEqual([
      "deny-answer",
      "allow-answer",
    ]);
    // A refusal grants nothing, so it lands from the row.
    expect(row.actions[0].confirm).toBe(true);
    await act(async () => {
      await row.actions[1].run();
    });
    expect(mocks.push).toHaveBeenCalledWith(
      expect.stringContaining(encodeURIComponent(ANSWER_ID)),
    );
    // Never the generic consent grant, and never the document decision.
    expect(mocks.allow).not.toHaveBeenCalled();
    expect(mocks.decide).not.toHaveBeenCalled();
  });

  it("names the price the owner set, with the question, before the tap", () => {
    mocks.pendingCount = 1;
    mocks.consentItems = [
      answerEntry("requester", "approved", {
        metadata: {
          request_source: "answer_request",
          request_status: "approved",
          role: "requester",
          proposed_scope_count: 2,
          answer_staged: true,
          answer_has_content: true,
          amount_cents: 100,
          question: "What is your age?",
        },
      }),
    ];
    const { result } = renderHook(() => useFeedActionables());
    const row = result.current.actionables.find(
      (item) => item.id === `consent:${ANSWER_ID}`,
    )!;
    expect(row.title).toBe("Pay $1 · What is your age?");
    expect(row.description).toBe("Pay $1");
    expect(row.actions.map((action) => action.label)).toEqual(["Pay $1"]);
  });

  it("takes the requester straight to Checkout, not to another Pay screen", async () => {
    mocks.idToken.mockResolvedValue("id-token");
    mocks.answerCheckout.mockResolvedValue("https://checkout.stripe.com/c/pay/cs_test_1");
    const assign = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, assign },
    });
    mocks.pendingCount = 1;
    mocks.consentItems = [
      answerEntry("requester", "approved", {
        metadata: {
          request_source: "answer_request",
          request_status: "approved",
          role: "requester",
          proposed_scope_count: 2,
          answer_staged: true,
          answer_has_content: true,
          amount_cents: 100,
          question: "What is your age?",
        },
      }),
    ];
    const { result } = renderHook(() => useFeedActionables());
    const row = result.current.actionables.find(
      (item) => item.id === `consent:${ANSWER_ID}`,
    )!;
    await act(async () => {
      await row.actions[0].run();
    });
    expect(mocks.answerCheckout).toHaveBeenCalledWith("id-token", ANSWER_ID);
    expect(assign).toHaveBeenCalledWith(
      "https://checkout.stripe.com/c/pay/cs_test_1",
    );
    // The price was decided before the tap; a screen whose only control is
    // Pay again is a step with no decision in it.
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("tells the requester the answer is not there instead of pricing it", () => {
    // The owner's device prepared the answer and the approved information
    // yielded nothing, so no price can ever be honoured. A suggested scope
    // count would have said the opposite.
    mocks.pendingCount = 1;
    mocks.consentItems = [
      answerEntry("requester", "approved", {
        metadata: {
          request_source: "answer_request",
          request_status: "approved",
          role: "requester",
          proposed_scope_count: 3,
          answer_staged: true,
          answer_has_content: false,
          amount_cents: 100,
        },
      }),
    ];
    const { result } = renderHook(() => useFeedActionables());
    const row = result.current.actionables.find(
      (item) => item.id === `consent:${ANSWER_ID}`,
    )!;
    expect(row.todo).toBeUndefined();
    expect(row.description).toBe("Answer not found");
    expect(row.actions).toEqual([]);
  });

  it.each([false, true])("does not price an unstaged answer, including overdue=%s", (overdue) => {
    // Locked, offline or still reading. "Not found" would be a guess and so
    // would a price, so the row says what is actually happening.
    mocks.pendingCount = 1;
    mocks.consentItems = [
      answerEntry("requester", "approved", {
        metadata: {
          request_source: "answer_request",
          request_status: "approved",
          role: "requester",
          proposed_scope_count: 3,
          answer_staged: false,
          preparation_overdue: overdue,
          amount_cents: 100,
          question: "What is your age?",
        },
      }),
    ];
    const { result } = renderHook(() => useFeedActionables());
    const row = result.current.actionables.find(
      (item) => item.id === `consent:${ANSWER_ID}`,
    )!;
    expect(row.todo).toBeUndefined();
    expect(row.description).toBe(overdue
      ? "Ask them to unlock memory and retry preparation"
      : "Their answer is being prepared");
    expect(row.actions).toEqual([]);
  });

  it.each([
    { scope: "attr.financial.*", allowed_next_action: "review_request" },
    {
      bundle_items: [
        { id: "legacy", scope: "attr.financial.*", status: "pending" },
      ],
    },
  ])("never grants generic consent for an answer row (%j)", (overrides) => {
    mocks.pendingCount = 1;
    mocks.consentItems = [answerEntry("owner", "pending", overrides)];
    const { result } = renderHook(() => useFeedActionables());
    const row = result.current.actionables.find(
      (item) => item.id === `consent:${ANSWER_ID}`,
    )!;
    expect(row.actions.map((action) => action.key)).toEqual(["review-answer"]);
  });
});

describe("Checkout callbacks stay with their original feed scope", () => {
  function checkoutEntry(lane: "drive" | "answer") {
    if (lane === "answer") return answerEntry("requester", "approved", { metadata: {
      request_source: "answer_request", request_status: "approved", role: "requester",
      proposed_scope_count: 2, answer_staged: true, answer_has_content: true,
      amount_cents: 100, question: "What is your age?",
    } });
    return { id: "document_share_request:44444444-4444-4444-8444-444444444444",
      request_id: "44444444-4444-4444-8444-444444444444", kind: "outgoing_request",
      status: "pending", action: "DOCUMENT_SHARE_REVIEW", scope: null,
      counterpart_type: "investor", counterpart_label: "Meena Rao", issued_at: 1790000000000,
      metadata: { request_source: "drive_document_share_request", direction: "outgoing",
        state: "pending", revision: 2, paymentStatus: "checkout_open", paymentAmountCents: 2000,
        paymentCurrency: "usd", checkoutExpiresAt: new Date(Date.now() + 30 * 60_000).toISOString() } };
  }

  it("reconciles no-charge completion past a forced consent read already in flight", async () => {
    mocks.realConsentResources = true;
    const cache = CacheService.getInstance();
    const entry = checkoutEntry("drive");
    const summaryKey = CACHE_KEYS.CONSENT_CENTER_SUMMARY("user-1", "one:consents");
    const sentKey = CACHE_KEYS.CONSENT_CENTER_LIST("user-1", "one:consents:sent", "pending", "", 1, 100);
    const progressKeys = ["pending", "active"].map(surface => CACHE_KEYS.CONSENT_CENTER_LIST("user-1", "one:consents", surface as "pending" | "active", "", 1, 100));
    cache.set(summaryKey, { counts: { pending: 0 } });
    cache.set(sentKey, { items: [entry], has_more: false });
    for (const key of progressKeys) cache.set(key, { items: [], has_more: false });
    vi.mocked(ConsentCenterService.getSummary).mockResolvedValue({ counts: { pending: 0 } } as Awaited<ReturnType<typeof ConsentCenterService.getSummary>>);
    let finishOld!: (value: Awaited<ReturnType<typeof ConsentCenterService.listEntries>>) => void;
    let sentReads = 0;
    vi.mocked(ConsentCenterService.listEntries).mockImplementation(async ({ requestView }) => {
      if (requestView === "sent" && ++sentReads === 1) return new Promise(resolve => { finishOld = resolve; });
      return { items: [], has_more: false } as Awaited<ReturnType<typeof ConsentCenterService.listEntries>>;
    });
    mocks.consentMutated.mockImplementation((owner: string) => {
      noteConsentMutated(owner);
      cache.invalidateMany([summaryKey, sentKey, ...progressKeys]);
    });
    mocks.driveCheckout.mockResolvedValueOnce({ requestId: entry.request_id, existingAccess: true });
    const assign = vi.fn();
    Object.defineProperty(window, "location", { configurable: true, value: { ...window.location, assign } });
    const mounted = renderHook(() => useFeedActionables());
    try {
      const action = mounted.result.current.actionables.flatMap(row => row.actions).find(item => item.key === "pay")!;
      act(() => { window.dispatchEvent(new CustomEvent(CONSENT_STATE_CHANGED_EVENT, { detail: { source: "sse" } })); });
      await waitFor(() => expect(sentReads).toBe(1));
      let pending!: Promise<void> | void;
      act(() => { pending = action.run(); });
      await waitFor(() => expect(mocks.consentMutated).toHaveBeenCalledWith("user-1"));
      await act(async () => {
        finishOld({ items: [entry], has_more: false } as Awaited<ReturnType<typeof ConsentCenterService.listEntries>>);
        await pending;
      });
      await waitFor(() => expect(mounted.result.current.actionables.some(row => row.id.startsWith("drive-payment:"))).toBe(false));
      expect(sentReads).toBeGreaterThanOrEqual(2);
      expect(assign).not.toHaveBeenCalled();
      const finalReadOrder = vi.mocked(ConsentCenterService.listEntries).mock.invocationCallOrder.at(-1)!;
      expect(mocks.consentMutated.mock.invocationCallOrder[0]).toBeLessThan(finalReadOrder);
    } finally {
      mounted.unmount();
      mocks.consentMutated.mockReset();
    }
  });

  it("opens approved packet review instead of bypassing disclosure with Feed Pay", async () => {
    const entry = checkoutEntry("drive");
    mocks.pendingCount = 1;
    mocks.consentItems = [{ ...entry, metadata: { ...entry.metadata, paymentView: {
      state: "payable", amountCents: 2000, currency: "usd", nextAction: "pay", refund: null,
      checkoutExpiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      packageDisclosureRequired: true,
    } } }];
    const mounted = renderHook(() => useFeedActionables());
    const row = mounted.result.current.actionables.find(item => item.id.startsWith("drive-payment:"))!;
    expect(row.actions.map(action => action.label)).toEqual(["Review packet"]);
    await act(async () => { await row.actions[0].run(); });
    expect(mocks.push).toHaveBeenCalledWith(expect.stringContaining("requestId=document_share_request%3A44444444-4444-4444-8444-444444444444"));
    expect(mocks.driveCheckout).not.toHaveBeenCalled();
    mounted.unmount();
  });

  it.each([["drive", "url"], ["drive", "nocharge"], ["answer", "url"]] as const)("fences %s %s checkout across account/session/request/unmount boundaries", async (lane, outcome) => {
    for (const boundary of ["account", "session", "request", "unmount"]) {
      mocks.userId = "user-1";
      mocks.pendingCount = 1;
      mocks.consentItems = [checkoutEntry(lane)];
      mocks.idToken.mockResolvedValue("id-token");
      let finish!: (value: string | { requestId: string; existingAccess: true }) => void;
      const checkout = lane === "drive" ? mocks.driveCheckout : mocks.answerCheckout;
      checkout.mockReset().mockReturnValueOnce(new Promise<string | { requestId: string; existingAccess: true }>(resolve => { finish = resolve; }));
      const assign = vi.fn();
      Object.defineProperty(window, "location", { configurable: true, value: { ...window.location, assign } });
      const mounted = renderHook(() => useFeedActionables());
      const action = mounted.result.current.actionables.flatMap(row => row.actions).find(item => item.key === (lane === "drive" ? "pay" : "pay-answer"))!;
      let pending!: Promise<void> | void;
      act(() => { pending = action.run(); });
      await waitFor(() => expect(checkout).toHaveBeenCalledOnce());
      if (boundary === "account") {
        mocks.userId = "another-user";
        mounted.rerender();
      } else if (boundary === "session") advanceVaultSessionEpoch();
      else if (boundary === "request") {
        mocks.consentItems = [];
        mounted.rerender();
      } else mounted.unmount();
      mocks.refresh.mockClear();
      mocks.toastError.mockClear();
      mocks.consentMutated.mockClear();
      await act(async () => { finish(outcome === "nocharge"
        ? { requestId: "44444444-4444-4444-8444-444444444444", existingAccess: true }
        : "https://checkout.stripe.com/c/pay/old"); await pending; });
      expect(assign).not.toHaveBeenCalled();
      expect(mocks.toastError).not.toHaveBeenCalled();
      expect(mocks.refresh).not.toHaveBeenCalled();
      expect(mocks.consentMutated).not.toHaveBeenCalled();
      mounted.unmount();
    }
  });

  it("does not send an answer checkout after an account change during token loading", async () => {
    mocks.pendingCount = 1;
    mocks.consentItems = [checkoutEntry("answer")];
    let finish!: (token: string) => void;
    mocks.idToken.mockReturnValueOnce(new Promise<string>(resolve => { finish = resolve; }));
    mocks.answerCheckout.mockClear();
    const mounted = renderHook(() => useFeedActionables());
    const action = mounted.result.current.actionables.flatMap(row => row.actions).find(item => item.key === "pay-answer")!;
    let pending!: Promise<void> | void;
    act(() => { pending = action.run(); });
    mocks.userId = "another-user";
    mounted.rerender();
    await act(async () => { finish("old-token"); await pending; });
    expect(mocks.answerCheckout).not.toHaveBeenCalled();
    mounted.unmount();
  });

  it("suppresses a late Drive checkout failure and refresh after the feed closes", async () => {
    mocks.pendingCount = 1;
    mocks.consentItems = [checkoutEntry("drive")];
    let fail!: (cause: Error) => void;
    mocks.driveCheckout.mockReturnValueOnce(new Promise<string>((_, reject) => { fail = reject; }));
    const mounted = renderHook(() => useFeedActionables());
    const action = mounted.result.current.actionables.flatMap(row => row.actions).find(item => item.key === "pay")!;
    let pending!: Promise<void> | void;
    act(() => { pending = action.run(); });
    await waitFor(() => expect(mocks.driveCheckout).toHaveBeenCalledOnce());
    mounted.unmount();
    mocks.refresh.mockClear();
    mocks.toastError.mockClear();
    await act(async () => { fail(new Error("old request")); await pending; });
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});
