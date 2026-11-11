import { afterEach, beforeEach, vi } from "vitest";

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

export { client, coordinator, domainResource, linkLoader, pendingSeal, linkPlatform, nativeRuntime };

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

export const ACCESS_TOKEN = "access-sandbox-0000aaaa-1111-2222-3333-444455556666";

export function snapshot(overrides: Record<string, unknown> = {}) {
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
export const plans: Array<{ domainData: unknown; mergeDecision?: { merge_mode?: string } }> = [];

export function saveRunsBuild(current: Record<string, unknown> = {}) {
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
