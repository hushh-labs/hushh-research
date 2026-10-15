/** Owner-only source provenance. These encrypted projections are derived, not
 * another authority, and never shared with another person. Only the bounded,
 * allowlisted Live Mirror packet reaches the owner's own private agent. */
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
/** Owner-only lag samples kept per source. */
export const MAX_LIVING_SOURCE_LAG_SAMPLES = 20;

type LivingSourceKind = LivingSourceInput["kind"];
/** Canonical kind order for encrypted bookkeeping and gap markers. */
export const LIVING_SOURCE_KINDS = [
  "profile", "consent", "connection", "curated_oauth_connector",
  "document_earning", "payout_activity", "document_request_payment",
] as const satisfies readonly LivingSourceKind[];

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isTime(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function ownEntry(map: Record<string, unknown>, kind: string): unknown {
  return Object.hasOwn(map, kind) ? map[kind] : undefined;
}

/** Missing bookkeeping is an empty list. Anything malformed returns null, and
 * the caller must then force an authoritative scan of every source. */
export function parseLivingJournalPending(value: unknown): LivingJournalPending | null {
  if (value === undefined) return { version: 1, kinds: {} };
  if (!isPlainRecord(value) || value.version !== 1 || !isPlainRecord(value.kinds)) return null;
  const known = new Set<string>(LIVING_SOURCE_KINDS);
  for (const [kind, entry] of Object.entries(value.kinds)) {
    if (!known.has(kind) || !isPlainRecord(entry) ||
        !(entry.count === null || isCount(entry.count)) ||
        !(entry.firstOccurredAt === null || isTime(entry.firstOccurredAt)) ||
        !(entry.lastOccurredAt === null || isTime(entry.lastOccurredAt)) ||
        !isCount(entry.historySequence) || entry.historySequence < 1)
      return null;
  }
  const kinds: LivingJournalPending["kinds"] = {};
  for (const kind of LIVING_SOURCE_KINDS) {
    const entry = ownEntry(value.kinds, kind) as LivingJournalPendingEntry | undefined;
    if (entry) kinds[kind] = {
      count: entry.count,
      firstOccurredAt: entry.firstOccurredAt,
      lastOccurredAt: entry.lastOccurredAt,
      historySequence: entry.historySequence,
    };
  }
  return { version: 1, kinds };
}

/** Freshness health is advisory: malformed entries are dropped, never trusted. */
export function parseLivingSourceHealth(value: unknown): LivingSourceHealth {
  const kinds: LivingSourceHealth["kinds"] = {};
  if (!isPlainRecord(value) || value.version !== 1 || !isPlainRecord(value.kinds))
    return { version: 1, kinds };
  for (const kind of LIVING_SOURCE_KINDS) {
    const entry = ownEntry(value.kinds, kind);
    if (!isPlainRecord(entry) || !isTime(entry.lastVerifiedAt) ||
        !(entry.lastLagMs === null || isCount(entry.lastLagMs)) ||
        !Array.isArray(entry.lagSamplesMs) || !entry.lagSamplesMs.every(isCount))
      continue;
    kinds[kind] = {
      lastLagMs: entry.lastLagMs,
      lagSamplesMs: entry.lagSamplesMs.slice(-MAX_LIVING_SOURCE_LAG_SAMPLES),
      lastVerifiedAt: entry.lastVerifiedAt,
    };
  }
  return { version: 1, kinds };
}

/** Bounds a retained history to the shared cap. A rollover records its time. */
function retainLivingSourceChanges(
  changes: LivingSourceChange[],
  nextSequence: number,
  truncatedAt: string | null,
  rolledOverAt: string,
): LivingSourceHistory {
  const overflow = Math.max(0, changes.length - MAX_RETAINED_LIVING_SOURCE_CHANGES);
  if (overflow) changes.splice(0, overflow);
  return {
    changes,
    nextSequence,
    firstRetainedSequence: changes[0]?.sequence ?? nextSequence,
    truncatedAt: overflow ? rolledOverAt : truncatedAt,
  };
}

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
  return retainLivingSourceChanges(
    changes, nextSequence, previousHistory?.truncatedAt ?? null, inventory.observedAt,
  );
}

/**
 * Append one explicit gap marker for each verified kind whose committed hints
 * outnumber the revisions this history recorded since the hints were first
 * pending. A marker counts changes; it never invents the values in between.
 * An unknown count (after a journal reset) is a "journal_gap". When retention
 * already removed part of that span, the recorded count is unknown (null).
 * Journal triggers also fire for rows that map to no mirrored record (a sent
 * connection request, a consent audit row), so a verified source with no
 * recorded change gets no marker.
 */
export function appendJournalGapMarkers(
  history: LivingSourceHistory,
  pending: LivingJournalPending,
  verifiedKinds: readonly LivingSourceKind[],
  capturedAt: string,
): LivingSourceHistory {
  const verified = new Set(verifiedKinds);
  const changes = [...history.changes];
  let nextSequence = history.nextSequence;
  for (const kind of LIVING_SOURCE_KINDS) {
    const entry = pending.kinds[kind];
    if (!entry || !verified.has(kind)) continue;
    const countable = entry.historySequence >= history.firstRetainedSequence &&
      entry.historySequence <= history.nextSequence;
    const verifiedChanges = countable
      ? history.changes.filter((change) => change.kind === kind &&
          change.operation !== "gap" && change.sequence >= entry.historySequence).length
      : null;
    if (verifiedChanges === 0) continue;
    if (entry.count !== null && verifiedChanges !== null && entry.count <= verifiedChanges)
      continue;
    const value: LivingSourceGapValue = {
      reason: entry.count === null ? "journal_gap" : "unobserved_changes",
      committedChanges: entry.count,
      verifiedChanges,
      firstOccurredAt: entry.firstOccurredAt,
      lastOccurredAt: entry.lastOccurredAt,
    };
    changes.push({
      sequence: nextSequence++,
      kind,
      id: "*",
      revision: 0,
      operation: "gap",
      capturedAt,
      sourceUpdatedAt: null,
      value: { ...value },
    });
  }
  if (nextSequence === history.nextSequence) return history;
  return retainLivingSourceChanges(changes, nextSequence, history.truncatedAt, capturedAt);
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
const VERIFICATION_WINDOWS = [
  ["consent", CONSENT_FRESHNESS_MS],
  ["curated_oauth_connector", CURATED_OAUTH_CONNECTOR_FRESHNESS_MS],
  ["connection", CONNECTION_FRESHNESS_MS],
  ["document_earning", DOCUMENT_EARNINGS_FRESHNESS_MS],
  ["payout_activity", PAYOUT_ACTIVITY_FRESHNESS_MS],
  ["document_request_payment", DOCUMENT_REQUEST_PAYMENT_FRESHNESS_MS],
] as const;
/** Sources that keep an inventory from being complete: unavailable in this
 * read, or last verified outside their freshness window. Ages are measured from
 * `freshnessAt` (when the read began, where a scan was judged reusable), so a
 * slow build cannot age a reused source past its window; a source verified
 * during the build, after that time and never after observedAt, is fresh. */
export function incompleteLivingSourceKinds(
  inventory: Pick<LivingSourceInventory, "unavailable" | "observedAt" | "verifiedAt">,
  freshnessAt: string = inventory.observedAt,
): string[] {
  const kinds = new Set(inventory.unavailable);
  const reference = Date.parse(freshnessAt);
  const observed = Date.parse(inventory.observedAt);
  for (const [kind, maxAge] of VERIFICATION_WINDOWS) {
    const at = inventory.verifiedAt?.[kind];
    const verified = at === undefined ? NaN : Date.parse(at);
    const duringBuild = verified > reference && verified <= observed;
    if (!duringBuild && !recentlyVerified(at, freshnessAt, maxAge)) kinds.add(kind);
  }
  return [...kinds].sort();
}
export function reconcileLivingSources(
  previous: LivingSourceInventory | null,
  inputs: LivingSourceInput[],
  successfulKinds: readonly string[],
  unavailable: string[],
  now: string,
  sourceVerifiedAt: Partial<Record<"connection" | "document_earning" | "payout_activity" | "document_request_payment" | "consent" | "curated_oauth_connector", string>> = {},
  /** When this build's read began; completeness ages are measured from it. */
  freshnessAt: string = now,
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
    complete: incompleteLivingSourceKinds({ unavailable, observedAt: now, verifiedAt }, freshnessAt).length === 0,
    unavailable: [...unavailable].sort(),
    observedAt: now,
    verifiedAt,
  };
}
