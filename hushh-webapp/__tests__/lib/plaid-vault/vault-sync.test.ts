import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { advanceVaultSessionEpoch } from "@/lib/vault/session-epoch";

const client = vi.hoisted(() => ({
  createVaultLinkToken: vi.fn(),
  exchangeVaultPublicToken: vi.fn(),
  fetchVaultSnapshot: vi.fn(),
  removeVaultItem: vi.fn(),
}));
const coordinator = vi.hoisted(() => ({ saveMergedDomain: vi.fn() }));
const domainResource = vi.hoisted(() => ({ prepareDomainWriteContext: vi.fn() }));
const linkLoader = vi.hoisted(() => ({ loadPlaidLink: vi.fn() }));
const pendingSeal = vi.hoisted(() => ({
  recordPendingSeal: vi.fn(),
  clearPendingSeal: vi.fn(),
  recoverPendingSeals: vi.fn(),
}));
const linkPlatform = vi.hoisted(() => ({ value: "ios" as "ios" | "android" | "web" }));
const nativeRuntime = vi.hoisted(() => ({
  isNativePlatform: vi.fn(() => false),
  get: vi.fn(),
}));

vi.mock("@/lib/kai/plaid-vault/vault-client", () => client);
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: (...args: unknown[]) => nativeRuntime.isNativePlatform(...args) } }));
vi.mock("@capacitor/preferences", () => ({ Preferences: { get: (...args: unknown[]) => nativeRuntime.get(...args) } }));
vi.mock("@/lib/services/pkm-write-coordinator", () => ({ PkmWriteCoordinator: coordinator }));
vi.mock("@/lib/capacitor/plaid-link", () => ({ resolvePlaidLinkPlatform: async () => linkPlatform.value }));
vi.mock("@/lib/kai/brokerage/plaid-redirect-uri", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/kai/brokerage/plaid-redirect-uri")>()),
  resolvePlaidRedirectUri: () => "https://uat.one.hushh.ai/one/kai/plaid/oauth/return",
}));
vi.mock("@/lib/kai/brokerage/plaid-link-loader", () => linkLoader);
vi.mock("@/lib/kai/plaid-vault/pending-seal", () => pendingSeal);
vi.mock("@/lib/pkm/pkm-domain-resource", () => ({ PkmDomainResourceService: domainResource }));

import { loadPlaidOAuthResumeSession } from "@/lib/kai/brokerage/plaid-oauth-session";
import {
  buildVaultPlaidStatus,
  completeVaultOAuthReturn,
  connectVaultPlaid,
  createVaultLink,
  PLAID_SANDBOX_PROOF_PREFERENCE_KEY,
  refreshVaultConnections,
  relinkVaultPlaid,
  revokeAllVaultPlaidAtPlaid,
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
const plans: Array<{ domainData: unknown; mergeDecision?: { merge_mode?: string } }> = [];

function saveRunsBuild(current: Record<string, unknown> = {}) {
  coordinator.saveMergedDomain.mockImplementation(async (params: { build: (c: unknown) => unknown }) => {
    const plan = params.build({ currentDomainData: current }) as (typeof plans)[number];
    plans.push(plan);
    return { success: true, fullBlob: { financial: plan.domainData } };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  linkPlatform.value = "ios";
  window.sessionStorage.clear();
  nativeRuntime.isNativePlatform.mockReturnValue(false);
  nativeRuntime.get.mockResolvedValue({ value: null });
  plans.length = 0;
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

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("local Plaid sandbox proof marker", () => {
  it("keeps ordinary Link-token requests unmarked", async () => {
    client.createVaultLinkToken.mockResolvedValue({ link_token: "link-normal", expiration: "x" });
    await createVaultLink({ vaultOwnerToken: "owner" });
    expect(client.createVaultLinkToken).toHaveBeenCalledWith({
      vaultOwnerToken: "owner",
      request: { platform: "ios", redirect_uri: "https://uat.one.hushh.ai/one/kai/plaid/oauth/return" },
    });
  });

  it("marks only a compiled local proof launched with its native one-shot flag", async () => {
    vi.stubEnv("NEXT_PUBLIC_PLAID_SANDBOX_PROOF", "true");
    nativeRuntime.isNativePlatform.mockReturnValue(true);
    nativeRuntime.get.mockResolvedValue({ value: "1" });
    client.createVaultLinkToken.mockResolvedValue({ link_token: "link-proof", expiration: "x" });

    await createVaultLink({ vaultOwnerToken: "owner" });

    expect(nativeRuntime.get).toHaveBeenCalledWith({ key: PLAID_SANDBOX_PROOF_PREFERENCE_KEY });
    expect(client.createVaultLinkToken).toHaveBeenCalledWith({
      vaultOwnerToken: "owner",
      request: {
        platform: "ios",
        redirect_uri: "https://uat.one.hushh.ai/one/kai/plaid/oauth/return",
        sandbox_proof: true,
      },
    });
  });

  it("refuses a proof build or native launch marker that does not match before the request", async () => {
    vi.stubEnv("NEXT_PUBLIC_PLAID_SANDBOX_PROOF", "true");
    await expect(createVaultLink({ vaultOwnerToken: "owner" })).rejects.toThrow(/matching local build/);
    expect(client.createVaultLinkToken).not.toHaveBeenCalled();

    vi.unstubAllEnvs();
    nativeRuntime.isNativePlatform.mockReturnValue(true);
    nativeRuntime.get.mockResolvedValue({ value: "1" });
    await expect(createVaultLink({ vaultOwnerToken: "owner" })).rejects.toThrow(/matching local build/);
    expect(client.createVaultLinkToken).not.toHaveBeenCalled();
  });
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
    // A merged write would keep only the first `entities` map it finds and
    // drop the sealed branches; the vault write replaces the whole domain.
    expect(plans[0]?.mergeDecision?.merge_mode).toBe("replace_domain");
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
    expect(plans[0]?.mergeDecision?.merge_mode).toBe("replace_domain");
    await expect(call.beforeEffect()).resolves.toBeUndefined();
    advanceVaultSessionEpoch();
    await expect(call.beforeEffect()).rejects.toMatchObject({ name: "AbortError" });
  });

  it("runs one background refresh per person at a time", async () => {
    saveRunsBuild(linked);
    const params = { userId: "owner", vaultKey: "vk", vaultOwnerToken: "vot", financial: linked };
    const [first, second] = await Promise.all([refreshVaultConnections(params), refreshVaultConnections(params)]);
    expect(second).toBe(first);
    expect(client.fetchVaultSnapshot).toHaveBeenCalledTimes(1);
    expect(coordinator.saveMergedDomain).toHaveBeenCalledTimes(1);
    // Finished runs do not block the next one.
    await refreshVaultConnections(params);
    expect(client.fetchVaultSnapshot).toHaveBeenCalledTimes(2);
  });

  it("does not write an old vault session after lock and lets a new session refresh", async () => {
    saveRunsBuild(linked);
    let releaseFirst!: (value: ReturnType<typeof snapshot>) => void;
    const delayed = new Promise<ReturnType<typeof snapshot>>((resolve) => { releaseFirst = resolve; });
    client.fetchVaultSnapshot.mockReturnValueOnce(delayed).mockResolvedValueOnce(snapshot());
    const params = { userId: "owner", vaultKey: "vk", vaultOwnerToken: "vot", financial: linked };
    const first = refreshVaultConnections(params);
    await vi.waitFor(() => expect(client.fetchVaultSnapshot).toHaveBeenCalledTimes(1));

    advanceVaultSessionEpoch();
    const second = refreshVaultConnections(params);
    expect(await second).toMatchObject({ refreshed: 1, saved: true });
    releaseFirst(snapshot());
    expect(await first).toMatchObject({ refreshed: 0, saved: false });
    expect(client.fetchVaultSnapshot).toHaveBeenCalledTimes(2);
    expect(coordinator.saveMergedDomain).toHaveBeenCalledTimes(1);
  });

  it("does not report a refresh when the encrypted save fails", async () => {
    coordinator.saveMergedDomain.mockResolvedValue({ success: false });
    const outcome = await refreshVaultConnections({
      userId: "owner", vaultKey: "vk", vaultOwnerToken: "vot", financial: linked,
    });
    expect(outcome).toMatchObject({ refreshed: 0, saved: false });
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

describe("relinking a connection that needs a new login", () => {
  const sealed = {
    connections_v1: {
      item_1: {
        access_token: ACCESS_TOKEN,
        institution_id: "ins_109508",
        institution_name: "First Platypus Bank",
        products: ["transactions"],
        linked_at: "2026-09-01T00:00:00Z",
        transactions_cursor: "cursor-0",
        last_refreshed_at: new Date().toISOString(),
        status: "needs_relink",
      },
    },
  };

  function linkThatEnds(outcome: "success" | "exit") {
    linkLoader.loadPlaidLink.mockResolvedValue({
      create: (config: { onSuccess: (token: string) => void; onExit: (error: null) => void }) => ({
        open: () => (outcome === "success" ? config.onSuccess("public-sandbox-relink") : config.onExit(null)),
        destroy: vi.fn(),
      }),
    });
  }

  beforeEach(() => {
    domainResource.prepareDomainWriteContext.mockResolvedValue({ domainData: sealed });
    client.createVaultLinkToken.mockResolvedValue({ link_token: "link-upd", expiration: "x" });
    saveRunsBuild(sealed);
  });

  it("opens Link in update mode with the sealed token, then forces a refresh", async () => {
    linkThatEnds("success");
    const result = await relinkVaultPlaid({ userId: "owner", vaultKey: "vk", vaultOwnerToken: "vot", itemId: "item_1" });

    expect(result).toEqual({ status: "repaired", refreshed: 1 });
    expect(client.createVaultLinkToken.mock.calls[0]![0].request.access_token).toBe(ACCESS_TOKEN);
    // Update mode never exchanges a new token: the sealed one stays.
    expect(client.exchangeVaultPublicToken).not.toHaveBeenCalled();
    // Forced: the connection was refreshed moments ago and is read anyway.
    expect(client.fetchVaultSnapshot).toHaveBeenCalledTimes(1);
  });

  it("changes nothing when the person closes Link", async () => {
    linkThatEnds("exit");
    const result = await relinkVaultPlaid({ userId: "owner", vaultKey: "vk", vaultOwnerToken: "vot", itemId: "item_1" });

    expect(result).toEqual({ status: "exited" });
    expect(client.fetchVaultSnapshot).not.toHaveBeenCalled();
    expect(coordinator.saveMergedDomain).not.toHaveBeenCalled();
  });

  it("refuses a connection that is not in the vault", async () => {
    const result = await relinkVaultPlaid({ userId: "owner", vaultKey: "vk", vaultOwnerToken: "vot", itemId: "missing" });

    expect(result.status).toBe("blocked");
    expect(client.createVaultLinkToken).not.toHaveBeenCalled();
  });
});

describe("the orphan guard around a seal", () => {
  it("records the token right after the exchange and clears it once saved", async () => {
    saveRunsBuild();
    await sealVaultPlaidConnection({
      userId: "owner",
      vaultKey: "vk",
      vaultOwnerToken: "vot",
      publicToken: "public-sandbox-abc",
      surface: "ios",
    });

    expect(pendingSeal.recordPendingSeal).toHaveBeenCalledWith({
      userId: "owner",
      vaultKey: "vk",
      itemId: "item_1",
      accessToken: ACCESS_TOKEN,
    });
    expect(pendingSeal.clearPendingSeal).toHaveBeenCalledWith({ userId: "owner", vaultKey: "vk", itemId: "item_1" });
  });

  it("disconnects and clears when the save throws", async () => {
    coordinator.saveMergedDomain.mockRejectedValueOnce(new Error("network"));
    await expect(
      sealVaultPlaidConnection({
        userId: "owner",
        vaultKey: "vk",
        vaultOwnerToken: "vot",
        publicToken: "public-sandbox-abc",
        surface: "web",
      }),
    ).rejects.toThrow("network");

    expect(client.removeVaultItem).toHaveBeenCalledWith({ vaultOwnerToken: "vot", accessToken: ACCESS_TOKEN });
    expect(pendingSeal.clearPendingSeal).toHaveBeenCalled();
  });

  it("keeps the record for the next unlock when the disconnect also fails", async () => {
    coordinator.saveMergedDomain.mockResolvedValueOnce({ success: false, message: "conflict" });
    client.removeVaultItem.mockRejectedValueOnce(new Error("offline"));
    await expect(
      sealVaultPlaidConnection({
        userId: "owner",
        vaultKey: "vk",
        vaultOwnerToken: "vot",
        publicToken: "public-sandbox-abc",
        surface: "web",
      }),
    ).rejects.toThrow();

    expect(pendingSeal.clearPendingSeal).not.toHaveBeenCalled();
  });
});

describe("a bank's OAuth login on the web", () => {
  const REDIRECT = "https://uat.one.hushh.ai/one/kai/plaid/oauth/return";
  let received: Array<Record<string, unknown>> = [];

  function linkThat(outcome: "success" | "exit" | "leaves") {
    linkLoader.loadPlaidLink.mockResolvedValue({
      create: (config: Record<string, unknown> & { onSuccess: (t: string) => void; onExit: (e: null) => void }) => {
        received.push(config);
        return {
          // "leaves": the bank takes the page away, so Link never calls back.
          open: () =>
            outcome === "success"
              ? config.onSuccess("public-sandbox-oauth")
              : outcome === "exit"
                ? config.onExit(null)
                : undefined,
          destroy: vi.fn(),
        };
      },
    });
  }

  beforeEach(() => {
    received = [];
    linkPlatform.value = "web";
    client.createVaultLinkToken.mockResolvedValue({ link_token: "link-web", expiration: "x" });
    saveRunsBuild();
  });

  it("sends no redirect URI on native Android, where the SDK hands the login back", async () => {
    linkPlatform.value = "android";
    const link = await createVaultLink({ vaultOwnerToken: "vot" });

    expect(link.redirectUri).toBeNull();
    expect(client.createVaultLinkToken.mock.calls[0]![0].request.redirect_uri).toBeNull();
  });

  it("remembers only the link token before Link leaves the page", async () => {
    linkThat("leaves");
    void connectVaultPlaid({ userId: "owner", vaultKey: "vk", vaultOwnerToken: "vot" });
    await vi.waitFor(() => expect(received).toHaveLength(1));

    const session = loadPlaidOAuthResumeSession();
    expect(session).toMatchObject({ userId: "owner", linkToken: "link-web", redirectUri: REDIRECT });
    expect(JSON.stringify(window.sessionStorage)).not.toContain("access-");
  });

  it("clears the remembered session when Link finishes on the same page", async () => {
    linkThat("exit");
    await connectVaultPlaid({ userId: "owner", vaultKey: "vk", vaultOwnerToken: "vot" });

    expect(loadPlaidOAuthResumeSession()).toBeNull();
  });

  it("finishes on the return page: re-opens Link with the bank's parameters and seals", async () => {
    linkThat("leaves");
    void connectVaultPlaid({ userId: "owner", vaultKey: "vk", vaultOwnerToken: "vot" });
    await vi.waitFor(() => expect(received).toHaveLength(1));
    const session = loadPlaidOAuthResumeSession()!;

    linkThat("success");
    const outcome = await completeVaultOAuthReturn({
      userId: "owner",
      vaultKey: "vk",
      vaultOwnerToken: "vot",
      session,
      currentUrl: "http://localhost:3000/one/kai/plaid/oauth/return?oauth_state_id=abc",
    });

    expect(outcome).toMatchObject({ kind: "connect", result: { status: "connected", itemId: "item_1" } });
    expect(received.at(-1)).toMatchObject({ token: "link-web", receivedRedirectUri: `${REDIRECT}?oauth_state_id=abc` });
    expect(coordinator.saveMergedDomain.mock.calls[0]![0].confirmation.surface).toBe("web");
    // Single use.
    expect(loadPlaidOAuthResumeSession()).toBeNull();
  });

  it("refuses a return started by a different account, without opening Link", async () => {
    linkThat("success");
    const outcome = await completeVaultOAuthReturn({
      userId: "someone-else",
      vaultKey: "vk",
      vaultOwnerToken: "vot",
      session: {
        version: 2,
        userId: "owner",
        linkToken: "link-web",
        redirectUri: REDIRECT,
        returnPath: "/one/kai",
        startedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      currentUrl: `${REDIRECT}?oauth_state_id=abc`,
    });

    expect(outcome.result.status).toBe("blocked");
    expect(received).toHaveLength(0);
    expect(client.exchangeVaultPublicToken).not.toHaveBeenCalled();
  });

  it("finishes a relink with a forced refresh and seals nothing new", async () => {
    domainResource.prepareDomainWriteContext.mockResolvedValue({
      domainData: {
        connections_v1: {
          item_1: {
            access_token: ACCESS_TOKEN,
            institution_id: "ins_109508",
            products: ["transactions"],
            linked_at: "2026-09-01T00:00:00Z",
            transactions_cursor: "cursor-0",
            last_refreshed_at: new Date().toISOString(),
            status: "needs_relink",
          },
        },
      },
    });
    client.fetchVaultSnapshot.mockResolvedValue(snapshot());
    linkThat("success");
    const outcome = await completeVaultOAuthReturn({
      userId: "owner",
      vaultKey: "vk",
      vaultOwnerToken: "vot",
      session: {
        version: 2,
        userId: "owner",
        linkToken: "link-upd",
        redirectUri: REDIRECT,
        returnPath: "/one/kai",
        startedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        relinkItemId: "item_1",
      },
      currentUrl: `${REDIRECT}?oauth_state_id=abc`,
    });

    expect(outcome).toEqual({ kind: "relink", result: { status: "repaired", refreshed: 1 } });
    expect(client.exchangeVaultPublicToken).not.toHaveBeenCalled();
  });
});

describe("revoking every bank before the account is erased", () => {
  const sealedTwo = {
    connections_v1: {
      item_1: { access_token: ACCESS_TOKEN, status: "active" },
      item_2: { access_token: "access-sandbox-second", status: "needs_relink" },
    },
  };

  beforeEach(() => {
    pendingSeal.recoverPendingSeals.mockResolvedValue({ disconnected: 1, alreadySealed: 0, failed: 0 });
  });

  it("removes each sealed connection and any unsaved link, writing nothing back", async () => {
    domainResource.prepareDomainWriteContext.mockResolvedValue({ domainData: sealedTwo });
    client.removeVaultItem.mockResolvedValue({ removed: true });

    const outcome = await revokeAllVaultPlaidAtPlaid({ userId: "owner", vaultKey: "vk", vaultOwnerToken: "vot" });

    expect(outcome).toEqual({ revoked: 3, failed: 0 });
    expect(client.removeVaultItem).toHaveBeenCalledTimes(2);
    expect([...pendingSeal.recoverPendingSeals.mock.calls[0]![0].sealedItemIds]).toEqual(["item_1", "item_2"]);
    expect(coordinator.saveMergedDomain).not.toHaveBeenCalled();
  });

  it("reports a connection Plaid would not remove", async () => {
    domainResource.prepareDomainWriteContext.mockResolvedValue({ domainData: sealedTwo });
    client.removeVaultItem.mockResolvedValueOnce({ removed: true }).mockRejectedValueOnce(new Error("offline"));

    const outcome = await revokeAllVaultPlaidAtPlaid({ userId: "owner", vaultKey: "vk", vaultOwnerToken: "vot" });

    expect(outcome.failed).toBe(1);
  });

  it("has nothing to revoke without a finance record", async () => {
    domainResource.prepareDomainWriteContext.mockResolvedValue({ domainData: null });
    pendingSeal.recoverPendingSeals.mockResolvedValue({ disconnected: 0, alreadySealed: 0, failed: 0 });

    await expect(
      revokeAllVaultPlaidAtPlaid({ userId: "owner", vaultKey: "vk", vaultOwnerToken: "vot" }),
    ).resolves.toEqual({ revoked: 0, failed: 0 });
    expect(client.removeVaultItem).not.toHaveBeenCalled();
  });
});
