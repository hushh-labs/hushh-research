import type {
  LivingJournalPending,
  LivingSourceChange,
  LivingSourceHealth,
  LivingSourceHistory,
  LivingSourceInventory,
} from "@/lib/pkm/living-source-records";
import {
  buildOwnerLivingFactIndex,
  LIVING_SOURCE_FACT_FIELDS,
  LIVING_SOURCE_FIELD_LABELS,
  type LivingFactNode,
} from "@/lib/pkm/living-source-fact-index";
import type { MemoryDocument } from "@/lib/pkm/memory-document";
import type { MemoryRefreshStatus } from "@/lib/pkm/memory-refresh";
import {
  LIVE_MEMORY_BOUNDARY_COPY,
  LIVE_MIRROR_FRESHNESS_MS,
  LIVE_MIRROR_HIDDEN_PREDICATES,
  LIVE_MIRROR_KINDS,
  LIVE_MIRROR_PRESENCE_ONLY_PREDICATES,
  LIVE_MIRROR_SOURCE_LABELS,
  LIVE_MIRROR_STALE_GRACE_MS,
  type LiveMirrorFact,
  type LiveMirrorFactValue,
  type LiveMirrorGap,
  type LiveMirrorHistory,
  type LiveMirrorHistoryEntry,
  type LiveMirrorKind,
  type LiveMirrorOverall,
  type LiveMirrorProjection,
  type LiveMirrorSource,
  type LiveMirrorView,
} from "@/lib/pkm/live-mirror-contract";

/**
 * Live Mirror v1 projection. Pure: no vault, network, clock or storage access,
 * so callers pass `now`. It derives the one owner-scoped view of current facts
 * and observed history from an already decrypted inventory and the derived
 * memory document. The result lives in memory only. Its Markdown is a
 * deterministic, escaped preview of this model, never the authority.
 */

export interface BuildLiveMirrorProjectionParams {
  ownerId: string;
  vaultEpoch: number;
  /** Build time as an ISO string or epoch milliseconds. */
  now: string | number;
  inventory: LivingSourceInventory | null | undefined;
  history: LivingSourceHistory | null | undefined;
  document: MemoryDocument | null | undefined;
  pending?: LivingJournalPending | null;
  health?: LivingSourceHealth | null;
  /** In-memory verification times already fenced to this owner and vault epoch. */
  sessionVerifiedAt?: Partial<Record<LiveMirrorKind, string>> | null;
  /** The owner-authored Soul name differs from the verified account name. */
  nameConflict?: boolean;
  /** The inventory could not be read, as opposed to not existing yet. */
  inventoryReadFailed?: boolean;
  /** Saved-detail domains already represented by the living sources. */
  excludeSavedDomains?: readonly string[];
}

/** Headline copy for each overall state, shared by every mirror surface. */
export const LIVE_MIRROR_OVERALL_HEADLINES: Record<LiveMirrorOverall, string> = {
  locked: "Memory locked",
  loading: "Checking sources",
  current: "Up to date",
  updating: "Updating",
  stale: "May be out of date",
  partial: "Some sources unavailable",
  conflict: "Needs your review",
  empty: "Nothing here yet",
};

const STALE_AFTER_MS = LIVE_MIRROR_FRESHNESS_MS + LIVE_MIRROR_STALE_GRACE_MS;
const HIDDEN_PREDICATES = new Set<string>(LIVE_MIRROR_HIDDEN_PREDICATES);
const PRESENCE_ONLY_PREDICATES = new Set<string>(LIVE_MIRROR_PRESENCE_ONLY_PREDICATES);
const KINDS = new Set<string>(LIVE_MIRROR_KINDS);
const MAX_VALUE_LENGTH = 2_048;
const PREVIEW_HISTORY_LIMIT = 20;
const PREVIEW_RECORDS_PER_SOURCE = 100;
const RECORD_LABELS: Record<LiveMirrorKind, string> = {
  profile: "Profile",
  consent: "Consent",
  connection: "Connection",
  curated_oauth_connector: "Connected app",
  document_earning: "Earning",
  payout_activity: "Wallet activity",
  document_request_payment: "Document payment",
};

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isKind(value: unknown): value is LiveMirrorKind {
  return typeof value === "string" && KINDS.has(value);
}

function isFactValue(value: unknown): value is LiveMirrorFactValue {
  return typeof value === "boolean" ||
    typeof value === "number" && Number.isFinite(value) ||
    typeof value === "string" && value.length <= MAX_VALUE_LENGTH;
}

function toMs(value: string | number): number {
  return typeof value === "number" ? value : Date.parse(value);
}

function laterOf(left: string | null, right: string | null): string | null {
  if (!left) return right;
  if (!right) return left;
  return Date.parse(right) > Date.parse(left) ? right : left;
}

function recordKey(kind: string, id: string): string {
  return JSON.stringify([kind, id]);
}

function byCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function humanize(text: string): string {
  const words = text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim().toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : text;
}

function fieldLabel(kind: LiveMirrorKind, field: string): string {
  const labels = LIVING_SOURCE_FIELD_LABELS[kind] as Readonly<Record<string, string>>;
  return Object.hasOwn(labels, field) ? labels[field]! : humanize(field);
}

/** Owner-facing text for a fact or history value. */
export function formatLiveMirrorValue(predicate: string, value: LiveMirrorFactValue | null): string {
  if (value === null) return "Sources disagree";
  if (PRESENCE_ONLY_PREDICATES.has(predicate)) return "Added";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

/** Display order: source kind, record ref, admitted field order. */
export function compareLiveMirrorFacts(left: LiveMirrorFact, right: LiveMirrorFact): number {
  const rank = (ref: string) => Number(/(\d+)$/.exec(ref)?.[1] ?? 0);
  const fields = (fact: LiveMirrorFact) => LIVING_SOURCE_FACT_FIELDS[fact.kind].indexOf(fact.field);
  return LIVE_MIRROR_KINDS.indexOf(left.kind) - LIVE_MIRROR_KINDS.indexOf(right.kind) ||
    rank(left.ref) - rank(right.ref) ||
    fields(left) - fields(right) ||
    byCodeUnit(left.key, right.key);
}

function readInventory(value: unknown, issues: Set<string>): LivingSourceInventory | null {
  if (value === null || value === undefined) return null;
  if (!isObject(value) || !Array.isArray(value.records) || !Array.isArray(value.unavailable) || !isIso(value.observedAt)) {
    issues.add("invalid_inventory");
    return null;
  }
  return value as unknown as LivingSourceInventory;
}

function isGapValue(value: unknown): boolean {
  const count = (item: unknown) => item === null || Number.isSafeInteger(item) && Number(item) >= 0;
  const time = (item: unknown) => item === null || isIso(item);
  return isObject(value) && (value.reason === "unobserved_changes" || value.reason === "journal_gap") &&
    count(value.committedChanges) && count(value.verifiedChanges) &&
    time(value.firstOccurredAt) && time(value.lastOccurredAt);
}

function isValidChange(value: unknown): value is LivingSourceChange {
  if (!isObject(value) || !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 1 ||
      !isKind(value.kind) || typeof value.id !== "string" || !value.id || !isIso(value.capturedAt) ||
      !(value.sourceUpdatedAt === null || typeof value.sourceUpdatedAt === "string") || !isObject(value.value))
    return false;
  if (value.operation === "gap") return value.id === "*" && value.revision === 0 && isGapValue(value.value);
  return (value.operation === "upsert" || value.operation === "delete") &&
    value.id !== "*" && Number.isSafeInteger(value.revision) && Number(value.revision) > 0;
}

function readHistory(value: unknown, issues: Set<string>): {
  changes: LivingSourceChange[]; firstRetainedSequence: number; truncatedAt: string | null;
} {
  const empty = { changes: [], firstRetainedSequence: 1, truncatedAt: null };
  if (value === null || value === undefined) return empty;
  if (!isObject(value) || !Array.isArray(value.changes)) {
    issues.add("invalid_history");
    return empty;
  }
  const changes: LivingSourceChange[] = [];
  for (const change of value.changes) {
    if (isValidChange(change)) changes.push(change);
    else issues.add("invalid_history");
  }
  const firstRetainedSequence = Number.isSafeInteger(value.firstRetainedSequence) && Number(value.firstRetainedSequence) >= 1
    ? Number(value.firstRetainedSequence)
    : changes.reduce((lowest, change) => Math.min(lowest, change.sequence), Number.MAX_SAFE_INTEGER);
  return {
    changes,
    firstRetainedSequence: firstRetainedSequence === Number.MAX_SAFE_INTEGER ? 1 : firstRetainedSequence,
    truncatedAt: isIso(value.truncatedAt) ? value.truncatedAt : null,
  };
}

function pendingChanges(pending: unknown, kind: LiveMirrorKind): number | null {
  if (!isObject(pending) || pending.version !== 1 || !isObject(pending.kinds)) return 0;
  const entry = pending.kinds[kind];
  if (!isObject(entry)) return 0;
  // A malformed count is unknown, never silently zero.
  return Number.isSafeInteger(entry.count) && Number(entry.count) >= 0 ? Number(entry.count) : null;
}

function lag(health: unknown, kind: LiveMirrorKind): { lastLagMs: number | null; medianLagMs: number | null } {
  const isLag = (item: unknown): item is number => typeof item === "number" && Number.isFinite(item) && item >= 0;
  const entry = isObject(health) && health.version === 1 && isObject(health.kinds) ? health.kinds[kind] : null;
  if (!isObject(entry)) return { lastLagMs: null, medianLagMs: null };
  const samples = (Array.isArray(entry.lagSamplesMs) ? entry.lagSamplesMs.filter(isLag) : []).slice(-20).sort((a, b) => a - b);
  const middle = Math.floor(samples.length / 2);
  return {
    lastLagMs: isLag(entry.lastLagMs) ? entry.lastLagMs : null,
    medianLagMs: samples.length === 0 ? null
      : samples.length % 2 ? samples[middle]! : Math.round((samples[middle - 1]! + samples[middle]!) / 2),
  };
}

/** Stable, human-safe references: inventory records by source creation time, then history-only records. */
function recordRefs(recordNodes: readonly LivingFactNode[], changes: readonly LivingSourceChange[]): Map<string, string> {
  const refs = new Map<string, string>();
  const counts = new Map<LiveMirrorKind, number>();
  const add = (kind: LiveMirrorKind, id: string) => {
    if (refs.has(recordKey(kind, id))) return;
    const count = (counts.get(kind) ?? 0) + 1;
    counts.set(kind, count);
    refs.set(recordKey(kind, id), kind === "profile" ? RECORD_LABELS.profile : `${RECORD_LABELS[kind]} ${count}`);
  };
  // New records normally have the newest creation time, so existing refs keep their number.
  const created = (at: string | null) => (isIso(at) ? Date.parse(at) : Number.NEGATIVE_INFINITY);
  for (const node of [...recordNodes].sort((a, b) =>
    created(a.provenance.createdAt) - created(b.provenance.createdAt) ||
    byCodeUnit(a.provenance.sourceId, b.provenance.sourceId))) {
    add(node.provenance.kind, node.provenance.sourceId);
  }
  for (const change of [...changes].sort((a, b) => a.sequence - b.sequence)) {
    if (change.operation !== "gap") add(change.kind, change.id);
  }
  return refs;
}

function admittedChanges(kind: LiveMirrorKind, value: Record<string, unknown>, unresolved: boolean): LiveMirrorHistoryEntry["changes"] {
  const changes: LiveMirrorHistoryEntry["changes"] = [];
  for (const field of LIVING_SOURCE_FACT_FIELDS[kind]) {
    const predicate = `${kind}.${field}`;
    const raw = value[field];
    if (HIDDEN_PREDICATES.has(predicate) || raw === null || raw === undefined || !isFactValue(raw)) continue;
    changes.push({
      predicate,
      label: fieldLabel(kind, field),
      value: unresolved ? null : PRESENCE_ONLY_PREDICATES.has(predicate) ? true : raw,
    });
  }
  return changes;
}

function gapOf(value: Record<string, unknown>): LiveMirrorGap {
  return {
    reason: value.reason as LiveMirrorGap["reason"],
    committedChanges: value.committedChanges as number | null,
    verifiedChanges: value.verifiedChanges as number | null,
    firstOccurredAt: value.firstOccurredAt as string | null,
    lastOccurredAt: value.lastOccurredAt as string | null,
  };
}

function buildHistory(params: {
  changes: readonly LivingSourceChange[];
  firstRetainedSequence: number;
  truncatedAt: string | null;
  refs: ReadonlyMap<string, string>;
  recordNodes: readonly LivingFactNode[];
}): LiveMirrorHistory {
  const latestSequence = new Map<string, number>();
  const removedAt = new Map<string, number>();
  for (const change of params.changes) {
    if (change.operation === "gap") continue;
    const key = recordKey(change.kind, change.id);
    latestSequence.set(key, Math.max(latestSequence.get(key) ?? 0, change.sequence));
    if (change.operation === "delete") removedAt.set(key, Math.max(removedAt.get(key) ?? 0, change.sequence));
  }
  const unresolvedRevision = new Map<string, number>();
  for (const node of params.recordNodes) {
    const key = recordKey(node.provenance.kind, node.provenance.sourceId);
    // A tombstone without its retained delete still hides every earlier value.
    if (node.status === "deleted" && !removedAt.has(key)) removedAt.set(key, Number.POSITIVE_INFINITY);
    if (node.status === "conflicted") unresolvedRevision.set(key, node.provenance.revision);
  }
  const entries = [...params.changes].sort((a, b) => b.sequence - a.sequence).map((change): LiveMirrorHistoryEntry => {
    if (change.operation === "gap") {
      return {
        sequence: change.sequence, kind: change.kind, ref: LIVE_MIRROR_SOURCE_LABELS[change.kind], revision: 0,
        operation: "gap", capturedAt: change.capturedAt, sourceUpdatedAt: change.sourceUpdatedAt,
        changes: [], current: false, redacted: false, gap: gapOf(change.value),
      };
    }
    const key = recordKey(change.kind, change.id);
    const redacted = change.operation === "upsert" && change.sequence < (removedAt.get(key) ?? 0);
    return {
      sequence: change.sequence,
      kind: change.kind,
      ref: params.refs.get(key) ?? RECORD_LABELS[change.kind],
      revision: change.revision,
      operation: change.operation,
      capturedAt: change.capturedAt,
      sourceUpdatedAt: change.sourceUpdatedAt,
      changes: redacted || change.operation === "delete"
        ? []
        : admittedChanges(change.kind, change.value, unresolvedRevision.get(key) === change.revision),
      current: latestSequence.get(key) === change.sequence,
      redacted,
      gap: null,
    };
  });
  return {
    entries,
    firstRetainedSequence: params.firstRetainedSequence,
    droppedCount: params.truncatedAt ? Math.max(0, params.firstRetainedSequence - 1) : 0,
    truncatedAt: params.truncatedAt,
    coverage: "open_app_only",
  };
}

function emptyHistory(): LiveMirrorHistory {
  return { entries: [], firstRetainedSequence: 1, droppedCount: 0, truncatedAt: null, coverage: "open_app_only" };
}

function savedSources(document: MemoryDocument | null | undefined, builtAt: string, exclude: ReadonlySet<string>): LiveMirrorSource[] {
  const sources = new Map<string, LiveMirrorSource>();
  const base = { group: "saved" as const, kind: null, staleAfterMs: null, liveCount: 0, pendingChanges: 0, lastLagMs: null, medianLagMs: null };
  for (const entry of Array.isArray(document?.freshness) ? document.freshness : []) {
    if (!entry || typeof entry.domain !== "string" || exclude.has(entry.domain)) continue;
    const state = entry.status === "unavailable" ? "unavailable" : entry.status === "conflicted" ? "conflict" : "current";
    sources.set(entry.domain, {
      ...base,
      id: `saved:${entry.domain}`,
      domain: entry.domain,
      label: typeof entry.title === "string" && entry.title.trim() ? entry.title : humanize(entry.domain),
      state,
      verifiedAt: state === "unavailable" ? null : builtAt,
      contentRevision: typeof entry.contentRevision === "number" ? entry.contentRevision : null,
      reason: state !== "unavailable" ? null
        : entry.reason === "source inventory incomplete" ? "inventory_incomplete" : "could_not_read",
      withheld: Array.isArray(entry.withheld) ? [...entry.withheld].sort(byCodeUnit) : [],
    });
  }
  for (const domain of Array.isArray(document?.excludedDomains) ? document.excludedDomains : []) {
    if (typeof domain !== "string" || exclude.has(domain) || sources.has(domain)) continue;
    sources.set(domain, {
      ...base, id: `saved:${domain}`, domain, label: humanize(domain), state: "withheld",
      verifiedAt: null, contentRevision: null, reason: "excluded_by_rule", withheld: [],
    });
  }
  return [...sources.values()].sort((a, b) => byCodeUnit(a.domain ?? "", b.domain ?? ""));
}

/**
 * Build the owner's Live Mirror. A profile record or history entry for a
 * different owner fails closed: zero facts and history, every living source
 * unavailable and the issue "owner_mismatch".
 */
export function buildLiveMirrorProjection(params: BuildLiveMirrorProjectionParams): LiveMirrorProjection {
  const nowMs = toMs(params.now);
  if (!params.ownerId || !Number.isFinite(nowMs)) throw new Error("A valid owner and build time are required");
  const builtAt = new Date(nowMs).toISOString();
  const issues = new Set<string>();
  const inventory = readInventory(params.inventory, issues);
  const index = inventory ? buildOwnerLivingFactIndex({ expectedOwnerId: params.ownerId, inventory, now: builtAt }) : null;
  // Freshness is decided at read time from each source's verification age.
  for (const issue of index?.issues ?? []) if (issue !== "source_stale") issues.add(issue);
  const history = readHistory(params.history, issues);
  if (history.changes.some(change => change.kind === "profile" && change.operation !== "gap" && change.id !== params.ownerId))
    issues.add("owner_mismatch");
  const ownerMismatch = issues.has("owner_mismatch");
  const recordNodes = ownerMismatch ? [] : (index?.nodes ?? []).filter(node => node.predicate.endsWith(".__record"));
  const session = isObject(params.sessionVerifiedAt) ? params.sessionVerifiedAt : {};
  const sessionAt = (kind: LiveMirrorKind) => (isIso(session[kind]) ? session[kind]! : null);

  const living = LIVE_MIRROR_KINDS.map((kind): LiveMirrorSource => {
    const base = {
      id: `living:${kind}`, group: "living" as const, kind, domain: null, label: LIVE_MIRROR_SOURCE_LABELS[kind],
      staleAfterMs: STALE_AFTER_MS, contentRevision: null, withheld: [],
    };
    if (ownerMismatch) {
      return { ...base, state: "unavailable", verifiedAt: null, reason: null, liveCount: 0, pendingChanges: 0, lastLagMs: null, medianLagMs: null };
    }
    const measured = { pendingChanges: pendingChanges(params.pending, kind), ...lag(params.health, kind) };
    if (!inventory) {
      return {
        ...base, ...measured, liveCount: 0,
        state: params.inventoryReadFailed ? "unavailable" : "not_checked",
        verifiedAt: kind === "profile" ? sessionAt(kind) : null,
        reason: params.inventoryReadFailed ? "could_not_read" : null,
      };
    }
    const unavailable = inventory.unavailable.includes(kind);
    const listed = isObject(inventory.verifiedAt) ? inventory.verifiedAt[kind] : undefined;
    // An unchanged sync skips its write, so the profile check time comes from
    // this owner session when it is newer than the stored inventory.
    const verifiedAt = kind === "profile"
      ? unavailable ? sessionAt(kind) : laterOf(sessionAt(kind), inventory.observedAt)
      : isIso(listed) ? listed : null;
    const records = recordNodes.filter(node => node.provenance.kind === kind);
    return {
      ...base, ...measured, verifiedAt,
      liveCount: records.filter(node => node.status !== "deleted").length,
      state: unavailable ? "unavailable"
        : records.some(node => node.status === "conflicted") ? "conflict"
          : verifiedAt === null ? "not_checked" : "current",
      reason: unavailable ? "could_not_read" : null,
    };
  });
  const sourceByKind = new Map(living.map(source => [source.kind!, source]));
  const refs = recordRefs(recordNodes, ownerMismatch ? [] : history.changes);
  const facts: LiveMirrorFact[] = [];
  for (const node of ownerMismatch ? [] : index?.nodes ?? []) {
    const { kind, sourceId, revision, updatedAt, capturedAt } = node.provenance;
    const source = sourceByKind.get(kind)!;
    const field = node.predicate.slice(kind.length + 1);
    const common = {
      kind, sourceId, ref: refs.get(recordKey(kind, sourceId)) ?? RECORD_LABELS[kind],
      revision, capturedAt, verifiedAt: source.verifiedAt,
    };
    if (field !== "__record") {
      if (HIDDEN_PREDICATES.has(node.predicate)) continue;
      facts.push({
        ...common, key: node.key, predicate: node.predicate, field, label: fieldLabel(kind, field),
        value: PRESENCE_ONLY_PREDICATES.has(node.predicate) ? true : node.value,
        state: source.state === "unavailable" ? "unavailable" : "verified",
        sourceUpdatedAt: updatedAt,
      });
      continue;
    }
    if (node.status !== "conflicted") continue;
    // Disagreeing versions show which admitted fields are unresolved, never a value.
    const fields = new Set<string>();
    for (const version of inventory!.records) {
      if (version?.kind !== kind || version.id !== sourceId || version.revision !== revision || !isObject(version.value)) continue;
      for (const candidate of LIVING_SOURCE_FACT_FIELDS[kind]) {
        if (version.value[candidate] !== null && version.value[candidate] !== undefined) fields.add(candidate);
      }
    }
    for (const candidate of LIVING_SOURCE_FACT_FIELDS[kind]) {
      const predicate = `${kind}.${candidate}`;
      if (!fields.has(candidate) || HIDDEN_PREDICATES.has(predicate)) continue;
      facts.push({
        ...common, key: JSON.stringify([kind, sourceId, candidate]), predicate, field: candidate,
        label: fieldLabel(kind, candidate), value: null, state: "conflicted", sourceUpdatedAt: null,
      });
    }
  }
  facts.sort((a, b) => byCodeUnit(a.key, b.key));
  const projection: Omit<LiveMirrorProjection, "markdown"> = {
    schemaVersion: "live_mirror.v1",
    ownerId: params.ownerId,
    vaultEpoch: params.vaultEpoch,
    builtAt,
    inventoryObservedAt: ownerMismatch ? null : inventory?.observedAt ?? null,
    inventoryComplete: !ownerMismatch && inventory?.complete === true,
    issues: [...issues].sort(byCodeUnit),
    nameConflict: params.nameConflict === true,
    sources: [...living, ...savedSources(params.document, builtAt, new Set(params.excludeSavedDomains ?? []))],
    facts,
    history: ownerMismatch ? emptyHistory() : buildHistory({ ...history, refs, recordNodes }),
  };
  return { ...projection, markdown: renderLiveMirrorMarkdown(projection) };
}

/** True when a living source can no longer be called current at `nowMs`. */
export function isLiveMirrorSourceExpired(source: LiveMirrorSource, nowMs: number): boolean {
  if (source.group !== "living" || source.state === "unavailable" || source.state === "withheld") return false;
  // Records that were never verified cannot be vouched for.
  if (source.verifiedAt === null) return source.liveCount > 0;
  const age = nowMs - Date.parse(source.verifiedAt);
  const limit = source.staleAfterMs ?? STALE_AFTER_MS;
  return !Number.isFinite(age) || age > limit || age < -limit;
}

export function liveMirrorHasExpiredSource(projection: LiveMirrorProjection, nowMs: number): boolean {
  return projection.sources.some(source => isLiveMirrorSourceExpired(source, nowMs));
}

const markdownByState = new WeakMap<LiveMirrorProjection, { key: string; markdown: string }>();

/**
 * Apply read-time states. "Current" is never trusted from a cache: a living
 * source past its window is stale, pending changes are updating, and its facts
 * follow. Overall: partial > conflict > updating > stale > empty > current.
 */
export function applyLiveMirrorReadTime(
  projection: LiveMirrorProjection,
  now: string | number,
  viewStatus: MemoryRefreshStatus,
): LiveMirrorView {
  const nowMs = toMs(now);
  if (!Number.isFinite(nowMs)) throw new Error("A valid read time is required");
  const expired = new Set<string>();
  const sources = projection.sources.map((source): LiveMirrorSource => {
    if (source.group === "saved") {
      // Saved sections are revision-based; only a stale document ages them.
      return { ...source, state: source.state === "current" && viewStatus === "stale" ? "stale" : source.state };
    }
    if (isLiveMirrorSourceExpired(source, nowMs)) expired.add(source.id);
    if (source.state !== "current" && source.state !== "not_checked") return { ...source };
    if (expired.has(source.id)) return { ...source, state: "stale" };
    const waiting = source.pendingChanges === null || source.pendingChanges > 0;
    return { ...source, state: waiting ? "updating" : source.state };
  });
  const sourceByKind = new Map(sources.filter(source => source.group === "living").map(source => [source.kind, source]));
  const facts = projection.facts.map((fact): LiveMirrorFact => {
    if (fact.state === "deleted" || fact.state === "conflicted") return { ...fact };
    const source = sourceByKind.get(fact.kind);
    if (!source || source.state === "unavailable") return { ...fact, state: "unavailable" };
    return { ...fact, state: expired.has(source.id) ? "stale" : "verified" };
  });
  // "Partial" names sources that could not be checked. A conflict also leaves
  // the document incomplete, so a failed refresh alone means "may be out of
  // date" and never hides a conflict behind "Some sources unavailable".
  const overall: LiveMirrorOverall =
    sources.some(source => source.state === "unavailable") ? "partial"
      : projection.nameConflict || projection.issues.includes("conflict") ||
          sources.some(source => source.state === "conflict") || facts.some(fact => fact.state === "conflicted") ? "conflict"
        : viewStatus === "refresh_pending" || sources.some(source => source.state === "updating") ? "updating"
          : viewStatus === "stale" || viewStatus === "refresh_failed" || sources.some(source => source.state === "stale") ? "stale"
            : facts.length === 0 && projection.history.entries.length === 0 ? "empty"
              : "current";
  const checked = sources
    .filter(source => source.group === "living" && source.state !== "unavailable" && source.verifiedAt !== null)
    .map(source => source.verifiedAt!)
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  const view: Omit<LiveMirrorView, "markdown"> = {
    ...projection,
    sources,
    facts,
    evaluatedAt: new Date(nowMs).toISOString(),
    overall,
    lastVerifiedAt: checked[0] ?? null,
  };
  // The preview depends only on states, so it is re-rendered only when one changes.
  const key = [overall, ...sources.map(source => `${source.id}:${source.state}:${expired.has(source.id) ? 1 : 0}`)].join("|");
  const memo = markdownByState.get(projection);
  if (memo?.key === key) return { ...view, markdown: memo.markdown };
  const markdown = renderLiveMirrorMarkdown(view);
  markdownByState.set(projection, { key, markdown });
  return { ...view, markdown };
}

const MARKDOWN_SPECIALS = /\r\n|[\n\r\t\v\f\u2028\u2029]|[&<>]|[!"#$%'()*+,\-./:;=?@[\\\]^_`{|}~]/g;
const HTML_ENTITIES: Readonly<Record<string, string>> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };

/** Inline text that cannot open any Markdown or HTML construct, or a new line. */
export function escapeLiveMirrorText(value: string): string {
  return value.replace(MARKDOWN_SPECIALS, (match) =>
    Object.hasOwn(HTML_ENTITIES, match) ? HTML_ENTITIES[match]! : /^[!-~]$/.test(match) ? `\\${match}` : " ");
}

/** "{n} changes waiting" for committed hints not yet verified; null when none. */
export function waitingText(pending: number | null): string | null {
  if (pending === null) return "Changes waiting";
  return pending > 0 ? `${pending} ${pending === 1 ? "change" : "changes"} waiting` : null;
}

function sourceStatusText(source: LiveMirrorSource): string {
  const at = source.verifiedAt ? escapeLiveMirrorText(source.verifiedAt) : null;
  const status = {
    current: at ? `Current · checked ${at}` : "Current",
    updating: at ? `Updating · checked ${at}` : "Updating",
    stale: at ? `Out of date · last checked ${at}` : "Out of date",
    unavailable: at ? `Unavailable · last checked ${at}` : "Unavailable",
    withheld: "Withheld · kept out of memory",
    conflict: "Needs review",
    not_checked: "Not checked yet",
  }[source.state];
  const waiting = waitingText(source.pendingChanges);
  return waiting ? `${status} · ${waiting.toLowerCase()}` : status;
}

function factLine(fact: LiveMirrorFact): string {
  const value = fact.state === "conflicted" ? "_Sources disagree_" : escapeLiveMirrorText(formatLiveMirrorValue(fact.predicate, fact.value));
  const note = fact.state === "stale" || fact.state === "unavailable" ? " _(last known)_" : "";
  return `${escapeLiveMirrorText(fact.label)}: ${value}${note}`;
}

function historyLine(entry: LiveMirrorHistoryEntry): string {
  const at = escapeLiveMirrorText(entry.capturedAt);
  if (entry.gap) {
    const count = entry.gap.committedChanges;
    return `${escapeLiveMirrorText(entry.ref)} · ${count === null ? "some changes may be missing" : `${count} changes made, only the latest seen`} · ${at}`;
  }
  const action = entry.operation === "delete" ? "Removed" : entry.revision === 1 ? "Added" : "Changed";
  const detail = entry.redacted ? " · details hidden"
    : entry.changes.length ? ` · ${entry.changes.map(change =>
      `${escapeLiveMirrorText(change.label)}: ${change.value === null ? "_Sources disagree_" : escapeLiveMirrorText(formatLiveMirrorValue(change.predicate, change.value))}`).join(", ")}`
      : "";
  return `${escapeLiveMirrorText(entry.ref)} · ${action} · ${at}${detail}`;
}

/** Deterministic preview of the model. Every value is Markdown- and HTML-escaped. */
export function renderLiveMirrorMarkdown(input: Omit<LiveMirrorProjection, "markdown"> & { overall?: LiveMirrorOverall }): string {
  const lines = ["# Live memory", ""];
  if (input.overall) lines.push(`**${LIVE_MIRROR_OVERALL_HEADLINES[input.overall]}.**`, "");
  lines.push(`_${LIVE_MEMORY_BOUNDARY_COPY}_`, "");
  const facts = [...input.facts].sort(compareLiveMirrorFacts);
  for (const source of input.sources) {
    if (source.group !== "living" || !source.kind) continue;
    lines.push(`## ${source.label}`, "", `_${sourceStatusText(source)}_`, "");
    const own = facts.filter(fact => fact.kind === source.kind);
    if (own.length === 0) {
      lines.push("_Nothing recorded._", "");
      continue;
    }
    if (source.kind === "profile") {
      for (const fact of own) lines.push(`- ${factLine(fact)}`);
      lines.push("");
      continue;
    }
    const refs = [...new Set(own.map(fact => fact.ref))];
    for (const ref of refs.slice(0, PREVIEW_RECORDS_PER_SOURCE)) {
      lines.push(`- ${escapeLiveMirrorText(ref)}`);
      for (const fact of own) if (fact.ref === ref) lines.push(`  - ${factLine(fact)}`);
    }
    if (refs.length > PREVIEW_RECORDS_PER_SOURCE) lines.push(`- _${refs.length - PREVIEW_RECORDS_PER_SOURCE} more not shown._`);
    lines.push("");
  }
  const saved = input.sources.filter(source => source.group === "saved");
  if (saved.length) {
    lines.push("## Saved details", "");
    for (const source of saved) {
      const state = { current: "Current", updating: "Updating", stale: "Out of date", unavailable: "Unavailable",
        withheld: "Withheld", conflict: "Needs review", not_checked: "Not checked yet" }[source.state];
      const version = source.contentRevision !== null ? ` · version ${source.contentRevision}` : "";
      lines.push(`- ${escapeLiveMirrorText(source.label)} · ${state}${version}`);
    }
    lines.push("");
  }
  lines.push("## Recent changes", "");
  const entries = input.history.entries;
  if (entries.length === 0) lines.push("_No changes yet._");
  for (const entry of entries.slice(0, PREVIEW_HISTORY_LIMIT)) lines.push(`- ${historyLine(entry)}`);
  if (entries.length > PREVIEW_HISTORY_LIMIT) lines.push(`- _${entries.length - PREVIEW_HISTORY_LIMIT} more in History._`);
  if (input.history.droppedCount > 0) lines.push(`- _${input.history.droppedCount} older changes not kept._`);
  lines.push("", "_Only changes seen while open._");
  return `${lines.join("\n")}\n`;
}
