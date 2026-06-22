import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ConsentCenterPage } from "@/components/consent/consent-center-page";

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
}));

vi.mock("@/lib/services/consent-center-service", () => ({
  CONSENT_CENTER_PAGE_SIZE: 20,
  ConsentCenterService: {
    getSummary: mocks.getSummary,
    listEntries: mocks.listEntries,
    lookupPendingRequests: mocks.lookupPendingRequests,
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

  it("resolves a selected pending request that is not present in the current list page", async () => {
    render(<ConsentCenterPage />);

    await waitFor(() => {
      expect(mocks.lookupPendingRequests).toHaveBeenCalledWith({
        vaultOwnerToken: "vault-token",
        userId: "user-1",
        requestIds: ["req_deep"],
      });
    });

    expect(await screen.findByRole("dialog", { name: "Macy's CRM" })).toBeTruthy();
    expect(screen.getByText("Shopping receipts")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Allow" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Don't allow" })).toBeTruthy();
  });

  it("disables pending decision buttons while the selected request is in flight", async () => {
    mocks.busyRequestIds = new Set(["req_deep"]);
    mocks.activeAction = {
      key: "approve:req_deep",
      kind: "approve",
      requestId: "req_deep",
    };

    render(<ConsentCenterPage />);

    const allowButton = await screen.findByRole("button", {
      name: "Allowing...",
    }) as HTMLButtonElement;
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
    expect(screen.queryByText("Consent history")).toBeNull();
    expect(screen.queryByText("Lifecycle 1")).toBeNull();
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

    expect(await screen.findByText("Consent history")).toBeTruthy();
    expect(screen.getByText("Lifecycle 1")).toBeTruthy();
    expect(screen.getByText("Lifecycle 2")).toBeTruthy();
    expect(screen.getAllByText("Shopping profile").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Receipts").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Revoke" })).toBeTruthy();
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

    const revokeButton = await screen.findByRole("button", {
      name: "Revoking...",
    }) as HTMLButtonElement;
    expect(revokeButton.disabled).toBe(true);
  });
});
