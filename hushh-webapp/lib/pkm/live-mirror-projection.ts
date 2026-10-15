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
import { normalizeInternalRouteHref } from "@/lib/navigation/routes";
import {
  LIVE_MIRROR_FRESHNESS_MS,
  LIVE_MIRROR_HIDDEN_PREDICATES,
  LIVE_MIRROR_KINDS,
  LIVE_MIRROR_PRESENCE_ONLY_PREDICATES,
  LIVE_MIRROR_SOURCE_LABELS,
  LIVE_MIRROR_STALE_GRACE_MS,
  type LiveMirrorClaim,
  type LiveMirrorConflict,
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
import {
  compareLiveMirrorFacts,
  formatLiveMirrorDateTime,
  formatLiveMirrorValue,
  liveMirrorCount,
  liveMirrorFactStateLabel,
  liveMirrorGapText,
  liveMirrorHistoryAction,
  liveMirrorHistoryDetail,
  liveMirrorIsMoneyPredicate,
  liveMirrorRecordCurrency,
  liveMirrorSourceRoute,
  liveMirrorSourceStateLabel,
  liveMirrorWaitingText,
} from "@/lib/pkm/live-mirror-presentation";

/**
 * Live Mirror v1 projection. Pure: no vault, network, clock or storage access,
 * so callers pass `now`. It derives the one owner-scoped view of current facts
 * and observed history from an already decrypted inventory and the derived
 * memory document. The result lives in memory only. Its Markdown is a
 * deterministic, escaped preview of this model, never the authority. Every
 * owner-facing word comes from the shared presentation module.
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
  /**
   * The sides of that name conflict: each name the owner wrote in chat memory
   * that differs, and the verified profile name. Read only while
   * `nameConflict` is true; a side that is not known stays null.
   */
  nameClaims?: { soul?: readonly string[] | null; profile?: string | null } | null;
  /** The inventory could not be read, as opposed to not existing yet. */
  inventoryReadFailed?: boolean;
  /** Saved-detail domains already represented by the living sources. */
  excludeSavedDomains?: readonly string[];
}

const STALE_AFTER_MS = LIVE_MIRROR_FRESHNESS_MS + LIVE_MIRROR_STALE_GRACE_MS;
const HIDDEN_PREDICATES = new Set<string>(LIVE_MIRROR_HIDDEN_PREDICATES);
const PRESENCE_ONLY_PREDICATES = new Set<string>(LIVE_MIRROR_PRESENCE_ONLY_PREDICATES);
const KINDS = new Set<string>(LIVE_MIRROR_KINDS);
const MAX_VALUE_LENGTH = 2_048;
const PREVIEW_HISTORY_LIMIT = 20;
const PREVIEW_RECORDS_PER_SOURCE = 100;
/** Where an owner-authored name claim comes from: what they wrote in chat memory. */
const SOUL_CLAIM_LABEL = "Your memory";
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

/**
 * Stable, human-safe references. Records are numbered in the order this vault
 * first saw them (their earliest retained change), so a new record, dated or
 * not, never renumbers an existing one. Records first seen together are
 * numbered by source creation time, undated ones last. History-only records
 * follow the inventory.
 */
function recordRefs(recordNodes: readonly LivingFactNode[], changes: readonly LivingSourceChange[]): Map<string, string> {
  const refs = new Map<string, string>();
  const counts = new Map<LiveMirrorKind, number>();
  const add = (kind: LiveMirrorKind, id: string) => {
    if (refs.has(recordKey(kind, id))) return;
    const count = (counts.get(kind) ?? 0) + 1;
    counts.set(kind, count);
    refs.set(recordKey(kind, id), kind === "profile" ? RECORD_LABELS.profile : `${RECORD_LABELS[kind]} ${count}`);
  };
  const firstChange = new Map<string, LivingSourceChange>();
  for (const change of changes) {
    if (change.operation === "gap") continue;
    const key = recordKey(change.kind, change.id);
    if (change.sequence < (firstChange.get(key)?.sequence ?? Number.POSITIVE_INFINITY)) firstChange.set(key, change);
  }
  const order = (node: LivingFactNode) => {
    const { kind, sourceId, createdAt, capturedAt } = node.provenance;
    const first = firstChange.get(recordKey(kind, sourceId));
    const created = isIso(createdAt) ? Date.parse(createdAt) : Number.POSITIVE_INFINITY;
    // Without a retained change, creation (else capture) time stands in for first sight.
    const seen = first ? Date.parse(first.capturedAt) : Number.isFinite(created) ? created : Date.parse(capturedAt);
    return { seen: Number.isFinite(seen) ? seen : Number.POSITIVE_INFINITY, created, sequence: first?.sequence ?? Number.POSITIVE_INFINITY };
  };
  const ordered = recordNodes.map(node => ({ node, ...order(node) }));
  const before = (left: number, right: number) => (left === right ? 0 : left < right ? -1 : 1);
  ordered.sort((a, b) =>
    before(a.seen, b.seen) || before(a.created, b.created) || before(a.sequence, b.sequence) ||
    byCodeUnit(a.node.provenance.sourceId, b.node.provenance.sourceId));
  for (const { node } of ordered) add(node.provenance.kind, node.provenance.sourceId);
  for (const change of [...changes].sort((a, b) => a.sequence - b.sequence)) {
    if (change.operation !== "gap") add(change.kind, change.id);
  }
  return refs;
}

function admittedValue(value: unknown): LiveMirrorFactValue | null {
  return value !== null && value !== undefined && isFactValue(value) ? value : null;
}

/** A claim's value: presence for a URL-valued field, else the admitted value or null. */
function claimValue(predicate: string, value: unknown): LiveMirrorFactValue | null {
  if (PRESENCE_ONLY_PREDICATES.has(predicate)) return value !== null && value !== undefined;
  return admittedValue(value);
}

/** A copy's own ISO currency code, else null (money then reads as US dollars, as everywhere else). */
function claimCurrency(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z]{3}$/.test(value.trim()) ? value.trim().toUpperCase() : null;
}

function claimText(value: unknown): string | null {
  return typeof value === "string" && value.trim() && value.length <= MAX_VALUE_LENGTH ? value : null;
}

/**
 * A conflicted record's claims by predicate: every distinct value an admitted
 * field holds across the versions at the record's latest revision, each with
 * that revision. A deleted version claims no value, a photo claims presence
 * only, and other people's identifiers never become claims. Each side is named
 * by its copy ("Payment 2, copy 1"), numbered in a stable order so a copy keeps
 * its number on every field and rebuild, and a money side carries its own
 * copy's currency.
 */
function recordClaims(params: {
  kind: LiveMirrorKind;
  sourceId: string;
  revision: number;
  ref: string;
  records: readonly unknown[];
  verifiedAt: string | null;
}): Map<string, LiveMirrorClaim[]> {
  const versions: { value: Record<string, unknown>; deleted: boolean; updatedAt: string | null }[] = [];
  for (const version of params.records) {
    if (!isObject(version) || version.kind !== params.kind || version.id !== params.sourceId ||
        version.revision !== params.revision || !isObject(version.value)) continue;
    versions.push({
      value: version.value,
      deleted: version.deletedAt !== null && version.deletedAt !== undefined,
      updatedAt: isIso(version.updatedAt) ? version.updatedAt : null,
    });
  }
  const time = (at: string | null) => {
    const ms = at === null ? NaN : Date.parse(at);
    return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
  };
  versions.sort((a, b) => time(a.updatedAt) - time(b.updatedAt) || Number(a.deleted) - Number(b.deleted) ||
    byCodeUnit(JSON.stringify(a.value), JSON.stringify(b.value)));
  const claims = new Map<string, LiveMirrorClaim[]>();
  for (const field of LIVING_SOURCE_FACT_FIELDS[params.kind]) {
    const predicate = `${params.kind}.${field}`;
    if (HIDDEN_PREDICATES.has(predicate)) continue;
    const money = liveMirrorIsMoneyPredicate(predicate);
    const seen = new Set<string>();
    const sides: LiveMirrorClaim[] = [];
    versions.forEach((version, index) => {
      const value = claimValue(predicate, version.deleted ? undefined : version.value[field]);
      // Sides split as the owner reads them: the same amount in another
      // currency is another claim, a copy naming no currency reads as US
      // dollars, and an empty field reads "Not set" whatever its currency.
      const own = money && !version.deleted ? claimCurrency(version.value.currency) : null;
      const key = JSON.stringify([value, value === null ? null : own ?? "USD"]);
      if (seen.has(key)) return;
      seen.add(key);
      sides.push({
        source: params.kind, origin: "record", label: `${params.ref}, copy ${index + 1}`, value,
        revision: params.revision, sourceUpdatedAt: version.updatedAt, verifiedAt: params.verifiedAt,
        ...(money ? { currency: own } : {}),
      });
    });
    if (sides.length > 1) claims.set(predicate, sides);
  }
  return claims;
}

/**
 * The sides of the name conflict the memory document reports: each name the
 * owner wrote in chat memory (memory.md's revision and time) and the verified
 * profile name (the profile record's revision and times). A side that is not
 * known stays null; nothing is chosen or overwritten.
 */
function nameConflictClaims(
  params: BuildLiveMirrorProjectionParams,
  profileName: LivingFactNode | undefined,
  verifiedAt: string | null,
): LiveMirrorClaim[] {
  const given = isObject(params.nameClaims) ? params.nameClaims : {};
  const memory = (Array.isArray(params.document?.freshness) ? params.document.freshness : [])
    .find(entry => isObject(entry) && entry.domain === "one_memory");
  const soul = (value: string | null): LiveMirrorClaim => ({
    source: "soul", origin: "named", label: SOUL_CLAIM_LABEL, value,
    revision: typeof memory?.contentRevision === "number" ? memory.contentRevision : null,
    sourceUpdatedAt: isIso(memory?.updatedAt) ? memory.updatedAt : null, verifiedAt: null,
  });
  const written = [...new Set((Array.isArray(given.soul) ? given.soul : []).map(claimText))]
    .filter((name): name is string => name !== null);
  return [
    ...(written.length ? written.map(soul) : [soul(null)]),
    {
      source: "profile", origin: "named", label: LIVE_MIRROR_SOURCE_LABELS.profile,
      value: claimText(profileName?.value) ?? claimText(given.profile),
      revision: profileName?.provenance.revision ?? null,
      sourceUpdatedAt: profileName?.provenance.updatedAt ?? null, verifiedAt,
    },
  ];
}

/**
 * One conflict per predicate, in display order (source kind, then admitted
 * field), so each is listed once. The name conflict's claims come first,
 * then each conflicted record's in ref order, each claim naming its record.
 * A profile record whose own copies disagree on the name leaves no verified
 * name to compare memory with, so its copies stand alone, as in memory-refresh,
 * which raises no name conflict then either.
 */
function liveMirrorConflicts(
  named: readonly LiveMirrorClaim[] | null,
  records: readonly { ref: string; claims: ReadonlyMap<string, LiveMirrorClaim[]> }[],
): LiveMirrorConflict[] {
  const byPredicate = new Map<string, LiveMirrorClaim[]>();
  const add = (predicate: string, claims: readonly LiveMirrorClaim[]) =>
    byPredicate.set(predicate, [...(byPredicate.get(predicate) ?? []), ...claims]);
  if (named && !records.some(record => record.claims.has("profile.name"))) add("profile.name", named);
  const rank = (ref: string) => Number(/(\d+)$/.exec(ref)?.[1] ?? 0);
  for (const record of [...records].sort((a, b) => rank(a.ref) - rank(b.ref) || byCodeUnit(a.ref, b.ref))) {
    for (const [predicate, claims] of record.claims) add(predicate, claims);
  }
  const conflicts = [...byPredicate].map(([predicate, claims]) => {
    const kind = predicate.slice(0, predicate.indexOf(".")) as LiveMirrorKind;
    const field = predicate.slice(kind.length + 1);
    const order = [LIVE_MIRROR_KINDS.indexOf(kind), LIVING_SOURCE_FACT_FIELDS[kind].indexOf(field)] as const;
    return { conflict: { predicate, label: fieldLabel(kind, field), claims }, order };
  });
  conflicts.sort((a, b) => a.order[0] - b.order[0] || a.order[1] - b.order[1]);
  return conflicts.map(({ conflict }) => conflict);
}

/**
 * The admitted fields a revision set, compared with the record's previous
 * retained change. Without one, every admitted field is listed. A
 * presence-only field reports presence (`false` when removed); a disagreeing
 * revision lists its fields without values.
 */
function admittedChanges(
  kind: LiveMirrorKind,
  value: Record<string, unknown>,
  previous: Record<string, unknown> | null,
  unresolved: boolean,
): LiveMirrorHistoryEntry["changes"] {
  const changes: LiveMirrorHistoryEntry["changes"] = [];
  for (const field of LIVING_SOURCE_FACT_FIELDS[kind]) {
    const predicate = `${kind}.${field}`;
    if (HIDDEN_PREDICATES.has(predicate)) continue;
    const now = admittedValue(value[field]);
    const before = previous && !unresolved ? admittedValue(previous[field]) : null;
    if (previous && !unresolved && now === before) continue;
    const label = fieldLabel(kind, field);
    if (PRESENCE_ONLY_PREDICATES.has(predicate)) {
      if (now !== null || before !== null) changes.push({ predicate, label, value: unresolved ? null : now !== null });
      continue;
    }
    if (now !== null) changes.push({ predicate, label, value: unresolved ? null : now });
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
  // Each change's previous retained change for the same record.
  const previous = new Map<number, LivingSourceChange>();
  const last = new Map<string, LivingSourceChange>();
  for (const change of [...params.changes].sort((a, b) => a.sequence - b.sequence)) {
    if (change.operation === "gap") continue;
    const key = recordKey(change.kind, change.id);
    latestSequence.set(key, change.sequence);
    if (change.operation === "delete") removedAt.set(key, change.sequence);
    const prior = last.get(key);
    if (prior) previous.set(change.sequence, prior);
    last.set(key, change);
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
        : admittedChanges(change.kind, change.value, previous.get(change.sequence)?.value ?? null,
          unresolvedRevision.get(key) === change.revision),
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
  const conflicted: { ref: string; claims: Map<string, LiveMirrorClaim[]> }[] = [];
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
    conflicted.push({
      ref: common.ref,
      claims: recordClaims({ kind, sourceId, revision, ref: common.ref, records: inventory!.records, verifiedAt: source.verifiedAt }),
    });
  }
  facts.sort((a, b) => byCodeUnit(a.key, b.key));
  // A mirror that fails closed reports no conflict either.
  const nameConflict = params.nameConflict === true && !ownerMismatch;
  const named = nameConflict
    ? nameConflictClaims(params, index?.byPredicate.get("profile.name")?.[0], sourceByKind.get("profile")!.verifiedAt)
    : null;
  const projection: Omit<LiveMirrorProjection, "markdown"> = {
    schemaVersion: "live_mirror.v1",
    ownerId: params.ownerId,
    vaultEpoch: params.vaultEpoch,
    builtAt,
    inventoryObservedAt: ownerMismatch ? null : inventory?.observedAt ?? null,
    inventoryComplete: !ownerMismatch && inventory?.complete === true,
    issues: [...issues].sort(byCodeUnit),
    nameConflict,
    conflicts: liveMirrorConflicts(named, conflicted),
    sources: [...living, ...savedSources(params.document, builtAt, new Set(params.excludeSavedDomains ?? []))],
    facts,
    history: ownerMismatch ? emptyHistory() : buildHistory({ ...history, refs, recordNodes }),
  };
  return { ...projection, markdown: renderLiveMirrorMarkdown(projection) };
}

/** True when a living source can no longer be called current at `nowMs`. */
function isLiveMirrorSourceExpired(source: LiveMirrorSource, nowMs: number): boolean {
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
  // Other people's identifiers never reach a surface, even inside a disagreement.
  const conflicts = (Array.isArray(projection.conflicts) ? projection.conflicts : [])
    .filter(conflict => !HIDDEN_PREDICATES.has(conflict?.predicate));
  const overall: LiveMirrorOverall =
    sources.some(source => source.state === "unavailable") ? "partial"
      : projection.nameConflict || conflicts.length > 0 || projection.issues.includes("conflict") ||
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
    // Read time changes no claim: both sides stay until the owner acts at the source.
    conflicts,
    sources,
    facts,
    evaluatedAt: new Date(nowMs).toISOString(),
    overall,
    lastVerifiedAt: checked[0] ?? null,
  };
  // The preview depends only on source states, so it is re-rendered only when one changes.
  const key = sources.map(source => `${source.id}:${source.state}:${expired.has(source.id) ? 1 : 0}`).join("|");
  const memo = markdownByState.get(projection);
  if (memo?.key === key) return { ...view, markdown: memo.markdown };
  const markdown = renderLiveMirrorMarkdown(view);
  markdownByState.set(projection, { key, markdown });
  return { ...view, markdown };
}

const MARKDOWN_SPECIALS = /\r\n|[\n\r\t\v\f\u2028\u2029]|[&<>]|[!"#$%'()*+,\-./:;=?@[\\\]^_`{|}~]/g;
const HTML_ENTITIES: Readonly<Record<string, string>> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };

/**
 * Inline text that cannot open a Markdown or HTML construct, link syntax, a
 * table cell or a new line. GFM still autolinks bare URL and email text; the
 * preview's one renderer (SafeMarkdown, linkPolicy "internal") shows every
 * link that is not app-relative as plain text, so nothing invisible is added
 * and copied text is exactly what shows.
 */
function escapeLiveMirrorText(value: string): string {
  return value.replace(MARKDOWN_SPECIALS, (match) =>
    Object.hasOwn(HTML_ENTITIES, match) ? HTML_ENTITIES[match]! : /^[!-~]$/.test(match) ? `\\${match}` : " ");
}

function timeText(at: string | null): string {
  return escapeLiveMirrorText(formatLiveMirrorDateTime(at) ?? "an unknown time");
}

function sourceStatusText(source: LiveMirrorSource): string {
  const state = liveMirrorSourceStateLabel(source.state);
  const at = source.verifiedAt ? timeText(source.verifiedAt) : null;
  const status = source.state === "withheld" ? `${state} · kept out of memory`
    : !at || source.state === "conflict" || source.state === "not_checked" ? state
      : `${state} · ${source.state === "stale" || source.state === "unavailable" ? "last checked" : "checked"} ${at}`;
  const waiting = liveMirrorWaitingText(source.pendingChanges);
  return waiting ? `${status} · ${waiting.toLowerCase()}` : status;
}

function factLine(fact: LiveMirrorFact, record: readonly LiveMirrorFact[]): string {
  if (fact.state === "conflicted") return `${escapeLiveMirrorText(fact.label)}: _Sources disagree_`;
  const value = formatLiveMirrorValue(fact.predicate, fact.value, { currency: liveMirrorRecordCurrency(record) });
  const note = liveMirrorFactStateLabel(fact.state);
  return `${escapeLiveMirrorText(fact.label)}: ${escapeLiveMirrorText(note ? `${value} · ${note}` : value)}`;
}

function historyLine(entry: LiveMirrorHistoryEntry, facts: readonly LiveMirrorFact[]): string {
  const ref = escapeLiveMirrorText(entry.ref);
  if (entry.gap) return `${ref} · ${escapeLiveMirrorText(liveMirrorGapText(entry.gap))} · ${timeText(entry.capturedAt)}`;
  const detail = liveMirrorHistoryDetail(entry, facts);
  return `${ref} · ${liveMirrorHistoryAction(entry)} · ${timeText(entry.capturedAt)}${detail ? ` · ${escapeLiveMirrorText(detail)}` : ""}`;
}

interface FinanceTable {
  amount: string;
  /** The first of these the record has; adjustments carry a type instead of a status. */
  status: readonly string[];
  when: string;
  mode: string;
  /** What the activity was, named beside the record. */
  activity?: string;
}

/** Money sources read as a table with one row per record. */
const FINANCE_TABLES: Partial<Record<LiveMirrorKind, FinanceTable>> = {
  document_earning: { amount: "grossCents", status: ["status"], when: "createdAt", mode: "stripeMode" },
  payout_activity: { amount: "amountCents", status: ["status", "type"], when: "occurredAt", mode: "mode", activity: "kind" },
  document_request_payment: { amount: "amountCents", status: ["status"], when: "paidAt", mode: "mode" },
};
const FINANCE_TABLE_HEAD = ["| Record | Amount | Status | When |", "| --- | --- | --- | --- |"];
const EMPTY_CELL = "—";

/**
 * One table row. Every cell is escaped like a list value, so a pipe or a line
 * break in an owner value cannot split the row and its link syntax stays text.
 * The record cell also says what the activity was, test mode and any
 * read-time state; a disagreeing record shows no value.
 */
function financeRow(table: FinanceTable, ref: string, record: readonly LiveMirrorFact[]): string {
  const cell = (...parts: (string | null)[]): string => {
    const text = parts.filter((part): part is string => part !== null).map(escapeLiveMirrorText);
    return text.length ? text.join(" · ") : EMPTY_CELL;
  };
  const row = (cells: readonly string[]) => `| ${cells.join(" | ")} |`;
  if (record.some(fact => fact.state === "conflicted")) {
    return row([cell(ref, liveMirrorFactStateLabel("conflicted")), EMPTY_CELL, EMPTY_CELL, EMPTY_CELL]);
  }
  const currency = liveMirrorRecordCurrency(record);
  const shown = (field?: string): string | null => {
    const fact = field ? record.find(each => each.field === field) : undefined;
    return fact ? formatLiveMirrorValue(fact.predicate, fact.value, { currency }) : null;
  };
  const testMode = record.find(each => each.field === table.mode)?.value === "test";
  return row([
    cell(ref, shown(table.activity), testMode ? shown(table.mode) : null, liveMirrorFactStateLabel(record[0]!.state)),
    cell(shown(table.amount)),
    cell(table.status.map(shown).find(text => text !== null) ?? null),
    cell(shown(table.when)),
  ]);
}

/** The section's one generated link, to where its source is changed. Only a canonical in-app route qualifies. */
function sourceLink(kind: LiveMirrorKind): string | null {
  const route = liveMirrorSourceRoute(kind);
  if (!route || normalizeInternalRouteHref(route.href) !== route.href || /[\s()<>]/.test(route.href)) return null;
  return `[${escapeLiveMirrorText(route.label)}](${route.href})`;
}

/**
 * Deterministic preview of the model. Every value is Markdown- and
 * HTML-escaped, so it never forms link syntax; a bare URL or email that GFM
 * autolinks renders as text under the preview's internal link policy, which
 * keeps only the generated app-relative links. It starts at level two and leaves
 * out what the surrounding panel already says (title, status, boundary and
 * history footer). Money sources render as GFM tables, the others as lists,
 * and each section ends with one link to where its source is changed.
 * Sources with nothing recorded share one line.
 */
function renderLiveMirrorMarkdown(input: Omit<LiveMirrorProjection, "markdown">): string {
  const lines: string[] = [];
  const facts = [...input.facts].sort(compareLiveMirrorFacts);
  const empty: LiveMirrorSource[] = [];
  for (const source of input.sources) {
    if (source.group !== "living" || !source.kind) continue;
    const own = facts.filter(fact => fact.kind === source.kind);
    if (own.length === 0) {
      empty.push(source);
      continue;
    }
    lines.push(`## ${source.label}`, "", `_${sourceStatusText(source)}_`, "");
    const refs = [...new Set(own.map(fact => fact.ref))];
    const shown = refs.slice(0, PREVIEW_RECORDS_PER_SOURCE);
    const more = refs.length - shown.length;
    const table = FINANCE_TABLES[source.kind];
    if (table) {
      lines.push(...FINANCE_TABLE_HEAD, ...shown.map(ref => financeRow(table, ref, own.filter(fact => fact.ref === ref))));
      // GFM continues a table until a blank line, so anything after one follows a blank line.
      if (more > 0) lines.push("", `_${more} more not shown._`);
    } else {
      for (const ref of shown) {
        const record = own.filter(fact => fact.ref === ref);
        if (source.kind === "profile") {
          for (const fact of record) lines.push(`- ${factLine(fact, record)}`);
          continue;
        }
        lines.push(`- ${escapeLiveMirrorText(ref)}`);
        for (const fact of record) lines.push(`  - ${factLine(fact, record)}`);
      }
      if (more > 0) lines.push(`- _${more} more not shown._`);
    }
    const link = sourceLink(source.kind);
    if (link) lines.push("", link);
    lines.push("");
  }
  const unreadable = empty.filter(source => source.state === "unavailable").map(source => source.label);
  const nothing = empty.filter(source => source.state !== "unavailable").map(source => source.label);
  if (nothing.length) lines.push(`_Nothing recorded: ${nothing.join(", ")}._`, "");
  if (unreadable.length) lines.push(`_Couldn’t check: ${unreadable.join(", ")}._`, "");
  const saved = input.sources.filter(source => source.group === "saved");
  if (saved.length) {
    lines.push("## Saved details", "");
    for (const source of saved) {
      const version = source.contentRevision !== null ? ` · version ${source.contentRevision}` : "";
      lines.push(`- ${escapeLiveMirrorText(source.label)} · ${liveMirrorSourceStateLabel(source.state)}${version}`);
    }
    lines.push("");
  }
  lines.push("## Recent changes", "");
  const entries = input.history.entries;
  if (entries.length === 0) lines.push("_No changes yet._");
  for (const entry of entries.slice(0, PREVIEW_HISTORY_LIMIT)) lines.push(`- ${historyLine(entry, facts)}`);
  if (entries.length > PREVIEW_HISTORY_LIMIT) lines.push(`- _${entries.length - PREVIEW_HISTORY_LIMIT} more in History._`);
  if (input.history.droppedCount > 0) lines.push(`- _${liveMirrorCount(input.history.droppedCount, "older change")} not kept._`);
  return `${lines.join("\n")}\n`;
}
