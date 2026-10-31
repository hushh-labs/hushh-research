"use client";
import { AccountIdentityService } from "@/lib/services/account-identity-service";
import { ConsentCenterService } from "@/lib/services/consent-center-service";
import { ConnectionsService } from "@/lib/services/connections-service";
import { ExternalConnectorService } from "@/lib/services/external-connector-service";
import { DocumentPayoutService } from "@/lib/services/document-payout-service";
import { PayoutActivityService, type PayoutActivityItem } from "@/lib/services/payout-activity-service";
import {
  DocumentRequestPaymentSourceCapacityError,
  DocumentRequestPaymentSourceService,
} from "@/lib/services/document-request-payment-source-service";
import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";
import {
  isSourceJournalCursor,
  SOURCE_JOURNAL_KINDS,
  SourceJournalService,
} from "@/lib/services/source-journal-service";
import {
  appendJournalGapMarkers,
  appendVerifiedLivingSourceChanges,
  incompleteLivingSourceKinds,
  LIVING_DOMAIN_REPLACE,
  LIVING_VERIFICATION_PERSIST_MS,
  livingSourceWriteDue,
  parseLivingJournalPending,
  parseLivingSourceHealth,
  reconcileLivingSources,
  DOCUMENT_EARNINGS_FRESHNESS_MS,
  PAYOUT_ACTIVITY_FRESHNESS_MS,
  DOCUMENT_REQUEST_PAYMENT_FRESHNESS_MS,
  CONNECTION_FRESHNESS_MS,
  CONSENT_FRESHNESS_MS,
  CURATED_OAUTH_CONNECTOR_FRESHNESS_MS,
  LIVING_SOURCE_KINDS,
  MAX_LIVING_SOURCE_LAG_SAMPLES,
  type LivingJournalPending,
  type LivingSourceHealth,
  type LivingSourceInput,
  type LivingSourceHistory,
  type LivingSourceInventory,
} from "@/lib/pkm/living-source-records";
import { recordLivingSourceSessionVerification } from "@/lib/pkm/living-source-session-verification";
import { LIVE_MIRROR_STALE_GRACE_MS } from "@/lib/pkm/live-mirror-contract";
import {
  emitLiveMemorySourceTelemetry,
  type LiveMemorySourceCheck,
} from "@/lib/pkm/live-mirror-telemetry";
import {
  isVaultSessionEpochCurrent,
  snapshotVaultSessionEpoch,
} from "@/lib/vault/session-epoch";

export const LIVING_SOURCE_DOMAIN = "one_living_sources";
const CONNECTION_PAGE_LIMIT = 100;
const MAX_CONNECTION_RECORDS = 5_000;
const MAX_CONNECTOR_CATALOG_ROWS = 500;
const MAX_RETAINED_CURATED_OAUTH_CONNECTORS = 1_000;
const MAX_DOCUMENT_EARNINGS = 5_000;
const PAYOUT_ACTIVITY_PAGE_LIMIT = 50;
const MAX_PAYOUT_ACTIVITY_RECORDS = 5_000;
const MAX_RETAINED_PAYOUT_ACTIVITY_RECORDS = 10_000;
const MAX_DOCUMENT_REQUEST_PAYMENT_RECORDS = 5_000;
const MAX_RETAINED_DOCUMENT_REQUEST_PAYMENT_RECORDS = 10_000;
const MAX_RETAINED_CONNECTION_RECORDS = 10_000;
const MAX_RETAINED_DOCUMENT_EARNINGS = 10_000;
const MAX_CONSENT_SCAN_ROWS = 5_000;
const MAX_CONSENT_PAGE_READS = 100;
const MAX_RETAINED_CONSENT_RECORDS = 10_000;
type CompletedScan = { epoch: number; verifiedAt: string; completedAt: string };
const lastDocumentEarningsScan = new Map<string, CompletedScan>();
const lastPayoutActivityScan = new Map<string, CompletedScan>();
const lastDocumentRequestPaymentsScan = new Map<string, CompletedScan>();
const lastConnectionScan = new Map<string, CompletedScan>();
const lastConsentScan = new Map<string, CompletedScan>();
const lastCuratedConnectorScan = new Map<string, CompletedScan>();
const lastConsentOverflow = new Map<string, { epoch: number; at: string }>();
const lastDocumentRequestPaymentOverflow = new Map<string, { epoch: number; at: string }>();

type JournalCursors = { connectors: string; events: string };

function readJournalCursors(value: unknown): {
  cursors: JournalCursors;
  stored: Record<string, unknown>;
  invalidConnectors: boolean;
  invalidEvents: boolean;
} {
  const stored = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  return {
    cursors: {
      connectors: isSourceJournalCursor(stored.connectors) ? stored.connectors : "0",
      events: isSourceJournalCursor(stored.events) ? stored.events : "0",
    },
    stored,
    invalidConnectors: stored.connectors !== undefined && !isSourceJournalCursor(stored.connectors),
    invalidEvents: stored.events !== undefined && !isSourceJournalCursor(stored.events),
  };
}

function nextJournalCursor(previous: string, head: string | null, reset: boolean): string {
  if (head === null) return previous;
  return reset || BigInt(head) > BigInt(previous) ? head : previous;
}

/** A source refused at one of its declared bounds, as opposed to one that
 * could not be read. Both leave the source unavailable; only consent and
 * requester payments get a capacity backoff window. */
class SourceCapacityError extends Error {}
class ConsentSourceCapacityError extends SourceCapacityError {}

function canReuseVerifiedScan(params: {
  userId: string;
  epoch: number;
  previousAt?: string;
  observedAt: string;
  maxAge: number;
  forced?: boolean;
  cache: Map<string, CompletedScan>;
}): boolean {
  const cached = params.cache.get(params.userId);
  const age = params.previousAt
    ? Date.parse(params.observedAt) - Date.parse(params.previousAt)
    : Infinity;
  const cooldownAge = cached
    ? Date.parse(params.observedAt) - Date.parse(cached.completedAt)
    : Infinity;
  return !params.forced && cached?.epoch === params.epoch &&
    cached.verifiedAt === params.previousAt && age >= -LIVING_VERIFICATION_PERSIST_MS &&
    (age < params.maxAge || (cooldownAge >= 0 && cooldownAge < params.maxAge));
}

type SourceKind = LivingSourceInput["kind"];
/** Every source except the always-read profile has a scan cache and retries. */
type RetriedKind = Exclude<SourceKind, "profile">;
type JournalHintRange = {
  count: number | null;
  firstOccurredAt: string | null;
  lastOccurredAt: string | null;
};
const UNKNOWN_HINT: JournalHintRange = { count: null, firstOccurredAt: null, lastOccurredAt: null };

const SCAN_CACHES: Record<RetriedKind, Map<string, CompletedScan>> = {
  consent: lastConsentScan,
  connection: lastConnectionScan,
  curated_oauth_connector: lastCuratedConnectorScan,
  document_earning: lastDocumentEarningsScan,
  payout_activity: lastPayoutActivityScan,
  document_request_payment: lastDocumentRequestPaymentsScan,
};
/** Record revisions and history position each owner's tab last stored or
 * confirmed in a vault epoch. Another tab or device can move the stored
 * inventory; a pass that then writes nothing still rebuilds this tab's mirror
 * and never vouches for the kinds that moved under it. */
const LAST_SEEN = new Map<string, { epoch: number; revisions: Map<string, string>; history: number }>();
// capturedAt moves with every revision, so two lineages that both reached a
// revision (concurrent first writes on two devices) still differ.
const recordRevisions = (inventory: LivingSourceInventory | undefined) => new Map((inventory?.records ?? [])
  .map((r) => [`${r.kind}:${r.id}`, `${r.revision}:${r.capturedAt}:${r.deletedAt ?? ""}`]));
/** Drops what a tab saw, with the session verification, when the tab's bridge stops. */
export const clearLivingSourceLastSeen = (userId?: string) =>
  userId === undefined ? LAST_SEEN.clear() : LAST_SEEN.delete(userId);

/** Thrown after the verified sources were stored, when at least one source
 * is still unavailable or outside its freshness window. */
export class LivingSourcesIncompleteError extends Error {
  readonly failedKinds: string[];
  /** Whether that stored write still changed a record or its history. */
  readonly recordsChanged: boolean;
  constructor(failedKinds: readonly string[], recordsChanged = false) {
    super("Source inventory incomplete; retry required");
    this.name = "LivingSourcesIncompleteError";
    this.failedKinds = [...failedKinds];
    this.recordsChanged = recordsChanged;
  }
}

const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 5 * 60_000;
type SourceRetry = { failures: number; lastFailureAt: number };
/** In-memory retry delays for failing sources, fenced by owner and vault
 * epoch. Never persisted; a lock or another owner starts clean. */
const sourceRetries = new Map<string, { epoch: number; kinds: Map<RetriedKind, SourceRetry> }>();

function isRetryDeferred(userId: string, epoch: number, kind: RetriedKind, now: number): boolean {
  const owner = sourceRetries.get(userId);
  const retry = owner?.epoch === epoch ? owner.kinds.get(kind) : undefined;
  if (!retry) return false;
  const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (retry.failures - 1));
  const elapsed = now - retry.lastFailureAt;
  return elapsed >= 0 && elapsed < delay;
}

/** Consecutive failed reads recorded for a source before this attempt. The
 * profile keeps no retry state, so it has no count. */
function priorSourceRetries(userId: string, epoch: number, kind: SourceKind): number | null {
  if (kind === "profile") return null;
  const owner = sourceRetries.get(userId);
  return owner?.epoch === epoch ? owner.kinds.get(kind)?.failures ?? 0 : 0;
}

/** A verified source clears its delay. Consecutive failures double it, from
 * 60 seconds up to five minutes, while the source stays unavailable. */
function recordSourceRetries(params: {
  userId: string;
  epoch: number;
  verified: readonly SourceKind[];
  failed: readonly RetriedKind[];
  previouslyUnavailable: ReadonlySet<string>;
  at: number;
}): void {
  let owner = sourceRetries.get(params.userId);
  if (owner?.epoch !== params.epoch) {
    if (!params.failed.length) {
      sourceRetries.delete(params.userId);
      return;
    }
    owner = { epoch: params.epoch, kinds: new Map() };
    sourceRetries.set(params.userId, owner);
  }
  for (const kind of params.verified) if (kind !== "profile") owner.kinds.delete(kind);
  for (const kind of params.failed) {
    const prior = params.previouslyUnavailable.has(kind) ? owner.kinds.get(kind) : undefined;
    owner.kinds.set(kind, { failures: (prior?.failures ?? 0) + 1, lastFailureAt: params.at });
  }
}

function earlierTime(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return Date.parse(b) < Date.parse(a) ? b : a;
}

function laterTime(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return Date.parse(b) > Date.parse(a) ? b : a;
}

/** Fold this read's journal hints into the encrypted pending list. Counts add
 * up unless either is unknown; a kind keeps the history position where it
 * first became pending. */
function mergeJournalHints(
  pending: LivingJournalPending,
  hints: ReadonlyMap<SourceKind, JournalHintRange>,
  historySequence: number,
): LivingJournalPending {
  const kinds: LivingJournalPending["kinds"] = {};
  for (const kind of LIVING_SOURCE_KINDS) {
    const prior = pending.kinds[kind];
    const hint = hints.get(kind);
    if (!hint) {
      if (prior) kinds[kind] = prior;
      continue;
    }
    kinds[kind] = {
      count: !prior ? hint.count : prior.count === null || hint.count === null ? null
        : Math.min(Number.MAX_SAFE_INTEGER, prior.count + hint.count),
      firstOccurredAt: earlierTime(prior?.firstOccurredAt ?? null, hint.firstOccurredAt),
      lastOccurredAt: laterTime(prior?.lastOccurredAt ?? null, hint.lastOccurredAt),
      historySequence: prior?.historySequence ?? historySequence,
    };
  }
  return { version: 1, kinds };
}

/** Owner-only commit-to-encrypted-write lag for each source verified with a
 * pending hint. A commit time after the write (clock skew) is not a sample. */
function nextSourceHealth(
  health: LivingSourceHealth,
  pending: LivingJournalPending,
  verified: readonly SourceKind[],
  storedAt: string,
): LivingSourceHealth {
  const kinds: LivingSourceHealth["kinds"] = {};
  for (const kind of LIVING_SOURCE_KINDS) {
    const prior = health.kinds[kind];
    const entry = pending.kinds[kind];
    if (!entry || !verified.includes(kind)) {
      if (prior) kinds[kind] = prior;
      continue;
    }
    const lag = entry.firstOccurredAt === null ? NaN
      : Date.parse(storedAt) - Date.parse(entry.firstOccurredAt);
    const measured = Number.isSafeInteger(lag) && lag >= 0;
    kinds[kind] = {
      lastLagMs: measured ? lag : null,
      lagSamplesMs: [...(prior?.lagSamplesMs ?? []), ...(measured ? [lag] : [])]
        .slice(-MAX_LIVING_SOURCE_LAG_SAMPLES),
      lastVerifiedAt: storedAt,
    };
  }
  return { version: 1, kinds };
}

/** Kinds whose records changed in this write (added, revised or tombstoned)
 * or whose history gained an entry. Verification times, cursors, pending
 * hints, health and provenance timestamps are bookkeeping, not changes. */
function changedSourceKinds(
  previous: LivingSourceInventory | null,
  inventory: LivingSourceInventory,
  history: LivingSourceHistory,
  firstNewSequence: number,
): Set<SourceKind> {
  const revisions = new Map(
    (previous?.records ?? []).map((record) => [`${record.kind}:${record.id}`, record.revision] as const),
  );
  const kinds = new Set<SourceKind>();
  for (const record of inventory.records)
    if (revisions.get(`${record.kind}:${record.id}`) !== record.revision) kinds.add(record.kind);
  for (const change of history.changes)
    if (change.sequence >= firstNewSequence) kinds.add(change.kind);
  return kinds;
}

/** The owner-vault earnings API uses a stable (createdAt, requestId) keyset.
 * Scan both mode partitions twice; any gap, duplicate, shift or overflow keeps
 * earlier records and forbids a deletion inference. */
async function collectDocumentEarnings(vaultOwnerToken: string): Promise<LivingSourceInput[]> {
  const scan = async () => {
    const entries: LivingSourceInput[] = [];
    const ids = new Set<string>();
    for (const mode of ["live", "test"] as const) {
      let cursor: string | undefined;
      const seenCursors = new Set<string>();
      for (;;) {
        const response = await DocumentPayoutService.earnings(vaultOwnerToken, cursor, mode);
        if (response.currency !== "USD" || response.mode !== mode ||
            !Array.isArray(response.transactions) || response.transactions.length > 20 ||
            !(response.nextCursor === null || typeof response.nextCursor === "string") ||
            (response.nextCursor !== null &&
              (response.transactions.length !== 20 ||
                response.nextCursor !== response.transactions.at(-1)?.requestId ||
                seenCursors.has(response.nextCursor))))
          throw new Error("Document earnings page could not be verified");
        for (const row of response.transactions) {
          if (
            !row || typeof row.requestId !== "string" || !row.requestId ||
            ids.has(row.requestId) ||
            (mode === "live" ? row.stripeMode !== "live" :
              row.stripeMode !== "test" && row.stripeMode !== "legacy") ||
            typeof row.status !== "string" || !row.status ||
            !Number.isSafeInteger(row.grossAmountCents) || row.grossAmountCents < 0 ||
            (row.refundAmountCents !== null &&
              (!Number.isSafeInteger(row.refundAmountCents) || row.refundAmountCents < 0)) ||
            (row.netAmountCents !== null &&
              (!Number.isSafeInteger(row.netAmountCents) || row.netAmountCents < 0)) ||
            typeof row.createdAt !== "string" ||
            !Number.isFinite(Date.parse(row.createdAt)) ||
            (row.transferredAt !== null &&
              (typeof row.transferredAt !== "string" ||
                !Number.isFinite(Date.parse(row.transferredAt)))) ||
            (row.settlementMethod !== undefined &&
              !["stripe_transfer", "hashcoins"].includes(row.settlementMethod))
          ) throw new Error("Document earning row could not be verified");
          ids.add(row.requestId);
          entries.push({
            kind: "document_earning",
            id: row.requestId,
            createdAt: row.createdAt,
            updatedAt: null,
            value: {
              requestId: row.requestId,
              stripeMode: row.stripeMode,
              status: row.status,
              grossCents: row.grossAmountCents,
              refundCents: row.refundAmountCents,
              netCents: row.netAmountCents,
              createdAt: row.createdAt,
              transferredAt: row.transferredAt,
              settlementMethod: row.settlementMethod ?? null,
            },
          });
        }
        if (entries.length > MAX_DOCUMENT_EARNINGS ||
            (entries.length === MAX_DOCUMENT_EARNINGS && response.nextCursor !== null))
          throw new SourceCapacityError("Document earnings inventory exceeds its safe bound");
        if (response.nextCursor === null) break;
        seenCursors.add(response.nextCursor);
        cursor = response.nextCursor;
      }
    }
    return entries.sort((a, b) => a.id.localeCompare(b.id));
  };
  const first = await scan();
  const second = await scan();
  if (JSON.stringify(first) !== JSON.stringify(second))
    throw new Error("Document earnings changed during pagination; retry required");
  return second;
}

/** Activity IDs can contain a provider deposit ID. Keep only a stable opaque
 * fingerprint in the encrypted inventory; the receipt service remains the
 * authority for any detail the owner chooses to open. */
async function payoutActivitySourceId(mode: "live" | "test", itemId: string): Promise<string> {
  const encoded = new TextEncoder().encode(`payout_activity.v1\0${mode}\0${itemId}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoded));
  return `${mode}:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function payoutActivityValue(item: Exclude<PayoutActivityItem, { kind: "earning" }>): Record<string, unknown> {
  const common = {
    kind: item.kind,
    mode: item.test ? "test" : "live",
    occurredAt: item.occurredAt,
    updatedAt: item.updatedAt,
    amountCents: item.amountCents,
    coinsDelta: item.coinsDelta,
  };
  if (item.kind === "redemption")
    return { ...common, status: item.status, reversalStatus: item.reversalStatus };
  if (item.kind === "deposit")
    return { ...common, status: item.status, expectedArrivalAt: item.expectedArrivalAt };
  return { ...common, type: item.type };
}

/** Read both owner activity partitions twice. A failed or shifting page never
 * licenses deletion of an earlier encrypted record. */
async function collectPayoutActivity(vaultOwnerToken: string): Promise<LivingSourceInput[]> {
  const scan = async () => {
    const entries: LivingSourceInput[] = [];
    const seenItems = new Set<string>();
    let scannedRows = 0;
    for (const mode of ["live", "test"] as const) {
      let cursor: string | undefined;
      const seenCursors = new Set<string>();
      for (;;) {
        const page = await PayoutActivityService.list(vaultOwnerToken, {
          kind: "all", mode, limit: PAYOUT_ACTIVITY_PAGE_LIMIT, cursor,
        }, { sourceRead: true });
        if (page.mode !== mode || page.kind !== "all" || page.reset ||
            page.items.length > PAYOUT_ACTIVITY_PAGE_LIMIT ||
            (page.nextCursor !== null &&
              (page.items.length !== PAYOUT_ACTIVITY_PAGE_LIMIT ||
                seenCursors.has(page.nextCursor))))
          throw new Error("Payout activity page could not be verified");
        scannedRows += page.items.length;
        if (scannedRows > MAX_PAYOUT_ACTIVITY_RECORDS ||
            (scannedRows === MAX_PAYOUT_ACTIVITY_RECORDS && page.nextCursor !== null))
          throw new SourceCapacityError("Payout activity inventory exceeds its safe bound");
        for (const item of page.items) {
          const sourceKey = `${mode}:${item.id}`;
          if (seenItems.has(sourceKey) || item.test !== (mode === "test"))
            throw new Error("Payout activity row could not be verified");
          seenItems.add(sourceKey);
          // Earnings already have the dedicated document_earning projection.
          if (item.kind === "earning") continue;
          entries.push({
            kind: "payout_activity",
            id: await payoutActivitySourceId(mode, item.id),
            createdAt: item.occurredAt,
            updatedAt: item.updatedAt,
            value: payoutActivityValue(item),
          });
        }
        if (page.nextCursor === null) break;
        seenCursors.add(page.nextCursor);
        cursor = page.nextCursor;
      }
    }
    return entries.sort((a, b) => a.id.localeCompare(b.id));
  };
  const first = await scan();
  const second = await scan();
  if (JSON.stringify(first) !== JSON.stringify(second))
    throw new Error("Payout activity changed during pagination; retry required");
  return second;
}

/** This is the requester's own paid document flow. A server-certified bounded
 * snapshot is read twice so an intervening payment change cannot tombstone a
 * previously verified record. No document, provider or raw counterpart ID is copied. */
async function collectDocumentRequestPayments(
  vaultOwnerToken: string,
  userId: string,
): Promise<LivingSourceInput[]> {
  const scan = async () => {
    const rows = await DocumentRequestPaymentSourceService.snapshot(vaultOwnerToken, userId);
    if (rows.length > MAX_DOCUMENT_REQUEST_PAYMENT_RECORDS)
      throw new DocumentRequestPaymentSourceCapacityError("Document request payment inventory exceeds its safe bound");
    const entries: LivingSourceInput[] = [];
    for (const row of rows) {
      entries.push({
        kind: "document_request_payment",
        id: row.requestId,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        value: {
          counterpartRef: row.counterpartRef,
          mode: row.mode,
          status: row.status,
          amountCents: row.amountCents,
          currency: row.currency,
          paidAt: row.paidAt,
          refundStatus: row.refundStatus,
          refundAmountCents: row.refundAmountCents,
          reconciliationRequired: row.reconciliationRequired,
        },
      });
    }
    return entries.sort((a, b) => a.id.localeCompare(b.id));
  };
  const first = await scan();
  const second = await scan();
  if (JSON.stringify(first) !== JSON.stringify(second))
    throw new Error("Document request payments changed during verification; retry required");
  return second;
}

/** The owner-token endpoint returns its complete, unpaginated catalog and
 * owner credential statuses. Strict source-read mode rejects malformed 2xx
 * responses while allowing a genuinely empty catalog. */
async function collectConnectorStatuses(vaultOwnerToken: string): Promise<LivingSourceInput[]> {
  const scan = async () => {
    const overview = await ExternalConnectorService.overview(vaultOwnerToken, {
      sourceRead: true,
    });
    const rows = overview.connectors;
    if (!Array.isArray(rows))
      throw new Error("Connector catalog completeness unverified");
    if (rows.length > MAX_CONNECTOR_CATALOG_ROWS)
      throw new SourceCapacityError("Connector catalog exceeds its safe bound");
    const ids = new Set<string>();
    const entries: LivingSourceInput[] = [];
    for (const row of rows) {
      if (
        !row || typeof row.connectorId !== "string" || !row.connectorId ||
        ids.has(row.connectorId) ||
        !["oauth", "api_key"].includes(row.authStyle) ||
        !["not_connected", "connected", "verifying", "needs_reauth", "revoked", "error"].includes(row.status) ||
        (row.connectedAt != null &&
          (typeof row.connectedAt !== "string" ||
            !Number.isFinite(Date.parse(row.connectedAt))))
      ) throw new Error("Connector catalog row could not be verified");
      ids.add(row.connectorId);
      if (row.authStyle !== "oauth" || row.status === "not_connected" ||
          (row.curatedOAuth !== true && row.connectorId !== "google_drive")) continue;
      entries.push({
        kind: "curated_oauth_connector",
        id: row.connectorId,
        createdAt: row.connectedAt ?? null,
        updatedAt: null,
        value: {
          provider: row.connectorId,
          status: row.status,
          connectedAt: row.connectedAt ?? null,
          authStyle: row.authStyle,
        },
      });
    }
    return entries.sort((a, b) => a.id.localeCompare(b.id));
  };
  const first = await scan();
  const second = await scan();
  if (JSON.stringify(first) !== JSON.stringify(second))
    throw new Error("Connector statuses changed during read; retry required");
  return second;
}

/** Offset pagination has no revision fence. Only matching complete scans may
 * authorize deletion; a concurrent change during either scan fails closed. */
async function collectConnections(params: {
  userId: string;
  idToken: string;
}): Promise<LivingSourceInput[]> {
  const scan = async () => {
    const entries: LivingSourceInput[] = [];
    const connectionIds = new Set<string>();
    const counterpartIds = new Set<string>();
    let expectedCount: number | null = null;
    for (let page = 1; ; page += 1) {
      const response = await ConnectionsService.listConnectionsPage({
        idToken: params.idToken,
        page,
        limit: CONNECTION_PAGE_LIMIT,
        audience: "all",
        sourceRead: true,
      });
      if (Number.isSafeInteger(response.totalCount) && response.totalCount > MAX_CONNECTION_RECORDS)
        throw new SourceCapacityError("Connection inventory exceeds its safe bound");
      if (
        response.page !== page || response.audience !== "all" ||
        !Number.isSafeInteger(response.totalCount) || response.totalCount < 0 ||
        (expectedCount !== null && response.totalCount !== expectedCount) ||
        !Array.isArray(response.items) ||
        response.items.length > CONNECTION_PAGE_LIMIT ||
        typeof response.hasMore !== "boolean"
      ) throw new Error("Connection page could not be verified");
      expectedCount = response.totalCount;
      for (const item of response.items) {
        if (
          !item || typeof item.connectionId !== "string" || !item.connectionId ||
          typeof item.userId !== "string" || !item.userId ||
          item.userId === params.userId ||
          connectionIds.has(item.connectionId) ||
          counterpartIds.has(item.userId) ||
          typeof item.connectedFromContacts !== "boolean" ||
          (item.createdAt !== null &&
            (typeof item.createdAt !== "string" ||
              !Number.isFinite(Date.parse(item.createdAt))))
        ) throw new Error("Connection row could not be verified");
        connectionIds.add(item.connectionId);
        counterpartIds.add(item.userId);
        entries.push({
          kind: "connection",
          id: item.connectionId,
          createdAt: item.createdAt,
          updatedAt: null,
          value: {
            counterpartId: item.userId,
            establishedAt: item.createdAt,
            connectedFromContacts: item.connectedFromContacts,
          },
        });
      }
      if (entries.length > expectedCount ||
          response.hasMore !== (entries.length < expectedCount) ||
          (response.hasMore && response.items.length === 0))
        throw new Error("Connection pagination incomplete");
      if (!response.hasMore) break;
    }
    return entries.sort((a, b) => a.id.localeCompare(b.id));
  };
  const first = await scan();
  const second = await scan();
  if (JSON.stringify(first) !== JSON.stringify(second))
    throw new Error("Connections changed during pagination; retry required");
  return second;
}

export async function syncLivingSources(params: {
  userId: string;
  vaultKey: string;
  vaultOwnerToken: string;
  idToken: string;
  forceDocumentEarnings?: boolean;
  forcePayoutActivity?: boolean;
  forceDocumentRequestPayments?: boolean;
  forceConnections?: boolean;
  forceConsent?: boolean;
  forceCuratedConnectors?: boolean;
}): Promise<{ stored: boolean; recordsChanged: boolean }> {
  const epoch = snapshotVaultSessionEpoch();
  // Whether the encrypted write changed anything. An unchanged sync still
  // verified its sources, which the session verification map records.
  let storedChange = false;
  // A skipped write keeps these stored verification times; scan caches match them.
  let storedVerifiedAt: Record<string, string> = {};
  let movedElsewhere = false;
  let lastSeen: typeof LAST_SEEN extends Map<string, infer V> ? V | undefined : never;
  // Kinds whose records or history this write changed. The cached mirror
  // still shows their old values, so this check cannot vouch for them.
  let changedKinds = new Set<SourceKind>();
  const readStartedAt = new Date().toISOString();
  let storedSnapshotAt = readStartedAt;
  let incompleteKinds: string[] = [];
  let verifiedKinds: SourceKind[] = [];
  let scanFailures: { kind: RetriedKind; counted: boolean }[] = [];
  let previouslyUnavailable = new Set<string>();
  // Telemetry inputs: which kinds this build checked, how each ended and the
  // backlog each cleared or left waiting. Exact numbers stay in this closure.
  let cappedKinds = new Set<RetriedKind>();
  let profileFailed = false;
  let sourceLagMs: Partial<Record<SourceKind, number | null>> = {};
  let sourcePendingCount: Partial<Record<SourceKind, number | null>> = {};
  let earningsScanned = false;
  let payoutActivityScanned = false;
  let documentRequestPaymentsScanned = false;
  let connectionsScanned = false;
  let consentScanned = false;
  let curatedConnectorsScanned = false;
  let earningsVerifiedAt: string | undefined;
  let payoutActivityVerifiedAt: string | undefined;
  let documentRequestPaymentsVerifiedAt: string | undefined;
  let connectionVerifiedAt: string | undefined;
  let consentVerifiedAt: string | undefined;
  let curatedConnectorsVerifiedAt: string | undefined;
  let consentOverflowed = false;
  let documentRequestPaymentOverflowed = false;
  let documentRequestPaymentOverflowCleared = false;
  const ownerForced: Record<RetriedKind, boolean> = {
    consent: Boolean(params.forceConsent),
    connection: Boolean(params.forceConnections),
    curated_oauth_connector: Boolean(params.forceCuratedConnectors),
    document_earning: Boolean(params.forceDocumentEarnings),
    payout_activity: Boolean(params.forcePayoutActivity),
    document_request_payment: Boolean(params.forceDocumentRequestPayments),
  };
  const fetchSources = async (
    previous: LivingSourceInventory | undefined,
    journal: { hinted: ReadonlySet<SourceKind>; pending: ReadonlySet<SourceKind> },
  ) => {
    // A coordinator conflict can run build again. Only the final attempt may
    // publish verification and cooldown state.
    earningsScanned = false;
    payoutActivityScanned = false;
    documentRequestPaymentsScanned = false;
    connectionsScanned = false;
    consentScanned = false;
    curatedConnectorsScanned = false;
    earningsVerifiedAt = undefined;
    payoutActivityVerifiedAt = undefined;
    documentRequestPaymentsVerifiedAt = undefined;
    connectionVerifiedAt = undefined;
    consentVerifiedAt = undefined;
    curatedConnectorsVerifiedAt = undefined;
    consentOverflowed = false;
    documentRequestPaymentOverflowed = false;
    documentRequestPaymentOverflowCleared = false;
    cappedKinds = new Set();
    profileFailed = false;
    const inputs: LivingSourceInput[] = [];
    const successful: string[] = [];
    const unavailable: string[] = [];
    const failed: { kind: RetriedKind; counted: boolean }[] = [];
    // A new journal hint or an owner event gets one immediate attempt. Hints
    // still pending from earlier reads force a rescan too, but a failing
    // source waits out its retry delay first.
    const immediate = (kind: RetriedKind) => ownerForced[kind] || journal.hinted.has(kind);
    const planScan = (
      kind: RetriedKind,
      maxAge: number,
      rescanUnavailable = false,
    ): "reuse" | "defer" | "scan" => {
      if (!rescanUnavailable && canReuseVerifiedScan({
        userId: params.userId, epoch, observedAt: readStartedAt,
        previousAt: previous?.verifiedAt?.[kind],
        maxAge,
        forced: immediate(kind) || journal.pending.has(kind),
        cache: SCAN_CACHES[kind],
      })) return "reuse";
      return !immediate(kind) && previous?.unavailable?.includes(kind) &&
        isRetryDeferred(params.userId, epoch, kind, Date.parse(readStartedAt))
        ? "defer" : "scan";
    };
    const scanFailed = (kind: RetriedKind) => {
      unavailable.push(kind);
      failed.push({ kind, counted: !immediate(kind) });
    };
    try {
      const identity = await AccountIdentityService.refreshIdentityForSession(
        params.userId,
        params.idToken,
        { force: true },
      );
      if (!identity || identity.user_id !== params.userId)
        throw new Error("Identity unavailable");
      inputs.push({
        kind: "profile",
        id: params.userId,
        createdAt: identity.created_at ?? null,
        updatedAt: identity.updated_at ?? identity.last_synced_at ?? null,
        value: {
          name: identity.display_name ?? null,
          photo: identity.photo_url ?? null,
          email: identity.email ?? null,
        },
      });
      successful.push("profile");
    } catch {
      unavailable.push("profile");
      profileFailed = true;
    }
    const overflow = lastConsentOverflow.get(params.userId);
    const overflowAge = overflow ? Date.parse(readStartedAt) - Date.parse(overflow.at) : Infinity;
    const consentPlan = !immediate("consent") && previous?.unavailable?.includes("consent") &&
        overflow?.epoch === epoch &&
        overflowAge >= 0 && overflowAge < CONSENT_FRESHNESS_MS
      ? "defer" : planScan("consent", CONSENT_FRESHNESS_MS);
    if (consentPlan === "defer") unavailable.push("consent");
    else if (consentPlan === "scan") try {
      const startFence = await ConsentCenterService.sourceFence(
        params.idToken,
        params.userId,
      );
      const collectConsent = async () => {
        const entries = new Map<string, LivingSourceInput>();
        let scannedRows = 0;
        let pageReads = 0;
        for (const surface of ["pending", "active", "previous"] as const) {
          for (const requestView of (surface === "pending"
            ? ["received", "sent"]
            : ["received"]) as ("received" | "sent")[]) {
            const seenPages = new Set<string>();
            for (let page = 1; ; page += 1) {
              const response = await ConsentCenterService.listEntries({
                idToken: params.idToken,
                userId: params.userId,
                surface,
                requestView,
                page,
                limit: 100,
                force: true,
                sourceRead: true,
              });
              pageReads++;
              if (pageReads > MAX_CONSENT_PAGE_READS ||
                  !Array.isArray(response.items) || response.items.length > 100)
                throw new ConsentSourceCapacityError("Consent source scan exceeds its safe bound");
              if (response.source_read_verified !== true)
                throw new Error("Source completeness unverified");
              if (response.user_id !== params.userId)
                throw new Error("Owner mismatch");
              const pageSignature = JSON.stringify(
                response.items.map((item) => item.id),
              );
              if (seenPages.has(pageSignature) && response.items.length)
                throw new Error("Repeated source page");
              seenPages.add(pageSignature);
              scannedRows += response.items.length;
              if (scannedRows > MAX_CONSENT_SCAN_ROWS)
                throw new ConsentSourceCapacityError("Consent source scan exceeds its safe bound");
              for (const entry of response.items) {
                // Presentation fields only: tokens, request payloads and provider metadata never enter memory.
                const expired =
                  entry.expires_at &&
                  Number(new Date(entry.expires_at)) < Date.now();
                entries.set(entry.id, {
                  kind: "consent",
                  id: entry.id,
                  createdAt: entry.issued_at
                    ? new Date(entry.issued_at).toISOString()
                    : null,
                  updatedAt: null,
                  value: {
                    scope: entry.scope ?? null,
                    status: expired && entry.active ? "expired" : entry.status,
                    active: expired ? false : entry.active === true,
                    counterpart: entry.counterpart_id ?? null,
                    expiresAt: entry.expires_at ?? null,
                    action: entry.action,
                  },
                });
              }
              if (!response.has_more) break;
              if (!response.items.length)
                throw new Error("Incomplete source pagination");
            }
          }
        }
        return [...entries.values()].sort((a, b) => a.id.localeCompare(b.id));
      };
      const first = await collectConsent();
      const second = await collectConsent();
      const endFence = await ConsentCenterService.sourceFence(
        params.idToken,
        params.userId,
      );
      if (
        startFence !== endFence ||
        JSON.stringify(first) !== JSON.stringify(second)
      )
        throw new Error("Consent changed during pagination; retry required");
      inputs.push(...second);
      successful.push("consent");
      consentScanned = true;
      consentVerifiedAt = new Date().toISOString();
    } catch (error) {
      consentOverflowed = error instanceof ConsentSourceCapacityError;
      if (consentOverflowed) cappedKinds.add("consent");
      scanFailed("consent");
    }
    const connectionPlan = planScan("connection", CONNECTION_FRESHNESS_MS);
    if (connectionPlan === "defer") unavailable.push("connection");
    else if (connectionPlan === "scan") {
      try {
        inputs.push(...await collectConnections(params));
        successful.push("connection");
        connectionsScanned = true;
        connectionVerifiedAt = new Date().toISOString();
      } catch (error) {
        if (error instanceof SourceCapacityError) cappedKinds.add("connection");
        scanFailed("connection");
      }
    }
    const connectorPlan = planScan("curated_oauth_connector", CURATED_OAUTH_CONNECTOR_FRESHNESS_MS);
    if (connectorPlan === "defer") unavailable.push("curated_oauth_connector");
    else if (connectorPlan === "scan") {
      try {
        inputs.push(...await collectConnectorStatuses(params.vaultOwnerToken));
        successful.push("curated_oauth_connector");
        curatedConnectorsScanned = true;
        curatedConnectorsVerifiedAt = new Date().toISOString();
      } catch (error) {
        if (error instanceof SourceCapacityError) cappedKinds.add("curated_oauth_connector");
        scanFailed("curated_oauth_connector");
      }
    }
    const earningsPlan = planScan("document_earning", DOCUMENT_EARNINGS_FRESHNESS_MS);
    if (earningsPlan === "defer") unavailable.push("document_earning");
    else if (earningsPlan === "scan") {
      try {
        inputs.push(...await collectDocumentEarnings(params.vaultOwnerToken));
        successful.push("document_earning");
        earningsScanned = true;
        earningsVerifiedAt = new Date().toISOString();
      } catch (error) {
        if (error instanceof SourceCapacityError) cappedKinds.add("document_earning");
        scanFailed("document_earning");
      }
    }
    const activityPlan = planScan("payout_activity", PAYOUT_ACTIVITY_FRESHNESS_MS);
    if (activityPlan === "defer") unavailable.push("payout_activity");
    else if (activityPlan === "scan") {
      try {
        inputs.push(...await collectPayoutActivity(params.vaultOwnerToken));
        successful.push("payout_activity");
        payoutActivityScanned = true;
        payoutActivityVerifiedAt = new Date().toISOString();
      } catch (error) {
        if (error instanceof SourceCapacityError) cappedKinds.add("payout_activity");
        scanFailed("payout_activity");
      }
    }
    const paymentOverflow = lastDocumentRequestPaymentOverflow.get(params.userId);
    const paymentOverflowAge = paymentOverflow
      ? Date.parse(readStartedAt) - Date.parse(paymentOverflow.at) : Infinity;
    const paymentPlan = !immediate("document_request_payment") &&
        previous?.unavailable?.includes("document_request_payment") &&
        paymentOverflow?.epoch === epoch && paymentOverflowAge >= 0 &&
        paymentOverflowAge < DOCUMENT_REQUEST_PAYMENT_FRESHNESS_MS
      ? "defer"
      : planScan("document_request_payment", DOCUMENT_REQUEST_PAYMENT_FRESHNESS_MS,
        previous?.unavailable?.includes("document_request_payment"));
    if (paymentPlan === "defer") unavailable.push("document_request_payment");
    else if (paymentPlan === "scan") {
      try {
        inputs.push(...await collectDocumentRequestPayments(params.vaultOwnerToken, params.userId));
        successful.push("document_request_payment");
        documentRequestPaymentsScanned = true;
        documentRequestPaymentsVerifiedAt = new Date().toISOString();
      } catch (error) {
        documentRequestPaymentOverflowed = error instanceof DocumentRequestPaymentSourceCapacityError;
        documentRequestPaymentOverflowCleared = !documentRequestPaymentOverflowed;
        if (documentRequestPaymentOverflowed) cappedKinds.add("document_request_payment");
        scanFailed("document_request_payment");
      }
    }
    // Tombstones are retained for owner provenance. Refuse a source update
    // before its encrypted retained history grows beyond its declared bound.
    for (const [kind, limit] of [
      ["connection", MAX_RETAINED_CONNECTION_RECORDS],
      ["document_earning", MAX_RETAINED_DOCUMENT_EARNINGS],
      ["payout_activity", MAX_RETAINED_PAYOUT_ACTIVITY_RECORDS],
      ["document_request_payment", MAX_RETAINED_DOCUMENT_REQUEST_PAYMENT_RECORDS],
      ["curated_oauth_connector", MAX_RETAINED_CURATED_OAUTH_CONNECTORS],
      ["consent", MAX_RETAINED_CONSENT_RECORDS],
    ] as const) {
      const retained = new Set(
        (previous?.records ?? []).filter((record) => record.kind === kind)
          .map((record) => record.id),
      );
      for (const input of inputs) if (input.kind === kind) retained.add(input.id);
      if (retained.size <= limit) continue;
      for (let index = inputs.length - 1; index >= 0; index--) {
        if (inputs[index]?.kind === kind) inputs.splice(index, 1);
      }
      const successfulIndex = successful.indexOf(kind);
      if (successfulIndex >= 0) {
        successful.splice(successfulIndex, 1);
        failed.push({ kind, counted: !immediate(kind) });
      }
      if (!unavailable.includes(kind)) unavailable.push(kind);
      cappedKinds.add(kind);
      if (kind === "connection") connectionsScanned = false;
      if (kind === "document_earning") earningsScanned = false;
      if (kind === "payout_activity") payoutActivityScanned = false;
      if (kind === "document_request_payment") {
        documentRequestPaymentsScanned = false;
        documentRequestPaymentOverflowed = true;
      }
      if (kind === "consent") {
        consentScanned = false;
        consentOverflowed = true;
      }
      if (kind === "curated_oauth_connector") curatedConnectorsScanned = false;
    }
    return { inputs, successful, unavailable, failed };
  };
  if (!isVaultSessionEpochCurrent(epoch)) return { stored: false, recordsChanged: false };
  const result = await PkmWriteCoordinator.saveMergedDomain({
    ...params,
    domain: LIVING_SOURCE_DOMAIN,
    confirmation: {
      authorizationMode: "owner_source_projection",
      surface: "web",
      source: "one_living_memory_source_projection",
    },
    beforeEffect: async () => {
      if (!isVaultSessionEpochCurrent(epoch))
        throw new Error("Vault session changed");
    },
    build: async (context) => {
      const current = context.currentDomainData ?? {};
      const privateData = (current._private ?? {}) as Record<string, unknown>;
      const previous = privateData.inventory as
        LivingSourceInventory | undefined;
      const priorHistory =
        (privateData.observed_history as LivingSourceHistory | undefined) ?? null;
      // Read replay cursors from this CAS-consistent decrypted domain, never
      // from device storage. A competing tab may have advanced them already.
      const persisted = readJournalCursors(privateData.journal_cursors);
      // Missing bookkeeping is empty. Malformed bookkeeping cannot say which
      // hints are still unverified, so every source is read again.
      const storedPending = parseLivingJournalPending(privateData.journal_pending);
      const hints = new Map<SourceKind, JournalHintRange>();
      if (!storedPending) for (const kind of LIVING_SOURCE_KINDS) hints.set(kind, UNKNOWN_HINT);
      if (persisted.invalidConnectors) hints.set("curated_oauth_connector", UNKNOWN_HINT);
      if (persisted.invalidEvents) for (const kind of SOURCE_JOURNAL_KINDS) hints.set(kind, UNKNOWN_HINT);
      let connectorHead: string | null = null;
      let connectorReset = false;
      try {
        const connector = await SourceJournalService.connectorHead(
          params.vaultOwnerToken, persisted.cursors.connectors,
        );
        connectorHead = connector.headCursor;
        connectorReset = connector.resetRequired;
        if ((connector.changed || connector.resetRequired) && !hints.has("curated_oauth_connector"))
          hints.set("curated_oauth_connector", connector.resetRequired ? UNKNOWN_HINT : {
            count: connector.pendingCount,
            firstOccurredAt: connector.firstOccurredAt,
            lastOccurredAt: null,
          });
      } catch {
        // A failed hint read cannot advance a cursor. Periodic authoritative
        // verification remains available while this journal is unavailable.
      }
      let eventsHead: string | null = null;
      let eventsReset = false;
      try {
        const changes = await SourceJournalService.sourceChanges(
          params.vaultOwnerToken, persisted.cursors.events,
        );
        eventsHead = changes.headCursor;
        eventsReset = changes.resetRequired;
        for (const kind of changes.changedKinds) {
          if (hints.has(kind)) continue;
          // A reset or a replay cut short cannot count its hints.
          const hint = changes.exact ? changes.hints[kind] : undefined;
          hints.set(kind, hint ? {
            count: hint.count,
            firstOccurredAt: hint.firstOccurredAt,
            lastOccurredAt: hint.lastOccurredAt,
          } : UNKNOWN_HINT);
        }
      } catch {
        // Retry this cursor on the next wake. Never infer a source value from
        // an unavailable or malformed journal page.
      }
      const pending = mergeJournalHints(
        storedPending ?? { version: 1, kinds: {} },
        hints,
        priorHistory?.nextSequence ?? 1,
      );
      const { inputs, successful, unavailable, failed } = await fetchSources(previous, {
        hinted: new Set(hints.keys()),
        pending: new Set(LIVING_SOURCE_KINDS.filter((kind) => storedPending?.kinds[kind])),
      });
      if (!isVaultSessionEpochCurrent(epoch))
        throw new Error("Vault session changed");
      // A long keyset read is fresh when it finishes. Timestamping the start
      // would immediately trigger another full scan if it exceeded five minutes.
      storedSnapshotAt = new Date().toISOString();
      // A source judged reusable when this read began stays fresh for this
      // build, unless the build outlasted the read-time grace: then ages are
      // measured at write time, so no source counts fresh past window + grace.
      const freshnessAt = Date.parse(storedSnapshotAt) - Date.parse(readStartedAt) <= LIVE_MIRROR_STALE_GRACE_MS
        ? readStartedAt : storedSnapshotAt;
      const inventory = reconcileLivingSources(
        previous ?? null,
        inputs,
        successful,
        unavailable,
        storedSnapshotAt,
        {
          connection: connectionVerifiedAt,
          document_earning: earningsVerifiedAt,
          payout_activity: payoutActivityVerifiedAt,
          document_request_payment: documentRequestPaymentsVerifiedAt,
          consent: consentVerifiedAt,
          curated_oauth_connector: curatedConnectorsVerifiedAt,
        },
        freshnessAt,
      );
      incompleteKinds = incompleteLivingSourceKinds(inventory, freshnessAt);
      verifiedKinds = LIVING_SOURCE_KINDS.filter((kind) => successful.includes(kind));
      scanFailures = failed;
      previouslyUnavailable = new Set(previous?.unavailable ?? []);
      // Only verified source revisions enter the encrypted observed history.
      // Journal hints choose scans and never become facts; a gap marker only
      // counts the committed changes this history did not capture.
      const history = appendJournalGapMarkers(
        appendVerifiedLivingSourceChanges(priorHistory, previous ?? null, inventory),
        pending,
        verifiedKinds,
        storedSnapshotAt,
      );
      changedKinds = changedSourceKinds(previous ?? null, inventory, history, priorHistory?.nextSequence ?? 1);
      const seen = LAST_SEEN.get(params.userId);
      const storedRevisions = recordRevisions(previous);
      if (seen?.epoch === epoch) {
        for (const key of new Set([...seen.revisions.keys(), ...storedRevisions.keys()]))
          if (seen.revisions.get(key) !== storedRevisions.get(key)) changedKinds.add(key.split(":")[0] as SourceKind);
        movedElsewhere = seen.history !== (priorHistory?.nextSequence ?? 1);
      }
      lastSeen = { epoch, revisions: recordRevisions(inventory), history: history.nextSequence };
      // A cursor moves past a hint only in this same write, which either
      // verifies the hint's source or keeps that source pending.
      const journalPending: LivingJournalPending = { version: 1, kinds: {} };
      for (const kind of LIVING_SOURCE_KINDS) {
        const entry = pending.kinds[kind];
        if (entry && !verifiedKinds.includes(kind)) journalPending.kinds[kind] = entry;
      }
      const sourceHealth = nextSourceHealth(
        parseLivingSourceHealth(privateData.source_health),
        pending,
        verifiedKinds,
        storedSnapshotAt,
      );
      // The backlog each kind carried into this build, and the lag of the
      // oldest change a verified kind cleared. A kind without a hint has no
      // backlog and nothing to measure.
      sourceLagMs = {};
      sourcePendingCount = {};
      for (const kind of LIVING_SOURCE_KINDS) {
        const entry = pending.kinds[kind];
        sourcePendingCount[kind] = entry ? entry.count : 0;
        if (entry && verifiedKinds.includes(kind))
          sourceLagMs[kind] = sourceHealth.kinds[kind]?.lastLagMs ?? null;
      }
      const journalCursors = connectorHead === null && eventsHead === null
        ? privateData.journal_cursors
        : {
          connectors: connectorHead === null ? persisted.stored.connectors ?? "0"
            : nextJournalCursor(persisted.cursors.connectors, connectorHead, connectorReset),
          events: eventsHead === null ? persisted.stored.events ?? "0"
            : nextJournalCursor(persisted.cursors.events, eventsHead, eventsReset),
        };
      const unchanged = !livingSourceWriteDue({
        inventory: previous, history: privateData.observed_history, journalCursors: privateData.journal_cursors,
        journalPending: privateData.journal_pending, sourceHealth: privateData.source_health,
      }, { inventory, history, journalCursors, journalPending, sourceHealth });
      storedChange = !unchanged;
      storedVerifiedAt = previous?.verifiedAt ?? {};
      return {
        unchanged,
        mergeDecision: LIVING_DOMAIN_REPLACE,
        domainData: {
          ...current,
          _private: {
            ...privateData,
            inventory,
            observed_history: history,
            ...(journalCursors === undefined ? {} : { journal_cursors: journalCursors }),
            journal_pending: journalPending,
            source_health: sourceHealth,
          },
        },
        summary: {
          item_count: inventory.records.length,
          source_projection_complete: inventory.complete,
        },
      };
    },
  });
  if (!result.success)
    throw new Error("Encrypted source projection not stored");
  if (lastSeen && isVaultSessionEpochCurrent(epoch)) LAST_SEEN.set(params.userId, lastSeen);
  // Reuse needs the cached time to equal the stored one (canReuseVerifiedScan),
  // so a skipped write caches the time it kept, never this unwritten renewal.
  const scanned = (kind: RetriedKind, verifiedAt: string): CompletedScan => storedChange
    ? { epoch, verifiedAt, completedAt: storedSnapshotAt }
    : { epoch, verifiedAt: storedVerifiedAt[kind] ?? verifiedAt, completedAt: storedVerifiedAt[kind] ?? verifiedAt };
  if (earningsScanned) lastDocumentEarningsScan.set(params.userId, scanned("document_earning", earningsVerifiedAt!));
  if (payoutActivityScanned) lastPayoutActivityScan.set(params.userId, scanned("payout_activity", payoutActivityVerifiedAt!));
  if (documentRequestPaymentsScanned)
    lastDocumentRequestPaymentsScan.set(params.userId, scanned("document_request_payment", documentRequestPaymentsVerifiedAt!));
  if (documentRequestPaymentsScanned || documentRequestPaymentOverflowCleared)
    lastDocumentRequestPaymentOverflow.delete(params.userId);
  if (documentRequestPaymentOverflowed)
    lastDocumentRequestPaymentOverflow.set(params.userId, { epoch, at: storedSnapshotAt });
  if (connectionsScanned) lastConnectionScan.set(params.userId, scanned("connection", connectionVerifiedAt!));
  if (consentScanned) lastConsentScan.set(params.userId, scanned("consent", consentVerifiedAt!));
  if (consentScanned) lastConsentOverflow.delete(params.userId);
  if (consentOverflowed) lastConsentOverflow.set(params.userId, { epoch, at: storedSnapshotAt });
  if (curatedConnectorsScanned)
    lastCuratedConnectorScan.set(params.userId, scanned("curated_oauth_connector", curatedConnectorsVerifiedAt!));
  // A failed scan is never reused as current. A later wake rescans it, after
  // its retry delay unless a new hint or owner event arrives first.
  for (const failure of scanFailures) SCAN_CACHES[failure.kind].delete(params.userId);
  // One check per kind this build read: how it ended, the backlog it cleared
  // or left waiting, and the failed reads before it. A kind reused from its
  // window or still waiting out its delay was not read and is not reported.
  const sourceChecks: LiveMemorySourceCheck[] = [];
  for (const kind of LIVING_SOURCE_KINDS) {
    const outcome = verifiedKinds.includes(kind) ? "verified"
      : kind === "profile" ? (profileFailed ? "unavailable" : null)
      : !scanFailures.some((failure) => failure.kind === kind) ? null
      : cappedKinds.has(kind) ? "capped" : "unavailable";
    if (!outcome) continue;
    sourceChecks.push({
      kind,
      outcome,
      lagMs: sourceLagMs[kind] ?? null,
      pendingCount: sourcePendingCount[kind] ?? null,
      retryCount: priorSourceRetries(params.userId, epoch, kind),
    });
  }
  recordSourceRetries({
    userId: params.userId,
    epoch,
    verified: verifiedKinds,
    failed: scanFailures.filter((failure) => failure.counted).map((failure) => failure.kind),
    previouslyUnavailable,
    at: Date.parse(storedSnapshotAt),
  });
  // An unchanged store skips its write, so the stored inventory time can lag
  // this verification. Profile reads the session time in this vault epoch.
  // A kind whose records changed is vouched for only by the rebuilt mirror:
  // stamping this time on the cached one would call its old values verified.
  if (isVaultSessionEpochCurrent(epoch))
    recordLivingSourceSessionVerification(
      params.userId, epoch, verifiedKinds.filter((kind) => !changedKinds.has(kind)), storedSnapshotAt,
    );
  // The store succeeded, so the checks are real. Buckets leave; numbers do not.
  // A quiet wake that wrote nothing and only re-read the profile reports nothing,
  // and neither does a session locked or switched during the awaited write.
  if (isVaultSessionEpochCurrent(epoch))
    emitLiveMemorySourceTelemetry(sourceChecks, { stored: storedChange });
  const recordsChanged = changedKinds.size > 0 || movedElsewhere;
  if (incompleteKinds.length)
    throw new LivingSourcesIncompleteError(incompleteKinds, recordsChanged);
  return { stored: storedChange, recordsChanged };
}
