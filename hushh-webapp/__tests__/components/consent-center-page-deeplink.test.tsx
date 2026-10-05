import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ConsentCenterPage } from "@/components/consent/consent-center-page";
import { usePublishVoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  getIdToken: vi.fn().mockResolvedValue("id-token"),
  getVaultOwnerToken: vi.fn(() => "vault-token"),
  isVaultUnlocked: true,
  vaultKey: null as string | null,
  toastShow: vi.fn(),
  toastDismiss: vi.fn(),
  search:
    "tab=pending&requestId=req_deep&from=%2Fone%2Fconnected-systems%2Fsalesforce-fsc-customer0",
  getSummary: vi.fn(),
  getCenter: vi.fn(),
  listEntries: vi.fn(),
  listConnectionsPage: vi.fn(),
  lookupPendingRequests: vi.fn(),
  handleApprove: vi.fn(),
  handleDeny: vi.fn(),
  handleRevoke: vi.fn(),
  handleLocationApprove: vi.fn(),
  handleLocationDeny: vi.fn(),
  handleLocationRevoke: vi.fn(),
  connectionAccept: vi.fn(),
  connectionReject: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  handleApproveBundle: vi.fn(),
  handleDenyBundle: vi.fn(),
  handleDecideBundle: vi.fn(),
  consentActionOptions: null as null | {
    onActionComplete?: (detail: {
      action: "approve" | "deny" | "revoke";
      requestId?: string;
      scope?: string;
      source: "consent_actions";
    }) => void;
  },
  sharePreviewState: { status: "idle" } as Record<string, unknown>,
  busyRequestIds: new Set<string>(),
  cacheSubscribers: new Set<
    (event: { type: string; key?: string; keys?: string[] }) => void
  >(),

  busyScopes: new Set<string>(),
  activeAction: null as null | {
    key: string;
    kind: "approve" | "deny" | "revoke";
    requestId?: string;
    scope?: string;
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace }),
  usePathname: () => "/consents",
  useSearchParams: () => new URLSearchParams(mocks.search),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { uid: "user-1", getIdToken: mocks.getIdToken },
    loading: false,
  }),
}));

vi.mock("@/components/consent/document-share-review", () => ({
  DocumentShareReview: ({ requestId }: { requestId: string }) => <div data-testid="private-document-review">{requestId}</div>,
}));

vi.mock("@/components/consent/drive-query-request-card", () => ({
  DriveQueryRequestCard: ({ requestId, direction }: { requestId: string; direction?: string }) => (
    <div data-testid="drive-query-card" data-direction={direction ?? ""}>{requestId}</div>
  ),
}));

// CapabilityExploreCard reads useAuth from the firebase context directly, not
// via the @/hooks/use-auth re-export, so it needs its own stub here.
vi.mock("@/lib/firebase/auth-context", () => ({
  useAuth: () => ({
    user: { uid: "user-1", getIdToken: mocks.getIdToken },
    loading: false,
  }),
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({
    getVaultOwnerToken: mocks.getVaultOwnerToken,
    isVaultUnlocked: mocks.isVaultUnlocked,
    vaultKey: mocks.vaultKey,
  }),
}));

// The unlock step is the whole vault ceremony; these tests only need to see
// that it opened, and to close it.
vi.mock("@/components/consent/owner-consent-unlock-prompt", () => ({
  OwnerConsentUnlockPrompt: ({
    prompt,
  }: {
    prompt: { open: boolean; title: string; cancel: () => void };
  }) =>
    prompt.open ? (
      <div role="alertdialog" aria-label={prompt.title}>
        <button type="button" onClick={prompt.cancel}>
          Not now
        </button>
      </div>
    ) : null,
}));

vi.mock("@/lib/one-marketplace/delivery-sweep", () => ({
  runMarketplaceDeliverySweep: vi.fn().mockResolvedValue({ delivered: 0 }),
}));

vi.mock("@/lib/services/connections-service", () => ({
  ConnectionsService: {
    accept: mocks.connectionAccept,
    reject: mocks.connectionReject,
    listConnectionsPage: mocks.listConnectionsPage,
  },
}));

vi.mock("sonner", () => ({
  toast: Object.assign(mocks.toastShow, {
    error: mocks.toastError,
    success: mocks.toastSuccess,
    dismiss: mocks.toastDismiss,
  }),
}));

// The on-device preview decrypts the owner's memory; these tests only need
// to control what it reports.
vi.mock("@/lib/consent/consent-share-preview", () => ({
  useConsentSharePreview: () => mocks.sharePreviewState,
}));

vi.mock("@/lib/consent", () => ({
  useConsentActions: (options: typeof mocks.consentActionOptions) => {
    mocks.consentActionOptions = options;
    return {
    handleApprove: mocks.handleApprove,
    handleApproveBundle: mocks.handleApproveBundle,
    handleDecideBundle: mocks.handleDecideBundle,
    handleDeny: mocks.handleDeny,
    handleDenyBundle: mocks.handleDenyBundle,
    handleRevoke: mocks.handleRevoke,
    activeAction: mocks.activeAction,
    activeActions: mocks.activeAction ? [mocks.activeAction] : [],
    isRequestBusy: (requestId?: string | null) =>
      mocks.busyRequestIds.has(String(requestId || "")),
    isScopeBusy: (scope?: string | null) =>
      mocks.busyScopes.has(String(scope || "")),
    };
  },
  // One Location rows route through a dedicated hook; non-location consents
  // never touch it, so a no-op mock is enough for these deep-link tests.
  useOneLocationConsentActions: () => ({
    handleApprove: mocks.handleLocationApprove,
    handleDeny: mocks.handleLocationDeny,
    handleRevoke: mocks.handleLocationRevoke,
    activeAction: null,
    activeActions: [],
    isRequestBusy: () => false,
    isScopeBusy: () => false,
  }),
  // Marketplace rows also route through a dedicated hook; no-op for these tests.
  useMarketplaceConsentActions: () => ({
    handleApprove: vi.fn(),
    handleDeny: vi.fn(),
    handleRevoke: vi.fn(),
    activeAction: null,
    activeActions: [],
    isRequestBusy: () => false,
    isScopeBusy: () => false,
  }),
}));

vi.mock("@/lib/voice/voice-surface-metadata", () => ({
  usePublishVoiceSurfaceMetadata: vi.fn(),
  useVoiceSurfaceControlTracking: () => ({
    activeControlId: null,
    lastInteractedControlId: null,
  }),
}));

vi.mock("@/lib/cache/request-audit-log", () => ({
  logRequestAudit: vi.fn(),
}));

vi.mock("@/lib/services/cache-service", () => ({
  CacheService: {
    getInstance: () => ({
      peek: vi.fn(() => null),
      subscribe: vi.fn(
        (
          subscriber: (event: {
            type: string;
            key?: string;
            keys?: string[];
          }) => void,
        ) => {
          mocks.cacheSubscribers.add(subscriber);
          return () => mocks.cacheSubscribers.delete(subscriber);
        },
      ),
    }),
  },
  CACHE_KEYS: {
    CONSENT_CENTER_LIST: (...parts: unknown[]) => `list:${parts.join(":")}`,
    CONSENT_CENTER_SUMMARY: (...parts: unknown[]) =>
      `summary:${parts.join(":")}`,
    CONSENT_CENTER: (...parts: unknown[]) => `center:${parts.join(":")}`,
  },
  // Imported transitively (personal-knowledge-model-service reads CACHE_TTL at
  // module init); the mock must export it or the whole import graph fails.
  CACHE_TTL: { SHORT: 30_000, MEDIUM: 300_000, LONG: 3_600_000 },
}));

vi.mock("@/lib/services/consent-center-service", () => ({
  CONSENT_CENTER_PAGE_SIZE: 20,
  ConsentCenterService: {
    getSummary: mocks.getSummary,
    getCenter: mocks.getCenter,
    listEntries: mocks.listEntries,
    lookupPendingRequests: mocks.lookupPendingRequests,
    // Only ever called by HandshakeTimeline, which must NOT render for
    // active_grant entries (see the "does not render a Consent timeline"
    // regression test below). Left unmocked-but-present so an accidental
    // regression that renders it fails loudly instead of throwing on an
    // undefined method.
    getHandshakeHistory: vi.fn().mockResolvedValue({ timeline: [] }),
  },
}));

function installDesktopMediaQuery() {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 1024,
  });
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

function installMobileMediaQuery() {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 390,
  });
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query.includes("max-width"),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

function summaryResponse() {
  return {
    user_id: "user-1",
    actor: "investor",
    mode: "consents",
    counts: { pending: 1, active: 0, previous: 0 },
  };
}

function emptyListResponse() {
  return {
    user_id: "user-1",
    actor: "investor",
    mode: "consents",
    surface: "pending",
    query: "",
    page: 1,
    limit: 20,
    total: 0,
    has_more: false,
    items: [],
  };
}

function pendingListResponse(entry: Record<string, unknown>) {
  return {
    ...emptyListResponse(),
    total: 1,
    items: [entry],
  };
}

/** Kushal's dinner request, as the pending list sends it today. */
function foodRequestEntry() {
  const now = Date.now();
  const decisionDeadline = new Date(now);
  decisionDeadline.setDate(decisionDeadline.getDate() + 7);

  return {
    id: "req_food",
    request_id: "req_food",
    kind: "incoming_request",
    status: "pending",
    action: "REQUESTED",
    allowed_next_action: "review_request",
    scope: "attr.food.preferences.*",
    scope_description: "Preferences",
    counterpart_type: "person",
    counterpart_id: "user-kushal",
    counterpart_label: "Kushal Trivedi",
    counterpart_email: "kushal@example.com",
    reason: "Picking a place for our dinner together",
    // Numeric epoch string, exactly as the pending list serialises it.
    issued_at: String(now - 60_000),
    // Keep the deadline outside the current day: `formatDecideBy` deliberately
    // says "Today" for a same-day deadline.
    approval_timeout_at: decisionDeadline.getTime(),
    metadata: { expiry_hours: 168 },
  };
}

function expectInHiddenSwipePanel(text: string) {
  const panel = screen.getByText(text).closest('[role="tabpanel"]');
  expect(panel?.getAttribute("aria-hidden")).toBe("true");
}

function groupedHistoryListResponse() {
  return {
    user_id: "user-1",
    actor: "investor",
    mode: "consents",
    surface: "previous",
    query: "",
    page: 1,
    limit: 20,
    total: 1,
    has_more: false,
    items: [
      {
        id: "identifier:macy",
        kind: "history",
        status: "approved",
        action: "CONSENT_GRANTED",
        counterpart_type: "developer",
        counterpart_label: "Macy's CRM",
        issued_at: "2026-06-18T17:30:00.000Z",
        trail_count: 2,
        event_count: 3,
        consent_trails: [
          {
            id: "trail_profile",
            scope: "attr.shopping.profile.*",
            scope_description: "Shopping profile",
            status: "approved",
            action: "CONSENT_GRANTED",
            issued_at: "2026-06-18T17:30:00.000Z",
            latest_request_id: "req_profile",
            event_count: 2,
            events: [
              {
                id: "event_grant",
                request_id: "req_profile",
                status: "approved",
                action: "CONSENT_GRANTED",
                scope_description: "Shopping profile",
                issued_at: "2026-06-18T17:30:00.000Z",
              },
              {
                id: "event_request",
                request_id: "req_profile",
                status: "pending",
                action: "REQUESTED",
                scope_description: "Shopping profile",
                issued_at: "2026-06-18T17:00:00.000Z",
              },
            ],
          },
          {
            id: "trail_receipts",
            scope: "attr.shopping.receipts.*",
            scope_description: "Receipts",
            status: "revoked",
            action: "REVOKED",
            issued_at: "2026-06-17T12:00:00.000Z",
            latest_request_id: "req_receipts",
            event_count: 1,
            events: [
              {
                id: "event_revoke",
                request_id: "req_receipts",
                status: "revoked",
                action: "REVOKED",
                scope_description: "Receipts",
                issued_at: "2026-06-17T12:00:00.000Z",
              },
            ],
          },
        ],
      },
    ],
  };
}

describe("ConsentCenterPage requestId deep links", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.search =
      "tab=pending&requestId=req_deep&from=%2Fone%2Fconnected-systems%2Fsalesforce-fsc-customer0";
    mocks.getVaultOwnerToken.mockImplementation(() => "vault-token");
    mocks.isVaultUnlocked = true;
    mocks.vaultKey = null;
    mocks.getSummary.mockResolvedValue(summaryResponse());
    mocks.getCenter.mockResolvedValue({ connection_requests: [] });
    mocks.listConnectionsPage.mockResolvedValue({
      items: [], page: 1, hasMore: false, totalCount: 0, audience: "all",
    });
    mocks.listEntries.mockResolvedValue(emptyListResponse());
    mocks.handleApprove.mockResolvedValue(undefined);
    mocks.handleDeny.mockResolvedValue(undefined);
    mocks.handleRevoke.mockResolvedValue(undefined);
    mocks.sharePreviewState = { status: "idle" };
    mocks.handleApproveBundle.mockResolvedValue(undefined);
    mocks.handleDenyBundle.mockResolvedValue(undefined);
    mocks.handleDecideBundle.mockResolvedValue(undefined);
    mocks.connectionAccept.mockResolvedValue(undefined);
    mocks.connectionReject.mockResolvedValue(undefined);
    mocks.busyRequestIds = new Set();
    mocks.busyScopes = new Set();
    mocks.cacheSubscribers.clear();
    mocks.activeAction = null;
    mocks.lookupPendingRequests.mockResolvedValue({
      items: [
        {
          request_id: "req_deep",
          requester_label: "Macy's CRM",
          scope: "attr.shopping.receipts_memory.*",
          scope_description: "Shopping receipts",
          reason: "Review requested from connected systems.",
          poll_timeout_at: Date.now() + 60_000,
        },
      ],
      missing_request_ids: [],
    });
    installDesktopMediaQuery();
  });

  it("shows active people and their first connection date, not resolved request logs", async () => {
    mocks.search = "tab=connections&requestId=connection-active-1";
    mocks.getCenter.mockResolvedValue({
      connection_requests: [{
        id: "old-request-1",
        kind: "connection_request",
        status: "revoked",
        action: "REVOKED",
        counterpart_type: "person",
        counterpart_label: "Former contact",
      }],
    });
    mocks.listConnectionsPage.mockResolvedValue({
      items: [{
        connectionId: "connection-active-1",
        userId: "other-owner",
        displayName: "Current contact",
        photoUrl: null,
        email: null,
        createdAt: "2026-09-22T09:00:00.000Z",
      }],
      page: 1,
      hasMore: false,
      totalCount: 1,
      audience: "all",
    });

    render(<ConsentCenterPage />);

    expect(await screen.findByRole("dialog", { name: "Current contact" })).toBeTruthy();
    expect(screen.queryByText("Former contact")).toBeNull();
    expect(screen.getAllByText("First connected").length).toBeGreaterThan(0);
    expect(mocks.listConnectionsPage).toHaveBeenCalledWith({
      idToken: "id-token",
      page: 1,
      limit: 20,
      query: "",
      audience: "all",
    });
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
  });

  it("does not call an unavailable connection graph an empty list", async () => {
    mocks.search = "tab=connections";
    mocks.listConnectionsPage.mockRejectedValue(new Error("provider detail must stay private"));

    render(<ConsentCenterPage />);

    expect(await screen.findByText("Could not check connections")).toBeTruthy();
    expect(mocks.getCenter).not.toHaveBeenCalled();
    expect(screen.queryByText("No connections yet.")).toBeNull();
    expect(screen.queryByText(/provider detail must stay private/)).toBeNull();
  });

  it("opens a twelve-item person bundle's sheet straight from its row, with no Review expansion", async () => {
    mocks.search = "tab=pending&bundleId=bundle-professional";
    const pendingItems = Array.from({ length: 12 }, (_, index) => ({
      request_id: `request-${index + 1}`,
      label: `Professional detail ${index + 1}`,
      status: index === 0 ? "granted" : index === 1 ? "denied" : "pending",
      entry:
        index < 2
          ? null
          : {
              id: `request-${index + 1}`,
              request_id: `request-${index + 1}`,
              kind: "incoming_request",
              status: "pending",
              action: "REQUESTED",
              allowed_next_action: "review_request",
              scope: `attr.professional.detail_${index + 1}`,
              scope_description: `Professional detail ${index + 1}`,
              counterpart_type: "person",
              counterpart_label: "A member",
              metadata: { bundle_id: "bundle-professional", expiry_hours: 24 },
            },
    }));
    mocks.listEntries.mockResolvedValue(
      pendingListResponse({
        id: "bundle:bundle-professional",
        bundle_id: "bundle-professional",
        bundle_complete: true,
        bundle_items: pendingItems,
        kind: "incoming_request",
        status: "pending",
        action: "REQUESTED",
        counterpart_type: "person",
        counterpart_label: "A member",
        scope_description: "12 information items",
        metadata: { bundle_id: "bundle-professional" },
      }),
    );

    const { rerender } = render(<ConsentCenterPage />);

    expect(await screen.findByTestId("consent-bundle-row")).toBeTruthy();
    // One row names the request; nothing is listed or expanded under it.
    const row = screen.getByRole("button", {
      name: "A member, Professional detail 3 and 9 more, review",
    });
    expect(screen.queryAllByTestId("consent-entry-row")).toHaveLength(0);
    expect(screen.queryAllByTestId("consent-bundle-item")).toHaveLength(0);
    expect(screen.queryByText("Review")).toBeNull();
    expect(screen.queryByRole("dialog", { name: "A member" })).toBeNull();

    // Negative control: the old row expanded in place on this tap (a nested
    // list with a "Review" per item) and navigated nowhere.
    fireEvent.click(row);
    expect(screen.queryAllByTestId("consent-bundle-item")).toHaveLength(0);
    expect(screen.queryByText("Review")).toBeNull();
    expect(mocks.replace).toHaveBeenCalledWith(
      expect.stringContaining("requestId=request-3"),
      { scroll: false },
    );
    mocks.search =
      "tab=pending&bundleId=bundle-professional&requestId=request-3";
    rerender(<ConsentCenterPage />);
    expect(
      await screen.findByRole("dialog", { name: "A member" }),
    ).toBeTruthy();
    // The sheet decides the whole request: every item still waiting, named
    // and counted, not only the one that was tapped, each one choosable.
    expect(screen.getByText("Access · 10 items")).toBeTruthy();
    const choice = screen.getByTestId("consent-bundle-choice");
    expect(within(choice).getAllByRole("checkbox")).toHaveLength(10);
    expect(within(choice).getByRole("checkbox", { name: "Professional detail 12" })).toBeChecked();
    expect(within(choice).queryByRole("checkbox", { name: "Professional detail 1" })).toBeNull();
    expect(screen.getByRole("button", { name: "Allow" })).toBeEnabled();
  });

  // Localhost run 4 (R5): no owner surface could approve part of a request.
  it("allows only the chosen items of a request and declines the rest", async () => {
    const member = (id: string, label: string, scope: string) => ({
      id, request_id: id, kind: "incoming_request", status: "pending", action: "REQUESTED",
      allowed_next_action: "review_request", scope, scope_description: label,
      counterpart_type: "person", counterpart_label: "Kushal Trivedi",
      metadata: { bundle_id: "bundle-mixed", expiry_hours: 168 },
    });
    mocks.search = "tab=pending&bundleId=bundle-mixed&requestId=request-food";
    mocks.listEntries.mockResolvedValue(pendingListResponse({
      id: "bundle:bundle-mixed", bundle_id: "bundle-mixed", bundle_complete: true,
      bundle_items: [
        { request_id: "request-food", label: "Food preferences", status: "pending", entry: member("request-food", "Food preferences", "attr.food.preferences.*") },
        { request_id: "request-events", label: "Events", status: "pending", entry: member("request-events", "Events", "attr.financial.events.*") },
      ],
      kind: "incoming_request", status: "pending", action: "REQUESTED", counterpart_type: "person",
      counterpart_label: "Kushal Trivedi", metadata: { bundle_id: "bundle-mixed" },
    }));
    render(<ConsentCenterPage />);
    const dialog = await screen.findByRole("dialog", { name: "Kushal Trivedi" });
    expect(within(dialog).getAllByRole("checkbox")).toHaveLength(2);

    fireEvent.click(screen.getByRole("checkbox", { name: "Financial events" }));
    expect(screen.getByText("Access · 1 of 2 items")).toBeTruthy();
    expect(screen.getByTestId("consent-bundle-choice-summary"))
      .toHaveTextContent("Only Food preferences will be shared. Financial events won't be.");
    fireEvent.click(screen.getByRole("button", { name: "Allow 1 of 2" }));

    await waitFor(() => expect(mocks.handleDecideBundle).toHaveBeenCalledTimes(1));
    const [allow, decline, options] = mocks.handleDecideBundle.mock.calls[0]!;
    expect(allow.map((consent: { id: string }) => consent.id)).toEqual(["request-food"]);
    expect(decline).toEqual(["request-events"]);
    expect(options).toMatchObject({ bundleId: "bundle-mixed" });
    // Negative control: a partial choice never becomes a whole Allow or a whole decline.
    expect(mocks.handleApproveBundle).not.toHaveBeenCalled();
    expect(mocks.handleDenyBundle).not.toHaveBeenCalled();
  });

  it("routes a cold document link only to its private review, never generic consent or voice decisions", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    mocks.search = `tab=pending&requestId=document_share_request%3A${id}&notificationAction=approve`;
    render(<ConsentCenterPage />);
    expect(await screen.findByTestId("private-document-review")).toHaveTextContent(id);
    expect(mocks.lookupPendingRequests).not.toHaveBeenCalled();
    expect(mocks.handleApprove).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
    const metadata = vi.mocked(usePublishVoiceSurfaceMetadata).mock.lastCall?.[0];
    expect(JSON.stringify(metadata)).not.toContain("consent_approve");
  });

  it("does not send malformed document links through generic pending lookup", async () => {
    mocks.search = "tab=pending&requestId=document_share_request%3Ainvalid";
    render(<ConsentCenterPage />);
    expect(await screen.findByText("Invalid document request")).toBeVisible();
    expect(mocks.lookupPendingRequests).not.toHaveBeenCalled();
    expect(screen.queryByTestId("private-document-review")).toBeNull();
  });

  it("routes a cold Drive question link only to its own card, never generic consent or voice decisions", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    mocks.search = `tab=pending&requestId=drive_query_request%3A${id}&notificationAction=approve`;
    render(<ConsentCenterPage />);
    expect(await screen.findByTestId("drive-query-card")).toHaveTextContent(id);
    expect(screen.getByRole("dialog", { name: "Drive question" })).toBeVisible();
    expect(screen.queryByTestId("private-document-review")).toBeNull();
    expect(mocks.lookupPendingRequests).not.toHaveBeenCalled();
    expect(mocks.handleApprove).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
    expect(screen.queryByText(/Allow was selected in the notification/)).toBeNull();
    const metadata = vi.mocked(usePublishVoiceSurfaceMetadata).mock.lastCall?.[0];
    expect(JSON.stringify(metadata)).not.toContain("consent_approve");
  });

  it("does not send malformed Drive question links through generic pending lookup", async () => {
    mocks.search = "tab=pending&requestId=drive_query_request%3Ainvalid";
    render(<ConsentCenterPage />);
    expect(await screen.findByText("Invalid Drive question")).toBeVisible();
    expect(mocks.lookupPendingRequests).not.toHaveBeenCalled();
    expect(screen.queryByTestId("drive-query-card")).toBeNull();
  });

  it("opens an incoming Drive question row in its own card with no generic Allow or Don't allow", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const entry = {
      id: `drive_query_request:${id}`,
      request_id: id,
      kind: "incoming_request",
      status: "pending",
      action: "DRIVE_QUERY_REVIEW",
      scope: null,
      scope_description: "Google Drive question",
      counterpart_type: "investor",
      counterpart_id: null,
      counterpart_label: "Drive question",
      issued_at: 1_790_000_000_000,
      metadata: {
        request_source: "drive_live_query_request",
        request_id: id,
        direction: "incoming",
        state: "pending",
        revision: 1,
        recorded_outcome_only: true,
      },
    };
    mocks.search = "tab=pending";
    mocks.listEntries.mockResolvedValue(pendingListResponse(entry));
    const { rerender } = render(<ConsentCenterPage />);
    fireEvent.click(await screen.findByText("Google Drive question"));
    expect(mocks.replace).toHaveBeenCalledWith(
      expect.stringContaining(`requestId=drive_query_request%3A${id}`),
      { scroll: false },
    );
    mocks.search = `tab=pending&requestId=drive_query_request%3A${id}`;
    rerender(<ConsentCenterPage />);
    const card = await screen.findByTestId("drive-query-card");
    expect(card).toHaveTextContent(id);
    expect(card).toHaveAttribute("data-direction", "incoming");
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Don't allow" })).toBeNull();
    expect(mocks.lookupPendingRequests).not.toHaveBeenCalled();
    expect(mocks.handleApprove).not.toHaveBeenCalled();
    expect(mocks.handleDeny).not.toHaveBeenCalled();
    const metadata = vi.mocked(usePublishVoiceSurfaceMetadata).mock.lastCall?.[0];
    expect(JSON.stringify(metadata)).not.toContain("consent_approve");
    expect(JSON.stringify(metadata)).not.toContain("consent_deny");
  });

  it("rediscovers sent requests in their own projection and preserves that view when closing detail", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    mocks.search = `tab=pending&requestView=sent&requestId=document_share_request%3A${id}`;
    render(<ConsentCenterPage />);
    await waitFor(() => expect(mocks.listEntries).toHaveBeenCalledWith(expect.objectContaining({ surface: "pending", requestView: "sent" })));
    expect(mocks.lookupPendingRequests).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(mocks.replace).toHaveBeenCalled());
    expect(await screen.findByRole("button", { name: "Sent documents" })).toHaveAttribute("aria-pressed", "true");
    expect(mocks.replace.mock.lastCall?.[0]).toContain("requestView=sent");
    expect(mocks.replace.mock.lastCall?.[0]).not.toContain("requestId=");
    fireEvent.click(screen.getByRole("button", { name: "Received" }));
    expect(mocks.replace.mock.lastCall?.[0]).not.toContain("requestView=sent");
  });

  it("keeps Northstar's material decision terms once without duplicate controls", async () => {
    mocks.search = "tab=requests&requestId=northstar-scope-upgrade";
    mocks.listEntries.mockResolvedValue(
      pendingListResponse({
        id: "northstar-scope-upgrade",
        request_id: "northstar-scope-upgrade",
        kind: "incoming_request",
        status: "pending",
        allowed_next_action: "review_request",
        action: "REQUESTED",
        scope: "attr.financial.portfolio.*",
        scope_description: "Portfolio positions and allocation",
        counterpart_type: "developer",
        counterpart_id: "northstar-planning",
        counterpart_label: "Northstar Planning",
        counterpart_email: "access@northstar.example",
        issued_at: "2026-07-24T09:00:00.000Z",
        expires_at: "2026-07-26T09:00:00.000Z",
        approval_timeout_at: "2026-07-26T09:00:00.000Z",
        reason:
          "Prepare a consolidated allocation review before your next meeting.",
        is_scope_upgrade: true,
        additional_access_summary:
          "Adds portfolio positions to the financial profile access already approved.",
        metadata: {
          expiry_hours: 48,
          refresh_policy: "continuous_until_expiry",
        },
      }),
    );

    render(<ConsentCenterPage />);

    expect(
      await screen.findByRole(
        "dialog",
        { name: "Northstar Planning" },
        { timeout: 5_000 },
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Allow" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Don't allow" })).toBeTruthy();
    expect(screen.queryByText("For")).toBeNull();
    expect(screen.queryByText("Future updates")).toBeNull();
    expect(
      screen.queryByText("Includes approved updates until access ends."),
    ).toBeNull();
    expect(
      screen.queryByText(
        "Requested for 2 days. You can choose a shorter window.",
      ),
    ).toBeNull();

    fireEvent.click(screen.getByRole("combobox", { name: "Access duration" }));
    expect(
      // One duration wording everywhere: the requester's form says "1 day".
      await screen.findByRole("option", { name: "1 day" }),
    ).toBeTruthy();
    expect(screen.getByRole("option", { name: "2 days" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "7 days" })).toBeNull();
  });

  it("renders a fixed 24-hour request without a one-option selector and preserves its approval duration", async () => {
    mocks.search = "tab=requests&requestId=fixed-24";
    mocks.listEntries.mockResolvedValue(
      pendingListResponse({
        id: "fixed-24",
        request_id: "fixed-24",
        kind: "incoming_request",
        status: "pending",
        action: "REQUESTED",
        scope: "attr.financial.documents.*",
        scope_description: "Verification documents",
        counterpart_type: "developer",
        counterpart_id: "one",
        counterpart_label: "One",
        issued_at: "2026-07-24T09:00:00.000Z",
        request_url: "/one/kyc?workflowId=fixed-24",
        metadata: {
          request_source: "one_email_kyc_v1",
          workflow_id: "fixed-24",
          gmail_thread_id: "thread-fixed-24",
          expiry_hours: 24,
        },
      }),
    );

    render(<ConsentCenterPage />);

    expect(await screen.findByText("For")).toBeTruthy();
    expect(screen.getAllByText("1 day")).toHaveLength(1);
    expect(
      screen.queryByText(
        "Shares a one-time copy; later changes are not included.",
      ),
    ).toBeNull();
    expect(
      screen.queryByRole("combobox", { name: "Access duration" }),
    ).toBeNull();
    expect(screen.getAllByRole("link", { name: "Open Mail" })).toHaveLength(1);
    expect(screen.queryByText("Original request")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    await waitFor(() => {
      expect(mocks.handleApprove).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "fixed-24",
          durationHours: 24,
        }),
      );
    });
  });

  it("does not invent duration or update controls for a request without those terms", async () => {
    mocks.search = "tab=requests&requestId=agent-task";
    mocks.listEntries.mockResolvedValue(
      pendingListResponse({
        id: "agent-task",
        request_id: "agent-task",
        kind: "incoming_request",
        status: "pending",
        action: "REQUESTED",
        scope: "cap.one.invoke",
        scope_description: "Invoke the private agent for this task",
        counterpart_type: "developer",
        counterpart_id: "travel-agent",
        counterpart_label: "Travel Agent",
        issued_at: "2026-07-24T09:00:00.000Z",
        metadata: { request_source: "legacy_agent_task" },
      }),
    );

    render(<ConsentCenterPage />);

    expect(
      await screen.findByRole("dialog", { name: "Travel Agent" }),
    ).toBeTruthy();
    expect(screen.queryByText("For")).toBeNull();
    expect(
      screen.queryByRole("combobox", { name: "Access duration" }),
    ).toBeNull();
    expect(screen.queryByText(/one-time copy/i)).toBeNull();
    expect(screen.queryByText(/future updates/i)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    await waitFor(() => {
      expect(mocks.handleApprove).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "agent-task",
          durationHours: undefined,
        }),
      );
    });
  });

  it("shows no decision CTAs while a request is awaiting the other party", async () => {
    mocks.search = "tab=requests&requestId=awaiting-party";
    mocks.listEntries.mockResolvedValue(
      pendingListResponse({
        id: "awaiting-party",
        request_id: "awaiting-party",
        kind: "incoming_request",
        status: "request_pending",
        allowed_next_action: "await_decision",
        action: "REQUESTED",
        scope: "attr.financial.profile.*",
        scope_description: "Financial profile",
        counterpart_type: "ria",
        counterpart_id: "ria-awaiting",
        counterpart_label: "Awaiting Advisor",
        issued_at: "2026-07-24T09:00:00.000Z",
      }),
    );

    render(<ConsentCenterPage />);

    expect(
      await screen.findByRole("dialog", { name: "Awaiting Advisor" }),
    ).toBeTruthy();
    expect(screen.queryByText("Your decision")).toBeNull();
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Don't allow" })).toBeNull();
  });

  it("resolves a selected pending request that is not present in the current list page", async () => {
    render(<ConsentCenterPage />);

    await waitFor(() => {
      expect(mocks.lookupPendingRequests).toHaveBeenCalledWith({
        vaultOwnerToken: "vault-token",
        userId: "user-1",
        requestIds: ["req_deep"],
      });
    });

    expect(
      await screen.findByRole("dialog", { name: "Macy's CRM" }),
    ).toBeTruthy();
    // Named from the item key, the same rule the Active row uses, so the
    // request and the access it becomes carry one name.
    expect(screen.getByText("Shopping receipts memory")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Allow" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Don't allow" })).toBeTruthy();
    expect(screen.getByText("Contact")).toBeTruthy();
    expect(screen.queryByText("Request details")).toBeNull();
    expect(screen.getByLabelText("Close detail panel")).toBeTruthy();
    expect(screen.queryByText("Technical details")).toBeNull();
  });

  it("offers a close control on the mobile decision sheet", async () => {
    installMobileMediaQuery();
    render(<ConsentCenterPage />);

    expect(
      await screen.findByRole("dialog", { name: "Macy's CRM" }),
    ).toBeTruthy();
    await waitFor(() => {
      expect(
        document.querySelector('[data-slot="sheet-content"]'),
      ).toBeTruthy();
      expect(
        document.querySelector('[data-slot="sheet-drag-handle"]'),
      ).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(mocks.handleApprove).not.toHaveBeenCalled();
    expect(mocks.handleDeny).not.toHaveBeenCalled();
  });

  it("uses connection actions without showing an ignored access duration", async () => {
    mocks.search = "tab=pending&requestId=connection-1";
    mocks.listEntries.mockResolvedValue({
      ...emptyListResponse(),
      total: 1,
      items: [
        {
          id: "connection-1",
          request_id: "connection-1",
          kind: "connection_request",
          status: "pending",
          action: "connection_request",
          scope: "cap.connections.trusted",
          scope_description: "Trusted connection",
          counterpart_type: "investor",
          counterpart_id: "user-rohan",
          counterpart_label: "Rohan",
          issued_at: "2026-07-24T09:00:00.000Z",
          reason: "Rohan wants to connect with you.",
          metadata: { request_source: "connection_request" },
        },
      ],
    });

    render(<ConsentCenterPage />);

    await screen.findByText("Relationship");
    expect(screen.queryByText("Connection request")).toBeNull();
    expect(screen.getByText("Relationship")).toBeTruthy();
    expect(screen.getAllByText("Trusted connection").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Accept" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Decline" })).toBeTruthy();
    expect(screen.queryByText("Access duration")).toBeNull();
    expect(screen.queryByText("For")).toBeNull();
    expect(screen.queryByText("Ends")).toBeNull();
  });

  it.each([
    {
      action: "Accept",
      errorMessage: "Could not accept the connection request. Try again.",
      mutate: mocks.connectionAccept,
    },
    {
      action: "Decline",
      errorMessage: "Could not decline the connection request. Try again.",
      mutate: mocks.connectionReject,
    },
  ])(
    "surfaces a failed $action connection decision",
    async ({ action, errorMessage, mutate }) => {
      mocks.search = "tab=pending&requestId=connection-1";
      mocks.listEntries.mockResolvedValue({
        ...emptyListResponse(),
        total: 1,
        items: [
          {
            id: "connection-1",
            request_id: "connection-1",
            kind: "connection_request",
            status: "pending",
            action: "connection_request",
            scope: "cap.connections.trusted",
            scope_description: "Trusted connection",
            counterpart_type: "investor",
            counterpart_id: "user-rohan",
            counterpart_label: "Rohan",
            issued_at: "2026-07-24T09:00:00.000Z",
            reason: "Rohan wants to connect with you.",
            metadata: { request_source: "connection_request" },
          },
        ],
      });
      mutate.mockRejectedValueOnce(new Error("network unavailable"));
      installMobileMediaQuery();

      render(<ConsentCenterPage />);

      const decisionButton = await screen.findByRole("button", {
        name: action,
      });
      fireEvent.click(decisionButton);
      if (action === "Decline") {
        // Decline is irreversible: the first tap only arms it.
        expect(mutate).not.toHaveBeenCalled();
        expect(decisionButton).toHaveTextContent("Sure?");
        fireEvent.click(
          screen.getByRole("button", { name: "Confirm Decline" }),
        );
      }

      await waitFor(() =>
        expect(mocks.toastError).toHaveBeenCalledWith(errorMessage),
      );
      expect(mutate).toHaveBeenCalledWith(
        expect.objectContaining({ requestId: "connection-1" }),
      );
    },
  );

  it("shows marketplace requested duration as read-only request context", async () => {
    mocks.search = "tab=pending&requestId=marketplace-1";
    mocks.listEntries.mockResolvedValue({
      ...emptyListResponse(),
      total: 1,
      items: [
        {
          id: "marketplace_request:marketplace-1",
          request_id: "marketplace-1",
          kind: "incoming_request",
          status: "pending",
          action: "REQUESTED",
          scope: "attr.travel.preferences.*",
          scope_description: "Travel preference summary",
          counterpart_type: "investor",
          counterpart_id: "atlas",
          counterpart_label: "Atlas Travel",
          issued_at: "2026-07-24T09:00:00.000Z",
          approval_timeout_at: "2026-07-27T09:00:00.000Z",
          metadata: {
            request_source: "marketplace_access_request",
            duration_days: 3,
          },
        },
      ],
    });

    render(<ConsentCenterPage />);

    expect(await screen.findByText("For")).toBeTruthy();
    expect(screen.getAllByText("3 days").length).toBeGreaterThan(0);
    expect(screen.getByText("Decide by")).toBeTruthy();
    expect(screen.queryByText("Access duration")).toBeNull();
  });

  it("closing the detail panel preserves the active tab instead of reverting to pending", async () => {
    // Regression test: closeDetailPanel used to be memoized with an empty
    // dependency array, permanently capturing the setParam/searchParams
    // snapshot from the FIRST render (mounted on tab=pending). Once the user
    // navigated to a different tab (a later render with fresh searchParams),
    // the frozen closeDetailPanel kept calling the stale, pending-tab-bound
    // setParam, silently reverting tab=history back to tab=pending on close.
    // Reproduce by mounting on pending, then re-rendering as the URL would
    // after a real tab switch (Next.js gives fresh searchParams on
    // navigation), then closing the panel.
    mocks.getSummary.mockResolvedValue({
      ...summaryResponse(),
      counts: { pending: 0, active: 0, previous: 1 },
    });
    mocks.listEntries.mockResolvedValue(emptyListResponse());
    mocks.search = "tab=pending";

    const { rerender } = render(<ConsentCenterPage />);
    await waitFor(() => expect(mocks.listEntries).toHaveBeenCalled());

    // Simulate the URL after switching to History and opening an entry -
    // exactly what a real router.replace + Next.js re-render would produce.
    mocks.listEntries.mockResolvedValue(groupedHistoryListResponse());
    mocks.search = "tab=history&requestId=identifier:macy";
    rerender(<ConsentCenterPage />);

    await screen.findByText("Access history");

    await act(async () => {
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    });

    await waitFor(() => {
      expect(mocks.replace).toHaveBeenCalled();
    });
    const [calledPath] =
      mocks.replace.mock.calls[mocks.replace.mock.calls.length - 1];
    expect(calledPath).toContain("tab=history");
    expect(calledPath).not.toContain("requestId");
  });

  it("disables pending decision buttons while the selected request is in flight", async () => {
    mocks.busyRequestIds = new Set(["req_deep"]);
    mocks.activeAction = {
      key: "approve:req_deep",
      kind: "approve",
      requestId: "req_deep",
    };

    render(<ConsentCenterPage />);

    const allowButton = (await screen.findByRole("button", {
      name: "Allowing...",
    })) as HTMLButtonElement;
    expect(allowButton.disabled).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Don't allow" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("shows an unlock state instead of an empty panel when scoped lookup cannot run", async () => {
    mocks.isVaultUnlocked = false;
    mocks.getVaultOwnerToken.mockImplementation(() => null);

    render(<ConsentCenterPage />);

    expect(await screen.findByText("Unlock vault to review")).toBeTruthy();
    expect(mocks.lookupPendingRequests).not.toHaveBeenCalled();
  });

  it("renders one route-local Consent Center title and registered tab rail", async () => {
    mocks.search = "tab=pending&q=macy";
    mocks.listEntries.mockResolvedValue(emptyListResponse());

    render(<ConsentCenterPage />);
    await waitFor(() => expect(mocks.listEntries).toHaveBeenCalled());

    expect(
      screen.getByRole("heading", { name: "Consent Center", level: 1 }),
    ).toBeVisible();
    const tabList = screen.getByRole("tablist", {
      name: "Consent Center navigation",
    });
    expect(within(tabList).getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Requests",
      "Active",
      "History",
      "Connections",
    ]);
  });

  it("does not auto-select the first row or open the detail panel after switching tabs", async () => {
    // Regression: selectedEntryFromList fell back to items[0] whenever no
    // requestId/bundleId was in the URL. With no selection open, every tab's
    // FIRST row rendered with the "selected" accent border/surface on mount,
    // and switching tabs (which loads a different items array) made a
    // different, never-clicked row appear highlighted every time - the
    // reported "acting funny" going from History to Active.
    mocks.search = "tab=history";
    mocks.getSummary.mockResolvedValue({
      ...summaryResponse(),
      counts: { pending: 0, active: 1, previous: 1 },
    });
    mocks.listEntries.mockResolvedValue(groupedHistoryListResponse());

    const { rerender } = render(<ConsentCenterPage />);
    expect(await screen.findByText("Macy's CRM")).toBeTruthy();

    // No consent detail panel should be open on a bare tab visit (no
    // requestId/bundleId in the URL). The unrelated CapabilityExploreCard
    // onboarding dialog ("Here's your access center") also uses role
    // "dialog", so this scopes to a panel actually describing an entry.
    expect(screen.queryByRole("dialog", { name: "Macy's CRM" })).toBeNull();

    // Simulate the URL after switching to Active Access - exactly what a
    // real router.replace + Next.js re-render would produce (the mocked
    // router.replace is a no-op recorder, not a real navigation, so the URL
    // must be advanced explicitly, matching the "closing the detail panel"
    // test's pattern above).
    mocks.search = "tab=active";
    mocks.listEntries.mockResolvedValue({
      ...emptyListResponse(),
      surface: "active",
      total: 1,
      items: [
        {
          id: "grant_active_1",
          kind: "active_grant",
          status: "active",
          action: "CONSENT_GRANTED",
          counterpart_type: "developer",
          counterpart_label: "Kushal Trivedi",
          counterpart_email: "kushaltrivedi1711@gmail.com",
          scope: "attr.financial.*",
          issued_at: "2026-07-09T19:26:29.000Z",
          expires_at: "2026-07-10T19:26:29.000Z",
        },
      ],
    });
    rerender(<ConsentCenterPage />);

    expect(await screen.findByText("kushaltrivedi1711@gmail.com")).toBeTruthy();

    // Switching tabs must not open the consent detail panel by itself.
    expect(screen.queryByRole("dialog", { name: "Kushal Trivedi" })).toBeNull();
  });

  it("never reuses rows from the previous Consent Center tab while the next tab loads", async () => {
    let resolveActive:
      ((value: ReturnType<typeof emptyListResponse>) => void) | undefined;
    let resolveHistory:
      ((value: ReturnType<typeof emptyListResponse>) => void) | undefined;
    const activeResponse = {
      ...emptyListResponse(),
      surface: "active",
      total: 1,
      items: [
        {
          id: "active-entry",
          kind: "active_grant",
          status: "active",
          counterpart_type: "investor",
          counterpart_label: "Active location workflow",
          scope: "location.share",
        },
      ],
    };
    const historyResponse = {
      ...emptyListResponse(),
      surface: "previous",
      total: 1,
      items: [
        {
          id: "history-entry",
          kind: "history",
          status: "revoked",
          counterpart_type: "developer",
          counterpart_label: "Revoked location workflow",
          scope: "location.share",
        },
      ],
    };

    mocks.search = "tab=requests";
    mocks.getSummary.mockResolvedValue({
      ...summaryResponse(),
      counts: { pending: 1, active: 1, previous: 1 },
    });
    mocks.listEntries.mockImplementation(
      ({ surface }: { surface: "pending" | "active" | "previous" }) => {
        if (surface === "active") {
          return new Promise((resolve) => {
            resolveActive = resolve;
          });
        }
        if (surface === "previous") {
          return new Promise((resolve) => {
            resolveHistory = resolve;
          });
        }
        return Promise.resolve({
          ...emptyListResponse(),
          total: 1,
          items: [
            {
              id: "pending-entry",
              request_id: "pending-entry",
              kind: "incoming_request",
              status: "pending",
              counterpart_type: "investor",
              counterpart_label: "Pending location workflow",
              scope: "location.share",
            },
          ],
        });
      },
    );

    const { rerender } = render(<ConsentCenterPage />);
    expect(await screen.findByText("Pending location workflow")).toBeTruthy();

    mocks.search = "tab=active";
    rerender(<ConsentCenterPage />);
    await waitFor(() => {
      expect(mocks.listEntries).toHaveBeenCalledWith(
        expect.objectContaining({ surface: "active" }),
      );
    });
    expectInHiddenSwipePanel("Pending location workflow");

    await act(async () => {
      resolveActive?.(activeResponse);
    });
    expect(await screen.findByText("Active location workflow")).toBeTruthy();
    expectInHiddenSwipePanel("Pending location workflow");

    mocks.search = "tab=history";
    rerender(<ConsentCenterPage />);
    await waitFor(() => {
      expect(mocks.listEntries).toHaveBeenCalledWith(
        expect.objectContaining({ surface: "previous" }),
      );
    });
    expectInHiddenSwipePanel("Active location workflow");

    await act(async () => {
      resolveHistory?.(historyResponse);
    });
    expect(await screen.findByText("Revoked location workflow")).toBeTruthy();
    expectInHiddenSwipePanel("Pending location workflow");
    expectInHiddenSwipePanel("Active location workflow");
  });

  it("does not falsely highlight a row that lacks its own request_id when nothing is selected", async () => {
    // Regression: the row-selected check was
    //   selectedEntry?.id === entry.id || selectedEntry?.request_id === entry.request_id
    // With nothing selected, selectedEntry is null, so both sides of the
    // second comparison are `undefined`, and `undefined === undefined` is
    // true. Any entry that has no request_id of its own (e.g. a
    // one_location_grant active-access row) then rendered as visually
    // "selected" (accent border/surface) even though nothing was clicked -
    // exactly the randomly-jumping-highlight symptom reported when
    // switching tabs, since different tabs surface different entries
    // without a request_id.
    mocks.search = "tab=active";
    mocks.getSummary.mockResolvedValue({
      ...summaryResponse(),
      counts: { pending: 0, active: 1, previous: 0 },
    });
    mocks.listEntries.mockResolvedValue({
      ...emptyListResponse(),
      surface: "active",
      total: 1,
      items: [
        {
          id: "one_location_grant:5fa0cbdf-1303-40a9-b467-d98f432395a4",
          kind: "active_grant",
          status: "active",
          action: "CONSENT_GRANTED",
          counterpart_type: "investor",
          counterpart_label: "Gautam Ahuja",
          counterpart_secondary_label: "Hussh connection",
          scope: "location.share",
          issued_at: "2026-07-09T11:19:48.000Z",
          expires_at: "2026-07-10T11:19:48.000Z",
          // No request_id - matches the real one_location_grant shape.
        },
      ],
    });

    render(<ConsentCenterPage />);

    const row = await screen.findByRole("button", { name: /Gautam Ahuja/ });
    expect(row.className).not.toContain("border-accent-border");
  });

  it("does not render a duplicate Consent timeline / history trail for an active_grant entry", async () => {
    // Bug: Active Access shows a single live grant, but its detail panel
    // also rendered the full HandshakeTimeline ("Consent timeline") with
    // every historical grant/request/revoke event for that counterpart -
    // an unrelated, duplicate history trail attached to a currently active
    // item. That trail belongs on the History tab only.
    mocks.search = "tab=active&requestId=req_active_1";
    mocks.getSummary.mockResolvedValue({
      ...summaryResponse(),
      counts: { pending: 0, active: 1, previous: 0 },
    });
    mocks.listEntries.mockResolvedValue({
      ...emptyListResponse(),
      surface: "active",
      total: 1,
      items: [
        {
          id: "grant_active_1",
          request_id: "req_active_1",
          kind: "active_grant",
          status: "active",
          action: "CONSENT_GRANTED",
          counterpart_type: "developer",
          counterpart_id: "developer:app_kushaltrivedi",
          counterpart_label: "Kushal Trivedi",
          counterpart_email: "kushaltrivedi1711@gmail.com",
          scope: "attr.financial.*",
          issued_at: "2026-07-09T19:26:29.000Z",
          expires_at: "2026-07-10T19:26:29.000Z",
        },
      ],
    });

    render(<ConsentCenterPage />);

    expect(
      await screen.findByRole("dialog", { name: "Kushal Trivedi" }),
    ).toBeTruthy();
    expect(screen.getAllByText("Active access").length).toBeGreaterThan(0);
    // The revoke action appears once, with no heading or blurb restating it.
    expect(
      screen.getAllByRole("button", { name: "Stop sharing" }),
    ).toHaveLength(1);
    expect(screen.queryByText("Manage access")).toBeNull();
    expect(screen.queryByText("Your decision")).toBeNull();
    expect(screen.queryByText("Technical details")).toBeNull();
    expect(screen.queryByText("Consent timeline")).toBeNull();
    expect(
      screen.queryByText(
        "Full history of consent changes with this connection.",
      ),
    ).toBeNull();
  });

  it("keeps stale actor=ria links on the One lane unless the URL is the advisor outgoing route", async () => {
    mocks.search = "tab=pending&actor=ria";

    render(<ConsentCenterPage />);

    await waitFor(() => {
      expect(mocks.listEntries).toHaveBeenCalledWith(
        expect.objectContaining({
          actor: undefined,
          surface: "pending",
        }),
      );
    });
    expect(mocks.replace).toHaveBeenCalledWith("/consents?tab=pending", {
      scroll: false,
    });
  });

  it("keeps explicit RIA outgoing compatibility links on the advisor lane", async () => {
    mocks.search = "tab=pending&actor=ria&view=outgoing";

    render(<ConsentCenterPage />);

    await waitFor(() => {
      expect(mocks.listEntries).toHaveBeenCalledWith(
        expect.objectContaining({
          actor: "ria",
          surface: "pending",
        }),
      );
    });
  });

  it("force refreshes consent data after approve or deny events", async () => {
    render(<ConsentCenterPage />);

    await waitFor(() => {
      expect(mocks.listEntries).toHaveBeenCalled();
    });

    act(() => {
      window.dispatchEvent(
        new CustomEvent("consent-action-complete", {
          detail: { action: "approve", requestId: "req_deep" },
        }),
      );
    });

    await waitFor(() => {
      expect(mocks.getSummary).toHaveBeenCalledWith(
        expect.objectContaining({ force: true }),
      );
      expect(mocks.listEntries).toHaveBeenCalledWith(
        expect.objectContaining({ force: true }),
      );
    });
  });

  it("does not force-refresh (and flicker) the list on a non-mutation consent-state-changed event", async () => {
    // Regression: selecting any Requests/Active row calls
    // acknowledgePendingConsent() (notification-provider.tsx), which POSTs
    // /api/consent/pending/opened. The backend inserts a NOTIFICATION_OPENED
    // audit event for still-pending rows, which echoes back to the same
    // client as an "fcm_opened" consent-state-changed event carrying no
    // `action`. The list-refresh listener used to force-refresh on ANY
    // consent-state-changed event regardless of payload, so merely opening a
    // request's detail panel made the whole list visibly flash "Refreshing
    // consent state...". History rows are already resolved and never
    // trigger that backend echo, which is why only Requests/Active flickered.
    // Non-action bookkeeping events (fcm_opened, queued_pending,
    // cached_pending, hydrated_pending, etc.) must NOT force a refresh.
    // Counts must match the (empty) list so the unrelated list/count
    // mismatch auto-retry effect does not also fire a background refresh
    // and pollute this assertion.
    mocks.getSummary.mockResolvedValue({
      ...summaryResponse(),
      counts: { pending: 0, active: 0, previous: 0 },
    });
    render(<ConsentCenterPage />);

    await waitFor(() => {
      expect(mocks.listEntries).toHaveBeenCalled();
    });

    const listCallsBefore = mocks.listEntries.mock.calls.length;
    const summaryCallsBefore = mocks.getSummary.mock.calls.length;

    act(() => {
      window.dispatchEvent(
        new CustomEvent("consent-state-changed", {
          detail: { source: "fcm_opened", requestId: "req_deep" },
        }),
      );
    });

    // Give any (incorrect) async refresh a chance to fire before asserting
    // it did not.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mocks.listEntries.mock.calls.length).toBe(listCallsBefore);
    expect(mocks.getSummary.mock.calls.length).toBe(summaryCallsBefore);
  });

  it("refreshes an invalidated visited tab only when the user returns to it", async () => {
    mocks.search = "tab=requests";
    const { rerender } = render(<ConsentCenterPage />);

    await waitFor(() => {
      expect(mocks.listEntries).toHaveBeenCalledWith(
        expect.objectContaining({ surface: "pending" }),
      );
    });

    mocks.search = "tab=active";
    rerender(<ConsentCenterPage />);
    await waitFor(() => {
      expect(mocks.listEntries).toHaveBeenCalledWith(
        expect.objectContaining({ surface: "active" }),
      );
    });

    const pendingCallsBeforeInvalidation = mocks.listEntries.mock.calls.filter(
      ([options]) => options.surface === "pending",
    ).length;
    act(() => {
      for (const subscriber of mocks.cacheSubscribers) {
        subscriber({
          type: "invalidate",
          keys: ["list:user-1:one:consents:pending::1:20"],
        });
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      mocks.listEntries.mock.calls.filter(
        ([options]) => options.surface === "pending",
      ),
    ).toHaveLength(pendingCallsBeforeInvalidation);

    mocks.search = "tab=requests";
    rerender(<ConsentCenterPage />);

    await waitFor(() => {
      expect(
        mocks.listEntries.mock.calls.filter(
          ([options]) => options.surface === "pending",
        ),
      ).toHaveLength(pendingCallsBeforeInvalidation + 1);
    });
  });

  it("keeps grouped history lifecycles out of the history list row", async () => {
    mocks.search = "tab=history";
    mocks.getSummary.mockResolvedValue({
      ...summaryResponse(),
      counts: { pending: 0, active: 0, previous: 1 },
    });
    mocks.listEntries.mockResolvedValue(groupedHistoryListResponse());

    render(<ConsentCenterPage />);

    expect(await screen.findByText("Macy's CRM")).toBeTruthy();
    expect(screen.queryByText("Consent audit timeline")).toBeNull();
    expect(screen.queryByText("Access history")).toBeNull();
    expect(screen.queryByText("Access 1")).toBeNull();
    expect(screen.queryByText("Shopping profile")).toBeNull();
  });

  it("shows grouped history lifecycles inside the selected detail panel", async () => {
    mocks.search = "tab=history&requestId=identifier:macy";
    mocks.getSummary.mockResolvedValue({
      ...summaryResponse(),
      counts: { pending: 0, active: 0, previous: 1 },
    });
    mocks.listEntries.mockResolvedValue(groupedHistoryListResponse());

    render(<ConsentCenterPage />);

    expect(await screen.findByText("Access history")).toBeTruthy();
    expect(screen.queryByText("History details")).toBeNull();
    expect(screen.queryByText("Your decision")).toBeNull();
    expect(screen.queryByText("Technical details")).toBeNull();
    expect(screen.getByText("Access 1")).toBeTruthy();
    expect(screen.getByText("Access 2")).toBeTruthy();
    expect(screen.getAllByText("Shopping profile").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Receipts").length).toBeGreaterThan(0);
    expect(
      screen.getByRole("button", { name: "Stop active access" }),
    ).toBeTruthy();
  });

  it("needs a confirming second tap before Don't allow denies a request", async () => {
    render(<ConsentCenterPage />);

    const denyButton = await screen.findByRole("button", {
      name: "Don't allow",
    });
    fireEvent.click(denyButton);

    // The first tap arms the button in place: no new heading, card, or dialog
    // appears around the decision, and nothing has been denied yet.
    expect(mocks.handleDeny).not.toHaveBeenCalled();
    expect(denyButton).toHaveTextContent("Sure?");
    expect(screen.getByRole("button", { name: "Confirm Don't allow" })).toBe(
      denyButton,
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Allow" })).toBeTruthy();

    fireEvent.click(denyButton);

    expect(mocks.handleDeny).toHaveBeenCalledTimes(1);
    expect(mocks.handleDeny).toHaveBeenCalledWith("req_deep");
    expect(denyButton).toHaveTextContent("Don't allow");
  });

  // Regression (localhost run 2026-09-28): one allowed request showed as one
  // Active row per field ("Food preferences kind", "Health dietary ...").
  it("shows one Active row per request, named by the server, each field still its own access", async () => {
    mocks.search = "tab=active";
    const grant = (id: string, scope: string, label: string) => ({
      id, request_id: `req_${id}`, kind: "active_grant", status: "active", action: "CONSENT_GRANTED",
      counterpart_type: "person", counterpart_id: "user-kushal", counterpart_label: "Kushal Trivedi",
      counterpart_email: "kushal@example.com", scope, scope_description: label,
      issued_at: "2026-09-28T23:20:00.000Z", expires_at: "2026-10-05T23:20:00.000Z",
      bundle_id: "bundle-dinner", bundle_labels: ["Food preferences", "Dietary constraints"],
      bundle_label: "Food preferences and Dietary constraints",
      metadata: { bundle_id: "bundle-dinner", request_source: "one_person_profile" },
    });
    mocks.listEntries.mockResolvedValue({
      ...emptyListResponse(), surface: "active", total: 2,
      items: [grant("g1", "attr.food.preferences.*", "Food preferences"), grant("g2", "attr.health.dietary.*", "Dietary constraints")],
    });
    render(<ConsentCenterPage />);
    const rows = await screen.findAllByTestId("consent-active-request-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("Food preferences and Dietary constraints");
    expect(screen.queryAllByTestId("consent-entry-row")).toHaveLength(0);
    fireEvent.click(within(rows[0]!).getByRole("button", { name: /Show Food preferences and Dietary constraints/ }));
    const items = within(rows[0]!).getAllByTestId("consent-active-request-item");
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining("Food preferences"), expect.stringContaining("Dietary constraints"),
    ]);
  });

  it("names what they'll see at once, then fills in the counts", async () => {
    mocks.search = "tab=requests&requestId=req_food";
    mocks.sharePreviewState = { status: "loading", labels: ["Food preferences"] };
    mocks.listEntries.mockResolvedValue(pendingListResponse(foodRequestEntry()));
    const { rerender } = render(<ConsentCenterPage />);
    const preview = await screen.findByTestId("consent-share-preview");
    expect(preview).toHaveTextContent("Food preferences");
    expect(preview).not.toHaveTextContent(/Checking/);
    mocks.sharePreviewState = { status: "ready", preview: { total: 2, groups: [
      { label: "Food preferences", count: 2, names: ["Favorite restaurants"] }] } };
    rerender(<ConsentCenterPage />);
    expect(screen.getByTestId("consent-share-preview")).toHaveTextContent("Food preferences · 2 items");
    expect(screen.getByTestId("consent-share-preview")).toHaveTextContent("Favorite restaurants");
  });

  it("confirms Stop sharing through an alert dialog before revoking", async () => {
    mocks.search = "tab=active&requestId=req_active_1";
    mocks.getSummary.mockResolvedValue({
      ...summaryResponse(),
      counts: { pending: 0, active: 1, previous: 0 },
    });
    mocks.listEntries.mockResolvedValue({
      ...emptyListResponse(),
      surface: "active",
      total: 1,
      items: [
        {
          id: "grant_active_1",
          request_id: "req_active_1",
          kind: "active_grant",
          status: "active",
          action: "CONSENT_GRANTED",
          counterpart_type: "developer",
          counterpart_id: "developer:app_kushaltrivedi",
          counterpart_label: "Kushal Trivedi",
          scope: "attr.financial.*",
          issued_at: "2026-07-09T19:26:29.000Z",
          expires_at: "2026-07-10T19:26:29.000Z",
        },
      ],
    });

    render(<ConsentCenterPage />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Stop sharing" }),
    );

    expect(mocks.handleRevoke).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Stop sharing with Kushal Trivedi?");

    const confirmButtons = screen
      .getAllByRole("button", { name: "Stop sharing" })
      .filter((button) => dialog.contains(button));
    expect(confirmButtons).toHaveLength(1);
    expect(confirmButtons[0]!.getAttribute("data-slot")).toBe(
      "alert-dialog-action",
    );

    fireEvent.click(confirmButtons[0]!);

    await waitFor(() =>
      expect(mocks.handleRevoke).toHaveBeenCalledWith(
        "attr.financial.*",
        "req_active_1",
        { quiet: true },
      ),
    );
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    // The sheet closes into a plain confirmation, never the "Request not
    // visible" dead end the old path left once the row left Active.
    expect(mocks.replace).toHaveBeenCalledWith(
      expect.not.stringContaining("requestId="),
      { scroll: false },
    );
    await waitFor(() =>
      expect(mocks.toastSuccess).toHaveBeenCalledWith(
        "Kushal Trivedi can no longer see your Financial data.",
      ),
    );
    expect(screen.queryByText("Request not visible")).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Kushal Trivedi" })).toBeNull();
  });

  // Regression (localhost run 3, 2026-09-28): after Stop sharing the Active
  // tab still listed the access, because each re-read returned the pre-stop
  // list. The server list below keeps returning it throughout.
  async function stopSharingFoodAccess(stop: Promise<void>) {
    mocks.search = "tab=active&requestId=req_active_food";
    mocks.handleRevoke.mockReturnValue(stop);
    mocks.getSummary.mockResolvedValue({
      ...summaryResponse(),
      counts: { pending: 0, active: 1, previous: 0 },
    });
    mocks.listEntries.mockResolvedValue({
      ...emptyListResponse(),
      surface: "active",
      total: 1,
      items: [
        {
          id: "grant_active_food",
          request_id: "req_active_food",
          kind: "active_grant",
          status: "active",
          action: "CONSENT_GRANTED",
          counterpart_type: "person",
          counterpart_id: "user-requester",
          counterpart_label: "Requester Person",
          scope: "attr.food.preferences.*",
          scope_description: "Food preferences",
          issued_at: "2026-09-28T23:20:00.000Z",
          expires_at: "2026-10-05T23:20:00.000Z",
        },
      ],
    });
    render(<ConsentCenterPage />);
    const list = screen.getByTestId("consent-manager-list");
    await waitFor(() => expect(list).toHaveTextContent("Requester Person"));
    fireEvent.click(await screen.findByRole("button", { name: "Stop sharing" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Stop sharing" }));
    return list;
  }

  it("takes the access out of Active on the confirming tap, before the server agrees", async () => {
    let finishStop: () => void = () => undefined;
    const list = await stopSharingFoodAccess(
      new Promise<void>((resolve) => {
        finishStop = resolve;
      }),
    );

    // The stop is still in flight and the server list still carries it.
    await waitFor(() => expect(list).not.toHaveTextContent("Requester Person"));
    expect(mocks.toastSuccess).not.toHaveBeenCalled();

    await act(async () => finishStop());
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalled());
    // A re-read that still returns the pre-stop list does not bring it back.
    act(() => {
      window.dispatchEvent(
        new CustomEvent("consent-state-changed", { detail: { reconcile: true } }),
      );
    });
    await waitFor(() => expect(mocks.listEntries.mock.calls.length).toBeGreaterThan(1));
    expect(list).not.toHaveTextContent("Requester Person");
  });

  it("puts the access back in Active when stopping fails", async () => {
    let failStop: (error: Error) => void = () => undefined;
    const list = await stopSharingFoodAccess(
      new Promise<void>((_resolve, reject) => {
        failStop = reject;
      }),
    );
    await waitFor(() => expect(list).not.toHaveTextContent("Requester Person"));

    // Negative control: the removal was a promise to the owner, not a server
    // answer. When the stop fails the access is still live, and says so.
    await act(async () => failStop(new Error("Could not stop sharing. Try again.")));
    await waitFor(() => expect(list).toHaveTextContent("Requester Person"));
    expect(mocks.toastError).toHaveBeenCalledWith("Could not stop sharing. Try again.");
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it("names a request plainly: when it was asked, when to decide, what and how long", async () => {
    mocks.search = "tab=requests&requestId=req_food";
    mocks.sharePreviewState = {
      status: "ready",
      preview: {
        total: 5,
        groups: [
          { label: "Favorite cuisines", count: 2 },
          { label: "Favorite restaurants", count: 3 },
        ],
      },
    };
    mocks.listEntries.mockResolvedValue(
      pendingListResponse(foodRequestEntry()),
    );

    render(<ConsentCenterPage />);

    const dialog = await screen.findByRole("dialog", { name: "Kushal Trivedi" });
    const valueFor = (label: string) =>
      screen.getByText(label, { selector: "dt" }).nextElementSibling?.textContent;
    // The wire sends issued_at as a numeric string; it used to read
    // "Unavailable".
    expect(valueFor("Requested")).toMatch(/^Today, /);
    expect(valueFor("Decide by")).toMatch(/^[A-Z][a-z]{2} \d{1,2}(, \d{4})?$/);
    // The request carries the same name its access will.
    expect(valueFor("Access")).toBe("Food preferences");
    // One duration wording: the requester's card says "7 days", so the
    // owner's picker says "7 days" too, never "1 week".
    expect(
      screen.getByRole("combobox", { name: "Access duration" }),
    ).toHaveTextContent("7 days");
    expect(dialog).not.toHaveTextContent("Unavailable");
    expect(dialog).not.toHaveTextContent("Decision due");
    // What an Allow would hand over, counted on this device.
    const preview = screen.getByTestId("consent-share-preview");
    expect(preview).toHaveTextContent("5 items");
    expect(preview).toHaveTextContent("Favorite restaurants · 3");
  });

  it("shows the new access in Active the moment an Allow is confirmed", async () => {
    mocks.search = "tab=requests&requestId=req_food";
    mocks.listEntries.mockImplementation(
      async (options: { surface: string }) =>
        options.surface === "pending"
          ? pendingListResponse(foodRequestEntry())
          : { ...emptyListResponse(), surface: options.surface },
    );

    const { rerender } = render(<ConsentCenterPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Allow" }));
    expect(mocks.handleApprove).toHaveBeenCalledWith(
      expect.objectContaining({ id: "req_food", durationHours: 168 }),
    );

    // The shared hook reports the confirmed approval.
    act(() => {
      mocks.consentActionOptions?.onActionComplete?.({
        action: "approve",
        requestId: "req_food",
        source: "consent_actions",
      });
    });

    // Active's server page is still the pre-approval one (empty).
    mocks.search = "tab=active";
    rerender(<ConsentCenterPage />);

    await waitFor(() =>
      expect(mocks.listEntries).toHaveBeenCalledWith(
        expect.objectContaining({ surface: "active" }),
      ),
    );
    // The Active pane shows the new access with its status, named the same
    // way the request was.
    const status = await screen.findByText("active");
    const activePane = status.closest('[role="tabpanel"]');
    expect(activePane).toHaveTextContent("Kushal Trivedi");
    expect(activePane).toHaveTextContent("Food preferences");
    expect(screen.queryByText("No one currently has active access.")).toBeNull();
  });

  it("advertises no consents.* voice actions the gateway cannot run", async () => {
    render(<ConsentCenterPage />);

    expect(
      await screen.findByRole("button", { name: "Don't allow" }),
    ).toBeTruthy();

    const published = vi.mocked(usePublishVoiceSurfaceMetadata).mock.calls;
    expect(published.length).toBeGreaterThan(0);
    const latest = published[published.length - 1]![0] as {
      actions: unknown[];
      availableActions: string[];
      controls: Array<{ id: string; actionId?: string | null }>;
    };
    expect(latest.actions).toEqual([]);
    expect(latest.availableActions).toEqual([]);
    // The decision controls remain visible as state...
    expect(latest.controls.map((control) => control.id)).toEqual(
      expect.arrayContaining([
        "consent_search",
        "consent_detail_panel",
        "consent_approve",
        "consent_deny",
      ]),
    );
    // ...but none of them names an action id nothing could resolve.
    expect(latest.controls.every((control) => !control.actionId)).toBe(true);
    expect(JSON.stringify(latest)).not.toContain("consents.");
  });

  it("describes grouped history in the owner's words", async () => {
    mocks.search = "tab=history&requestId=identifier:macy";
    mocks.getSummary.mockResolvedValue({
      ...summaryResponse(),
      counts: { pending: 0, active: 0, previous: 1 },
    });
    const grouped = groupedHistoryListResponse();
    const [entry] = grouped.items;
    mocks.listEntries.mockResolvedValue({
      ...grouped,
      items: [
        {
          ...entry,
          trail_count: 3,
          event_count: 3,
          consent_trails: [
            ...entry!.consent_trails,
            {
              id: "trail_unlabelled",
              status: "approved",
              action: "CONSENT_GRANTED",
              issued_at: "2026-06-16T12:00:00.000Z",
              event_count: 0,
              events: [],
            },
          ],
        },
      ],
    });

    render(<ConsentCenterPage />);

    expect(await screen.findByText("Access history")).toBeTruthy();
    expect(screen.getByText("3 events across 3 requests.")).toBeTruthy();
    expect(screen.getByText("Shared information")).toBeTruthy();
    expect(screen.queryByText("Consent scope")).toBeNull();
    expect(screen.queryByText(/consent events? across/)).toBeNull();
    expect(screen.queryByText(/lifecycle/)).toBeNull();
  });

  it("disables the matching lifecycle revoke button while revoke is in flight", async () => {
    mocks.search = "tab=history&requestId=identifier:macy";
    mocks.busyScopes = new Set(["attr.shopping.profile.*"]);
    mocks.activeAction = {
      key: "revoke:attr.shopping.profile.*",
      kind: "revoke",
      scope: "attr.shopping.profile.*",
    };
    mocks.getSummary.mockResolvedValue({
      ...summaryResponse(),
      counts: { pending: 0, active: 0, previous: 1 },
    });
    mocks.listEntries.mockResolvedValue(groupedHistoryListResponse());

    render(<ConsentCenterPage />);

    const revokeButton = (await screen.findByRole("button", {
      name: "Stopping...",
    })) as HTMLButtonElement;
    expect(revokeButton.disabled).toBe(true);
  });

  // Founder decision 2026-09-28 (CONTRACT-2 C8): a waiting request carries
  // ✗ and ✓ on its row, and the row itself opens the sheet.
  describe("Requests row decisions", () => {
    const ROW_NAME = "Kushal Trivedi, Food preferences, review";

    function renderFoodRequestRow() {
      mocks.search = "tab=pending";
      mocks.listEntries.mockImplementation(
        async (options: { surface: string }) =>
          options.surface === "pending"
            ? pendingListResponse(foodRequestEntry())
            : { ...emptyListResponse(), surface: options.surface },
      );
      return render(<ConsentCenterPage />);
    }

    function twelveItemBundle() {
      return {
        id: "bundle:bundle-professional",
        bundle_id: "bundle-professional",
        bundle_complete: true,
        bundle_items: Array.from({ length: 12 }, (_, index) => ({
          request_id: `request-${index + 1}`,
          label: `Professional detail ${index + 1}`,
          status: index < 2 ? "granted" : "pending",
          entry:
            index < 2
              ? null
              : {
                  id: `request-${index + 1}`,
                  request_id: `request-${index + 1}`,
                  kind: "incoming_request",
                  status: "pending",
                  action: "REQUESTED",
                  allowed_next_action: "review_request",
                  scope: `attr.professional.detail_${index + 1}`,
                  scope_description: `Professional detail ${index + 1}`,
                  counterpart_type: "person",
                  counterpart_label: "A member",
                  metadata: { bundle_id: "bundle-professional", expiry_hours: 24 },
                },
        })),
        kind: "incoming_request",
        status: "pending",
        action: "REQUESTED",
        counterpart_type: "person",
        counterpart_label: "A member",
        metadata: { bundle_id: "bundle-professional" },
      };
    }

    function lastUndoAction() {
      const options = mocks.toastShow.mock.calls.at(-1)?.[1] as {
        duration: number;
        action: { label: string; onClick: () => void };
      };
      return options.action;
    }

    it("makes the row one button that opens the sheet, with the decisions beside it", async () => {
      renderFoodRequestRow();
      const row = await screen.findByRole("button", { name: ROW_NAME });
      // A native button: Enter and Space open the sheet like a tap does.
      expect(row.tagName).toBe("BUTTON");
      const shell = screen.getByTestId("consent-entry-row");
      const allow = within(shell).getByRole("button", { name: "Allow" });
      const decline = within(shell).getByRole("button", { name: "Don't allow" });
      // Never nested in the row's button, so they cannot open the sheet.
      expect(row.contains(allow) || row.contains(decline)).toBe(false);

      fireEvent.click(row);
      expect(mocks.replace).toHaveBeenCalledWith(
        expect.stringContaining("requestId=req_food"),
        { scroll: false },
      );
    });

    it("allows from ✓ for the requested duration, moves the row to Active, and never opens the sheet", async () => {
      mocks.vaultKey = "vault-key";
      const { rerender } = renderFoodRequestRow();
      const shell = await screen.findByTestId("consent-entry-row");
      fireEvent.click(within(shell).getByRole("button", { name: "Allow" }));

      await waitFor(() =>
        expect(mocks.handleApproveBundle).toHaveBeenCalledTimes(1),
      );
      const [consents] = mocks.handleApproveBundle.mock.calls[0] as [
        Array<{ id: string; durationHours?: number }>,
      ];
      expect(consents.map((consent) => [consent.id, consent.durationHours])).toEqual([
        ["req_food", 168],
      ]);
      expect(
        mocks.replace.mock.calls.some(([href]) => String(href).includes("requestId=")),
      ).toBe(false);
      // Out of Requests at once, before the server confirms.
      await waitFor(() =>
        expect(screen.queryByRole("button", { name: ROW_NAME })).toBeNull(),
      );

      act(() => {
        mocks.consentActionOptions?.onActionComplete?.({
          action: "approve",
          requestId: "req_food",
          source: "consent_actions",
        });
      });
      mocks.search = "tab=active";
      rerender(<ConsentCenterPage />);
      const status = await screen.findByText("active");
      expect(status.closest('[role="tabpanel"]')).toHaveTextContent("Kushal Trivedi");
    });

    it("opens the unlock before ✓ allows on a locked vault, and sends nothing meanwhile", async () => {
      const { rerender } = renderFoodRequestRow();
      const shell = await screen.findByTestId("consent-entry-row");
      fireEvent.click(within(shell).getByRole("button", { name: "Allow" }));

      expect(
        await screen.findByRole("alertdialog", { name: "Unlock to allow" }),
      ).toBeTruthy();
      expect(mocks.handleApproveBundle).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: ROW_NAME })).toBeTruthy();

      mocks.vaultKey = "vault-key";
      rerender(<ConsentCenterPage />);
      await waitFor(() =>
        expect(mocks.handleApproveBundle).toHaveBeenCalledTimes(1),
      );
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });

    it("declines from ✗ behind a five-second Undo, and Undo sends nothing", async () => {
      mocks.vaultKey = "vault-key";
      renderFoodRequestRow();
      const shell = await screen.findByTestId("consent-entry-row");
      fireEvent.click(within(shell).getByRole("button", { name: "Don't allow" }));

      await waitFor(() =>
        expect(screen.queryByRole("button", { name: ROW_NAME })).toBeNull(),
      );
      expect(mocks.toastShow).toHaveBeenCalledWith(
        "Declined Kushal's request.",
        expect.objectContaining({ duration: 5000 }),
      );
      expect(mocks.handleDenyBundle).not.toHaveBeenCalled();
      expect(mocks.handleDeny).not.toHaveBeenCalled();

      act(() => lastUndoAction().onClick());
      expect(await screen.findByRole("button", { name: ROW_NAME })).toBeTruthy();
      expect(mocks.handleDenyBundle).not.toHaveBeenCalled();
    });

    it("still declines when the page is left inside the Undo window", async () => {
      mocks.vaultKey = "vault-key";
      const { unmount } = renderFoodRequestRow();
      const shell = await screen.findByTestId("consent-entry-row");
      fireEvent.click(within(shell).getByRole("button", { name: "Don't allow" }));
      await waitFor(() => expect(mocks.toastShow).toHaveBeenCalledTimes(1));
      expect(mocks.handleDenyBundle).not.toHaveBeenCalled();

      unmount();
      expect(mocks.handleDenyBundle).toHaveBeenCalledWith(
        ["req_food"],
        expect.objectContaining({ quiet: true }),
      );
    });

    it("decides every waiting item of a grouped request from its row", async () => {
      mocks.vaultKey = "vault-key";
      mocks.search = "tab=pending";
      mocks.listEntries.mockResolvedValue(pendingListResponse(twelveItemBundle()));
      const { unmount } = render(<ConsentCenterPage />);
      const shell = await screen.findByTestId("consent-bundle-row");
      const waiting = Array.from({ length: 10 }, (_, index) => `request-${index + 3}`);

      fireEvent.click(within(shell).getByRole("button", { name: "Allow" }));
      await waitFor(() =>
        expect(mocks.handleApproveBundle).toHaveBeenCalledTimes(1),
      );
      const [consents] = mocks.handleApproveBundle.mock.calls[0] as [
        Array<{ id: string; durationHours?: number }>,
      ];
      expect(consents.map((consent) => consent.id)).toEqual(waiting);
      expect(consents.every((consent) => consent.durationHours === 24)).toBe(true);

      // A fresh visit: ✗ declines every waiting item, with the same Undo.
      unmount();
      mocks.handleApproveBundle.mockClear();
      const second = render(<ConsentCenterPage />);
      const again = await screen.findByTestId("consent-bundle-row");
      fireEvent.click(within(again).getByRole("button", { name: "Don't allow" }));
      await waitFor(() => expect(mocks.toastShow).toHaveBeenCalled());
      second.unmount();
      expect(mocks.handleDenyBundle).toHaveBeenCalledWith(
        waiting,
        expect.objectContaining({ quiet: true }),
      );
    });
  });
});
