import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  identity: vi.fn(),
  list: vi.fn(),
  fence: vi.fn(),
  connections: vi.fn(),
  connectors: vi.fn(),
  earnings: vi.fn(),
  activity: vi.fn(),
  paymentSnapshot: vi.fn(),
  connectorHead: vi.fn(),
  sourceChanges: vi.fn(),
  save: vi.fn(),
  track: vi.fn(),
  epoch: 0,
}));
// Only the sink is replaced; the bucket helpers stay real so the events here
// carry the bands the fleet will see.
vi.mock("@/lib/observability/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/observability/client")>()),
  trackEvent: m.track,
}));
vi.mock("@/lib/services/account-identity-service", () => ({
  AccountIdentityService: { refreshIdentityForSession: m.identity },
}));
vi.mock("@/lib/services/consent-center-service", () => ({
  ConsentCenterService: { listEntries: m.list, sourceFence: m.fence },
}));
vi.mock("@/lib/services/connections-service", () => ({
  ConnectionsService: { listConnectionsPage: m.connections },
}));
vi.mock("@/lib/services/external-connector-service", () => ({
  ExternalConnectorService: { overview: m.connectors },
}));
vi.mock("@/lib/services/document-payout-service", () => ({
  DocumentPayoutService: { earnings: m.earnings },
}));
vi.mock("@/lib/services/payout-activity-service", () => ({
  PayoutActivityService: { list: m.activity },
}));
vi.mock("@/lib/services/document-request-payment-source-service", () => ({
  DocumentRequestPaymentSourceCapacityError: class extends Error {},
  DocumentRequestPaymentSourceService: { snapshot: m.paymentSnapshot },
}));
vi.mock("@/lib/services/pkm-write-coordinator", () => ({
  PkmWriteCoordinator: { saveMergedDomain: m.save },
}));
vi.mock("@/lib/services/source-journal-service", () => ({
  SOURCE_JOURNAL_KINDS: ["profile", "consent", "connection", "document_earning", "payout_activity", "document_request_payment"],
  isSourceJournalCursor: (value: unknown) => typeof value === "string" && /^(0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= 9223372036854775807n,
  SourceJournalService: {
    connectorHead: m.connectorHead,
    sourceChanges: m.sourceChanges,
  },
}));
vi.mock("@/lib/vault/session-epoch", () => ({
  snapshotVaultSessionEpoch: () => m.epoch,
  isVaultSessionEpochCurrent: (epoch: number) => epoch === m.epoch,
}));
import { LivingSourcesIncompleteError, syncLivingSources } from "@/lib/pkm/living-source-sync";
import {
  clearLivingSourceSessionVerification,
  getLivingSourceSessionVerification,
} from "@/lib/pkm/living-source-session-verification";
import { DocumentRequestPaymentSourceCapacityError } from "@/lib/services/document-request-payment-source-service";
import type {
  LivingJournalPending,
  LivingSourceHealth,
  LivingSourceHistory,
  LivingSourceInventory,
} from "@/lib/pkm/living-source-records";
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
const connection = (id: string, userId = "peer") => ({
  connectionId: id,
  userId,
  createdAt: T,
  connectedFromContacts: true,
  displayName: "must-not-persist",
  email: "must-not-persist@example.test",
  photoUrl: "https://example.test/must-not-persist",
  contactPhone: "must-not-persist",
});
const connectionPage = (items: ReturnType<typeof connection>[], page = 1, totalCount = items.length) => ({
  items,
  page,
  hasMore: page * 100 < totalCount,
  totalCount,
  audience: "all" as const,
});
const connector = (status = "connected", connectorId = "google_drive") => ({
  connectorId,
  authStyle: "oauth",
  status,
  connectedAt: T,
  accountLabel: "must-not-persist@example.test",
  accessToken: "must-not-persist",
  scopes: ["must-not-persist"],
  catalogCard: true,
  curatedOAuth: true,
});
const earningId = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const earning = (number: number, stripeMode: "live" | "test" | "legacy" = "live") => ({
  requestId: earningId(number), stripeMode, status: "due",
  grossAmountCents: 300, refundAmountCents: 0, netAmountCents: 260,
  createdAt: T, transferredAt: null, settlementMethod: "stripe_transfer",
  description: "must-not-persist", bankReference: "must-not-persist",
  providerTransferId: "must-not-persist",
});
const earningsPage = (mode: "live" | "test", transactions = [] as ReturnType<typeof earning>[], nextCursor: string | null = null) => ({
  mode, currency: "USD", transactions, nextCursor,
});
const cashOut = (status = "succeeded") => ({
  id: `redemption:${earningId(88)}`, kind: "redemption" as const,
  status, reversalStatus: "none", occurredAt: T, updatedAt: T,
  coinsDelta: -300, amountCents: 300, test: false,
  request: { label: "must-not-persist" },
  bank: { last4: "1234" }, providerTransferId: "tr_must-not-persist",
});
const deposit = () => ({
  id: "deposit:po_PrivateProvider1234", kind: "deposit" as const,
  status: "in_transit", occurredAt: T, updatedAt: T,
  coinsDelta: null, amountCents: 300, test: false,
  expectedArrivalAt: T, bank: { last4: "1234" },
});
const activityPage = (mode: "live" | "test", items: unknown[] = [], nextCursor: string | null = null) => ({
  mode, kind: "all" as const, asOf: T, balanceCoins: 0,
  items, nextCursor, reset: false,
});
const requesterPayment = (status: "paid" | "refunded" = "paid") => ({
  requestId: earningId(501), counterpartRef: `sub_${"a".repeat(32)}`,
  mode: "test" as const, status, amountCents: 300, currency: "USD" as const,
  paidAt: T, refundStatus: status === "refunded" ? "succeeded" : null,
  refundAmountCents: status === "refunded" ? 300 : null,
  reconciliationRequired: false, createdAt: T, updatedAt: T,
});
let stored: Record<string, unknown>;
const inventory = () =>
  (stored._private as { inventory: LivingSourceInventory }).inventory;
type StoredPrivate = Record<string, unknown> & {
  journal_cursors: { connectors: string; events: string };
  journal_pending: LivingJournalPending;
  source_health: LivingSourceHealth;
  observed_history: LivingSourceHistory;
};
const privateData = () => stored._private as StoredPrivate;
const ALL_JOURNAL_KINDS = ["profile", "consent", "connection", "document_earning", "payout_activity", "document_request_payment"];
const quietConnector = (head = "0") => ({
  headCursor: head, changed: false, resetRequired: false, pendingCount: 0, firstOccurredAt: null,
});
const quietEvents = (head = "0") => ({
  headCursor: head, changedKinds: [], resetRequired: false, hints: {}, exact: true,
});
const exactHints = (head: string, counts: Record<string, number>, at = T) => ({
  headCursor: head, changedKinds: Object.keys(counts), resetRequired: false, exact: true,
  hints: Object.fromEntries(Object.entries(counts).map(([kind, count]) =>
    [kind, { count, firstOccurredAt: at, lastOccurredAt: at }])),
});
const collectorCalls = () => ({
  consent: m.list.mock.calls.length,
  connection: m.connections.mock.calls.length,
  connector: m.connectors.mock.calls.length,
  earnings: m.earnings.mock.calls.length,
  activity: m.activity.mock.calls.length,
  payments: m.paymentSnapshot.mock.calls.length,
});
type CollectorCalls = ReturnType<typeof collectorCalls>;
const callsSince = (before: CollectorCalls): CollectorCalls => {
  const after = collectorCalls();
  return Object.fromEntries(Object.entries(after).map(([kind, count]) =>
    [kind, count - before[kind as keyof CollectorCalls]])) as CollectorCalls;
};
const emptyConsent = () => ({ source_read_verified: true, user_id: OWNER, items: [], has_more: false });
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
  m.connections.mockResolvedValue(connectionPage([]));
  m.connectors.mockResolvedValue({
    connectors: [connector("not_connected")], features: {},
  });
  m.earnings.mockImplementation(async (_token, _cursor, mode) =>
    earningsPage(mode));
  m.activity.mockImplementation(async (_token, query) => activityPage(query.mode));
  m.paymentSnapshot.mockResolvedValue([]);
  m.connectorHead.mockResolvedValue(quietConnector());
  m.sourceChanges.mockResolvedValue(quietEvents());
  m.save.mockImplementation(async (p) => {
    await p.beforeEffect();
    const plan = await p.build({ currentDomainData: stored });
    await p.beforeEffect();
    stored = plan.domainData;
    return { success: true };
  });
});

it("commits source and connector cursors with a verified encrypted inventory", async () => {
  m.connectorHead.mockResolvedValue({
    headCursor: "4", changed: true, resetRequired: false, pendingCount: 4, firstOccurredAt: T,
  });
  m.sourceChanges.mockResolvedValue(exactHints("7", { consent: 2, document_request_payment: 1 }));
  await syncLivingSources(params);
  expect((stored._private as Record<string, unknown>).journal_cursors).toEqual({
    connectors: "4", events: "7",
  });
  expect(m.connectors).toHaveBeenCalledTimes(2);
  expect(m.list).toHaveBeenCalled();
  expect(m.paymentSnapshot).toHaveBeenCalledTimes(2);
  expect(m.sourceChanges).toHaveBeenCalledWith(params.vaultOwnerToken, "0");

  m.connectorHead.mockResolvedValue(quietConnector("4"));
  m.sourceChanges.mockResolvedValue(quietEvents("7"));
  await syncLivingSources(params);
  expect(m.connectorHead).toHaveBeenLastCalledWith(params.vaultOwnerToken, "4");
  expect(m.sourceChanges).toHaveBeenLastCalledWith(params.vaultOwnerToken, "7");
});

it("replays an uncommitted hint after incomplete source verification", async () => {
  await syncLivingSources(params);
  m.sourceChanges.mockResolvedValue(exactHints("8", { consent: 1 }));
  m.list.mockRejectedValueOnce(new Error("source unavailable"));
  await expect(syncLivingSources(params)).rejects.toThrow("incomplete");
  // The cursor moves past the hint only in the same encrypted write that keeps
  // its unverified source pending, so the hint is never lost.
  expect(privateData().journal_cursors.events).toBe("8");
  expect(privateData().journal_pending.kinds).toEqual({
    consent: { count: 1, firstOccurredAt: T, lastOccurredAt: T, historySequence: expect.any(Number) },
  });
  m.list.mockResolvedValue(emptyConsent());
  m.sourceChanges.mockResolvedValue(quietEvents("8"));
  const before = collectorCalls();
  await syncLivingSources(params);
  expect(m.sourceChanges).toHaveBeenLastCalledWith(params.vaultOwnerToken, "8");
  expect(callsSince(before).consent).toBeGreaterThan(0);
  expect(privateData().journal_pending.kinds).toEqual({});
});

it("rebuilds sources on reset and can checkpoint a reset stream below its old cursor", async () => {
  await syncLivingSources(params);
  (stored._private as Record<string, unknown>).journal_cursors = {
    connectors: "12", events: "12",
  };
  m.connectorHead.mockResolvedValue({
    headCursor: "3", changed: true, resetRequired: true, pendingCount: null, firstOccurredAt: null,
  });
  m.sourceChanges.mockResolvedValue({
    headCursor: "3", changedKinds: ALL_JOURNAL_KINDS, resetRequired: true, hints: {}, exact: false,
  });
  m.list.mockClear();
  m.paymentSnapshot.mockClear();
  await syncLivingSources(params);
  expect(m.list).toHaveBeenCalled();
  expect(m.paymentSnapshot).toHaveBeenCalledTimes(2);
  expect((stored._private as Record<string, unknown>).journal_cursors).toEqual({
    connectors: "3", events: "3",
  });
});

it("repairs an in-range journal gap by full rescan without trusting hints", async () => {
  // Every source is verified, so only the reset can make it read again.
  const atCursor4 = async () => {
    stored = {};
    m.connectorHead.mockResolvedValue(quietConnector());
    m.sourceChanges.mockResolvedValue(quietEvents());
    await syncLivingSources(params);
    privateData().journal_cursors = { connectors: "4", events: "4" };
    m.connectorHead.mockResolvedValue({
      headCursor: "6", changed: true, resetRequired: true, pendingCount: null, firstOccurredAt: null,
    });
    m.sourceChanges.mockResolvedValue({
      headCursor: "6", changedKinds: ALL_JOURNAL_KINDS, resetRequired: true, hints: {}, exact: false,
    });
    return { calls: collectorCalls(), historySequence: privateData().observed_history.nextSequence };
  };

  const { calls: before } = await atCursor4();
  await syncLivingSources(params);
  expect(callsSince(before)).toEqual({
    consent: 8, connection: 2, connector: 2, earnings: 4, activity: 4, payments: 2,
  });
  expect(privateData().journal_cursors).toEqual({ connectors: "6", events: "6" });
  expect(privateData().journal_pending.kinds).toEqual({});
  expect(JSON.stringify(inventory().records)).not.toMatch(/historySequence|OccurredAt|committedChanges/);

  // A source that fails the rescan stays pending, with an unknown count, in
  // the same write that moves the cursor past the reset.
  const { historySequence } = await atCursor4();
  m.list.mockRejectedValueOnce(new Error("consent offline"));
  await expect(syncLivingSources(params)).rejects.toThrow("incomplete");
  expect(privateData().journal_cursors).toEqual({ connectors: "6", events: "6" });
  expect(privateData().journal_pending.kinds).toEqual({
    consent: { count: null, firstOccurredAt: null, lastOccurredAt: null, historySequence },
  });

  // Negative control: an unreadable journal moves neither its cursor nor the list.
  await atCursor4();
  m.sourceChanges.mockRejectedValueOnce(new Error("journal offline"));
  await syncLivingSources(params);
  expect(privateData().journal_cursors.events).toBe("4");
  expect(privateData().journal_pending.kinds).toEqual({});
});

it("a failing source stays pending while healthy sources and cursors advance", async () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date("2026-10-16T00:00:00.000Z"));
    stored = { _private: { future_field: { kept: true } } };
    m.sourceChanges.mockResolvedValue(exactHints("8", { consent: 1, connection: 1 }));
    m.list.mockRejectedValue(new Error("consent offline"));
    const first = syncLivingSources(params);
    await expect(first).rejects.toBeInstanceOf(LivingSourcesIncompleteError);
    await expect(first).rejects.toMatchObject({ failedKinds: ["consent"] });
    expect(privateData().journal_cursors.events).toBe("8");
    expect(Object.keys(privateData().journal_pending.kinds)).toEqual(["consent"]);
    expect(privateData().future_field).toEqual({ kept: true });

    // No new hints: the pending source alone is read again; the verified one
    // stays inside its window.
    vi.setSystemTime(new Date("2026-10-16T00:01:00.000Z"));
    m.sourceChanges.mockResolvedValue(quietEvents("8"));
    let before = collectorCalls();
    await expect(syncLivingSources(params)).rejects.toThrow("incomplete");
    expect(callsSince(before)).toMatchObject({ consent: 1, connection: 0 });
    expect(Object.keys(privateData().journal_pending.kinds)).toEqual(["consent"]);

    vi.setSystemTime(new Date("2026-10-16T00:03:00.000Z"));
    m.list.mockResolvedValue(emptyConsent());
    before = collectorCalls();
    await syncLivingSources(params);
    expect(callsSince(before)).toMatchObject({ consent: 8, connection: 0 });
    expect(privateData().journal_pending.kinds).toEqual({});
  } finally {
    vi.useRealTimers();
  }
});

it.each([
  ["missing", undefined, []],
  ["another tab's", { version: 1, kinds: { consent: {
    count: 1, firstOccurredAt: T, lastOccurredAt: T, historySequence: 1,
  } } }, ["consent"]],
  ["malformed", "bad", ["consent", "connection", "connector", "earnings", "activity", "payments"]],
] as const)("reads %s pending bookkeeping safely", async (_label, value, rescanned) => {
  await syncLivingSources(params);
  const bookkeeping = stored._private as Record<string, unknown>;
  if (value === undefined) delete bookkeeping.journal_pending;
  else bookkeeping.journal_pending = value;
  const before = collectorCalls();
  await syncLivingSources(params);
  // Missing bookkeeping is empty. A pending source is read again even though
  // this tab verified it recently. Malformed bookkeeping cannot say which
  // hints are unverified, so every source is read again.
  expect(Object.entries(callsSince(before)).filter(([, count]) => count > 0)
    .map(([collector]) => collector)).toEqual(rescanned);
  expect(privateData().journal_pending).toEqual({ version: 1, kinds: {} });
});

it("rescans a source whose forced read failed instead of reusing its older verification", async () => {
  await syncLivingSources(params);
  m.list.mockRejectedValueOnce(new Error("consent offline"));
  await expect(syncLivingSources({ ...params, forceConsent: true })).rejects.toThrow("incomplete");
  const before = collectorCalls();
  await syncLivingSources(params);
  // The earlier consent verification is still inside its window, but a failed
  // read after a change signal can never be reported as current.
  expect(callsSince(before)).toMatchObject({ consent: 8, connection: 0 });
  expect(inventory().complete).toBe(true);
});

it.each([
  [2, ["upsert", "gap"]],
  [1, ["upsert"]],
] as const)("stores %i committed profile changes as only what was verified", async (count, operations) => {
  m.identity.mockResolvedValue(profile("A"));
  await syncLivingSources(params);
  m.identity.mockResolvedValue(profile("C"));
  m.sourceChanges.mockResolvedValue(exactHints("2", { profile: count }));
  await syncLivingSources(params);
  const changes = privateData().observed_history.changes.filter((change) => change.kind === "profile");
  expect(changes.slice(1).map((change) => change.operation)).toEqual(operations);
  expect(changes.slice(1, 2).map((change) => change.value.name)).toEqual(["C"]);
  if (count === 2) expect(changes.at(-1)?.value).toEqual({
    reason: "unobserved_changes", committedChanges: 2, verifiedChanges: 1,
    firstOccurredAt: T, lastOccurredAt: T,
  });
});
it("stores each verified profile correction in the encrypted owner history", async () => {
  m.identity.mockResolvedValue(profile("Ankit Kumar Singh"));
  await syncLivingSources(params);
  m.identity.mockResolvedValue(profile("Ankit"));
  await syncLivingSources(params);
  await syncLivingSources(params);
  const privateData = stored._private as {
    observed_history: { changes: Array<{ kind: string; operation: string; value: Record<string, unknown> }> };
  };
  expect(privateData.observed_history.changes
    .filter(change => change.kind === "profile")
    .map(change => ({ operation: change.operation, name: change.value.name })))
    .toEqual([
      { operation: "upsert", name: "Ankit Kumar Singh" },
      { operation: "upsert", name: "Ankit" },
    ]);
});
it("projects requester document payment status and refund without provider or document details", async () => {
  m.paymentSnapshot.mockResolvedValue([{ ...requesterPayment(),
    stripePaymentIntentId: "pi_must_not_persist", documentName: "must not persist",
    counterpartUserId: "raw-peer",
  }]);
  await syncLivingSources(params);
  expect(m.paymentSnapshot).toHaveBeenCalledTimes(2);
  expect(m.paymentSnapshot).toHaveBeenCalledWith(params.vaultOwnerToken, OWNER);
  const before = inventory().records.find((record) => record.kind === "document_request_payment");
  expect(before).toMatchObject({ id: earningId(501), value: {
    counterpartRef: `sub_${"a".repeat(32)}`, mode: "test", status: "paid",
    amountCents: 300, currency: "USD", paidAt: T,
    refundStatus: null, refundAmountCents: null, reconciliationRequired: false,
  } });
  expect(JSON.stringify(stored)).not.toContain("pi_must_not_persist");
  expect(JSON.stringify(stored)).not.toContain("raw-peer");
  m.paymentSnapshot.mockResolvedValue([requesterPayment("refunded")]);
  await syncLivingSources({ ...params, forceDocumentRequestPayments: true });
  expect(inventory().records.find((record) => record.kind === "document_request_payment"))
    .toMatchObject({ revision: 2, value: { status: "refunded", refundAmountCents: 300 } });
});

it("preserves requester payment history on failed or racing reads, then tombstones after verified absence", async () => {
  m.paymentSnapshot.mockResolvedValue([requesterPayment()]);
  await syncLivingSources(params);
  const prior = inventory().records.find((record) => record.kind === "document_request_payment");
  m.paymentSnapshot.mockRejectedValueOnce(new Error("source unavailable"));
  await expect(syncLivingSources({ ...params, forceDocumentRequestPayments: true }))
    .rejects.toThrow("incomplete");
  expect(inventory().unavailable).toContain("document_request_payment");
  expect(inventory().records.find((record) => record.kind === "document_request_payment"))
    .toEqual(prior);
  const afterFailureCalls = m.paymentSnapshot.mock.calls.length;
  m.paymentSnapshot.mockResolvedValue([requesterPayment()]);
  await syncLivingSources(params);
  expect(m.paymentSnapshot).toHaveBeenCalledTimes(afterFailureCalls + 2);
  expect(inventory().complete).toBe(true);
  m.paymentSnapshot.mockResolvedValueOnce([requesterPayment()]).mockResolvedValueOnce([]);
  await expect(syncLivingSources({ ...params, forceDocumentRequestPayments: true }))
    .rejects.toThrow("incomplete");
  expect(inventory().records.find((record) => record.kind === "document_request_payment"))
    .toEqual(prior);
  m.paymentSnapshot.mockResolvedValue([]);
  await syncLivingSources({ ...params, forceDocumentRequestPayments: true });
  expect(inventory().records.find((record) => record.kind === "document_request_payment"))
    .toMatchObject({ revision: 2, value: {}, deletedAt: expect.any(String) });
});

it("backs off only a requester payment capacity error for five minutes unless a payment hint forces retry", async () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date("2026-10-15T00:00:00.000Z"));
    m.paymentSnapshot.mockRejectedValue(new DocumentRequestPaymentSourceCapacityError("over cap"));
    await expect(syncLivingSources({ ...params, forceDocumentRequestPayments: true }))
      .rejects.toThrow("incomplete");
    expect(m.paymentSnapshot).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date("2026-10-15T00:01:00.000Z"));
    await expect(syncLivingSources(params)).rejects.toThrow("incomplete");
    expect(m.paymentSnapshot).toHaveBeenCalledTimes(1);
    await expect(syncLivingSources({ ...params, forceDocumentRequestPayments: true }))
      .rejects.toThrow("incomplete");
    expect(m.paymentSnapshot).toHaveBeenCalledTimes(2);
    // Other failures never get the five-minute capacity window; a failing
    // source retries after the bounded 60-second delay instead.
    vi.setSystemTime(new Date("2026-10-15T00:06:01.000Z"));
    m.paymentSnapshot.mockRejectedValue(new Error("network"));
    await expect(syncLivingSources(params)).rejects.toThrow("incomplete");
    await expect(syncLivingSources(params)).rejects.toThrow("incomplete");
    expect(m.paymentSnapshot).toHaveBeenCalledTimes(3);
    vi.setSystemTime(new Date("2026-10-15T00:07:02.000Z"));
    await expect(syncLivingSources(params)).rejects.toThrow("incomplete");
    expect(m.paymentSnapshot).toHaveBeenCalledTimes(4);
  } finally {
    vi.useRealTimers();
  }
});

it("bounds retries of a failing source while healthy sources keep their cadence", async () => {
  vi.useFakeTimers();
  try {
    const T0 = Date.parse("2026-10-18T00:00:00.000Z");
    const at = (offsetMs: number) => vi.setSystemTime(T0 + offsetMs);
    const receiptPages = async (_token: string, _cursor: string | undefined, mode: "live" | "test") =>
      earningsPage(mode, mode === "live" ? [earning(1)] : []);
    at(-6 * 60_000);
    m.earnings.mockImplementation(receiptPages);
    await syncLivingSources(params);
    const receipt = inventory().records.find((record) => record.kind === "document_earning");
    m.earnings.mockRejectedValue(new Error("offline"));
    const attempted: boolean[] = [];
    const connectionsScanned: boolean[] = [];
    for (const offset of [0, 30_000, 61_000, 120_000, 182_000, 482_000]) {
      at(offset);
      const before = collectorCalls();
      await expect(syncLivingSources(params)).rejects.toThrow("incomplete");
      const calls = callsSince(before);
      attempted.push(calls.earnings > 0);
      connectionsScanned.push(calls.connection > 0);
      // A waiting source stays unavailable and keeps its records.
      expect(inventory().unavailable).toContain("document_earning");
      expect(inventory().records.find((record) => record.kind === "document_earning")).toEqual(receipt);
    }
    // 60s, 120s and 240s delays, then the five-minute cap.
    expect(attempted).toEqual([true, false, true, false, true, true]);
    // The healthy source keeps its own five-minute cadence.
    expect(connectionsScanned).toEqual([true, false, false, false, false, true]);

    // A new committed hint gets one immediate attempt and stays pending.
    at(483_000);
    m.sourceChanges.mockResolvedValue(exactHints("1", { document_earning: 1 }));
    let before = collectorCalls();
    await expect(syncLivingSources(params)).rejects.toThrow("incomplete");
    expect(callsSince(before).earnings).toBe(1);
    at(484_000);
    m.sourceChanges.mockResolvedValue(quietEvents("1"));
    before = collectorCalls();
    await expect(syncLivingSources(params)).rejects.toThrow("incomplete");
    expect(callsSince(before).earnings).toBe(0);
    expect(Object.keys(privateData().journal_pending.kinds)).toEqual(["document_earning"]);

    // Success clears the delay: the next failure retries after 60s again.
    at(782_000);
    m.earnings.mockImplementation(receiptPages);
    await syncLivingSources(params);
    expect(privateData().journal_pending.kinds).toEqual({});
    m.earnings.mockRejectedValue(new Error("offline"));
    at(1_083_000);
    await expect(syncLivingSources(params)).rejects.toThrow("incomplete");
    at(1_144_000);
    before = collectorCalls();
    await expect(syncLivingSources(params)).rejects.toThrow("incomplete");
    expect(callsSince(before).earnings).toBe(1);
  } finally {
    vi.useRealTimers();
  }
});

it("measures commit-to-encrypted-write lag per source for the owner only", async () => {
  vi.useFakeTimers();
  try {
    let now = Date.parse("2026-10-17T00:00:00.000Z");
    const hintedBefore = (lagMs: number, head: number) => {
      vi.setSystemTime(now);
      m.sourceChanges.mockResolvedValue(
        exactHints(String(head), { consent: 1 }, new Date(now - lagMs).toISOString()));
    };
    m.list.mockResolvedValue({ ...emptyConsent(), items: [entry("grant-1")] });
    hintedBefore(42_000, 1);
    await syncLivingSources(params);
    const health = () => privateData().source_health;
    expect(health()).toEqual({ version: 1, kinds: { consent: {
      lastLagMs: 42_000, lagSamplesMs: [42_000], lastVerifiedAt: new Date(now).toISOString(),
    } } });
    for (let build = 2; build <= 25; build++) {
      now += 1_000;
      hintedBefore(42_000, build);
      await syncLivingSources(params);
    }
    expect(health().kinds.consent?.lagSamplesMs).toHaveLength(20);
    expect(health().kinds.consent?.lagSamplesMs.at(-1)).toBe(42_000);
    // A commit stamped after the write (clock skew) is not a lag sample.
    now += 1_000;
    hintedBefore(-10_000, 26);
    await syncLivingSources(params);
    expect(health().kinds.consent?.lastLagMs).toBeNull();
    expect(health().kinds.consent?.lagSamplesMs).toHaveLength(20);
    expect(JSON.stringify(health())).not.toMatch(/grant-1|must-not-persist|peer|attr\./);
  } finally {
    vi.useRealTimers();
  }
});
it("projects real payout activity metadata without bank or provider details", async () => {
  m.activity.mockImplementation(async (_token, query) => activityPage(query.mode,
    query.mode === "live" ? [
      { ...cashOut(), id: `earning:${earningId(1)}`, kind: "earning" },
      cashOut(), deposit(),
    ] : []));
  await syncLivingSources(params);
  expect(m.activity).toHaveBeenCalledTimes(4);
  const rows = inventory().records.filter((record) => record.kind === "payout_activity");
  expect(rows).toHaveLength(2);
  expect(rows.every((row) => /^(live|test):[a-f0-9]{64}$/.test(row.id))).toBe(true);
  expect(Object.fromEntries(rows.map((row) => [row.value.kind, row.value]))).toEqual({
    redemption: { kind: "redemption", mode: "live", occurredAt: T, updatedAt: T,
      amountCents: 300, coinsDelta: -300, status: "succeeded", reversalStatus: "none" },
    deposit: { kind: "deposit", mode: "live", occurredAt: T, updatedAt: T,
      amountCents: 300, coinsDelta: null, status: "in_transit", expectedArrivalAt: T },
  });
  expect(JSON.stringify(stored)).not.toContain("po_PrivateProvider1234");
  expect(JSON.stringify(stored)).not.toContain("must-not-persist");
  expect(JSON.stringify(stored)).not.toContain("1234");
});

it("retains payout activity on an incomplete scan and tombstones only after two complete scans", async () => {
  m.activity.mockImplementation(async (_token, query) => activityPage(query.mode,
    query.mode === "live" ? [cashOut()] : []));
  await syncLivingSources(params);
  const before = inventory().records.find((record) => record.kind === "payout_activity");
  m.activity.mockImplementation(async (_token, query) => ({
    ...activityPage(query.mode), nextCursor: "incomplete",
  }));
  await expect(syncLivingSources({ ...params, forcePayoutActivity: true })).rejects.toThrow("incomplete");
  expect(inventory().records.find((record) => record.kind === "payout_activity")).toEqual(before);
  m.activity.mockImplementation(async (_token, query) => activityPage(query.mode));
  await syncLivingSources({ ...params, forcePayoutActivity: true });
  expect(inventory().records.find((record) => record.kind === "payout_activity")?.deletedAt).not.toBeNull();
});
it("reads live and test earnings by complete keyset pages with only receipt metadata", async () => {
  const firstPage = Array.from({ length: 20 }, (_, index) => earning(index + 1));
  m.earnings.mockImplementation(async (_token, cursor, mode) => {
    if (mode === "test") return earningsPage("test", [earning(100, "legacy")]);
    return cursor
      ? earningsPage("live", [earning(21)])
      : earningsPage("live", firstPage, earningId(20));
  });
  await syncLivingSources(params);
  expect(m.earnings).toHaveBeenCalledTimes(6);
  expect(m.earnings).toHaveBeenCalledWith(params.vaultOwnerToken, earningId(20), "live");
  const receipts = inventory().records.filter((record) => record.kind === "document_earning");
  expect(receipts).toHaveLength(22);
  expect(receipts.find((record) => record.id === earningId(1))?.value).toEqual({
    requestId: earningId(1), stripeMode: "live", status: "due",
    grossCents: 300, refundCents: 0, netCents: 260,
    createdAt: T, transferredAt: null, settlementMethod: "stripe_transfer",
  });
  expect(JSON.stringify(stored)).not.toContain("must-not-persist");
});

it("keeps per-kind verification times on skipped scans and fails closed when payout freshness expires", async () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date("2026-10-14T00:00:00.000Z"));
    await syncLivingSources(params);
    const verified = { ...inventory().verifiedAt };
    const connectionCalls = m.connections.mock.calls.length;
    const earningCalls = m.earnings.mock.calls.length;
    const consentCalls = m.list.mock.calls.length;
    const connectorCalls = m.connectors.mock.calls.length;
    vi.setSystemTime(new Date("2026-10-14T00:01:00.000Z"));
    await syncLivingSources(params);
    expect(m.connections).toHaveBeenCalledTimes(connectionCalls);
    expect(m.earnings).toHaveBeenCalledTimes(earningCalls);
    expect(m.list).toHaveBeenCalledTimes(consentCalls);
    expect(m.connectors).toHaveBeenCalledTimes(connectorCalls);
    expect(inventory().verifiedAt?.connection).toBe(verified.connection);
    expect(inventory().verifiedAt?.document_earning).toBe(verified.document_earning);
    expect(inventory().verifiedAt?.consent).toBe(verified.consent);
    expect(inventory().verifiedAt?.curated_oauth_connector).toBe(verified.curated_oauth_connector);
    expect(inventory().complete).toBe(true);

    vi.setSystemTime(new Date("2026-10-14T00:05:01.000Z"));
    m.earnings.mockRejectedValue(new Error("offline"));
    await expect(syncLivingSources(params)).rejects.toThrow("incomplete");
    expect(m.connections.mock.calls.length).toBeGreaterThan(connectionCalls);
    expect(m.earnings.mock.calls.length).toBeGreaterThan(earningCalls);
    expect(inventory().verifiedAt?.document_earning).toBe(verified.document_earning);
    expect(inventory().complete).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

it("judges reused sources from when the read began, unless the build outlasts the grace", async () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date("2026-10-14T00:00:00.000Z"));
    await syncLivingSources(params);
    const identity = m.identity.getMockImplementation();
    // Every scan is still reusable at 4:59; this build's profile read takes 30s.
    vi.setSystemTime(new Date("2026-10-14T00:04:59.000Z"));
    m.identity.mockImplementationOnce(async (...args: unknown[]) => {
      vi.setSystemTime(new Date("2026-10-14T00:05:29.000Z"));
      return identity?.(...args);
    });
    await expect(syncLivingSources(params)).resolves.toBeDefined();
    expect(inventory().complete).toBe(true);

    // Negative control: a build longer than the 2-minute grace is judged at
    // write time, so a reused source is never fresh past window plus grace.
    vi.setSystemTime(new Date("2026-10-14T00:09:58.000Z"));
    await syncLivingSources(params);
    vi.setSystemTime(new Date("2026-10-14T00:14:57.000Z"));
    m.identity.mockImplementationOnce(async (...args: unknown[]) => {
      vi.setSystemTime(new Date("2026-10-14T00:17:58.000Z"));
      return identity?.(...args);
    });
    await expect(syncLivingSources(params)).rejects.toThrow("incomplete");
    expect(inventory().complete).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

it("timestamps a long scan at completion so a queued refresh does not repeat it", async () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date("2026-10-14T00:00:00.000Z"));
    let advanced = false;
    m.earnings.mockImplementation(async (_token, _cursor, mode) => {
      if (!advanced) {
        advanced = true;
        vi.setSystemTime(new Date("2026-10-14T00:06:00.000Z"));
      }
      return earningsPage(mode);
    });
    await expect(syncLivingSources(params)).rejects.toThrow("incomplete");
    const verifiedAt = inventory().verifiedAt;
    expect(verifiedAt?.document_earning).toBe("2026-10-14T00:06:00.000Z");
    expect(verifiedAt?.connection).toBe("2026-10-14T00:00:00.000Z");
    expect(inventory().complete).toBe(false);
    const earningsCalls = m.earnings.mock.calls.length;
    const connectionCalls = m.connections.mock.calls.length;
    await expect(syncLivingSources(params)).rejects.toThrow("incomplete");
    expect(m.earnings).toHaveBeenCalledTimes(earningsCalls);
    expect(m.connections).toHaveBeenCalledTimes(connectionCalls);
  } finally {
    vi.useRealTimers();
  }
});

it.each(["connection", "document_earning", "document_request_payment", "curated_oauth_connector", "consent"] as const)(
  "fails incomplete before retained %s history exceeds its bound",
  async (kind) => {
    const limit = kind === "curated_oauth_connector" ? 1_000 : 10_000;
    const previousRecords = Array.from({ length: limit }, (_, index) => ({
      kind, id: `old-${index}`, value: {}, revision: 1,
      createdAt: T, updatedAt: T, capturedAt: T, deletedAt: T,
    }));
    stored = { _private: { inventory: {
      records: previousRecords, complete: true, unavailable: [],
      observedAt: T, verifiedAt: {},
    } } };
    if (kind === "connection")
      m.connections.mockResolvedValue(connectionPage([connection("new-link")], 1, 1));
    else if (kind === "document_earning")
      m.earnings.mockImplementation(async (_token, _cursor, mode) =>
        earningsPage(mode, mode === "live" ? [earning(1)] : []));
    else if (kind === "document_request_payment")
      m.paymentSnapshot.mockResolvedValue([requesterPayment()]);
    else if (kind === "curated_oauth_connector")
      m.connectors.mockResolvedValue({
        connectors: [connector("connected", "new-provider")], features: {},
      });
    if (kind === "consent")
      m.list.mockResolvedValue({
        source_read_verified: true, user_id: OWNER,
        items: [entry("new-consent")], has_more: false,
      });
    await expect(syncLivingSources(params)).rejects.toThrow("incomplete");
    expect(inventory().unavailable).toContain(kind);
    expect(inventory().records.filter((record) => record.kind === kind)).toHaveLength(limit);
    expect(inventory().records.some((record) => record.id === "new-link" ||
      record.id === earningId(1) || record.id === "new-provider" ||
      record.id === "new-consent" || record.id === earningId(501))).toBe(false);
  },
);

it("retains receipts after failed pagination, then tombstones after two empty scans", async () => {
  m.earnings.mockImplementation(async (_token, _cursor, mode) =>
    earningsPage(mode, mode === "live" ? [earning(1)] : []));
  await syncLivingSources(params);
  const prior = inventory().records.find((record) => record.kind === "document_earning");
  m.earnings.mockImplementation(async (_token, _cursor, mode) =>
    mode === "live" ? earningsPage(mode, [], earningId(1)) : earningsPage(mode));
  await expect(syncLivingSources({ ...params, forceDocumentEarnings: true })).rejects.toThrow("incomplete");
  expect(inventory().records.find((record) => record.kind === "document_earning"))
    .toEqual(prior);
  m.earnings.mockImplementation(async (_token, _cursor, mode) => earningsPage(mode));
  await syncLivingSources({ ...params, forceDocumentEarnings: true });
  expect(inventory().records.find((record) => record.kind === "document_earning"))
    .toMatchObject({ revision: 2, value: {}, deletedAt: expect.any(String) });
});

it.each(["shifted", "duplicate", "wrong-mode", "overflow"])(
  "marks %s earnings incomplete without deleting prior receipts",
  async (failure) => {
    m.earnings.mockImplementation(async (_token, _cursor, mode) =>
      earningsPage(mode, mode === "live" ? [earning(1)] : []));
    await syncLivingSources(params);
    const prior = inventory().records.find((record) => record.kind === "document_earning");
    let liveScans = 0;
    m.earnings.mockImplementation(async (_token, cursor, mode) => {
      if (mode === "test") return earningsPage(mode);
      if (!cursor) liveScans++;
      if (failure === "shifted") return earningsPage(mode, [earning(liveScans === 1 ? 2 : 3)]);
      if (failure === "duplicate") return earningsPage(mode, [earning(2), earning(2)]);
      if (failure === "wrong-mode") return earningsPage("test", [earning(2)]);
      const page = cursor ? Number(cursor.slice(-12)) + 1 : 1;
      const rows = Array.from({ length: 20 }, (_, index) => earning((page - 1) * 20 + index + 1));
      return earningsPage(mode, rows, rows.at(-1)!.requestId);
    });
    await expect(syncLivingSources({ ...params, forceDocumentEarnings: true })).rejects.toThrow("incomplete");
    expect(inventory().unavailable).toContain("document_earning");
    expect(inventory().records.find((record) => record.kind === "document_earning"))
      .toEqual(prior);
  },
);
it("records only allowlisted owner OAuth status from a stable overview", async () => {
  m.connectors.mockResolvedValue({
    connectors: [connector(), {
      ...connector("connected", "private_api_key"), authStyle: "api_key",
    }],
    features: {},
  });
  await syncLivingSources(params);
  expect(m.connectors).toHaveBeenCalledTimes(2);
  expect(m.connectors).toHaveBeenCalledWith(params.vaultOwnerToken, {
    sourceRead: true,
  });
  expect(inventory().records.filter((record) => record.kind === "curated_oauth_connector"))
    .toMatchObject([{ id: "google_drive", value: {
      provider: "google_drive", status: "connected",
      connectedAt: T, authStyle: "oauth",
    } }]);
  expect(JSON.stringify(stored)).not.toContain("must-not-persist");
});

it("revises OAuth status and tombstones only after a complete overview", async () => {
  m.connectors.mockResolvedValue({ connectors: [connector()], features: {} });
  await syncLivingSources(params);
  m.connectors.mockResolvedValue({
    connectors: [connector("needs_reauth")], features: {},
  });
  await syncLivingSources({ ...params, forceCuratedConnectors: true });
  expect(inventory().records.find((record) => record.kind === "curated_oauth_connector"))
    .toMatchObject({ revision: 2, value: { status: "needs_reauth" } });
  const prior = inventory().records.find((record) => record.kind === "curated_oauth_connector");
  m.connectors.mockRejectedValue(new Error("Connector source read is incomplete."));
  await expect(syncLivingSources({ ...params, forceCuratedConnectors: true })).rejects.toThrow("incomplete");
  expect(inventory().records.find((record) => record.kind === "curated_oauth_connector"))
    .toEqual(prior);
  m.connectors.mockResolvedValue({ connectors: [], features: {} });
  await syncLivingSources({ ...params, forceCuratedConnectors: true });
  expect(inventory().records.find((record) => record.kind === "curated_oauth_connector"))
    .toMatchObject({ revision: 3, value: {}, deletedAt: expect.any(String) });
});

it.each(["duplicate", "changed", "overflow", "malformed"])(
  "marks connector %s overview incomplete and retains prior rows",
  async (failure) => {
    m.connectors.mockResolvedValue({ connectors: [connector()], features: {} });
    await syncLivingSources(params);
    const prior = inventory().records.find((record) => record.kind === "curated_oauth_connector");
    let scans = 0;
    m.connectors.mockImplementation(async () => {
      scans++;
      return { connectors: failure === "duplicate"
        ? [connector(), connector()]
        : failure === "changed"
          ? [connector(scans === 1 ? "connected" : "revoked")]
          : failure === "overflow"
            ? Array.from({ length: 501 }, (_, index) => connector("connected", `provider-${index}`))
            : [{ ...connector(), status: "unexpected" }], features: {} };
    });
    await expect(syncLivingSources({ ...params, forceCuratedConnectors: true })).rejects.toThrow("incomplete");
    expect(inventory().unavailable).toContain("curated_oauth_connector");
    expect(inventory().records.find((record) => record.kind === "curated_oauth_connector"))
      .toEqual(prior);
  },
);
it("persists an allowlisted complete connection scan across pages", async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) =>
    connection(`connection-${index}`, `peer-${index}`));
  m.connections.mockImplementation(async ({ page }) =>
    page === 1
      ? connectionPage(firstPage, 1, 101)
      : connectionPage([connection("connection-100", "peer-100")], 2, 101));
  await syncLivingSources(params);
  expect(m.connections).toHaveBeenCalledTimes(4);
  expect(m.connections).toHaveBeenCalledWith({
    idToken: params.idToken, page: 2, limit: 100, audience: "all", sourceRead: true,
  });
  const records = inventory().records.filter((record) => record.kind === "connection");
  expect(records).toHaveLength(101);
  expect(records[0]?.value).toEqual({
    counterpartId: "peer-0",
    establishedAt: T,
    connectedFromContacts: true,
  });
  expect(JSON.stringify(stored)).not.toContain("must-not-persist");
});

it("skips a redundant encrypted write when a verified inventory is unchanged", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-14T00:00:00.000Z"));
  try {
    expect(await syncLivingSources(params)).toEqual({ stored: true, recordsChanged: true });
    const observedAt = inventory().observedAt;
    const previousStored = stored;
    m.save.mockImplementation(async (p) => {
      const plan = await p.build({ currentDomainData: stored });
      expect(plan.unchanged).toBe(true);
      await p.beforeEffect();
      return { success: true, idempotentReplay: true };
    });
    vi.setSystemTime(new Date("2026-10-14T00:01:00.000Z"));
    expect(await syncLivingSources(params)).toEqual({ stored: false, recordsChanged: false });
    expect(stored).toBe(previousStored);
    expect(inventory().observedAt).toBe(observedAt);
    // The skipped write still verified the profile in this unlocked session.
    // Reused scans were not verified again, and another vault epoch sees nothing.
    expect(getLivingSourceSessionVerification(OWNER, 0)).toMatchObject({
      profile: "2026-10-14T00:01:00.000Z", consent: "2026-10-14T00:00:00.000Z",
    });
    expect(getLivingSourceSessionVerification(OWNER, 1)).toEqual({});

    // Pending and health bookkeeping belong to the change check: a repaired
    // value is written, never skipped as unchanged.
    const unchangedPlans: boolean[] = [];
    m.save.mockImplementation(async (p) => {
      const plan = await p.build({ currentDomainData: stored });
      unchangedPlans.push(plan.unchanged);
      await p.beforeEffect();
      if (!plan.unchanged) stored = plan.domainData;
      return { success: true };
    });
    for (const [field, value] of [
      ["source_health", { version: 1, kinds: { consent: "bad" } }],
      ["journal_pending", { version: 1, kinds: {}, stray: true }],
    ] as const) {
      (stored._private as Record<string, unknown>)[field] = value;
      unchangedPlans.length = 0;
      await syncLivingSources(params);
      expect(unchangedPlans).toEqual([false]);
      expect((stored._private as Record<string, unknown>)[field]).toEqual({ version: 1, kinds: {} });
    }

    // A failed identity read is not a verification.
    vi.setSystemTime(new Date("2026-10-14T00:02:00.000Z"));
    m.identity.mockRejectedValueOnce(new Error("identity offline"));
    await expect(syncLivingSources(params)).rejects.toThrow("incomplete");
    expect(getLivingSourceSessionVerification(OWNER, 0).profile).toBe("2026-10-14T00:01:00.000Z");
  } finally {
    vi.useRealTimers();
  }
});

it("vouches in the session only for sources whose records this write left unchanged", async () => {
  // The session time is stamped on the cached mirror. Stamped on a source
  // whose records just changed, it called the old values verified at the very
  // check that found them changed, until the rebuild landed.
  vi.useFakeTimers();
  clearLivingSourceSessionVerification();
  const consentList = (status: string) => ({
    ...emptyConsent(), items: [{ ...entry("c1"), status, active: status === "approved" }],
  });
  try {
    vi.setSystemTime(new Date("2026-10-15T10:00:00.000Z"));
    m.list.mockResolvedValue(consentList("approved"));
    expect(await syncLivingSources(params)).toEqual({ stored: true, recordsChanged: true });

    // A routine wake past the five-minute window re-reads consent and finds it
    // revoked. Profile is unchanged, so only profile is vouched for.
    vi.setSystemTime(new Date("2026-10-15T10:06:00.000Z"));
    m.list.mockResolvedValue(consentList("revoked"));
    expect(await syncLivingSources(params)).toEqual({ stored: true, recordsChanged: true });
    expect(inventory().records.find((record) => record.id === "c1")).toMatchObject({ revision: 2 });
    expect(getLivingSourceSessionVerification(OWNER, 0).profile).toBe("2026-10-15T10:06:00.000Z");
    expect(getLivingSourceSessionVerification(OWNER, 0).consent).toBeUndefined();

    // A consent audit row hints consent again and the re-read finds nothing
    // new: no gap marker, only verification bookkeeping, now vouched for.
    vi.setSystemTime(new Date("2026-10-15T10:07:00.000Z"));
    const historyLength = privateData().observed_history.changes.length;
    m.sourceChanges.mockResolvedValue(exactHints("9", { consent: 1 }));
    expect(await syncLivingSources(params)).toEqual({ stored: true, recordsChanged: false });
    expect(privateData().observed_history.changes).toHaveLength(historyLength);
    expect(getLivingSourceSessionVerification(OWNER, 0).consent).toBe("2026-10-15T10:07:00.000Z");

    vi.setSystemTime(new Date("2026-10-15T10:08:00.000Z"));
    m.sourceChanges.mockResolvedValue(quietEvents("9"));
    expect(await syncLivingSources(params)).toEqual({ stored: false, recordsChanged: false });
  } finally {
    vi.useRealTimers();
  }
});

it("retains connections on a failed scan, then tombstones after two complete scans", async () => {
  m.connections.mockResolvedValue(connectionPage([connection("link-1")], 1, 1));
  await syncLivingSources(params);
  const prior = inventory().records.find((record) => record.kind === "connection");
  m.connections.mockResolvedValue(connectionPage([], 1, 1));
  await expect(syncLivingSources({ ...params, forceConnections: true })).rejects.toThrow("incomplete");
  expect(inventory().records.find((record) => record.kind === "connection")).toEqual(prior);
  m.connections.mockResolvedValue(connectionPage([]));
  await syncLivingSources({ ...params, forceConnections: true });
  expect(inventory().records.find((record) => record.kind === "connection")).toMatchObject({
    id: "link-1", revision: 2, deletedAt: expect.any(String), value: {},
  });
});

it.each(["duplicate", "owner", "shifted", "count", "wrong-page", "overflow"])(
  "rejects %s connection scans without deleting prior records",
  async (failure) => {
    m.connections.mockResolvedValue(connectionPage([connection("link-1")], 1, 1));
    await syncLivingSources(params);
    const prior = inventory().records.find((record) => record.kind === "connection");
    let calls = 0;
    m.connections.mockImplementation(async ({ page }) => {
      calls++;
      if (failure === "duplicate")
        return connectionPage([connection("same"), connection("same")], 1, 2);
      if (failure === "owner")
        return connectionPage([connection("self", OWNER)], 1, 1);
      if (failure === "count") return connectionPage([], 1, 1);
      if (failure === "wrong-page") return connectionPage([], 2, 0);
      if (failure === "overflow") return connectionPage([connection("one")], 1, 5_001);
      return connectionPage(calls === 1 ? [connection("one")] : [connection("two")], page, 1);
    });
    await expect(syncLivingSources({ ...params, forceConnections: true })).rejects.toThrow("incomplete");
    expect(inventory().unavailable).toContain("connection");
    expect(inventory().records.find((record) => record.kind === "connection")).toEqual(prior);
  },
);
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
  await expect(syncLivingSources({ ...params, forceConsent: true })).rejects.toThrow("incomplete");
  expect(inventory().records.find((r) => r.id === "existing")).toEqual(prior);
  m.list.mockResolvedValue({
    source_read_verified: true,
    user_id: OWNER,
    items: [],
    has_more: false,
  });
  await syncLivingSources({ ...params, forceConsent: true });
  expect(inventory().complete).toBe(true);
  expect(inventory().records.find((r) => r.id === "existing")).toMatchObject({
    value: {},
    revision: 2,
  });
});
it("marks an oversized consent scan incomplete before adding new records", async () => {
  m.list.mockImplementation(async ({ surface, requestView, page }) => {
    const collecting = surface === "pending" && requestView === "received";
    return {
      source_read_verified: true, user_id: OWNER,
      items: collecting
        ? Array.from({ length: 100 }, (_, index) => entry(`grant-${page}-${index}`))
        : [],
      has_more: collecting && page <= 50,
    };
  });
  await expect(syncLivingSources(params)).rejects.toThrow("incomplete");
  expect(inventory().unavailable).toContain("consent");
  expect(inventory().records.some((record) => record.kind === "consent")).toBe(false);
  expect(m.list.mock.calls.length).toBeLessThanOrEqual(51);
  const firstScanCalls = m.list.mock.calls.length;
  await expect(syncLivingSources(params)).rejects.toThrow("incomplete");
  expect(m.list).toHaveBeenCalledTimes(firstScanCalls);
  await expect(syncLivingSources({ ...params, forceConsent: true })).rejects.toThrow("incomplete");
  expect(m.list.mock.calls.length).toBeGreaterThan(firstScanCalls);
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
  await expect(syncLivingSources({ ...params, forceConsent: true })).rejects.toThrow("incomplete");
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
  await expect(syncLivingSources({ ...params, forceConsent: true })).rejects.toThrow("incomplete");
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
  await expect(syncLivingSources({ ...params, forceConsent: true })).rejects.toThrow("incomplete");
  expect(inventory().records.find((r) => r.id === "live")).toEqual(prior);
});

const sourceChecks = () => m.track.mock.calls.map(([name, payload]) => ({ name, ...payload }));
const checkSummaries = () =>
  sourceChecks().map((check) => `${check.kind}:${check.outcome}:${check.retry_bucket}`);

it("reports one bucketed check per source it read, once per build, and nothing on a quiet wake", async () => {
  vi.useFakeTimers();
  // A vault epoch of its own: retry state left by earlier tests cannot leak in.
  m.epoch = 1019;
  try {
    const T0 = Date.parse("2026-10-19T00:00:00.000Z");
    vi.setSystemTime(T0);
    // Two consent changes committed 42 seconds ago are still waiting.
    m.sourceChanges.mockResolvedValue(
      exactHints("1", { consent: 2 }, new Date(T0 - 42_000).toISOString()));
    m.list.mockResolvedValue({ ...emptyConsent(), items: [entry("grant-1")] });
    await syncLivingSources(params);
    // The first build reads every kind once.
    expect(sourceChecks()).toHaveLength(7);
    expect(new Set(sourceChecks().map((check) => check.kind)).size).toBe(7);
    expect(sourceChecks().find((check) => check.kind === "consent")).toEqual({
      name: "live_memory_source_verified", kind: "consent", outcome: "verified",
      lag_bucket: "lt_1m", pending_bucket: "2_5", retry_bucket: "0",
    });
    expect(sourceChecks().find((check) => check.kind === "profile")).toEqual({
      name: "live_memory_source_verified", kind: "profile", outcome: "verified",
      lag_bucket: "unknown", pending_bucket: "0", retry_bucket: "unknown",
    });
    // Negative control: the sink sees bands and nothing else. The record id
    // "grant-1", its value "attr.travel.visits", the counterpart, the owner,
    // the commit time and the exact lag never leave the sync.
    for (const check of sourceChecks())
      expect(Object.keys(check).sort()).toEqual(
        ["kind", "lag_bucket", "name", "outcome", "pending_bucket", "retry_bucket"]);
    expect(JSON.stringify(m.track.mock.calls))
      .not.toMatch(/grant-1|must-not-persist|attr\.|peer|owner|Owner|2026-|42000|fixture/);

    // A quiet wake a minute later reuses every scan and only re-reads the
    // profile. It wrote nothing and verified nothing new, so it reports nothing.
    m.track.mockClear();
    vi.setSystemTime(T0 + 60_000);
    m.sourceChanges.mockResolvedValue(quietEvents("1"));
    expect(await syncLivingSources(params)).toEqual({ stored: false, recordsChanged: false });
    expect(m.track).not.toHaveBeenCalled();

    // A hinted source that cannot be read reports its backlog as waiting.
    // The reused kinds stay silent; the profile rides along with the write.
    m.track.mockClear();
    vi.setSystemTime(T0 + 120_000);
    m.sourceChanges.mockResolvedValue(
      exactHints("2", { consent: 1 }, new Date(T0 + 100_000).toISOString()));
    m.list.mockRejectedValueOnce(new Error("consent offline"));
    await expect(syncLivingSources(params)).rejects.toThrow("incomplete");
    expect(sourceChecks().map((check) => check.kind)).toEqual(["profile", "consent"]);
    expect(sourceChecks().find((check) => check.kind === "consent")).toMatchObject({
      outcome: "unavailable", lag_bucket: "unknown", pending_bucket: "1", retry_bucket: "0",
    });

    // When it recovers, the lag of that waiting change is measured: six minutes.
    m.track.mockClear();
    vi.setSystemTime(T0 + 100_000 + 6 * 60_000);
    m.sourceChanges.mockResolvedValue(quietEvents("2"));
    m.list.mockResolvedValue(emptyConsent());
    await syncLivingSources(params);
    expect(sourceChecks()).toHaveLength(7);
    expect(sourceChecks().find((check) => check.kind === "consent")).toMatchObject({
      outcome: "verified", lag_bucket: "5m_15m", pending_bucket: "1",
    });

    // A coordinator conflict runs the build twice; each kind is still reported once.
    m.track.mockClear();
    vi.setSystemTime(T0 + 100_000 + 12 * 60_000);
    m.save.mockImplementationOnce(async (p) => {
      await p.build({ currentDomainData: stored });
      const retried = await p.build({ currentDomainData: stored });
      await p.beforeEffect();
      stored = retried.domainData;
      return { success: true };
    });
    await syncLivingSources(params);
    expect(m.identity).toHaveBeenCalledTimes(6);
    expect(sourceChecks()).toHaveLength(7);
    expect(new Set(sourceChecks().map((check) => check.kind)).size).toBe(7);

    // A build that never stores reports nothing.
    m.track.mockClear();
    m.identity.mockImplementationOnce(async () => {
      m.epoch++;
      return profile("Owner");
    });
    await expect(syncLivingSources(params)).rejects.toThrow("Vault session changed");
    expect(m.track).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it("reports nothing when the vault locks or changes owner while the encrypted write is in flight", async () => {
  vi.useFakeTimers();
  // A vault epoch of its own: retry state left by earlier tests cannot leak in.
  m.epoch = 3030;
  const verifiedEvents = () => m.track.mock.calls.filter(([name]) => name === "live_memory_source_verified");
  try {
    const T0 = Date.parse("2026-10-21T00:00:00.000Z");
    vi.setSystemTime(T0);
    m.save.mockImplementationOnce(async (p) => {
      await p.beforeEffect();
      const plan = await p.build({ currentDomainData: stored });
      await p.beforeEffect();
      stored = plan.domainData;
      // The write has landed; the vault locks before the sync resumes.
      m.epoch++;
      return { success: true };
    });
    expect(await syncLivingSources(params)).toEqual({ stored: true, recordsChanged: true });
    expect(verifiedEvents()).toEqual([]);
    // The same fence the session's verification stamp already has.
    expect(getLivingSourceSessionVerification(OWNER, 3030)).toEqual({});
    // Positive control: the next build, in the session now current, reports every check.
    vi.setSystemTime(T0 + 60_000);
    await syncLivingSources(params);
    expect(verifiedEvents()).toHaveLength(7);
  } finally {
    vi.useRealTimers();
  }
});

it("reports a failed read with its retry band, a bound as capped, and a waiting source not at all", async () => {
  vi.useFakeTimers();
  m.epoch = 2020;
  try {
    const T0 = Date.parse("2026-10-20T00:00:00.000Z");
    vi.setSystemTime(T0);
    await syncLivingSources(params);
    // Past the five-minute window every source is read again; earnings is offline.
    m.track.mockClear();
    vi.setSystemTime(T0 + 5 * 60_000 + 1_000);
    m.earnings.mockRejectedValue(new Error("offline"));
    await expect(syncLivingSources(params)).rejects.toThrow("incomplete");
    expect(checkSummaries()).toContain("document_earning:unavailable:0");
    // Thirty seconds on, it is still inside its 60-second delay and every
    // other source is fresh: nothing is read, nothing is written, nothing is reported.
    m.track.mockClear();
    vi.setSystemTime(T0 + 5 * 60_000 + 31_000);
    await expect(syncLivingSources(params)).rejects.toThrow("incomplete");
    expect(m.track).not.toHaveBeenCalled();
    // After the delay it is tried again, with one failure behind it. The
    // write is unchanged, so the profile stays quiet.
    m.track.mockClear();
    vi.setSystemTime(T0 + 5 * 60_000 + 62_000);
    await expect(syncLivingSources(params)).rejects.toThrow("incomplete");
    expect(checkSummaries()).toEqual(["document_earning:unavailable:1"]);
    // Recovery reports how many failed reads it took.
    m.track.mockClear();
    vi.setSystemTime(T0 + 5 * 60_000 + 183_000);
    m.earnings.mockImplementation(async (_token, _cursor, mode) => earningsPage(mode));
    await syncLivingSources(params);
    expect(checkSummaries()).toEqual(["profile:verified:unknown", "document_earning:verified:2_5"]);
    // A source refused at its bound is capped, not unavailable.
    m.track.mockClear();
    m.paymentSnapshot.mockRejectedValue(new DocumentRequestPaymentSourceCapacityError("over cap"));
    await expect(syncLivingSources({ ...params, forceDocumentRequestPayments: true }))
      .rejects.toThrow("incomplete");
    expect(checkSummaries()).toContain("document_request_payment:capped:0");
    expect(JSON.stringify(m.track.mock.calls)).not.toMatch(/over cap|offline/);
  } finally {
    vi.useRealTimers();
  }
});
