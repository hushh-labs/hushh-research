import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  identity: vi.fn(),
  list: vi.fn(),
  fence: vi.fn(),
  save: vi.fn(),
  epoch: 0,
}));
vi.mock("@/lib/services/account-identity-service", () => ({
  AccountIdentityService: { refreshIdentityForSession: m.identity },
}));
vi.mock("@/lib/services/consent-center-service", () => ({
  ConsentCenterService: { listEntries: m.list, sourceFence: m.fence },
}));
vi.mock("@/lib/services/pkm-write-coordinator", () => ({
  PkmWriteCoordinator: { saveMergedDomain: m.save },
}));
vi.mock("@/lib/vault/session-epoch", () => ({
  snapshotVaultSessionEpoch: () => m.epoch,
  isVaultSessionEpochCurrent: (epoch: number) => epoch === m.epoch,
}));
import { syncLivingSources } from "@/lib/pkm/living-source-sync";
import type { LivingSourceInventory } from "@/lib/pkm/living-source-records";
const OWNER = "owner",
  T = "2026-10-11T00:00:00.000Z";
const params = {
  userId: OWNER,
  vaultKey: "fixture-key",
  vaultOwnerToken: "fixture-token",
  idToken: "fixture-id-token",
};
const profile = (name: string, user_id = OWNER) => ({
  user_id,
  display_name: name,
  email: "owner@example.test",
  photo_url: null,
  created_at: T,
  updated_at: T,
});
const entry = (id: string) => ({
  id,
  status: "approved",
  active: true,
  scope: "attr.travel.visits",
  action: "CONSENT_GRANTED",
  issued_at: Date.parse(T),
  expires_at: null,
  counterpart_id: "peer",
  token: "must-not-persist",
  metadata: { private: "must-not-persist" },
});
let stored: Record<string, unknown>;
const inventory = () =>
  (stored._private as { inventory: LivingSourceInventory }).inventory;
beforeEach(() => {
  vi.clearAllMocks();
  m.epoch = 0;
  m.fence.mockResolvedValue("stable");
  stored = {};
  m.identity.mockResolvedValue(profile("Owner"));
  m.list.mockResolvedValue({
    source_read_verified: true,
    user_id: OWNER,
    items: [],
    has_more: false,
  });
  m.save.mockImplementation(async (p) => {
    await p.beforeEffect();
    const plan = await p.build({ currentDomainData: stored });
    await p.beforeEffect();
    stored = plan.domainData;
    return { success: true };
  });
});
it("reads all pages and sent requests with only the explicit presentation projection", async () => {
  m.list.mockImplementation(async ({ surface, requestView, page }) => {
    const received = surface === "pending" && requestView === "received";
    return {
      source_read_verified: true,
      user_id: OWNER,
      items: received
        ? [entry(`received-${page}`)]
        : surface === "pending" && requestView === "sent"
          ? [entry("sent-1")]
          : [],
      has_more: received && page === 1,
    };
  });
  await syncLivingSources(params);
  expect(inventory().complete).toBe(true);
  expect(
    inventory()
      .records.filter((r) => r.kind === "consent")
      .map((r) => r.id),
  ).toEqual(["received-1", "received-2", "sent-1"]);
  expect(JSON.stringify(stored)).not.toContain("must-not-persist");
  expect(m.list).toHaveBeenCalledWith(
    expect.objectContaining({ page: 2, requestView: "received", force: true }),
  );
  expect(m.save).toHaveBeenCalledWith(
    expect.objectContaining({
      domain: "one_living_sources",
      confirmation: {
        authorizationMode: "owner_source_projection",
        surface: "web",
        source: "one_living_memory_source_projection",
      },
    }),
  );
});
it("preserves unavailable sources then recovers and records deletion", async () => {
  m.list.mockResolvedValue({
    source_read_verified: true,
    user_id: OWNER,
    items: [entry("existing")],
    has_more: false,
  });
  await syncLivingSources(params);
  const prior = inventory().records.find((r) => r.id === "existing");
  m.list.mockImplementation(async ({ surface }) => {
    if (surface === "active") throw new Error("offline");
    return {
      source_read_verified: true,
      user_id: OWNER,
      items: [],
      has_more: false,
    };
  });
  await expect(syncLivingSources(params)).rejects.toThrow("incomplete");
  expect(inventory().records.find((r) => r.id === "existing")).toEqual(prior);
  m.list.mockResolvedValue({
    source_read_verified: true,
    user_id: OWNER,
    items: [],
    has_more: false,
  });
  await syncLivingSources(params);
  expect(inventory().complete).toBe(true);
  expect(inventory().records.find((r) => r.id === "existing")).toMatchObject({
    value: {},
    revision: 2,
  });
});
it.each(["wrong-owner", "empty-page", "repeated-page"])(
  "refuses complete inventory after %s",
  async (failure) => {
    m.list.mockResolvedValue({
      source_read_verified: true,
      user_id: failure === "wrong-owner" ? "other" : OWNER,
      items: failure === "repeated-page" ? [entry("loop")] : [],
      has_more: failure !== "wrong-owner",
    });
    await expect(syncLivingSources(params)).rejects.toThrow("incomplete");
    expect(inventory().unavailable).toContain("consent");
    expect(inventory().records.some((r) => r.kind === "consent")).toBe(false);
  },
);
it("rejects a foreign account projection", async () => {
  m.identity.mockResolvedValue(profile("Other", "other"));
  await expect(syncLivingSources(params)).rejects.toThrow("incomplete");
  expect(JSON.stringify(stored)).not.toContain("Other");
});
it("refetches sources after a coordinator conflict", async () => {
  m.identity
    .mockResolvedValueOnce(profile("Old"))
    .mockResolvedValue(profile("New"));
  m.save.mockImplementation(async (p) => {
    await p.build({ currentDomainData: {} });
    const retried = await p.build({ currentDomainData: stored });
    await p.beforeEffect();
    stored = retried.domainData;
    return { success: true };
  });
  await syncLivingSources(params);
  expect(m.identity).toHaveBeenCalledTimes(2);
  expect(
    inventory().records.find((r) => r.kind === "profile")?.value.name,
  ).toBe("New");
});
it("rejects publication after session changes during a read", async () => {
  m.identity.mockImplementation(async () => {
    m.epoch++;
    return profile("Owner");
  });
  await expect(syncLivingSources(params)).rejects.toThrow(
    "Vault session changed",
  );
  expect(stored).toEqual({});
});

it("retains prior records when optional contributors cannot certify completeness", async () => {
  m.list.mockResolvedValue({
    source_read_verified: true,
    user_id: OWNER,
    items: [entry("existing")],
    has_more: false,
  });
  await syncLivingSources(params);
  const prior = inventory().records.find((r) => r.id === "existing");
  m.list.mockResolvedValue({ user_id: OWNER, items: [], has_more: false });
  await expect(syncLivingSources(params)).rejects.toThrow("incomplete");
  expect(inventory().records.find((r) => r.id === "existing")).toEqual(prior);
});
it("retains prior records when offset pages shift during a refresh", async () => {
  m.list.mockResolvedValue({
    source_read_verified: true,
    user_id: OWNER,
    items: [entry("existing")],
    has_more: false,
  });
  await syncLivingSources(params);
  const prior = inventory().records.find((r) => r.id === "existing");
  let scans = 0;
  m.list.mockImplementation(async ({ surface, requestView, page }) => {
    if (surface === "pending" && requestView === "received" && page === 1)
      scans++;
    return {
      source_read_verified: true,
      user_id: OWNER,
      items: surface === "active" && scans === 2 ? [entry("existing")] : [],
      has_more: false,
    };
  });
  await expect(syncLivingSources(params)).rejects.toThrow("incomplete");
  expect(inventory().records.find((r) => r.id === "existing")).toEqual(prior);
});

it("retains records on an ABA mutation even when both page scans omit the same IDs", async () => {
  m.list.mockResolvedValue({
    source_read_verified: true,
    user_id: OWNER,
    items: [entry("live")],
    has_more: false,
  });
  await syncLivingSources(params);
  const prior = inventory().records.find((r) => r.id === "live");
  m.list.mockResolvedValue({
    source_read_verified: true,
    user_id: OWNER,
    items: [],
    has_more: false,
  });
  m.fence.mockResolvedValueOnce("before").mockResolvedValueOnce("after");
  await expect(syncLivingSources(params)).rejects.toThrow("incomplete");
  expect(inventory().records.find((r) => r.id === "live")).toEqual(prior);
});
