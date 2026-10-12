"use client";

/**
 * Shared payout data for one signed-in owner and vault session.
 *
 * CONTRACT (owned by the live-store lane; signatures are stable):
 * - usePayoutResource(key, load, options) returns the last verified snapshot
 *   for one payout resource plus freshness. Every mount of the same key shares
 *   one read: single flight, one queued follow-up, coalesced invalidations.
 * - Resources refresh only for payout kinds they depend on
 *   (lib/payouts/payout-events.ts), never for unrelated consent changes. The
 *   one consent signal kept is the bank-ready announcement, for "account".
 * - A failed refresh keeps the last verified data; `stale` turns true once the
 *   last attempt failed, a known change is not read yet, or the wallet is older
 *   than the freshness window.
 * - usePayoutFreshness() summarises every mounted resource for one short
 *   "Updated 2m ago" / "Updating…" line.
 *
 * Lifetime: module memory only, never browser storage. The store belongs to one
 * vault owner token and vault session epoch; a lock, sign-out, token change or
 * epoch change drops everything. Data outlives a screen while any payout reader
 * stays mounted (the Feed's bank cue keeps Payouts' last balance), and is
 * dropped when the last reader leaves.
 *
 * Reads: the stream is the fast path. One shared poll on the idle clock repairs
 * missed changes while the page is visible: 45 s, 15 s for a transfer or
 * deposit still moving while the stream is not live, and never faster than
 * 5 min for the Stripe-backed account. A return to the page reads each resource
 * once, never behind a read already in flight.
 */
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import { CONSENT_STATE_CHANGED_EVENT } from "@/lib/consent/consent-events";
import {
  dispatchPayoutStateChanged,
  payoutChangeTouches,
  subscribePayoutStateChanged,
  type PayoutChangeSource,
  type PayoutKind,
  type PayoutStateChangedDetail,
} from "@/lib/payouts/payout-events";
import { registerPeriodicTask } from "@/lib/perf/idle-scheduler";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { useVault } from "@/lib/vault/vault-context";

export type PayoutResourceKey = "wallet" | "account" | "bank_payouts" | "earnings" | "balance";

/** Payout kinds each resource depends on. */
export const PAYOUT_RESOURCE_KINDS: Record<PayoutResourceKey, readonly PayoutKind[]> = {
  wallet: ["wallet", "earnings"],
  account: ["account"],
  bank_payouts: ["bank_payouts"],
  earnings: ["earnings", "wallet"],
  balance: ["balance", "bank_payouts", "wallet"],
};

export type PayoutStreamState = "live" | "reconnecting" | "polling" | "unavailable";

export type PayoutFreshness = {
  /** Oldest last-success time across mounted resources (epoch ms). */
  lastSuccessAt: number | null;
  /** A change- or reconnect-triggered read is in flight. */
  refreshing: boolean;
  /** Consecutive failed attempts on the worst mounted resource. */
  failures: number;
  online: boolean;
  stream: PayoutStreamState;
};

export type PayoutResource<T> = {
  data: T | null;
  loading: boolean;
  failed: boolean;
  error: unknown;
  token: string | null | undefined;
  scope: unknown;
  isCurrent: () => boolean;
  retry: () => void;
  /** When this resource last loaded successfully (epoch ms). */
  lastSuccessAt: number | null;
  /** Old or unconfirmed data: show it, but never act on money with it. */
  stale: boolean;
};

/** Visible-page fallback read; the stream is the fast path. */
export const PAYOUT_POLL_MS = 45_000;
/** A transfer or deposit still moving, while no live stream reports it. */
export const PAYOUT_MOVING_POLL_MS = 15_000;
/** The account read calls Stripe, so nothing but its own change reads it faster. */
export const PAYOUT_ACCOUNT_POLL_MS = 5 * 60_000;
/** A wallet read older than this is stale: shown, never acted on. */
export const PAYOUT_FRESH_MS = 60_000;
/** Change signals inside this window share one read. */
export const PAYOUT_COALESCE_MS = 150;
/** The bank-ready announcement on the consent bus; checkout screens listen to it. */
export const PAYOUT_READY_SOURCE = "document_payout_ready";

// Focus and visibilitychange both fire on one return to the page.
const RESUME_GAP_MS = 1_000;
// Away this long, what is on screen no longer counts as fresh until read again.
const LONG_HIDDEN_MS = 60_000;
// A reader that mounts next to data this recent reuses it.
const MOUNT_REUSE_MS = 10_000;
// A read this recent already covers a poll tick (a return and a due tick coincide).
const POLL_EPSILON_MS = 1_000;
const POLL_TASK_ID = "payout-live-store:poll";
// A reconnect or a stalled stream rereads everything except the Stripe-backed account.
const BROAD_SOURCES: ReadonlySet<PayoutChangeSource> = new Set<PayoutChangeSource>(["sse_reset", "stall"]);
const STREAM_STATES: ReadonlySet<string> = new Set<PayoutStreamState>(["live", "reconnecting", "polling", "unavailable"]);

type Loader = (token: string) => Promise<unknown>;
type ReadReason = "initial" | "mount" | "poll" | "resume" | "event" | "retry";
// Reads a person can wait on; the first load and the fallback poll stay quiet.
const TRIGGERED: ReadonlySet<ReadReason> = new Set<ReadReason>(["mount", "resume", "event", "retry"]);

/** What one mounted reader asks of its resource. */
export type PayoutReader = {
  /** Reread when a payout change names this resource. */
  wantsEvents: boolean;
  /** "account" only: reread on the bank-ready announcement. */
  wantsReady: boolean;
  /** Loaders outside the known resources: skip request-scoped changes. */
  bankOnly: boolean;
};

type Flight = { reason: ReadReason; startedAt: number; seq: number };

type EntrySnapshot = {
  data: unknown;
  hasData: boolean;
  failures: number;
  error: unknown;
  lastSuccessAt: number | null;
  /** A change is known that no completed read has picked up yet. */
  dirty: boolean;
  /** The wallet is past its freshness window. */
  aged: boolean;
};

type Entry = {
  id: string;
  key: PayoutResourceKey | null;
  load: Loader;
  readers: Map<symbol, PayoutReader>;
  data: unknown;
  hasData: boolean;
  error: unknown;
  failures: number;
  lastSuccessAt: number | null;
  lastAttemptAt: number | null;
  resumedAt: number;
  /** Bumped by every known change; a read covers changes up to its start. */
  changeSeq: number;
  readSeq: number;
  flight: Flight | null;
  queued: ReadReason | null;
  timer: ReturnType<typeof setTimeout> | null;
  timerReason: ReadReason | null;
  ageTimer: ReturnType<typeof setTimeout> | null;
  snapshot: EntrySnapshot;
};

const EMPTY_SNAPSHOT: EntrySnapshot = {
  data: null, hasData: false, failures: 0, error: null, lastSuccessAt: null, dirty: false, aged: false,
};
const SERVER_FRESHNESS: PayoutFreshness = {
  lastSuccessAt: null, refreshing: false, failures: 0, online: true, stream: "polling",
};

const store = {
  /** `${epoch}:${token}` of the owner whose data is held; null when empty. */
  scope: null as string | null,
  token: null as string | null,
  epoch: 0,
  /** Fences every read and registration made before a reset. */
  generation: 0,
  entries: new Map<string, Entry>(),
  readers: 0,
  stream: "polling" as PayoutStreamState,
  hiddenAt: null as number | null,
  detach: null as (() => void) | null,
  pollTick: null as number | null,
  pollStop: null as (() => void) | null,
  resetQueued: false,
};
const entryListeners = new Map<string, Set<() => void>>();
const freshnessListeners = new Set<() => void>();
let freshness: PayoutFreshness = SERVER_FRESHNESS;
let freshnessDirty = true;
let detachOnline: (() => void) | null = null;
const customIds = new WeakMap<object, string>();
let customSeq = 0;

function pageHidden(): boolean {
  return typeof document !== "undefined" && (document.hidden === true || document.visibilityState === "hidden");
}

function browserOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function scopeKeyFor(token: string, epoch: number): string {
  return `${epoch}:${token}`;
}

/** A loader outside the known resources gets an entry of its own. */
function customResourceId(load: object): string {
  let id = customIds.get(load);
  if (!id) {
    customSeq += 1;
    id = `custom:${customSeq}`;
    customIds.set(load, id);
  }
  return id;
}

// --- notifications ----------------------------------------------------------

function notifyEntry(id: string): void {
  for (const listener of entryListeners.get(id) ?? []) listener();
}

function markFreshness(): void {
  freshnessDirty = true;
  for (const listener of freshnessListeners) listener();
}

function notifyAll(): void {
  for (const id of entryListeners.keys()) notifyEntry(id);
  markFreshness();
}

function isDirty(entry: Entry): boolean {
  return entry.changeSeq > entry.readSeq;
}

function publish(entry: Entry): void {
  const next: EntrySnapshot = {
    data: entry.data,
    hasData: entry.hasData,
    failures: entry.failures,
    error: entry.error,
    lastSuccessAt: entry.lastSuccessAt,
    dirty: isDirty(entry),
    aged: entry.key === "wallet" && entry.lastSuccessAt !== null && Date.now() - entry.lastSuccessAt > PAYOUT_FRESH_MS,
  };
  const previous = entry.snapshot;
  markFreshness();
  if ((Object.keys(next) as (keyof EntrySnapshot)[]).every((field) => Object.is(next[field], previous[field]))) return;
  entry.snapshot = next;
  if (store.entries.get(entry.id) === entry) notifyEntry(entry.id);
}

// --- reads ------------------------------------------------------------------

function hasReaders(entry: Entry): boolean {
  return entry.readers.size > 0;
}

function isCurrentEntry(entry: Entry): boolean {
  return store.entries.get(entry.id) === entry;
}

/** A transfer or deposit that will change soon without the owner doing anything. */
function isMoving(entry: Entry): boolean {
  if (!entry.hasData || !isRecord(entry.data)) return false;
  const data = entry.data;
  if (entry.key === "wallet") {
    const open = (row: unknown) => isRecord(row) && (row.status === "pending" || row.status === "unknown");
    return open(data.latestRedemption) || (Array.isArray(data.redemptionHistory) && data.redemptionHistory.some(open));
  }
  if (entry.key === "bank_payouts") {
    return Array.isArray(data.payouts) && data.payouts.some((row) => isRecord(row) && row.status === "pending");
  }
  return false;
}

function scheduleAgeOut(entry: Entry): void {
  if (entry.ageTimer) clearTimeout(entry.ageTimer);
  entry.ageTimer = null;
  if (entry.key !== "wallet" || entry.lastSuccessAt === null) return;
  const wait = Math.max(0, entry.lastSuccessAt + PAYOUT_FRESH_MS + 1 - Date.now());
  entry.ageTimer = setTimeout(() => {
    entry.ageTimer = null;
    if (isCurrentEntry(entry)) publish(entry);
  }, wait);
}

function startRead(entry: Entry, reason: ReadReason): void {
  if (!isCurrentEntry(entry) || !store.token) return;
  if (entry.flight) {
    // A read already on its way may predate this request: one follow-up, never more.
    if (entry.queued === null || (!TRIGGERED.has(entry.queued) && TRIGGERED.has(reason))) entry.queued = reason;
    return;
  }
  if (!isVaultSessionEpochCurrent(store.epoch)) return;
  const token = store.token;
  const generation = store.generation;
  const now = Date.now();
  const flight: Flight = { reason, startedAt: now, seq: entry.changeSeq };
  entry.flight = flight;
  entry.lastAttemptAt = now;
  markFreshness();
  let pending: Promise<unknown>;
  try {
    pending = Promise.resolve(entry.load(token));
  } catch (error) {
    pending = Promise.reject(error);
  }
  pending.then(
    (value) => settle(entry, flight, generation, { ok: true, value }),
    (error: unknown) => settle(entry, flight, generation, { ok: false, error }),
  );
}

function settle(
  entry: Entry,
  flight: Flight,
  generation: number,
  outcome: { ok: true; value: unknown } | { ok: false; error: unknown },
): void {
  if (store.generation !== generation || entry.flight !== flight) return;
  entry.flight = null;
  // A lock or a new token is on its way: never show this owner's reply.
  if (!isVaultSessionEpochCurrent(store.epoch)) return;
  if (outcome.ok) {
    entry.data = outcome.value;
    entry.hasData = true;
    entry.error = null;
    entry.failures = 0;
    entry.lastSuccessAt = Date.now();
    entry.readSeq = Math.max(entry.readSeq, flight.seq);
    scheduleAgeOut(entry);
  } else {
    entry.error = outcome.error;
    entry.failures += 1;
  }
  publish(entry);
  const queued = entry.queued;
  entry.queued = null;
  if (queued) startRead(entry, queued);
  // A change that arrived while the page was away and this read was out.
  else if (outcome.ok && isDirty(entry) && !entry.timer && hasReaders(entry) && !pageHidden()) startRead(entry, "event");
  syncPoll();
}

/** Starts a read after the coalescing window; signals inside it share the read. */
function scheduleRead(entry: Entry, reason: ReadReason): void {
  if (entry.timer) {
    if (entry.timerReason === null || (!TRIGGERED.has(entry.timerReason) && TRIGGERED.has(reason))) entry.timerReason = reason;
    return;
  }
  entry.timerReason = reason;
  entry.timer = setTimeout(() => {
    entry.timer = null;
    const due = entry.timerReason ?? reason;
    entry.timerReason = null;
    if (isCurrentEntry(entry) && hasReaders(entry)) startRead(entry, due);
  }, PAYOUT_COALESCE_MS);
}

/** A known change: the data is stale now, and read again unless nobody is looking. */
function invalidate(entry: Entry): void {
  entry.changeSeq += 1;
  publish(entry);
  // Hidden or unmounted: the next return or reader reads it once.
  if (!hasReaders(entry) || pageHidden()) return;
  scheduleRead(entry, "event");
}

function accountPollDue(entry: Entry, now: number): boolean {
  return entry.lastAttemptAt === null || now - entry.lastAttemptAt >= PAYOUT_ACCOUNT_POLL_MS;
}

function changeReaches(entry: Entry, detail: PayoutStateChangedDetail): boolean {
  const readers = [...entry.readers.values()];
  const wanting = readers.filter((reader) => reader.wantsEvents);
  // Readers that asked for no change-driven reads keep their old behaviour.
  if (readers.length > 0 && wanting.length === 0) return false;
  if (entry.key !== null) return payoutChangeTouches(detail, PAYOUT_RESOURCE_KINDS[entry.key]);
  return !(detail.requestIds?.length && wanting.length > 0 && wanting.every((reader) => reader.bankOnly));
}

function onPayoutChanged(detail: PayoutStateChangedDetail): void {
  const broad = BROAD_SOURCES.has(detail.source);
  const now = Date.now();
  for (const entry of [...store.entries.values()]) {
    if (!changeReaches(entry, detail)) continue;
    // A reset never pulls the account (a Stripe read) faster than its own poll.
    if (broad && entry.key === "account" && !accountPollDue(entry, now)) continue;
    invalidate(entry);
  }
}

function onConsentChanged(event: Event): void {
  const detail = (event as CustomEvent<{ source?: unknown } | undefined>).detail;
  if (detail?.source !== PAYOUT_READY_SOURCE) return;
  const account = store.entries.get("account");
  if (account && [...account.readers.values()].some((reader) => reader.wantsReady)) invalidate(account);
}

function resume(): void {
  const now = Date.now();
  const hiddenFor = store.hiddenAt === null ? 0 : now - store.hiddenAt;
  store.hiddenAt = null;
  for (const entry of [...store.entries.values()]) {
    if (!hasReaders(entry)) continue;
    if (hiddenFor >= LONG_HIDDEN_MS && entry.hasData) {
      entry.changeSeq += 1;
      publish(entry);
    }
    // One read per return; a read already in flight is fresh enough.
    if (entry.flight || now - entry.resumedAt < RESUME_GAP_MS) continue;
    entry.resumedAt = now;
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
      entry.timerReason = null;
    }
    startRead(entry, "resume");
  }
}

function onVisibilityChange(): void {
  if (pageHidden()) {
    store.hiddenAt ??= Date.now();
    return;
  }
  resume();
}

function onFocus(): void {
  if (!pageHidden()) resume();
}

function onOnline(): void {
  markFreshness();
  if (pageHidden()) return;
  for (const entry of store.entries.values()) {
    if (hasReaders(entry) && !entry.flight && (entry.failures > 0 || isDirty(entry))) scheduleRead(entry, "event");
  }
}

// --- polling ----------------------------------------------------------------

function cadenceFor(entry: Entry): number {
  if (entry.key === "account") return PAYOUT_ACCOUNT_POLL_MS;
  return store.stream !== "live" && isMoving(entry) ? PAYOUT_MOVING_POLL_MS : PAYOUT_POLL_MS;
}

function pollOnce(): void {
  const tick = store.pollTick;
  if (tick === null || pageHidden()) return;
  const now = Date.now();
  for (const entry of [...store.entries.values()]) {
    if (!hasReaders(entry) || entry.timer) continue;
    const since = entry.lastAttemptAt === null ? Number.POSITIVE_INFINITY : now - entry.lastAttemptAt;
    // Ticks are aligned to the shortest cadence on screen; a slower resource
    // waits for the tick that completes its own interval.
    const due = entry.key === "account"
      ? since >= PAYOUT_ACCOUNT_POLL_MS
      : since >= cadenceFor(entry) - tick + POLL_EPSILON_MS;
    if (due) startRead(entry, "poll");
  }
}

function syncPoll(): void {
  let tick: number | null = null;
  for (const entry of store.entries.values()) {
    if (hasReaders(entry)) tick = Math.min(tick ?? Number.POSITIVE_INFINITY, cadenceFor(entry));
  }
  if (tick === store.pollTick) return;
  store.pollStop?.();
  store.pollStop = null;
  store.pollTick = tick;
  // The idle clock runs nothing while the page is hidden and catches up on return.
  if (tick !== null) store.pollStop = registerPeriodicTask({ id: POLL_TASK_ID, intervalMs: tick, run: pollOnce });
}

// --- lifetime ---------------------------------------------------------------

function syncOnlineListeners(): void {
  const wanted = typeof window !== "undefined" && (store.readers > 0 || freshnessListeners.size > 0);
  if (wanted && !detachOnline) {
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", markFreshness);
    detachOnline = () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", markFreshness);
    };
  } else if (!wanted && detachOnline) {
    detachOnline();
    detachOnline = null;
  }
}

function attachListeners(): void {
  if (store.detach || typeof window === "undefined") return;
  if (pageHidden()) store.hiddenAt = Date.now();
  const unsubscribe = subscribePayoutStateChanged(onPayoutChanged);
  window.addEventListener(CONSENT_STATE_CHANGED_EVENT, onConsentChanged);
  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", onVisibilityChange);
  store.detach = () => {
    unsubscribe();
    window.removeEventListener(CONSENT_STATE_CHANGED_EVENT, onConsentChanged);
    window.removeEventListener("focus", onFocus);
    document.removeEventListener("visibilitychange", onVisibilityChange);
  };
}

function resetEntries(): void {
  for (const entry of store.entries.values()) {
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.ageTimer) clearTimeout(entry.ageTimer);
    entry.timer = null;
    entry.ageTimer = null;
  }
  store.entries.clear();
  store.readers = 0;
  store.generation += 1;
}

function clearStore(): void {
  resetEntries();
  store.scope = null;
  store.token = null;
  store.hiddenAt = null;
  store.detach?.();
  store.detach = null;
  syncPoll();
  syncOnlineListeners();
  notifyAll();
}

function adoptScope(token: string, epoch: number): void {
  const scope = scopeKeyFor(token, epoch);
  if (store.scope === scope) return;
  const replaced = store.scope !== null;
  resetEntries();
  store.scope = scope;
  store.token = token;
  store.epoch = epoch;
  if (replaced) notifyAll();
}

// Effects of one commit unmount before they mount, so the reset waits for the
// commit to finish: a reader swapped for another never drops the data.
function scheduleIdleReset(): void {
  if (store.resetQueued) return;
  store.resetQueued = true;
  queueMicrotask(() => {
    store.resetQueued = false;
    if (store.readers === 0 && store.scope !== null) clearStore();
  });
}

function createEntry(id: string, key: PayoutResourceKey | null, load: Loader): Entry {
  return {
    id, key, load, readers: new Map(),
    data: null, hasData: false, error: null, failures: 0,
    lastSuccessAt: null, lastAttemptAt: null, resumedAt: Number.NEGATIVE_INFINITY,
    changeSeq: 0, readSeq: 0, flight: null, queued: null,
    timer: null, timerReason: null, ageTimer: null,
    snapshot: EMPTY_SNAPSHOT,
  };
}

/** A new reader reads what is missing, failed, changed or no longer recent. */
function activate(entry: Entry, forceRead: boolean): void {
  // A read on its way, or one about to start, serves this reader too.
  if (entry.flight || entry.timer) return;
  if (!entry.hasData) {
    startRead(entry, "initial");
    return;
  }
  const age = entry.lastSuccessAt === null ? Number.POSITIVE_INFINITY : Date.now() - entry.lastSuccessAt;
  if (forceRead || isDirty(entry) || entry.failures > 0 || age > MOUNT_REUSE_MS) startRead(entry, "mount");
}

function registerReader(input: {
  id: string;
  key: PayoutResourceKey | null;
  load: Loader;
  token: string;
  epoch: number;
  reader: PayoutReader;
  forceRead: boolean;
}): () => void {
  adoptScope(input.token, input.epoch);
  const entry = store.entries.get(input.id) ?? createEntry(input.id, input.key, input.load);
  store.entries.set(input.id, entry);
  entry.load = input.load;
  const handle = Symbol(input.id);
  entry.readers.set(handle, input.reader);
  store.readers += 1;
  const generation = store.generation;
  attachListeners();
  syncOnlineListeners();
  activate(entry, input.forceRead);
  syncPoll();
  markFreshness();
  return () => {
    if (store.generation !== generation || !isCurrentEntry(entry) || !entry.readers.delete(handle)) return;
    store.readers -= 1;
    syncPoll();
    markFreshness();
    if (store.readers === 0) scheduleIdleReset();
  };
}

function entryFor(id: string, scopeKey: string | null): Entry | null {
  if (scopeKey === null || store.scope !== scopeKey) return null;
  return store.entries.get(id) ?? null;
}

function subscribeEntry(id: string, listener: () => void): () => void {
  let listeners = entryListeners.get(id);
  if (!listeners) {
    listeners = new Set();
    entryListeners.set(id, listeners);
  }
  listeners.add(listener);
  return () => {
    const current = entryListeners.get(id);
    current?.delete(listener);
    if (current?.size === 0) entryListeners.delete(id);
  };
}

// --- freshness --------------------------------------------------------------

function computeFreshness(): PayoutFreshness {
  let lastSuccessAt: number | null = null;
  let failures = 0;
  let refreshing = false;
  for (const entry of store.entries.values()) {
    // Only data on screen counts. The account row reports its own state and
    // refreshes on a slower cadence, so it never ages this line.
    if (!hasReaders(entry) || !entry.hasData || entry.key === "account") continue;
    if (entry.lastSuccessAt !== null && (lastSuccessAt === null || entry.lastSuccessAt < lastSuccessAt)) {
      lastSuccessAt = entry.lastSuccessAt;
    }
    failures = Math.max(failures, entry.failures);
    if (entry.flight && TRIGGERED.has(entry.flight.reason)) refreshing = true;
  }
  return { lastSuccessAt, refreshing, failures, online: browserOnline(), stream: store.stream };
}

/** The freshness summary outside React (tests, diagnostics). */
export function getPayoutFreshness(): PayoutFreshness {
  if (freshnessDirty) {
    freshnessDirty = false;
    const next = computeFreshness();
    const same = (Object.keys(next) as (keyof PayoutFreshness)[]).every((field) => next[field] === freshness[field]);
    if (!same) freshness = next;
  }
  return freshness;
}

function subscribeFreshness(listener: () => void): () => void {
  freshnessListeners.add(listener);
  syncOnlineListeners();
  // `online` was not watched before this subscriber; read it afresh.
  freshnessDirty = true;
  return () => {
    freshnessListeners.delete(listener);
    syncOnlineListeners();
  };
}

// --- hooks ------------------------------------------------------------------

/** One stable object per owner, vault session and active flag; replies are fenced to it. */
export type PayoutScope = { token: string | null | undefined; active: boolean; epoch: number };

export type PayoutStoreReadOptions = {
  active?: boolean;
  /** A changed value rereads (Stripe's return markers). */
  refreshKey?: string;
  /** Reread when a payout change names this resource. Default true. */
  refreshOnChange?: boolean;
  /** "account": reread on the bank-ready announcement. Default true. */
  refreshOnReady?: boolean;
  /** Loaders outside the known resources: skip request-scoped changes. */
  bankOnly?: boolean;
};

/**
 * The store behind usePayoutResource and the compact usePayoutSnapshot. `key`
 * null gives a loader outside the known resources an entry of its own, which
 * follows every payout change.
 */
export function usePayoutStoreResource<T>(
  key: PayoutResourceKey | null,
  load: (token: string) => Promise<T>,
  options: PayoutStoreReadOptions = {},
): PayoutResource<T> & { scope: PayoutScope } {
  const { active = true, refreshKey = "", refreshOnChange = true, refreshOnReady = true, bankOnly = false } = options;
  const { vaultOwnerToken: token } = useVault();
  const epoch = snapshotVaultSessionEpoch();
  const id = key ?? customResourceId(load);
  const scope = useMemo<PayoutScope>(() => ({ token, active, epoch }), [token, active, epoch]);
  const scopeKey = active && token ? scopeKeyFor(token, epoch) : null;

  const subscribe = useCallback((listener: () => void) => subscribeEntry(id, listener), [id]);
  const getSnapshot = useCallback(() => entryFor(id, scopeKey)?.snapshot ?? EMPTY_SNAPSHOT, [id, scopeKey]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_SNAPSHOT);

  // The registered reader is one object; its wishes follow the latest render.
  const reader = useRef<PayoutReader>({ wantsEvents: refreshOnChange, wantsReady: refreshOnReady, bankOnly });
  const latest = useRef({ load, refreshKey });
  useEffect(() => {
    reader.current.wantsEvents = refreshOnChange;
    reader.current.wantsReady = refreshOnReady;
    reader.current.bankOnly = bankOnly;
    latest.current = { load, refreshKey };
    const entry = entryFor(id, scopeKey);
    if (entry) entry.load = load as Loader;
  });

  useEffect(() => {
    if (!active || !token) return;
    return registerReader({
      id, key, token, epoch, reader: reader.current,
      load: latest.current.load as Loader,
      forceRead: latest.current.refreshKey !== "",
    });
  }, [id, key, token, epoch, active]);

  // A new refresh key (a return from Stripe) is a known change.
  const seenRefreshKey = useRef(refreshKey);
  useEffect(() => {
    if (seenRefreshKey.current === refreshKey) return;
    seenRefreshKey.current = refreshKey;
    const entry = entryFor(id, scopeKey);
    if (entry) invalidate(entry);
  }, [id, scopeKey, refreshKey]);

  const live = useRef<object | null>(null);
  useEffect(() => {
    live.current = scope;
    return () => { live.current = null; };
  }, [scope]);
  const isCurrent = useCallback(() => live.current === scope, [scope]);
  const retry = useCallback(() => {
    const entry = entryFor(id, scopeKey);
    if (entry && hasReaders(entry)) scheduleRead(entry, "retry");
  }, [id, scopeKey]);

  // Read at render so a clock that jumped is seen before the age-out timer runs.
  const aged = snapshot.aged || (key === "wallet" && snapshot.lastSuccessAt !== null
    && Date.now() - snapshot.lastSuccessAt > PAYOUT_FRESH_MS);
  return {
    data: snapshot.hasData ? (snapshot.data as T) : null,
    loading: !snapshot.hasData && snapshot.failures === 0,
    failed: snapshot.failures > 0,
    error: snapshot.failures > 0 ? snapshot.error : null,
    token,
    scope,
    isCurrent,
    retry,
    lastSuccessAt: snapshot.hasData ? snapshot.lastSuccessAt : null,
    stale: snapshot.failures > 0 || snapshot.dirty || aged,
  };
}

export function usePayoutResource<T>(
  key: PayoutResourceKey,
  load: (token: string) => Promise<T>,
  options: { active?: boolean } = {},
): PayoutResource<T> {
  return usePayoutStoreResource(key, load, { active: options.active ?? true });
}

export function usePayoutFreshness(): PayoutFreshness {
  return useSyncExternalStore(subscribeFreshness, getPayoutFreshness, () => SERVER_FRESHNESS);
}

/**
 * The document-feed stream manager reports its state here, so freshness and
 * polling cadence follow the real connection ("live" means typed payout frames
 * are arriving; anything else means the store polls).
 */
export function setPayoutStreamState(state: PayoutStreamState): void {
  if (!STREAM_STATES.has(state) || store.stream === state) return;
  store.stream = state;
  syncPoll();
  markFreshness();
}

/** Ask every mounted payout resource that depends on these kinds to reread. */
export function invalidatePayoutResources(
  kinds: readonly PayoutKind[],
  source: PayoutChangeSource = "manual",
): void {
  dispatchPayoutStateChanged({ kinds: [...kinds], source });
}

/** Test seam: drop every resource, timer, listener and the stream state. */
export function resetPayoutLiveStoreForTests(): void {
  clearStore();
  store.stream = "polling";
  store.resetQueued = false;
  freshness = SERVER_FRESHNESS;
  freshnessDirty = true;
}
