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
  vaultToken: "vault-token" as string | null,
  allow: vi.fn(),
  decide: vi.fn(),
  review: vi.fn(),
  account: vi.fn(),
  consentMutated: vi.fn(),
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
  useVault: () => ({
    vaultOwnerToken: mocks.vaultToken,
    getVaultOwnerToken: () => mocks.vaultToken,
  }),
}));

vi.mock("@/lib/services/drive-sharing-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/services/drive-sharing-service")>()),
  DriveSharingService: {
    allow: mocks.allow,
    decide: mocks.decide,
    review: mocks.review,
    // Payment rows read private request text; these rows stay metadata-only.
    requesterContext: vi.fn().mockRejectedValue(new Error("not in this test")),
  },
}));
vi.mock("@/lib/services/document-payout-service", () => ({
  DocumentPayoutService: { account: mocks.account },
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

vi.mock("@/lib/navigation/routes", () => ({
  buildKaiMarketRoute: () => "/one/kai",
  ROUTES: { PROFILE_MY_DATA: "/one/profile/my-data" },
}));

import {
  useFeedActionables,
  type FeedActionable,
} from "@/lib/feed/use-feed-actionables";
import { DriveSharingError } from "@/lib/services/drive-sharing-service";

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
  vi.clearAllMocks();
  platform.android = false;
  mocks.consentItems = [];
  mocks.connectionRequests = [];
  mocks.circleMemberInvites = [];
  mocks.appTasks = [];
  mocks.pendingCount = 0;
  mocks.vaultToken = "vault-token";
  mocks.account.mockResolvedValue({ account: null });
});

describe("useFeedActionables — connection request de-duplication", () => {

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
      scope_description: index === 0 ? "Enable background Drive access" : "Google Drive files",
      metadata: { request_source: "drive_document_share_request", direction },
    }));
    const { result } = renderHook(() => useFeedActionables());
    const documents = result.current.actionables.filter((row) => row.id.startsWith("consent:document_share_request:"));
    expect(documents).toHaveLength(1);
    expect(documents[0].id).toBe(`consent:${mocks.consentItems[0].id}`);
    expect(documents[0].description).toBe("Enable background Drive access");
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
        { owner_decision_available: false, payment_waiting_for_requester: true },
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

  it("Allow opens the price step at once and sends the owner's price on this vault session", async () => {
    mocks.allow.mockResolvedValue({ requestId: DOC_ID, status: "pending", revision: 3 });
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
    await waitFor(() => expect(result.current.documentPricePrompt.open).toBe(false));

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

  it("holds Allow until the request's terms load, and sends nothing without them", async () => {
    mocks.review.mockRejectedValue(new DriveSharingError("request_unavailable", 404));
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

    // A price that is not whole dollars never leaves the device.
    act(() => result.current.documentPricePrompt.submit(2050));
    expect(mocks.allow).not.toHaveBeenCalled();
    expect(result.current.documentPricePrompt.error).toBe(
      "Choose a whole-dollar price from $1 to $500.",
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
      ownerReview({ revision: 4, allowAvailable: false, ownerAllowed: true, priceCents: 3000 }),
    );
    act(() => result.current.documentPricePrompt.submit(3000));
    await waitFor(() => expect(result.current.documentPricePrompt.open).toBe(false));
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

  it("allows a free request without a price", async () => {
    mocks.allow.mockResolvedValue({ requestId: DOC_ID, status: "pending", revision: 3 });
    mocks.review.mockResolvedValue(ownerReview({ paymentRequired: false }));
    const { result } = renderWith(documentEntry(DOC_ID, { payment_required: false }));
    act(() => {
      actionOf(documentRow(result), "allow").run();
    });
    await waitFor(() =>
      expect(result.current.documentPricePrompt.detailsPending).toBe(false),
    );
    expect(result.current.documentPricePrompt.paymentRequired).toBe(false);

    act(() => result.current.documentPricePrompt.submit(null));
    await waitFor(() => expect(result.current.documentPricePrompt.open).toBe(false));
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
    mocks.consentItems = [{
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
    }];
    const { result } = renderHook(() => useFeedActionables());
    const payment = result.current.actionables.find(
      (row) => row.id === `drive-payment:${paymentId}`,
    );
    expect(payment).toMatchObject({
      title: "Waiting for owner payout setup",
      actions: [],
      chevron: true,
      href: expect.stringContaining("requestId="),
    });
  });

  it("shows one owner payout setup action when remote Stripe readiness is false, even if the DB hint is true", async () => {
    mocks.account.mockResolvedValue({ account: { ready: false, status: "restricted" } });
    const entries = [
      documentEntry(DOC_ID, { ownerPayoutAccountReady: true,
        owner_attention_required: false, owner_decision_available: false }),
      documentEntry("33333333-3333-4333-8333-333333333333", {
        ownerPayoutAccountReady: false, owner_attention_required: false, owner_decision_available: false,
      }),
    ];
    const { result } = renderWith(...entries);
    await waitFor(() => expect(result.current.actionables.find((row) => row.id === "drive-payout-setup"))
      .toMatchObject({ title: "Set up US payouts" }));
    expect(result.current.actionables.filter((row) => row.id === "drive-payout-setup")).toHaveLength(1);
    expect(mocks.account).toHaveBeenCalledExactlyOnceWith("vault-token");
    await act(async () => result.current.actionables.find((row) => row.id === "drive-payout-setup")!.actions[0].run());
    expect(mocks.push).toHaveBeenCalledWith("/one/profile/my-data");
  });

  it("hides a stale setup hint when Stripe says the account is ready", async () => {
    mocks.account.mockResolvedValue({ account: { ready: true, status: "ready" } });
    const { result } = renderWith(documentEntry(DOC_ID, { ownerPayoutAccountReady: false }));
    await waitFor(() => expect(mocks.account).toHaveBeenCalledExactlyOnceWith("vault-token"));
    expect(result.current.actionables.find((row) => row.id === "drive-payout-setup")).toBeUndefined();
  });

  it("keeps legacy requests out of Connect setup discovery", () => {
    const { result } = renderWith(documentEntry(DOC_ID));
    expect(result.current.actionables.find((row) => row.id === "drive-payout-setup")).toBeUndefined();
    expect(mocks.account).not.toHaveBeenCalled();
  });
});
