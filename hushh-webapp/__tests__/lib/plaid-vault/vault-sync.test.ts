import { beforeEach, describe, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({
  createVaultLinkToken: vi.fn(),
  exchangeVaultPublicToken: vi.fn(),
  fetchVaultSnapshot: vi.fn(),
  removeVaultItem: vi.fn(),
}));
const coordinator = vi.hoisted(() => ({ saveMergedDomain: vi.fn() }));

vi.mock("@/lib/kai/plaid-vault/vault-client", () => client);
vi.mock("@/lib/services/pkm-write-coordinator", () => ({ PkmWriteCoordinator: coordinator }));
vi.mock("@/lib/capacitor/plaid-link", () => ({ resolvePlaidLinkPlatform: async () => "ios" }));
vi.mock("@/lib/kai/brokerage/plaid-redirect-uri", () => ({
  resolvePlaidRedirectUri: () => "https://uat.one.hushh.ai/one/kai/plaid/oauth/return",
}));
vi.mock("@/lib/kai/brokerage/plaid-link-loader", () => ({ loadPlaidLink: vi.fn() }));
vi.mock("@/lib/pkm/pkm-domain-resource", () => ({ PkmDomainResourceService: {} }));

import {
  buildVaultPlaidStatus,
  refreshVaultConnections,
  sealVaultPlaidConnection,
} from "@/lib/kai/plaid-vault/vault-sync";

const ACCESS_TOKEN = "access-sandbox-0000aaaa-1111-2222-3333-444455556666";

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    item: { item_id: "item_1", institution_id: "ins_109508", products: ["transactions"], consented_products: [], error: null },
    accounts: [
      {
        account_id: "acc_chk",
        persistent_account_id: null,
        name: "Plaid Checking",
        official_name: "Plaid Gold Standard 0% Interest Checking",
        mask: "0000",
        type: "depository",
        subtype: "checking",
        balances: { available: 100, current: 110, limit: null, iso_currency_code: "USD" },
      },
    ],
    investments: { unavailable: "PRODUCTS_NOT_SUPPORTED" },
    transactions: { added: [], modified: [], removed: [], next_cursor: "cursor-1", has_more: false, pages: 1 },
    ...overrides,
  };
}

/** Run the coordinator's build against a given current memory, like the real one. */
function saveRunsBuild(current: Record<string, unknown> = {}) {
  coordinator.saveMergedDomain.mockImplementation(async (params: { build: (c: unknown) => unknown }) => {
    const plan = params.build({ currentDomainData: current }) as { domainData: unknown };
    return { success: true, fullBlob: { financial: plan.domainData } };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  client.exchangeVaultPublicToken.mockResolvedValue({
    access_token: ACCESS_TOKEN,
    item_id: "item_1",
    institution: { id: "ins_109508", name: "First Platypus Bank" },
    products: ["transactions"],
    consented_products: ["transactions", "investments"],
  });
  client.fetchVaultSnapshot.mockResolvedValue(snapshot());
  client.removeVaultItem.mockResolvedValue({ removed: true });
});

describe("sealing a new Plaid connection", () => {
  it("puts the token only in the owner-confirmed memory write", async () => {
    saveRunsBuild();
    const sealed = await sealVaultPlaidConnection({
      userId: "owner",
      vaultKey: "vk",
      vaultOwnerToken: "vot",
      publicToken: "public-sandbox-abc",
      surface: "ios",
    });
    const call = coordinator.saveMergedDomain.mock.calls[0]![0];
    expect(call.confirmation).toMatchObject({ confirmedByUser: true, source: "plaid_vault_connect", surface: "ios" });
    const connection = (sealed.financial.connections_v1 ?? {})["item_1"];
    expect(connection?.access_token).toBe(ACCESS_TOKEN);
    expect(connection?.transactions_cursor).toBe("cursor-1");
    expect((sealed.financial.sources as Record<string, unknown>).active_source).toBe("plaid");
    // What the screens receive never carries the token or the cursor.
    const status = JSON.stringify(sealed.status);
    expect(status).not.toContain(ACCESS_TOKEN);
    expect(status).not.toContain("cursor-1");
    expect(status).not.toContain("official_name");
    expect(sealed.status?.custody).toBe("vault");
    expect(client.removeVaultItem).not.toHaveBeenCalled();
  });

  it("disconnects at Plaid when the connection cannot be sealed", async () => {
    coordinator.saveMergedDomain.mockResolvedValue({ success: false, message: "conflict" });
    await expect(
      sealVaultPlaidConnection({
        userId: "owner",
        vaultKey: "vk",
        vaultOwnerToken: "vot",
        publicToken: "public-sandbox-abc",
        surface: "web",
      }),
    ).rejects.toThrow();
    expect(client.removeVaultItem).toHaveBeenCalledWith({ vaultOwnerToken: "vot", accessToken: ACCESS_TOKEN });
  });

  it("follows has_more until every transactions page is read", async () => {
    saveRunsBuild();
    client.fetchVaultSnapshot
      .mockResolvedValueOnce(snapshot({ transactions: { added: [], modified: [], removed: [], next_cursor: "c1", has_more: true, pages: 10 } }))
      .mockResolvedValueOnce(snapshot({ transactions: { added: [], modified: [], removed: [], next_cursor: "c2", has_more: false, pages: 2 } }));
    const sealed = await sealVaultPlaidConnection({
      userId: "owner",
      vaultKey: "vk",
      vaultOwnerToken: "vot",
      publicToken: "public-sandbox-abc",
      surface: "web",
    });
    expect(client.fetchVaultSnapshot).toHaveBeenCalledTimes(2);
    expect(client.fetchVaultSnapshot.mock.calls[1]![0].transactionsCursor).toBe("c1");
    expect(sealed.financial.connections_v1?.["item_1"]?.transactions_cursor).toBe("c2");
  });
});

describe("refreshing on unlock", () => {
  const linked = {
    connections_v1: {
      item_1: {
        access_token: ACCESS_TOKEN,
        institution_id: "ins_109508",
        institution_name: "First Platypus Bank",
        products: ["transactions"],
        linked_at: "2026-09-01T00:00:00Z",
        transactions_cursor: "cursor-0",
        last_refreshed_at: "2026-09-01T00:00:00Z",
        status: "active",
      },
    },
  };

  it("saves under the connected-source receipt, never as the owner's review", async () => {
    saveRunsBuild(linked);
    const outcome = await refreshVaultConnections({
      userId: "owner",
      vaultKey: "vk",
      vaultOwnerToken: "vot",
      financial: linked,
    });
    expect(outcome).toMatchObject({ refreshed: 1, saved: true });
    expect(client.fetchVaultSnapshot.mock.calls[0]![0].transactionsCursor).toBe("cursor-0");
    const call = coordinator.saveMergedDomain.mock.calls[0]![0];
    expect(call.confirmation).toMatchObject({
      authorizationMode: "owner_connected_source_sync",
      connectedSourceProvider: "plaid",
    });
    expect(call.confirmation.confirmedByUser).toBeUndefined();
  });

  it("leaves a connection refreshed moments ago alone", async () => {
    const fresh = {
      connections_v1: {
        item_1: { ...linked.connections_v1.item_1, last_refreshed_at: new Date().toISOString() },
      },
    };
    const outcome = await refreshVaultConnections({ userId: "owner", vaultKey: "vk", vaultOwnerToken: "vot", financial: fresh });
    expect(outcome.refreshed).toBe(0);
    expect(client.fetchVaultSnapshot).not.toHaveBeenCalled();
    expect(coordinator.saveMergedDomain).not.toHaveBeenCalled();
  });
});

describe("status for the finance screens", () => {
  it("is absent without sealed connections", () => {
    expect(buildVaultPlaidStatus({ sources: {} }, "owner")).toBeNull();
  });
});
