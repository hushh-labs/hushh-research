"use client";

import { trackCacheResourceResolved, trackRouteReadinessCompleted, trackRouteRefreshCompleted } from "@/lib/observability/client";
import { loadReceiptSnapshot, receiptStoreVersion, writeReceiptSnapshot, type ReceiptStoreSession } from "@/lib/mail/receipt-store";
import { mergeReceiptSnapshot } from "@/lib/mail/receipt-continuity";
import type { ReceiptSnapshot } from "@/lib/mail/receipt-snapshot";
import { subscribeDurableOwnerReset } from "./secure-durable-resource-service";
import { snapshotVaultSessionEpoch, isVaultSessionEpochCurrent } from "@/lib/vault/session-epoch";
import { GmailReceiptsService, type GmailLiveReceiptScanResponse, type ReceiptListItem } from "./gmail-receipts-service";
import { MailReceiptHistoryService } from "./mail-receipt-history-service";

import { withReceiptBudget } from "@/lib/mail/receipt-operation";

const FRESH_MS = 5 * 60_000;
const OPERATION_MS = 120_000;
const RESTORE_MS = 15_000;
export type ReceiptProgress = { phase: "opening" | "reading" | "saving"; checked: number; found: number };
type Resource = { snapshot: ReceiptSnapshot | null; hydrated: boolean; refreshing: boolean; error: string | null; attemptedAt: number; progress: ReceiptProgress | null };
type RefreshResult = { snapshot: ReceiptSnapshot; generation: number; revision: number; response: GmailLiveReceiptScanResponse; complete: boolean };
const resources = new Map<string, Resource>();
const restores = new Map<string, Promise<ReceiptSnapshot | null>>();
const restoreControllers = new Map<string, AbortController>();
const restoreEpochs = new Map<string, ReturnType<typeof snapshotVaultSessionEpoch>>();
const flights = new Map<string, { promise: Promise<RefreshResult>; controller: AbortController; queued: boolean; trailing: boolean; epoch: ReturnType<typeof snapshotVaultSessionEpoch>; isCurrent: () => boolean }>();
const listeners = new Set<() => void>();
let resetSubscription: (() => void) | null = null;
function resolved(tier: "memory" | "secure_device", snapshot: ReceiptSnapshot | null, began: number) {
  const stale = Boolean(snapshot && Date.now() - Date.parse(snapshot.freshness) >= FRESH_MS);
  trackCacheResourceResolved({ routeId: "gmail", result: "success", resourceClass: "financial_resource", cacheTier: tier,
    freshness: snapshot ? stale ? "stale" : "fresh" : "missing", durationMs: performance.now() - began });
  trackRouteReadinessCompleted({ routeId: "gmail", result: "success", resourceClass: "financial_resource", cacheTier: tier,
    renderPath: tier === "memory" ? "fresh_memory" : "secure_device_stale", durationMs: performance.now() - began,
    blockingLoaderShown: false, staleRendered: stale });
}
const identity = (owner: string, account: string) => JSON.stringify([owner, account]);
const empty: Resource = { snapshot: null, hydrated: false, refreshing: false, error: null, attemptedAt: 0, progress: null };
function publish(key: string, change: Partial<Resource>) {
  resetSubscription ??= subscribeDurableOwnerReset(owner => MailReceiptResourceService.clear(owner));
  resources.set(key, { ...(resources.get(key) ?? empty), ...change });
  listeners.forEach(listener => listener());
}


export class MailReceiptResourceService {
  static subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
  static peek(owner: string, account: string): Resource { return resources.get(identity(owner, account)) ?? empty; }
  static isStale(owner: string, account: string): boolean {
    const resource = this.peek(owner, account);
    const stamp = Math.max(resource.attemptedAt, resource.snapshot ? Date.parse(resource.snapshot.freshness) : 0);
    return !stamp || Date.now() - stamp >= FRESH_MS;
  }
  static clear(owner: string): void {
    MailReceiptHistoryService.clear(owner);
    for (const key of new Set([...resources.keys(), ...restores.keys(), ...flights.keys()])) {
      if (JSON.parse(key)[0] !== owner) continue;
      flights.get(key)?.controller.abort(); restoreControllers.get(key)?.abort(); restoreControllers.delete(key); flights.delete(key); restores.delete(key); restoreEpochs.delete(key); resources.delete(key);
    }
    if (!resources.size && !flights.size && !restores.size) { resetSubscription?.(); resetSubscription = null; }
    listeners.forEach(listener => listener());
  }
  static retireObsolete(owner: string): void {
    for (const [key, flight] of flights) {
      if (JSON.parse(key)[0] === owner && (!isVaultSessionEpochCurrent(flight.epoch) || !flight.isCurrent())) {
        flight.controller.abort(); flights.delete(key);
        publish(key, { refreshing: false, attemptedAt: 0, progress: null });
      }
    }
  }
  static hydrate(session: ReceiptStoreSession, account: string): Promise<ReceiptSnapshot | null> {
    const key = identity(session.userId, account);
    if (this.peek(session.userId, account).hydrated) {
      const snapshot = this.peek(session.userId, account).snapshot; resolved("memory", snapshot, performance.now()); return Promise.resolve(snapshot);
    }
    const existing = restores.get(key);
    if (existing && isVaultSessionEpochCurrent(restoreEpochs.get(key)!)) return existing;
    restoreControllers.get(key)?.abort(); restoreControllers.delete(key); restores.delete(key); restoreEpochs.delete(key);
    const began = performance.now();
    const epoch = snapshotVaultSessionEpoch();
    const controller = new AbortController();
    let request: Promise<ReceiptSnapshot | null>;
    request = withReceiptBudget(async signal => {
      const isCurrent = () => !signal.aborted && restores.get(key) === request && isVaultSessionEpochCurrent(epoch) && (session.isCurrent?.() ?? true);
      const saved = await loadReceiptSnapshot({ ...session, isCurrent }, account);
      if (!isCurrent()) throw new DOMException("Mail session changed.", "AbortError");
      publish(key, { snapshot: saved?.value ?? null, hydrated: true, error: null });
      resolved("secure_device", saved?.value ?? null, began);
      return saved?.value ?? null;
    }, controller, RESTORE_MS).catch(error => {
      if (restores.get(key) === request && isVaultSessionEpochCurrent(epoch)) publish(key, { error: "Saved receipts couldn’t be opened. Try again." });
      throw error;
    }).finally(() => { if (restores.get(key) === request) { restores.delete(key); restoreEpochs.delete(key); restoreControllers.delete(key); } });
    restores.set(key, request); restoreEpochs.set(key, epoch); restoreControllers.set(key, controller); return request;
  }
  static refresh(session: ReceiptStoreSession, account: string, getIdToken: () => Promise<string>, options: {
    force?: boolean; onPage?: (items: ReceiptListItem[], page: number) => void;
  } = {}): Promise<RefreshResult> {
    const key = identity(session.userId, account);
    let existing = flights.get(key);
    if (existing && (!isVaultSessionEpochCurrent(existing.epoch) || !existing.isCurrent())) { existing.controller.abort(); flights.delete(key); existing = undefined; }
    if (existing) { if (options.force && !existing.trailing) existing.queued = true; return existing.promise; }
    const began = performance.now();
    const epoch = snapshotVaultSessionEpoch();
    const controller = new AbortController();
    const flight = { promise: null as unknown as Promise<RefreshResult>, controller, queued: false, trailing: false, epoch, isCurrent: () => session.isCurrent?.() ?? true };
    publish(key, { refreshing: true, error: null, attemptedAt: Date.now(), progress: { phase: "opening", checked: 0, found: 0 } });
    flight.promise = withReceiptBudget(async signal => {
      const current = () => !signal.aborted && flights.get(key) === flight && isVaultSessionEpochCurrent(epoch) && (session.isCurrent?.() ?? true);
      const guarded = { ...session, signal, isCurrent: current };
      const execute = async (): Promise<RefreshResult> => {
        await this.hydrate(guarded, account);
        // Reconcile any commit that landed just before a previous timeout.
        const absentExpected = await receiptStoreVersion(session.userId, account);
        const durable = await loadReceiptSnapshot(guarded, account);
        let previous = durable?.value ?? null;
        let expected = durable ?? absentExpected;
        const idToken = await getIdToken();
        if (!current()) throw new DOMException("Mail session changed.", "AbortError");
        const pending = previous?.sync?.pending;
        const resumable = pending && Date.now() - pending.started_at >= 0 && Date.now() - pending.started_at < 100 * 60_000;
        const startedAt = resumable ? pending.started_at : Date.now();
        const priorPartial = resumable ? pending.prior_partial : previous?.coverage.partial ?? false;
        let cursor: string | null = resumable ? pending.cursor : null;
        let checkpoint = previous?.sync?.checkpoint ?? null;
        let items: ReceiptListItem[] = [];
        const unavailable = new Set<string>();
        let response: GmailLiveReceiptScanResponse;
        let page = resumable ? pending.page % 50 + 1 : 1;
        let committed: RefreshResult | null = null;
        let recovered = false;
        let checked = 0;
        publish(key, { progress: { phase: "reading", checked: 0, found: 0 } });
        for (;;) {
          let retries = 0;
          for (;;) {
            try { response = await GmailReceiptsService.scanReceipts({ idToken, vaultOwnerToken: session.vaultOwnerToken,
              userId: session.userId, accountKey: account, page, cursor, checkpoint, incremental: true, signal }); break; }
            catch (error) {
              const code = (error as { code?: string }).code;
              if (["GMAIL_RECEIPT_CHECKPOINT_EXPIRED", "GMAIL_RECEIPT_CURSOR_EXPIRED"].includes(code ?? "") && !recovered) {
                recovered = true; checkpoint = null; cursor = null; items = []; unavailable.clear(); page = 1; continue;
              }
              const retryable = (error as { retryable?: boolean }).retryable === true || code === "GMAIL_RECEIPT_SCAN_IN_PROGRESS";
              if (!retryable || ++retries > 2 || !current()) throw error;
              await new Promise<void>((resolve, reject) => {
                const aborted = () => { clearTimeout(timer); reject(new DOMException("Mail update paused.", "AbortError")); };
                const timer = setTimeout(() => { signal.removeEventListener("abort", aborted); resolve(); }, 750);
                signal.addEventListener("abort", aborted, { once: true });
              });
            }
          }
          if (!current()) throw new DOMException("Mail session changed.", "AbortError");
          const bySource = new Map(items.map(item => [item.event_id ?? item.source_id, item]));
          response.items.forEach(item => bySource.set(item.event_id ?? item.source_id, item));
          items = [...bySource.values()]; response.unavailable_events?.forEach(ref => unavailable.add(ref));
          checked += response.coverage.listed_count;
          publish(key, { progress: { phase: "saving", checked, found: items.length } });
          const complete = !response.coverage.reached_limit && !response.has_more;
          const progress = response.has_more && response.next_cursor && page <= response.coverage.max_pages
            ? { cursor: response.next_cursor, page, started_at: startedAt, prior_partial: priorPartial } : null;
          options.onPage?.(items, page);
          const snapshot = await mergeReceiptSnapshot(previous, response.items, account, response, [...unavailable], complete, progress);
          const version = await writeReceiptSnapshot(guarded, snapshot, expected);
          if (!current()) throw new DOMException("Mail session changed.", "AbortError");
          // Every verified batch is recoverable, including after a deadline or
          // process exit. Only the final batch advances the completed checkpoint.
          publish(key, { snapshot, hydrated: true, progress: { phase: "reading", checked, found: items.length } });
          previous = snapshot; expected = version;
          committed = { snapshot, ...version, response, complete };
          if (!progress || response.coverage.reached_limit) break;
          cursor = response.next_cursor ?? null; page += 1;
        }
        return committed!;
      };
      let result = await execute();
      if (flight.queued && current()) { flight.trailing = true; flight.queued = false; result = await execute(); }
      trackRouteRefreshCompleted({ routeId: "gmail", result: "success", resourceClass: "financial_resource", refreshTrigger: options.force ? "manual" : "focus", durationMs: performance.now() - began });
      return result;
    }, controller, OPERATION_MS).catch(error => {
      trackRouteRefreshCompleted({ routeId: "gmail", result: "error", resourceClass: "financial_resource", refreshTrigger: options.force ? "manual" : "focus", durationMs: performance.now() - began });
      if (flights.get(key) === flight) publish(key, { error: error instanceof DOMException && error.name === "AbortError" ? "Mail update paused. Your saved receipts are safe." : "Mail couldn’t update. Saved receipts were kept." });
      throw error;
    }).finally(() => {
      if (flights.get(key) === flight) { flights.delete(key); publish(key, { refreshing: false, progress: null }); }
    });
    flights.set(key, flight); return flight.promise;
  }
}
