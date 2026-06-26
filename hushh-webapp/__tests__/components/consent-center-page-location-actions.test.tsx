import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ConsentCenterPage } from "@/components/consent/consent-center-page";

// Verifies that One Location rows in the Access Manager (/consents) route their
// Allow / Don't allow / Revoke CTAs through the dedicated One Location hook
// (E2E-encrypted endpoints), NOT the generic developer-consent pipeline. This
// locks the parity fix so the consent manager behaves like the One Location
// page Activity tab. Regression guard for the UAT "Failed to revoke consent"
// bug on `one_location_grant:*` entries.

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  getIdToken: vi.fn().mockResolvedValue("id-token"),
  getVaultOwnerToken: vi.fn(() => "vault-token"),
  isVaultUnlocked: true,
  search: "tab=active&requestId=one_location_grant:grant-1",
  getSummary: vi.fn(),
  listEntries: vi.fn(),
  lookupPendingRequests: vi.fn(),
  // generic developer-consent handlers (must NOT fire for location rows)
  handleApprove: vi.fn(),
  handleDeny: vi.fn(),
  handleRevoke: vi.fn(),
  // One Location handlers (must fire for location rows)
  handleLocationApprove: vi.fn(),
  handleLocationDeny: vi.fn(),
  handleLocationRevoke: vi.fn(),
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
    activeAction: null,
    activeActions: [],
    isRequestBusy: () => false,
    isScopeBusy: () => false,
  }),
  useOneLocationConsentActions: () => ({
    handleApprove: mocks.handleLocationApprove,
    handleDeny: mocks.handleLocationDeny,
    handleRevoke: mocks.handleLocationRevoke,
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

function summaryResponse(counts: {
  pending: number;
  active: number;
  previous: number;
}) {
  return {
    user_id: "user-1",
    actor: "investor",
    mode: "consents",
    counts,
  };
}

function activeLocationGrantList() {
  return {
    user_id: "user-1",
    actor: "investor",
    mode: "consents",
    surface: "active",
    query: "",
    page: 1,
    limit: 20,
    total: 1,
    has_more: false,
    items: [
      {
        id: "one_location_grant:grant-1",
        kind: "active_grant",
        status: "active",
        action: "CONSENT_GRANTED",
        scope: "cap.location.live.view",
        scope_description: "Live location sharing",
        counterpart_type: "investor",
        counterpart_label: "hushh Social",
        issued_at: "2026-06-24T18:03:06.000Z",
        expires_at: "2026-06-25T00:03:06.000Z",
        metadata: {
          request_source: "one_location_share_grant",
          section: "people",
          grant_id: "grant-1",
        },
      },
    ],
  };
}

function pendingLocationRequestList() {
  return {
    user_id: "user-1",
    actor: "investor",
    mode: "consents",
    surface: "pending",
    query: "",
    page: 1,
    limit: 20,
    total: 1,
    has_more: false,
    items: [
      {
        id: "one_location_request:req-1",
        kind: "incoming_request",
        status: "pending",
        action: "REQUESTED",
        scope: "cap.location.live.view",
        scope_description: "Live location access request",
        counterpart_type: "investor",
        counterpart_label: "hushh Social",
        request_id: "req-1",
        issued_at: "2026-06-24T18:03:06.000Z",
        metadata: {
          request_source: "one_location_access_request",
          section: "approvals",
          request_id: "req-1",
        },
      },
    ],
  };
}

function activeDeveloperGrantList() {
  return {
    user_id: "user-1",
    actor: "investor",
    mode: "consents",
    surface: "active",
    query: "",
    page: 1,
    limit: 20,
    total: 1,
    has_more: false,
    items: [
      {
        id: "grant-dev-1",
        kind: "active_grant",
        status: "active",
        action: "CONSENT_GRANTED",
        scope: "attr.shopping.receipts.*",
        scope_description: "Shopping receipts",
        counterpart_type: "developer",
        counterpart_label: "Macy's CRM",
        issued_at: "2026-06-24T18:03:06.000Z",
        metadata: { request_source: "developer_api_v1" },
      },
    ],
  };
}

describe("ConsentCenterPage One Location action routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getVaultOwnerToken.mockImplementation(() => "vault-token");
    mocks.isVaultUnlocked = true;
    mocks.handleLocationApprove.mockResolvedValue(undefined);
    mocks.handleLocationDeny.mockResolvedValue(undefined);
    mocks.handleLocationRevoke.mockResolvedValue(undefined);
    installDesktopMediaQuery();
  });

  it("revokes an active location grant through the One Location hook, not the generic flow", async () => {
    mocks.search = "tab=active&requestId=one_location_grant:grant-1";
    mocks.getSummary.mockResolvedValue(
      summaryResponse({ pending: 0, active: 1, previous: 0 }),
    );
    mocks.listEntries.mockResolvedValue(activeLocationGrantList());

    render(<ConsentCenterPage />);

    const revokeButton = (await screen.findByRole("button", {
      name: "Revoke",
    })) as HTMLButtonElement;
    fireEvent.click(revokeButton);

    await waitFor(() => {
      expect(mocks.handleLocationRevoke).toHaveBeenCalledTimes(1);
    });
    expect(mocks.handleLocationRevoke).toHaveBeenCalledWith(
      expect.objectContaining({ id: "one_location_grant:grant-1" }),
    );
    expect(mocks.handleRevoke).not.toHaveBeenCalled();
  });

  it("allows a pending location request through the One Location hook", async () => {
    mocks.search = "tab=pending&requestId=one_location_request:req-1";
    mocks.getSummary.mockResolvedValue(
      summaryResponse({ pending: 1, active: 0, previous: 0 }),
    );
    mocks.listEntries.mockResolvedValue(pendingLocationRequestList());

    render(<ConsentCenterPage />);

    const allowButton = (await screen.findByRole("button", {
      name: "Allow",
    })) as HTMLButtonElement;
    fireEvent.click(allowButton);
    await waitFor(() => {
      expect(mocks.handleLocationApprove).toHaveBeenCalledTimes(1);
    });
    expect(mocks.handleLocationApprove).toHaveBeenCalledWith(
      expect.objectContaining({ id: "one_location_request:req-1" }),
      expect.anything(),
    );
    expect(mocks.handleApprove).not.toHaveBeenCalled();
  });

  it("denies a pending location request through the One Location hook", async () => {
    mocks.search = "tab=pending&requestId=one_location_request:req-1";
    mocks.getSummary.mockResolvedValue(
      summaryResponse({ pending: 1, active: 0, previous: 0 }),
    );
    mocks.listEntries.mockResolvedValue(pendingLocationRequestList());

    render(<ConsentCenterPage />);

    const denyButton = (await screen.findByRole("button", {
      name: "Don't allow",
    })) as HTMLButtonElement;
    fireEvent.click(denyButton);
    await waitFor(() => {
      expect(mocks.handleLocationDeny).toHaveBeenCalledTimes(1);
    });
    expect(mocks.handleLocationDeny).toHaveBeenCalledWith(
      expect.objectContaining({ id: "one_location_request:req-1" }),
    );
    expect(mocks.handleDeny).not.toHaveBeenCalled();
  });


  it("keeps non-location active grants on the generic consent revoke flow", async () => {
    mocks.search = "tab=active&requestId=grant-dev-1";
    mocks.getSummary.mockResolvedValue(
      summaryResponse({ pending: 0, active: 1, previous: 0 }),
    );
    mocks.listEntries.mockResolvedValue(activeDeveloperGrantList());

    render(<ConsentCenterPage />);

    const revokeButton = (await screen.findByRole("button", {
      name: "Revoke",
    })) as HTMLButtonElement;
    fireEvent.click(revokeButton);

    await waitFor(() => {
      expect(mocks.handleRevoke).toHaveBeenCalledWith("attr.shopping.receipts.*");
    });
    expect(mocks.handleLocationRevoke).not.toHaveBeenCalled();
  });
});
