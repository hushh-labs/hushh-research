import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ConsentCenterPage } from "@/components/consent/consent-center-page";
import {
  getLocalConsentPreviewList,
  getLocalConsentPreviewSummary,
  resetLocalConsentPreviewState,
} from "@/lib/consent/local-consent-preview";

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  getIdToken: vi.fn().mockResolvedValue("id-token"),
  getVaultOwnerToken: vi.fn(() => "vault-token"),
  isVaultUnlocked: true,
  search:
    "tab=pending&requestId=req_deep&from=%2Fone%2Fconnected-systems%2Fsalesforce-fsc-customer0",
  getSummary: vi.fn(),
  listEntries: vi.fn(),
  lookupPendingRequests: vi.fn(),
  handleApprove: vi.fn(),
  handleDeny: vi.fn(),
  handleRevoke: vi.fn(),
  handleLocationApprove: vi.fn(),
  handleLocationDeny: vi.fn(),
  handleLocationRevoke: vi.fn(),
  localPreview: false,
  busyRequestIds: new Set<string>(),

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

vi.mock("@/lib/consent/local-consent-preview-gate", () => ({
  isLocalConsentPreviewRuntime: () => mocks.localPreview,
  syncLocalConsentPreviewSession: () => mocks.localPreview,
  loadLocalConsentPreviewModule: vi.fn().mockResolvedValue(null),
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
  }),
}));

vi.mock("@/lib/consent", () => ({
  useConsentActions: () => ({
    handleApprove: mocks.handleApprove,
    handleDeny: mocks.handleDeny,
    handleRevoke: mocks.handleRevoke,
    activeAction: mocks.activeAction,
    activeActions: mocks.activeAction ? [mocks.activeAction] : [],
    isRequestBusy: (requestId?: string | null) =>
      mocks.busyRequestIds.has(String(requestId || "")),
    isScopeBusy: (scope?: string | null) =>
      mocks.busyScopes.has(String(scope || "")),
  }),
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
      subscribe: vi.fn(() => () => {}),
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

function pendingListResponse(
  entry: Record<string, unknown>,
) {
  return {
    ...emptyListResponse(),
    total: 1,
    items: [entry],
  };
}

function configureLocalPreview(search: string) {
  resetLocalConsentPreviewState(
    Date.parse("2026-07-23T12:00:00.000Z"),
  );
  mocks.localPreview = true;
  mocks.search = search;
  mocks.getSummary.mockResolvedValue(
    getLocalConsentPreviewSummary("user-1"),
  );
  mocks.listEntries.mockImplementation(
    ({
      surface,
      q,
      page,
      limit,
    }: {
      surface: "pending" | "active" | "previous";
      q?: string;
      page?: number;
      limit?: number;
    }) =>
      Promise.resolve(
        getLocalConsentPreviewList({
          userId: "user-1",
          surface,
          q,
          page,
          limit,
        }),
      ),
  );
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
    window.sessionStorage.clear();
    mocks.search =
      "tab=pending&requestId=req_deep&from=%2Fone%2Fconnected-systems%2Fsalesforce-fsc-customer0";
    mocks.getVaultOwnerToken.mockImplementation(() => "vault-token");
    mocks.isVaultUnlocked = true;
    mocks.localPreview = false;
    mocks.getSummary.mockResolvedValue(summaryResponse());
    mocks.listEntries.mockResolvedValue(emptyListResponse());
    mocks.handleApprove.mockResolvedValue(undefined);
    mocks.handleDeny.mockResolvedValue(undefined);
    mocks.handleRevoke.mockResolvedValue(undefined);
    mocks.busyRequestIds = new Set();
    mocks.busyScopes = new Set();
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

  it.each([
    {
      tab: "requests",
      searchName: "Search requests",
    },
    {
      tab: "active",
      searchName: "Search active access",
    },
    {
      tab: "history",
      searchName: "Search history",
    },
  ])(
    "renders a complete paginated $tab layout in local preview mode",
    async ({ tab, searchName }) => {
      resetLocalConsentPreviewState(
        Date.parse("2026-07-23T12:00:00.000Z"),
      );
      mocks.localPreview = true;
      mocks.search = `tab=${tab}&preview=consent`;
      mocks.getSummary.mockResolvedValue(
        getLocalConsentPreviewSummary("user-1"),
      );
      mocks.listEntries.mockImplementation(
        ({
          surface,
          q,
          page,
          limit,
        }: {
          surface: "pending" | "active" | "previous";
          q?: string;
          page?: number;
          limit?: number;
        }) =>
          Promise.resolve(
            getLocalConsentPreviewList({
              userId: "user-1",
              surface,
              q,
              page,
              limit,
            }),
          ),
      );

      render(<ConsentCenterPage />);

      expect(await screen.findByText("Layout preview")).toBeTruthy();
      expect(screen.getByText(/never reach the backend/i)).toBeTruthy();
      expect(
        screen.getByRole("textbox", { name: searchName }),
      ).toBeTruthy();
      expect(await screen.findAllByTestId("consent-entry-row")).toHaveLength(
        20,
      );
      expect(screen.getByText("Page 1 of 2")).toBeTruthy();
      expect(
        screen.getByRole("button", { name: "Go to next page" }),
      ).not.toBeDisabled();
    },
  );

  it("keeps Northstar's material decision terms once without duplicate controls", async () => {
    configureLocalPreview(
      "tab=requests&requestId=preview-request-scope-upgrade&preview=consent",
    );

    render(<ConsentCenterPage />);

    expect(
      await screen.findByRole("dialog", { name: "Northstar Planning" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Allow" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Don't allow" }),
    ).toBeTruthy();
    expect(screen.queryByText("Requested duration")).toBeNull();
    expect(screen.queryByText("Future updates")).toBeNull();
    expect(
      screen.getByText("Includes approved updates until access ends."),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Requested for 2 days. You can choose a shorter window.",
      ),
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole("combobox", { name: "Access duration" }),
    );
    expect(
      await screen.findByRole("option", { name: "24 hours" }),
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

    expect(await screen.findByText("Requested duration")).toBeTruthy();
    expect(screen.getAllByText("1 day")).toHaveLength(1);
    expect(
      screen.getByText(
        "Shares a one-time copy; later changes are not included.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByRole("combobox", { name: "Access duration" }),
    ).toBeNull();
    expect(screen.getAllByRole("link", { name: "Open Email" })).toHaveLength(
      1,
    );
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

    expect(await screen.findByText("Your decision")).toBeTruthy();
    expect(screen.queryByText("Requested duration")).toBeNull();
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
    expect(
      screen.queryByRole("button", { name: "Don't allow" }),
    ).toBeNull();
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
    expect(screen.getByText("Shopping receipts")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Allow" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Don't allow" })).toBeTruthy();
    const requestDetails = screen.getByText("Request details");
    const decision = screen.getByText("Your decision");
    expect(
      requestDetails.compareDocumentPosition(decision) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.queryByText("Technical details")).toBeNull();
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

    expect(await screen.findByText("Connection request")).toBeTruthy();
    expect(screen.getByText("Relationship")).toBeTruthy();
    expect(screen.getAllByText("Trusted connection").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Accept" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Decline" })).toBeTruthy();
    expect(screen.queryByText("Access duration")).toBeNull();
    expect(screen.queryByText("Requested duration")).toBeNull();
    expect(screen.queryByText("Ends")).toBeNull();
  });

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

    expect(await screen.findByText("Your decision")).toBeTruthy();
    expect(screen.getByText("Requested duration")).toBeTruthy();
    expect(screen.getAllByText("3 days").length).toBeGreaterThan(0);
    expect(screen.getByText("Decision due")).toBeTruthy();
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

    const closeButton = screen.getByRole("button", { name: /close/i });
    await act(async () => {
      closeButton.click();
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

  it("does not render a duplicate in-page tab switcher", async () => {
    // The shared top shell now owns Consent Center tab navigation. Retaining a
    // route-local switcher would create two selection authorities and allow a
    // search query to leak across one of them.
    mocks.search = "tab=pending&q=macy";
    mocks.listEntries.mockResolvedValue(emptyListResponse());

    render(<ConsentCenterPage />);
    await waitFor(() => expect(mocks.listEntries).toHaveBeenCalled());

    expect(screen.queryByRole("button", { name: /Active Access/i })).toBeNull();
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
      | ((value: ReturnType<typeof emptyListResponse>) => void)
      | undefined;
    let resolveHistory:
      | ((value: ReturnType<typeof emptyListResponse>) => void)
      | undefined;
    const activeResponse = {
      ...emptyListResponse(),
      surface: "active",
      total: 1,
      items: [
        {
          id: "preview-active",
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
          id: "preview-history",
          kind: "history",
          status: "revoked",
          counterpart_type: "developer",
          counterpart_label: "Revoked location workflow",
          scope: "location.share",
        },
      ],
    };

    mocks.search = "tab=requests&preview=consent";
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
              id: "preview-request",
              request_id: "preview-request",
              kind: "pending_request",
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

    mocks.search = "tab=active&preview=consent";
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

    mocks.search = "tab=history&preview=consent";
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
    expect(screen.getByText("Manage access")).toBeTruthy();
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
});
