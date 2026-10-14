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
  save: vi.fn(),
  epoch: 0,
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
vi.mock("@/lib/vault/session-epoch", () => ({
  snapshotVaultSessionEpoch: () => m.epoch,
  isVaultSessionEpochCurrent: (epoch: number) => epoch === m.epoch,
}));
import { syncLivingSources } from "@/lib/pkm/living-source-sync";
import { DocumentRequestPaymentSourceCapacityError } from "@/lib/services/document-request-payment-source-service";
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
  m.save.mockImplementation(async (p) => {
    await p.beforeEffect();
    const plan = await p.build({ currentDomainData: stored });
    await p.beforeEffect();
    stored = plan.domainData;
    return { success: true };
  });
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
    vi.setSystemTime(new Date("2026-10-15T00:06:01.000Z"));
    m.paymentSnapshot.mockRejectedValue(new Error("network"));
    await expect(syncLivingSources(params)).rejects.toThrow("incomplete");
    await expect(syncLivingSources(params)).rejects.toThrow("incomplete");
    expect(m.paymentSnapshot).toHaveBeenCalledTimes(4);
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
    await syncLivingSources(params);
    const observedAt = inventory().observedAt;
    const previousStored = stored;
    m.save.mockImplementation(async (p) => {
      const plan = await p.build({ currentDomainData: stored });
      expect(plan.unchanged).toBe(true);
      await p.beforeEffect();
      return { success: true, idempotentReplay: true };
    });
    vi.setSystemTime(new Date("2026-10-14T00:01:00.000Z"));
    await syncLivingSources(params);
    expect(stored).toBe(previousStored);
    expect(inventory().observedAt).toBe(observedAt);
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
