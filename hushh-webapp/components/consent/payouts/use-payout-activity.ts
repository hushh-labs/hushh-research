"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";

import {
  appendPage,
  createPagedHistory,
  reconcileHead,
  upsertItems,
  type PagedHistory,
  type PagedHistoryOrder,
} from "@/lib/payouts/paged-history";
import { payoutChangeTouches, subscribePayoutStateChanged, type PayoutKind } from "@/lib/payouts/payout-events";
import { PAYOUT_COALESCE_MS, usePayoutFreshness } from "@/lib/payouts/payout-live-store";
import { usePeriodicTask } from "@/lib/perf/use-periodic-task";
import {
  PayoutActivityService,
  type PayoutActivityItem,
  type PayoutActivityMode,
  type PayoutActivityPage,
  type PayoutActivityQueryKind,
} from "@/lib/services/payout-activity-service";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { useVault } from "@/lib/vault/vault-context";

/** Activity reads the coin ledger, earnings and bank deposits. */
export const ACTIVITY_CHANGE_KINDS: readonly PayoutKind[] = ["wallet", "earnings", "bank_payouts"];
/** Fallback read while the live stream is not delivering payout changes. */
export const ACTIVITY_REFRESH_MS = 45_000;
/**
 * A fallback read skips a read started this recently. One return to the page
 * wakes the idle clock twice (visibilitychange and focus), and both wakes can
 * run the same due task.
 */
export const ACTIVITY_POLL_GAP_MS = 1_000;

export const ACTIVITY_ORDER: PagedHistoryOrder<PayoutActivityItem> = {
  id: (item) => item.id,
  compare: (a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt),
  // A slower, older response never undoes a newer state.
  replaces: (incoming, current) => Date.parse(incoming.updatedAt) >= Date.parse(current.updatedAt),
};

type ActivityState = {
  key: string;
  history: PagedHistory<PayoutActivityItem>;
  balanceCoins: number | null;
  /** Every loaded row is known to be current as of this server time. */
  syncedAt: string | null;
  /** When the first page last read successfully (client clock), for "Updated 3m ago". */
  lastSuccessAt: number | null;
  failed: boolean;
  error: unknown;
  more: { cursor: string; busy: boolean; failed: boolean } | null;
};

function initialState(key: string): ActivityState {
  return {
    key, history: createPagedHistory(), balanceCoins: null, syncedAt: null, lastSuccessAt: null,
    failed: false, error: null, more: null,
  };
}

function earlier(a: string | null, b: string): string {
  return a !== null && Date.parse(a) <= Date.parse(b) ? a : b;
}

function hasTail(history: PagedHistory<PayoutActivityItem>): boolean {
  return history.items.length > history.headIds.length;
}

export type PayoutActivityView = {
  items: readonly PayoutActivityItem[];
  initialized: boolean;
  balanceCoins: number | null;
  loading: boolean;
  /** The latest read failed. With `initialized`, the rows shown are from `lastSuccessAt`. */
  failed: boolean;
  error: unknown;
  lastSuccessAt: number | null;
  hasMore: boolean;
  loadingMore: boolean;
  moreFailed: boolean;
  loadMore: () => void;
  retry: () => void;
};

/**
 * One owner's payout activity for a filter and mode, newest first.
 *
 * A refresh (payout event, fallback read, retry) re-reads the first page and
 * merges it by id: older pages stay, a row changes in place, and a "More"
 * already in flight is never cancelled; it is dropped only if the refresh
 * found a gap that must be read first. With `syncTail`, rows below the first
 * page are updated through `since=` so an older row's new state shows too.
 * Payout events inside the store's coalescing window share one read, and an
 * inactive instance (e.g. the card under View all) reads nothing until it is
 * active again.
 */
export function usePayoutActivity({ kind, mode, pageSize, active = true, syncTail = false }: {
  kind: PayoutActivityQueryKind;
  mode: PayoutActivityMode;
  pageSize: number;
  active?: boolean;
  syncTail?: boolean;
}): PayoutActivityView {
  const { vaultOwnerToken: token } = useVault();
  const key = `${token ?? ""}|${mode}|${kind}|${pageSize}`;
  const [state, setState] = useState<ActivityState>(() => initialState(key));
  const [attempt, setAttempt] = useState(0);
  const view = state.key === key ? state : initialState(key);
  const liveKey = useRef<string | null>(null);
  const latest = useRef(view);
  const moreInFlight = useRef<string | null>(null);
  const pollNow = useRef<(() => void) | null>(null);
  const taskId = `payout-activity:${useId()}`;
  const { stream } = usePayoutFreshness();

  useEffect(() => {
    latest.current = view;
  });
  useEffect(() => {
    liveKey.current = key;
    return () => { liveKey.current = null; };
  }, [key]);

  useEffect(() => {
    if (!active || !token) return;
    const epoch = snapshotVaultSessionEpoch();
    let cancelled = false;
    let pending = false;
    let queued = false;
    let startedAt = Number.NEGATIVE_INFINITY;
    let coalesce: ReturnType<typeof setTimeout> | null = null;
    const current = () => !cancelled && isVaultSessionEpochCurrent(epoch);
    const refresh = async () => {
      if (!current()) return;
      if (pending) { queued = true; return; }
      pending = true;
      startedAt = Date.now();
      try {
        const known = latest.current.key === key ? latest.current : initialState(key);
        const since = syncTail && hasTail(known.history) ? known.syncedAt : null;
        const [head, changes] = await Promise.all([
          PayoutActivityService.list(token, { kind, mode, limit: pageSize }),
          since
            ? PayoutActivityService.list(token, { kind, mode, limit: 50, since }).catch((): null => null)
            : Promise.resolve<PayoutActivityPage | null>(null),
        ]);
        if (!current()) return;
        setState((previous) => {
          const base = previous.key === key ? previous : initialState(key);
          let history = reconcileHead(base.history, head, ACTIVITY_ORDER);
          const synced = changes !== null && !changes.reset;
          if (synced) history = upsertItems(history, changes.items, ACTIVITY_ORDER);
          const syncedAt = synced ? earlier(head.asOf, changes.asOf)
            : hasTail(base.history) ? base.syncedAt : head.asOf;
          return {
            ...base, history, balanceCoins: head.balanceCoins, syncedAt, lastSuccessAt: Date.now(), failed: false, error: null,
          };
        });
      } catch (error) {
        if (current()) {
          setState((previous) => ({ ...(previous.key === key ? previous : initialState(key)), failed: true, error }));
        }
      } finally {
        pending = false;
        if (queued && current()) { queued = false; void refresh(); }
      }
    };
    // A read in flight or just started is fresh enough for a fallback read.
    pollNow.current = () => {
      if (!pending && Date.now() - startedAt >= ACTIVITY_POLL_GAP_MS) void refresh();
    };
    void refresh();
    const unsubscribe = subscribePayoutStateChanged((detail) => {
      if (!payoutChangeTouches(detail, ACTIVITY_CHANGE_KINDS) || coalesce !== null) return;
      // A burst of payout frames shares one read, like the store's resources.
      coalesce = setTimeout(() => {
        coalesce = null;
        void refresh();
      }, PAYOUT_COALESCE_MS);
    });
    return () => {
      cancelled = true;
      if (coalesce !== null) clearTimeout(coalesce);
      pollNow.current = null;
      unsubscribe();
    };
  }, [active, token, key, kind, mode, pageSize, syncTail, attempt]);

  // The idle clock runs this only while the page is visible, and on return.
  usePeriodicTask(taskId, ACTIVITY_REFRESH_MS, () => pollNow.current?.(), {
    enabled: active && Boolean(token) && stream !== "live",
  });

  const loadMore = useCallback(() => {
    const cursor = view.history.nextCursor;
    if (!token || !cursor || moreInFlight.current === `${key}|${cursor}`) return;
    const flight = `${key}|${cursor}`;
    const epoch = snapshotVaultSessionEpoch();
    const current = () => liveKey.current === key && isVaultSessionEpochCurrent(epoch);
    moreInFlight.current = flight;
    setState((previous) => ({
      ...(previous.key === key ? previous : initialState(key)), more: { cursor, busy: true, failed: false },
    }));
    const settle = (page: PayoutActivityPage | null) => {
      if (moreInFlight.current === flight) moreInFlight.current = null;
      if (!current()) return;
      setState((previous) => {
        const base = previous.key === key ? previous : initialState(key);
        const more = base.more?.cursor === cursor ? (page ? null : { cursor, busy: false, failed: true }) : base.more;
        if (!page) return { ...base, more };
        // A head refresh may have moved the cursor while this page was loading.
        const appended = appendPage(base.history, page, cursor, ACTIVITY_ORDER);
        return { ...base, history: appended, more,
          syncedAt: appended === base.history ? base.syncedAt : earlier(base.syncedAt, page.asOf) };
      });
    };
    PayoutActivityService.list(token, { kind, mode, limit: pageSize, cursor }).then(settle, () => settle(null));
  }, [view.history.nextCursor, token, key, kind, mode, pageSize]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  return {
    items: view.history.items,
    initialized: view.history.initialized,
    balanceCoins: view.balanceCoins,
    loading: active && Boolean(token) && !view.history.initialized && !view.failed,
    failed: view.failed,
    error: view.error,
    lastSuccessAt: view.lastSuccessAt,
    hasMore: view.history.nextCursor !== null,
    loadingMore: Boolean(view.more?.busy),
    moreFailed: Boolean(view.more?.failed && view.more.cursor === view.history.nextCursor),
    loadMore,
    retry,
  };
}
