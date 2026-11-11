"use client";

/**
 * Owner-scoped live activity journal for this device. Capture is synchronous
 * and O(1) into RAM; persistence is a debounced, encrypted chunk write through
 * SecureResourceCacheService under the vault key with a 7-day TTL and the
 * durable owner-generation fence. Nothing here writes PKM: consolidation is
 * the only reader that turns activity into memory.
 *
 * Every async step is fenced on the attachment it started from: the validated
 * owner snapshot plus durable reset counter captured at attach, and the vault
 * session epoch. A step for a stale attachment drops silently, so a late
 * event or write for one owner can never land in another owner's journal.
 * Diagnostics never include event content; this module logs nothing.
 */

import {
  isProductActivityScopeCurrent,
  snapshotProductActivityScope,
  type ProductActivityScope,
} from "@/lib/observability/product-activity-scope";
import { subscribeTrackedEvents } from "@/lib/observability/tracked-event-bus";
import { SecureDurableResourceService } from "@/lib/services/secure-durable-resource-service";
import { SecureResourceCacheService } from "@/lib/services/secure-resource-cache-service";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { liveActivityFromTrackedEvent } from "./live-activity-event-map";
import { LiveActivityRing } from "./live-activity-ring";
import {
  LIVE_ACTIVITY_CHUNK_SIZE,
  LIVE_ACTIVITY_COALESCE_WINDOW_MS,
  LIVE_ACTIVITY_MAX_PERSISTED_EVENTS,
  LIVE_ACTIVITY_RESOURCE_PREFIX,
  LIVE_ACTIVITY_RETENTION_MS,
  isLiveActivityEvent,
  normalizeLiveActivityInput,
  type LiveActivityEvent,
  type LiveActivityInput,
} from "./live-activity-types";

export type LiveActivityBatch = Readonly<{ userId: string; events: readonly LiveActivityEvent[]; through: Readonly<Record<string, number>>; attempt: number; attemptKey: string }>;

const CHUNK_PREFIX = `${LIVE_ACTIVITY_RESOURCE_PREFIX}chunk:`;
const LEDGER_KEY = `${LIVE_ACTIVITY_RESOURCE_PREFIX}ledger`;
const FLUSH_DELAY_MS = 2_000;
const FLUSH_EVENT_THRESHOLD = 16;
const MAX_FAILED_ATTEMPTS = 2;
const DEFAULT_PEEK_LIMIT = 200;
const STREAM_PATTERN = /^[a-z0-9]{1,40}$/;
const CHUNK_KEY_PATTERN = /^([a-z0-9]{1,40}):(\d{1,7})$/;
const EVENT_ID_PATTERN = /^[a-z0-9]{1,40}:\d{1,9}$/;
const EMPTY: readonly LiveActivityEvent[] = Object.freeze([]);

type Ledger = { v: 1; through: Record<string, number>; attempts: Record<string, number> };
type StoredChunk = { key: string; streamId: string; events: LiveActivityEvent[] };

type Attachment = {
  readonly userId: string;
  readonly vaultKey: string;
  readonly scope: ProductActivityScope;
  /** Vault session epoch; carried only across a verified same-owner renewal. */
  epoch: number;
  /** One stream per attachment, so tabs and re-attaches never share a record. */
  readonly streamId: string;
  readonly ring: LiveActivityRing;
  readonly dirty: Set<number>;
  seq: number;
  pending: number;
  generation: number | null;
  ready: Promise<boolean>;
  /** Events from earlier streams, loaded for the visible journal. */
  persisted: readonly LiveActivityEvent[];
  chain: Promise<void>;
  timer: ReturnType<typeof setTimeout> | null;
  removeLifecycle: () => void;
};

let attachment: Attachment | null = null;
const enabledOwners = new Set<string>();
const listeners = new Set<() => void>();
let busSubscribed = false;
let version = 0;
let peekCache: { key: string; value: readonly LiveActivityEvent[] } | null = null;

function isCurrent(att: Attachment): boolean {
  return attachment === att && isProductActivityScopeCurrent(att.scope) && isVaultSessionEpochCurrent(att.epoch);
}

function changed(): void {
  version += 1;
  peekCache = null;
  for (const listener of [...listeners]) {
    try { listener(); } catch { /* A view's failure never affects capture. */ }
  }
}

function newStreamId(): string {
  const random = typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function"
    ? Array.from(crypto.getRandomValues(new Uint32Array(2)), value => value.toString(36)).join("")
    : Math.random().toString(36).slice(2);
  return `${Date.now().toString(36)}${random}`.slice(0, 32);
}

const chunkIndexOf = (seq: number) => Math.floor((seq - 1) / LIVE_ACTIVITY_CHUNK_SIZE);
const chunkKey = (streamId: string, index: number) => `${CHUNK_PREFIX}${streamId}:${index}`;
const byLastAtDesc = (a: LiveActivityEvent, b: LiveActivityEvent) => b.lastAt - a.lastAt || b.seq - a.seq;
const byFirstAt = (a: LiveActivityEvent, b: LiveActivityEvent) =>
  a.firstAt - b.firstAt || a.streamId.localeCompare(b.streamId) || a.seq - b.seq;

function clearRam(att: Attachment): void {
  if (att.timer) clearTimeout(att.timer);
  att.timer = null;
  att.ring.clear();
  att.dirty.clear();
  att.pending = 0;
  att.persisted = EMPTY;
}

function teardown(att: Attachment): void {
  if (attachment !== att) return;
  clearRam(att);
  att.removeLifecycle();
  attachment = null;
}

/** Every write carries the owner generation, so an account Reset/delete aborts it. */
async function writeRecord(att: Attachment, resourceKey: string, value: unknown): Promise<void> {
  if (att.generation === null) throw new Error("Live activity storage is not ready.");
  await SecureResourceCacheService.writeRequired({
    userId: att.userId,
    resourceKey,
    value,
    ttlMs: LIVE_ACTIVITY_RETENTION_MS,
    vaultKey: att.vaultKey,
    ownerGeneration: att.generation,
  });
}

/** Writes this stream's dirty chunks. A failed write is retried on the next flush. */
async function persistDirty(att: Attachment): Promise<void> {
  if (!att.dirty.size || !(await att.ready) || !isCurrent(att)) return;
  const indices = [...att.dirty].sort((a, b) => a - b);
  att.dirty.clear();
  att.pending = 0;
  const events = att.ring.toArray();
  try {
    for (const index of indices) {
      const chunk = events.filter(event => chunkIndexOf(event.seq) === index);
      if (!isCurrent(att)) return;
      if (chunk.length) await writeRecord(att, chunkKey(att.streamId, index), { v: 1, streamId: att.streamId, index, events: chunk });
    }
  } catch {
    if (attachment === att) for (const index of indices) att.dirty.add(index);
  }
}

function flushNow(att: Attachment): Promise<void> {
  if (att.timer) clearTimeout(att.timer);
  att.timer = null;
  att.chain = att.chain.then(() => persistDirty(att)).catch(() => undefined);
  return att.chain;
}

function scheduleFlush(att: Attachment): void {
  if (att.pending >= FLUSH_EVENT_THRESHOLD) {
    void flushNow(att);
    return;
  }
  if (!att.timer) att.timer = setTimeout(() => { att.timer = null; void flushNow(att); }, FLUSH_DELAY_MS);
}

/** Best effort on page hide; mobile WebViews often skip pagehide, so hidden also flushes. */
function listenForPageHide(att: Attachment): () => void {
  if (typeof window === "undefined") return () => undefined;
  const flush = () => { void flushNow(att); };
  const onVisibility = () => { if (document.visibilityState === "hidden") flush(); };
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    window.removeEventListener("pagehide", flush);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}

function parseChunkKey(key: string): { streamId: string; index: number } | null {
  if (!key.startsWith(CHUNK_PREFIX)) return null;
  const match = CHUNK_KEY_PATTERN.exec(key.slice(CHUNK_PREFIX.length));
  return match ? { streamId: match[1]!, index: Number(match[2]) } : null;
}

function chunkEvents(value: unknown, ref: { streamId: string; index: number }): LiveActivityEvent[] {
  if (!value || typeof value !== "object") return [];
  const chunk = value as Record<string, unknown>;
  if (chunk.v !== 1 || chunk.streamId !== ref.streamId || chunk.index !== ref.index || !Array.isArray(chunk.events)) return [];
  return chunk.events.filter((event): event is LiveActivityEvent =>
    isLiveActivityEvent(event) && event.streamId === ref.streamId && chunkIndexOf(event.seq) === ref.index);
}

/** Every readable chunk for the attachment's owner with its valid events, or null when it went stale. */
async function readStoredChunks(att: Attachment, vaultKey: string): Promise<StoredChunk[] | null> {
  const keys = await SecureResourceCacheService.listResourceKeys(att.userId, CHUNK_PREFIX);
  if (!isCurrent(att)) return null;
  const refs = keys.flatMap(key => { const ref = parseChunkKey(key); return ref ? [{ key, ref }] : []; });
  const values = await Promise.all(refs.map(({ key }) =>
    SecureResourceCacheService.read<unknown>({ userId: att.userId, resourceKey: key, vaultKey })));
  if (!isCurrent(att)) return null;
  return refs.map(({ key, ref }, position) => ({ key, streamId: ref.streamId, events: chunkEvents(values[position], ref) }));
}

/** Retained events (inside the 7-day window), de-duplicated by id. */
function retainedEvents(chunks: readonly StoredChunk[]): LiveActivityEvent[] {
  const cutoff = Date.now() - LIVE_ACTIVITY_RETENTION_MS;
  const byId = new Map<string, LiveActivityEvent>();
  for (const chunk of chunks) for (const event of chunk.events) if (event.lastAt >= cutoff) byId.set(event.id, event);
  return [...byId.values()];
}

/** Earlier streams' chunks whose newest event is past 7 days or, newest first, past LIVE_ACTIVITY_MAX_PERSISTED_EVENTS retained events (once a chunk is chosen, `kept` is Infinity and every older chunk is too). Unreadable chunks wait for their TTL; this stream's chunks are never chosen. */
function chunksPastRetention(chunks: readonly StoredChunk[], ownStreamId: string): StoredChunk[] {
  const cutoff = Date.now() - LIVE_ACTIVITY_RETENTION_MS;
  const newest = (chunk: StoredChunk) => Math.max(...chunk.events.map(event => event.lastAt));
  let kept = 0;
  return chunks.filter(chunk => chunk.streamId !== ownStreamId && chunk.events.length)
    .sort((a, b) => newest(b) - newest(a))
    .filter(chunk => {
      const retained = chunk.events.filter(event => event.lastAt >= cutoff).length;
      kept = retained === 0 || kept + retained > LIVE_ACTIVITY_MAX_PERSISTED_EVENTS ? Infinity : kept + retained;
      return kept === Infinity;
    });
}

/** Best effort, one chunk at a time, only while the attachment is current. */
async function pruneChunks(att: Attachment, chunks: readonly StoredChunk[]): Promise<ReadonlySet<string>> {
  const removed = new Set<string>();
  for (const chunk of chunks) {
    if (!isCurrent(att)) break;
    await SecureResourceCacheService.invalidateResource(att.userId, chunk.key).then(() => removed.add(chunk.key), () => undefined);
  }
  return removed;
}

async function loadGeneration(att: Attachment): Promise<boolean> {
  try {
    const { generation } = await SecureDurableResourceService.version(att.userId, LEDGER_KEY);
    if (!isCurrent(att)) return false;
    att.generation = generation;
    return true;
  } catch {
    return false; // No encrypted device storage: capture stays RAM-only for this attachment.
  }
}

async function loadPersisted(att: Attachment): Promise<void> {
  try {
    if (!(await att.ready)) return;
    const chunks = await readStoredChunks(att, att.vaultKey);
    if (!chunks || !isCurrent(att)) return;
    const removed = await pruneChunks(att, chunksPastRetention(chunks, att.streamId));
    if (!isCurrent(att)) return;
    att.persisted = retainedEvents(chunks.filter(chunk => !removed.has(chunk.key)))
      .filter(event => event.streamId !== att.streamId)
      .sort(byLastAtDesc).slice(0, LIVE_ACTIVITY_MAX_PERSISTED_EVENTS);
    changed();
  } catch { /* The visible journal starts from this stream only. */ }
}

function ensureBusSubscription(): void {
  if (busSubscribed) return;
  busSubscribed = true;
  subscribeTrackedEvents((eventName, sanitized) => {
    const input = liveActivityFromTrackedEvent(eventName, sanitized);
    if (input) recordLiveActivity(input);
  });
}

export type LiveActivityOrigin = ProductActivityScope | null;

/** Take before async work and pass to recordLiveActivity, so a late result never lands under another owner. */
export function snapshotLiveActivityOwner(): LiveActivityOrigin {
  return snapshotProductActivityScope();
}

/** O(1); never throws or awaits; true when stored. Drops unless an attached, enabled store exists for the current validated owner, and, when `origin` is given, unless that owner is still the one who started the action. Coalesces repeats; schedules a debounced encrypted chunk write (<= 2 s or 16 events; best effort on pagehide). */
export function recordLiveActivity(input: LiveActivityInput, origin?: ProductActivityScope | null): boolean {
  try {
    const att = attachment;
    if (!att || !enabledOwners.has(att.userId)) return false;
    if (origin !== undefined && (!origin || origin.owner.userId !== att.userId || !isProductActivityScopeCurrent(origin))) return false;
    if (!isCurrent(att)) {
      teardown(att);
      changed();
      return false;
    }
    const normalized = normalizeLiveActivityInput(input);
    if (!normalized) return false;
    const event = att.ring.push(normalized, att.streamId, () => ++att.seq);
    att.dirty.add(chunkIndexOf(event.seq));
    att.pending += 1;
    scheduleFlush(att);
    changed();
    return true;
  } catch { return false; /* Capture is best effort; it never breaks the action that produced it. */ }
}

/** Bridge calls this after unlock. Captures owner snapshot, reset fence, vault epoch and durable generation; subscribes the tracked-event bus (once); deletes earlier streams' chunks past retention (7 days, LIVE_ACTIVITY_MAX_PERSISTED_EVENTS events) and loads the rest for the visible view; enables persistence of this tab's stream. Returns detach (stops persistence and clears RAM for this owner). */
export function attachLiveActivityStore(params: { userId: string; vaultKey: string }): () => void {
  const scope = snapshotProductActivityScope();
  if (!scope || scope.owner.userId !== params.userId || !params.vaultKey) return () => undefined;
  if (attachment) teardown(attachment);
  ensureBusSubscription();
  const att: Attachment = {
    userId: params.userId,
    vaultKey: params.vaultKey,
    scope,
    epoch: snapshotVaultSessionEpoch(),
    streamId: newStreamId(),
    ring: new LiveActivityRing(),
    dirty: new Set(),
    seq: 0,
    pending: 0,
    generation: null,
    ready: Promise.resolve(false),
    persisted: EMPTY,
    chain: Promise.resolve(),
    timer: null,
    removeLifecycle: () => undefined,
  };
  attachment = att;
  att.ready = loadGeneration(att);
  att.removeLifecycle = listenForPageHide(att);
  void loadPersisted(att);
  changed();
  return () => {
    if (attachment !== att) return;
    teardown(att);
    changed();
  };
}

/** Called when the vault advances the session epoch for the same owner and key: a verified token renewal or a same-key re-unlock (Kai). */
export function renewLiveActivitySession(params: { userId: string; previousEpoch: number; vaultKey: string }): void {
  const att = attachment;
  if (!att || att.userId !== params.userId || att.vaultKey !== params.vaultKey || att.epoch !== params.previousEpoch) return;
  if (!isProductActivityScopeCurrent(att.scope)) return;
  att.epoch = snapshotVaultSessionEpoch();
}

/** Policy gate per owner (default disabled until the bridge enables it). Disabling clears RAM. */
export function setLiveActivityEnabled(userId: string, enabled: boolean): void {
  if (enabled) {
    enabledOwners.add(userId);
  } else {
    enabledOwners.delete(userId);
    if (attachment?.userId === userId) clearRam(attachment);
  }
  changed();
}

/** Visible journal for the current owner, newest first (default limit 200). Empty for any other owner or when detached. */
export function peekLiveActivity(userId: string, limit: number = DEFAULT_PEEK_LIMIT): readonly LiveActivityEvent[] {
  const att = attachment;
  if (!att || att.userId !== userId || !enabledOwners.has(userId) || !isCurrent(att)) return EMPTY;
  const bounded = Number.isSafeInteger(limit) && limit > 0 ? limit : DEFAULT_PEEK_LIMIT;
  const key = `${userId}|${bounded}|${version}`;
  if (peekCache?.key === key) return peekCache.value;
  const visible = [...att.persisted, ...att.ring.toArray()].sort(byLastAtDesc).slice(0, bounded);
  peekCache = { key, value: Object.freeze(visible) };
  return peekCache.value;
}

/** Fires on record, load, settle and clear. */
export function subscribeLiveActivity(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function sanitizeCounts(value: unknown, keyPattern: RegExp): Record<string, number> {
  const counts: Record<string, number> = {};
  if (!value || typeof value !== "object") return counts;
  for (const [key, count] of Object.entries(value as Record<string, unknown>)) {
    if (keyPattern.test(key) && Number.isSafeInteger(count) && (count as number) >= 0) counts[key] = count as number;
  }
  return counts;
}

/** Absent, expired or unreadable ledger reads as empty: at worst a batch is offered again. */
async function readLedger(att: Attachment, vaultKey: string): Promise<Ledger> {
  const stored = await SecureResourceCacheService.read<Record<string, unknown>>({ userId: att.userId, resourceKey: LEDGER_KEY, vaultKey });
  return {
    v: 1,
    through: sanitizeCounts(stored?.v === 1 ? stored.through : null, STREAM_PATTERN),
    attempts: sanitizeCounts(stored?.v === 1 ? stored.attempts : null, EVENT_ID_PATTERN),
  };
}

/** Oldest first; `through` never skips an unoffered or held event of the same stream. */
function takeBatch(pending: LiveActivityEvent[], max: number, held: readonly LiveActivityEvent[] = []) {
  const ordered = [...pending].sort(byFirstAt);
  const taken = ordered.slice(0, max);
  const through: Record<string, number> = {};
  for (const event of taken) through[event.streamId] = Math.max(through[event.streamId] ?? 0, event.seq);
  for (const event of [...ordered.slice(max), ...held]) {
    const limit = through[event.streamId];
    if (limit !== undefined && event.seq <= limit) through[event.streamId] = event.seq - 1;
  }
  return { events: taken.filter(event => event.seq <= (through[event.streamId] ?? 0)), through };
}

function currentFor(userId: string, vaultKey: string): Attachment | null {
  const att = attachment;
  return att && att.userId === userId && att.vaultKey === vaultKey && isCurrent(att) ? att : null;
}

/** Unconsolidated events across all persisted streams for the owner (seq above the encrypted ledger), oldest first, at most max. An event that can still absorb repeats (last seen within the coalesce window) is held back, and so is everything after it in its stream (even if the clock moved back), so a repeat never merges into an event already sent and the ledger never passes an unsent event. Flushes this tab's pending chunk first. Null when detached, not current, or nothing pending. */
export async function readUnconsolidatedLiveActivity(params: { userId: string; vaultKey: string; max: number }): Promise<LiveActivityBatch | null> {
  const att = currentFor(params.userId, params.vaultKey);
  const max = Math.floor(params.max);
  if (!att || !(max > 0)) return null;
  try {
    await flushNow(att);
    if (!(await att.ready) || !isCurrent(att)) return null;
    const [chunks, ledger] = await Promise.all([readStoredChunks(att, params.vaultKey), readLedger(att, params.vaultKey)]);
    if (!chunks || !isCurrent(att)) return null;
    const settledBefore = Date.now() - LIVE_ACTIVITY_COALESCE_WINDOW_MS;
    const unsent = retainedEvents(chunks).filter(event => event.seq > (ledger.through[event.streamId] ?? 0));
    const batch = takeBatch(unsent.filter(event => event.lastAt <= settledBefore), max, unsent.filter(event => event.lastAt > settledBefore));
    const first = batch.events[0]; if (!first) return null;
    return Object.freeze({
      userId: params.userId,
      events: Object.freeze(batch.events),
      through: Object.freeze(batch.through),
      attempt: ledger.attempts[first.id] ?? 0, attemptKey: first.id,
    });
  } catch {
    return null;
  }
}

function settledLedger(ledger: Ledger, batch: LiveActivityBatch, outcome: "consolidated" | "failed", liveStreams: ReadonlySet<string>): Ledger {
  const attemptKey = batch.attemptKey;
  const failures = batch.attempt + 1;
  const advance = outcome === "consolidated" || failures >= MAX_FAILED_ATTEMPTS;
  const through: Record<string, number> = {};
  const attempts: Record<string, number> = {};
  for (const [streamId, seq] of Object.entries(ledger.through)) if (liveStreams.has(streamId)) through[streamId] = seq;
  for (const [id, count] of Object.entries(ledger.attempts)) {
    if (id !== attemptKey && liveStreams.has(id.split(":")[0]!)) attempts[id] = count;
  }
  if (!advance) {
    if (attemptKey) attempts[attemptKey] = failures;
    return { v: 1, through, attempts };
  }
  for (const [streamId, seq] of Object.entries(batch.through)) {
    if (STREAM_PATTERN.test(streamId) && Number.isSafeInteger(seq)) through[streamId] = Math.max(through[streamId] ?? 0, seq);
  }
  return { v: 1, through, attempts };
}

/** Ledger is one encrypted record `${LIVE_ACTIVITY_RESOURCE_PREFIX}ledger` written only by the consolidation leader. consolidated -> advance through; failed -> attempt+1, and after 2 failed attempts advance anyway (never retry forever). True when the ledger was written. */
export async function settleLiveActivityBatch(params: { userId: string; vaultKey: string; batch: LiveActivityBatch; outcome: "consolidated" | "failed" }): Promise<boolean> {
  const att = currentFor(params.userId, params.vaultKey);
  if (!att || params.batch.userId !== params.userId) return false;
  try {
    if (!(await att.ready) || !isCurrent(att)) return false;
    const [ledger, keys] = await Promise.all([
      readLedger(att, params.vaultKey),
      SecureResourceCacheService.listResourceKeys(att.userId, CHUNK_PREFIX),
    ]);
    if (!isCurrent(att)) return false;
    const liveStreams = new Set(keys.map(key => parseChunkKey(key)?.streamId).filter((id): id is string => Boolean(id)));
    await writeRecord(att, LEDGER_KEY, settledLedger(ledger, params.batch, params.outcome, liveStreams));
    if (isCurrent(att)) changed(); return true;
  } catch { return false; /* An unsettled batch is offered again on the next cycle. */ }
}

/** Drops RAM state (all owners when omitted). Device chunks stay encrypted; account reset/delete purge them via SecureDurableResourceService.purgeUser. */
export function clearLiveActivity(userId?: string): void {
  if (userId) enabledOwners.delete(userId);
  else enabledOwners.clear();
  if (attachment && (!userId || attachment.userId === userId)) teardown(attachment);
  changed();
}

const noticeSeenThisSession = new Set<string>();
const noticeKey = (userId: string) => `hussh.live_activity_notice.v1:${userId}`;

/** Seen on this device. Storage failure reads as not seen, but a notice marked this session reads as seen, so it shows at most once per session. */
export function hasSeenLiveActivityNotice(userId: string): boolean {
  if (noticeSeenThisSession.has(userId)) return true;
  try { return window.localStorage.getItem(noticeKey(userId)) !== null; } catch { return false; }
}

export function markLiveActivityNoticeSeen(userId: string): void {
  noticeSeenThisSession.add(userId);
  try { window.localStorage.setItem(noticeKey(userId), "1"); } catch { /* The session guard still limits the notice. */ }
}

export function clearLiveActivityNotice(userId: string): void {
  noticeSeenThisSession.delete(userId);
  try { window.localStorage.removeItem(noticeKey(userId)); } catch { /* Nothing to clear without storage. */ }
}
