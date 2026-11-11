import { afterEach, beforeEach, expect, it, vi } from "vitest";

// Two clients of one owner (two tabs, or a phone and a laptop) are two module
// registries over one stored domain. The save mock follows the coordinator: a
// fresh read per build, an `unchanged` plan writes nothing, and a plan without
// replace semantics is deep-merged, which keeps keys the writer cleared.
const m = vi.hoisted(() => ({
  identity: vi.fn(), list: vi.fn(), fence: vi.fn(), connections: vi.fn(), connectors: vi.fn(),
  earnings: vi.fn(), activity: vi.fn(), paymentSnapshot: vi.fn(), connectorHead: vi.fn(),
  sourceChanges: vi.fn(), save: vi.fn(), epoch: 0,
}));
vi.mock("@/lib/observability/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/observability/client")>()), trackEvent: vi.fn(),
}));
vi.mock("@/lib/services/account-identity-service", () => ({ AccountIdentityService: { refreshIdentityForSession: m.identity } }));
vi.mock("@/lib/services/consent-center-service", () => ({ ConsentCenterService: { listEntries: m.list, sourceFence: m.fence } }));
vi.mock("@/lib/services/connections-service", () => ({ ConnectionsService: { listConnectionsPage: m.connections } }));
vi.mock("@/lib/services/external-connector-service", () => ({ ExternalConnectorService: { overview: m.connectors } }));
vi.mock("@/lib/services/document-payout-service", () => ({ DocumentPayoutService: { earnings: m.earnings } }));
vi.mock("@/lib/services/payout-activity-service", () => ({ PayoutActivityService: { list: m.activity } }));
vi.mock("@/lib/services/document-request-payment-source-service", () => ({
  DocumentRequestPaymentSourceCapacityError: class extends Error {},
  DocumentRequestPaymentSourceService: { snapshot: m.paymentSnapshot },
}));
vi.mock("@/lib/services/pkm-write-coordinator", () => ({ PkmWriteCoordinator: { saveMergedDomain: m.save } }));
vi.mock("@/lib/services/source-journal-service", () => ({
  SOURCE_JOURNAL_KINDS: ["profile", "consent", "connection", "document_earning", "payout_activity", "document_request_payment"],
  isSourceJournalCursor: (value: unknown) => typeof value === "string" && /^(0|[1-9][0-9]{0,18})$/.test(value),
  SourceJournalService: { connectorHead: m.connectorHead, sourceChanges: m.sourceChanges },
}));
vi.mock("@/lib/vault/session-epoch", () => ({
  snapshotVaultSessionEpoch: () => m.epoch,
  isVaultSessionEpochCurrent: (epoch: number) => epoch === m.epoch,
}));
import { buildOwnerLivingFactIndex } from "@/lib/pkm/living-source-fact-index";
import type { LivingSourceHistory, LivingSourceInventory } from "@/lib/pkm/living-source-records";

const OWNER = "owner";
const T0 = Date.parse("2026-10-15T10:00:00.000Z");
const at = (seconds: number) => new Date(T0 + seconds * 1000);
const params = { userId: OWNER, vaultKey: "fixture-key", vaultOwnerToken: "fixture-token", idToken: "fixture-id-token" };
let stored: Record<string, unknown> = {};
let writes = 0;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const deepMerge = (base: unknown, next: unknown): unknown => !isRecord(base) || !isRecord(next) ? next
  : Object.fromEntries([...new Set([...Object.keys(base), ...Object.keys(next)])]
    .map((key) => [key, key in next ? deepMerge(base[key], next[key]) : base[key]]));
const consentList = (status: string) => ({
  source_read_verified: true, user_id: OWNER, has_more: false,
  items: [{ id: "c1", status, active: status === "approved", scope: "attr.travel.visits", action: "CONSENT_GRANTED",
    issued_at: T0, expires_at: null, counterpart_id: "peer" }],
});
const journal = (head: string, counts: Record<string, number> = {}) => ({
  headCursor: head, changedKinds: Object.keys(counts), resetRequired: false, exact: true,
  hints: Object.fromEntries(Object.entries(counts).map(([kind, count]) =>
    [kind, { count, firstOccurredAt: at(0).toISOString(), lastOccurredAt: at(0).toISOString() }])),
});
const pendingKinds = () =>
  Object.keys(((stored._private as { journal_pending?: { kinds?: object } }).journal_pending?.kinds) ?? {});
const storedPrivate = () => stored._private as { inventory: LivingSourceInventory; observed_history: LivingSourceHistory };
async function client() {
  vi.resetModules();
  return {
    sync: await import("@/lib/pkm/living-source-sync"),
    session: await import("@/lib/pkm/living-source-session-verification"),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(at(0));
  stored = {};
  writes = 0;
  m.epoch = 0;
  m.fence.mockResolvedValue("stable");
  m.identity.mockImplementation(async () => ({ user_id: OWNER, display_name: "Owner", email: "owner@example.test",
    photo_url: null, created_at: at(0).toISOString(), updated_at: new Date().toISOString() }));
  m.list.mockResolvedValue(consentList("approved"));
  m.connections.mockResolvedValue({ items: [], page: 1, hasMore: false, totalCount: 0, audience: "all" });
  m.connectors.mockResolvedValue({ connectors: [], features: {} });
  m.earnings.mockImplementation(async (_token: string, _cursor: string, mode: string) =>
    ({ mode, currency: "USD", transactions: [], nextCursor: null }));
  m.activity.mockImplementation(async (_token: string, query: { mode: string }) =>
    ({ mode: query.mode, kind: "all", asOf: at(0).toISOString(), balanceCoins: 0, items: [], nextCursor: null, reset: false }));
  m.paymentSnapshot.mockResolvedValue([]);
  m.connectorHead.mockResolvedValue({ headCursor: "0", changed: false, resetRequired: false, pendingCount: 0, firstOccurredAt: null });
  m.sourceChanges.mockResolvedValue(journal("0"));
  m.save.mockImplementation(async (p) => {
    await p.beforeEffect();
    const plan = await p.build({ currentDomainData: structuredClone(stored) });
    await p.beforeEffect();
    if (!plan.unchanged) {
      stored = structuredClone((plan.mergeDecision?.merge_mode === "replace_domain"
        ? plan.domainData : deepMerge(stored, plan.domainData)) as Record<string, unknown>);
      writes += 1;
    }
    return { success: true };
  });
});

afterEach(() => {
  vi.useRealTimers();
});

it("rebuilds and stops vouching when another client changed the stored records, without writing", async () => {
  const b = await client();
  const a = await client();
  expect(await b.sync.syncLivingSources(params)).toEqual({ stored: true, recordsChanged: true });
  // The other client sees the revocation and stores it.
  vi.setSystemTime(at(30));
  m.list.mockResolvedValue(consentList("revoked"));
  expect(await a.sync.syncLivingSources({ ...params, forceConsent: true })).toEqual({ stored: true, recordsChanged: true });
  // This client's next wake finds the stored inventory already current. Its cached
  // mirror predates the revocation, so it must rebuild, and its session must not
  // call the consent it last showed verified at this check.
  vi.setSystemTime(at(60));
  const before = writes;
  expect(await b.sync.syncLivingSources(params)).toEqual({ stored: false, recordsChanged: true });
  expect(writes).toBe(before);
  expect(b.session.getLivingSourceSessionVerification(OWNER, 0).consent).not.toBe(at(60).toISOString());
  // Having seen the change, the next quiet wake asks for nothing.
  vi.setSystemTime(at(120));
  expect(await b.sync.syncLivingSources(params)).toEqual({ stored: false, recordsChanged: false });
});

it("keeps a client whose clock runs a minute behind current, without rewriting the other client's times", async () => {
  const fast = await client();
  const slow = await client();
  let slowWrites = 0;
  for (let seconds = 0; seconds < 300; seconds += 60) {
    vi.setSystemTime(at(seconds + 90));
    await fast.sync.syncLivingSources(params);
    vi.setSystemTime(at(seconds + 30));
    const before = writes;
    await slow.sync.syncLivingSources(params);
    slowWrites += writes - before;
  }
  expect(slowWrites).toBe(0);
  // The stored profile check is a minute ahead of the slow clock, inside the tolerance.
  const index = buildOwnerLivingFactIndex({ expectedOwnerId: OWNER, inventory: storedPrivate().inventory, now: new Date().toISOString() });
  expect(index.byPredicate.get("profile.__record")?.[0]?.status).toBe("verified");
});

it("rebuilds when another client added history without changing records", async () => {
  const { sync } = await client();
  await sync.syncLivingSources(params);
  // Another client stored a gap marker: the history moved, no record did.
  const history = storedPrivate().observed_history;
  history.changes.push({ sequence: history.nextSequence, kind: "consent", id: "*", revision: 0, operation: "gap",
    capturedAt: at(20).toISOString(), sourceUpdatedAt: null, value: { reason: "journal_gap", committedChanges: 2,
      verifiedChanges: 0, firstOccurredAt: at(10).toISOString(), lastOccurredAt: at(10).toISOString() } });
  history.nextSequence += 1;
  vi.setSystemTime(at(30));
  expect(await sync.syncLivingSources(params)).toEqual({ stored: false, recordsChanged: true });
});

it("treats a record another lineage stored at the same revision as moved", async () => {
  const { sync } = await client();
  await sync.syncLivingSources(params);
  // Concurrent first writes on two devices: the other lineage won with the same
  // revision number for a different value.
  const consent = storedPrivate().inventory.records.find((record) => record.kind === "consent")!;
  consent.value = { ...consent.value, status: "revoked", active: false };
  consent.capturedAt = at(5).toISOString();
  m.list.mockResolvedValue(consentList("revoked"));
  vi.setSystemTime(at(30));
  expect(await sync.syncLivingSources(params)).toEqual({ stored: false, recordsChanged: true });
});

it("keeps every stored key it did not change when it replaces the domain", async () => {
  const { sync } = await client();
  stored = { retained: { kept: true }, _private: { memory_document: { scopeSlices: { slice: { kept: true } } }, other: 1 } };
  await sync.syncLivingSources(params);
  expect(stored.retained).toEqual({ kept: true });
  expect(stored._private).toMatchObject({ other: 1, memory_document: { scopeSlices: { slice: { kept: true } } } });
});

it("clears a verified pending hint from storage, so the next quiet pass writes nothing", async () => {
  const { sync } = await client();
  await sync.syncLivingSources(params);
  vi.setSystemTime(at(10));
  m.sourceChanges.mockResolvedValue(journal("8", { consent: 1 }));
  m.list.mockRejectedValueOnce(new Error("source unavailable"));
  await expect(sync.syncLivingSources(params)).rejects.toThrow("incomplete");
  expect(pendingKinds()).toEqual(["consent"]);
  vi.setSystemTime(at(20));
  m.sourceChanges.mockResolvedValue(journal("8"));
  await sync.syncLivingSources({ ...params, forceConsent: true });
  expect(pendingKinds()).toEqual([]);
  vi.setSystemTime(at(30));
  const before = writes;
  expect(await sync.syncLivingSources(params)).toEqual({ stored: false, recordsChanged: false });
  expect(writes).toBe(before);
});
