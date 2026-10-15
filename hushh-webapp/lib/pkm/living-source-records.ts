/** Owner-only source provenance. These encrypted projections are derived,
 * not another authority and never an agent/shareable export. */
export interface LivingSourceInput {
  kind: "profile" | "consent" | "connection" | "curated_oauth_connector" | "document_earning" | "payout_activity" | "document_request_payment";
  id: string;
  value: Record<string, unknown>;
  createdAt: string | null;
  updatedAt: string | null;
}
export interface LivingSourceRecord extends LivingSourceInput {
  revision: number;
  capturedAt: string;
  deletedAt: string | null;
}
export interface LivingSourceInventory {
  records: LivingSourceRecord[];
  complete: boolean;
  unavailable: string[];
  observedAt: string;
  /** Last complete read per bounded source. A skipped scan retains its prior time. */
  verifiedAt?: Record<string, string>;
}

/** An owner-only history of source revisions actually verified by this vault.
 * It cannot reconstruct an intermediate value while no unlocked consumer ran.
 * Keep the retention boundary explicit instead of silently claiming a full log. */
export interface LivingSourceChange {
  sequence: number;
  kind: LivingSourceInput["kind"];
  /** "*" for a gap marker, which belongs to a source kind rather than a record. */
  id: string;
  /** 0 for a gap marker. */
  revision: number;
  operation: "upsert" | "delete" | "gap";
  capturedAt: string;
  sourceUpdatedAt: string | null;
  /** A gap marker's value is exactly a LivingSourceGapValue. */
  value: Record<string, unknown>;
}

/** Committed changes that were not individually captured; never invented values. */
export interface LivingSourceGapValue {
  reason: "unobserved_changes" | "journal_gap";
  committedChanges: number | null;
  verifiedChanges: number | null;
  firstOccurredAt: string | null;
  lastOccurredAt: string | null;
}

/** Encrypted replay bookkeeping stored in the same write as the journal cursors.
 * A kind stays pending until a build verifies it, so a cursor can move past
 * its hints without losing them. */
export interface LivingJournalPendingEntry {
  /** Committed hints awaiting verification; null when unknown after a reset. */
  count: number | null;
  firstOccurredAt: string | null;
  lastOccurredAt: string | null;
  /** observed_history.nextSequence when this entry was first recorded. */
  historySequence: number;
}
export interface LivingJournalPending {
  version: 1;
  kinds: Partial<Record<LivingSourceInput["kind"], LivingJournalPendingEntry>>;
}

/** Owner-only freshness health. Source-kind keys, numbers and ISO times only. */
export interface LivingSourceHealthEntry {
  lastLagMs: number | null;
  /** At most 20 recent commit-to-encrypted-write lags. */
  lagSamplesMs: number[];
  lastVerifiedAt: string;
}
export interface LivingSourceHealth {
  version: 1;
  kinds: Partial<Record<LivingSourceInput["kind"], LivingSourceHealthEntry>>;
}

export interface LivingSourceHistory {
  changes: LivingSourceChange[];
  nextSequence: number;
  firstRetainedSequence: number;
  truncatedAt: string | null;
}

export const MAX_RETAINED_LIVING_SOURCE_CHANGES = 2_048;

/** Append only changed, verified revisions. Incomplete source scans retain
 * their old records and therefore cannot manufacture a deletion here. */
export function appendVerifiedLivingSourceChanges(
  previousHistory: LivingSourceHistory | null,
  previousInventory: LivingSourceInventory | null,
  inventory: LivingSourceInventory,
): LivingSourceHistory {
  const previousRecords = new Map(
    (previousInventory?.records ?? []).map((record) =>
      [`${record.kind}:${record.id}`, record] as const),
  );
  const changes = [...(previousHistory?.changes ?? [])];
  let nextSequence = previousHistory?.nextSequence ?? 1;
  for (const record of inventory.records) {
    const old = previousRecords.get(`${record.kind}:${record.id}`);
    if (old && old.revision === record.revision) continue;
    if (old && record.revision <= old.revision)
      throw new Error("Living source revision went backwards");
    changes.push({
      sequence: nextSequence++,
      kind: record.kind,
      id: record.id,
      revision: record.revision,
      operation: record.deletedAt ? "delete" : "upsert",
      capturedAt: record.capturedAt,
      sourceUpdatedAt: record.updatedAt,
      value: record.deletedAt ? {} : record.value,
    });
  }
  const overflow = Math.max(0, changes.length - MAX_RETAINED_LIVING_SOURCE_CHANGES);
  if (overflow) changes.splice(0, overflow);
  return {
    changes,
    nextSequence,
    firstRetainedSequence: changes[0]?.sequence ?? nextSequence,
    truncatedAt: overflow ? inventory.observedAt : previousHistory?.truncatedAt ?? null,
  };
}
export const DOCUMENT_EARNINGS_FRESHNESS_MS = 5 * 60_000;
export const PAYOUT_ACTIVITY_FRESHNESS_MS = 5 * 60_000;
export const DOCUMENT_REQUEST_PAYMENT_FRESHNESS_MS = 5 * 60_000;
export const CONNECTION_FRESHNESS_MS = 5 * 60_000;
export const CONSENT_FRESHNESS_MS = 5 * 60_000;
export const CURATED_OAUTH_CONNECTOR_FRESHNESS_MS = 5 * 60_000;
function recentlyVerified(at: string | undefined, now: string, maxAge: number): boolean {
  if (!at) return true; // Legacy inventories gain a timestamp on their next scan.
  const age = Date.parse(now) - Date.parse(at);
  return Number.isFinite(age) && age >= 0 && age <= maxAge;
}
export function reconcileLivingSources(
  previous: LivingSourceInventory | null,
  inputs: LivingSourceInput[],
  successfulKinds: readonly string[],
  unavailable: string[],
  now: string,
  sourceVerifiedAt: Partial<Record<"connection" | "document_earning" | "payout_activity" | "document_request_payment" | "consent" | "curated_oauth_connector", string>> = {},
): LivingSourceInventory {
  const verifiedAt = { ...(previous?.verifiedAt ?? {}) };
  for (const kind of successfulKinds) {
    if (kind === "connection" || kind === "document_earning" || kind === "payout_activity" ||
        kind === "document_request_payment" ||
        kind === "consent" || kind === "curated_oauth_connector")
      verifiedAt[kind] = sourceVerifiedAt[kind] ?? now;
  }
  const records = new Map(
    (previous?.records ?? []).map((record) => [
      `${record.kind}:${record.id}`,
      record,
    ]),
  );
  const seen = new Set<string>();
  for (const input of inputs) {
    const key = `${input.kind}:${input.id}`;
    seen.add(key);
    const prior = records.get(key);
    if (
      prior &&
      !prior.deletedAt &&
      JSON.stringify(prior.value) === JSON.stringify(input.value)
    ) {
      // Provenance backfill is retained without inventing a payload revision.
      records.set(key, {
        ...prior,
        createdAt: prior.createdAt ?? input.createdAt,
        updatedAt: input.updatedAt ?? prior.updatedAt,
      });
      continue;
    }
    records.set(key, {
      ...input,
      createdAt: prior?.createdAt ?? input.createdAt,
      revision: (prior?.revision ?? 0) + 1,
      capturedAt: now,
      deletedAt: null,
    });
  }
  for (const [key, prior] of records) {
    if (
      successfulKinds.includes(prior.kind) &&
      !seen.has(key) &&
      !prior.deletedAt
    ) {
      records.set(key, {
        ...prior,
        value: {},
        revision: prior.revision + 1,
        updatedAt: now,
        capturedAt: now,
        deletedAt: now,
      });
    }
  }
  return {
    records: [...records.values()].sort((a, b) =>
      `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`),
    ),
    complete: unavailable.length === 0 &&
      recentlyVerified(verifiedAt.consent, now, CONSENT_FRESHNESS_MS) &&
      recentlyVerified(verifiedAt.curated_oauth_connector, now, CURATED_OAUTH_CONNECTOR_FRESHNESS_MS) &&
      recentlyVerified(verifiedAt.connection, now, CONNECTION_FRESHNESS_MS) &&
      recentlyVerified(verifiedAt.document_earning, now, DOCUMENT_EARNINGS_FRESHNESS_MS) &&
      recentlyVerified(verifiedAt.payout_activity, now, PAYOUT_ACTIVITY_FRESHNESS_MS) &&
      recentlyVerified(verifiedAt.document_request_payment, now, DOCUMENT_REQUEST_PAYMENT_FRESHNESS_MS),
    unavailable: [...unavailable].sort(),
    observedAt: now,
    verifiedAt,
  };
}
