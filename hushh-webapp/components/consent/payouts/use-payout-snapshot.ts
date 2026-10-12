"use client";

import { useCallback, useEffect, useMemo } from "react";

import {
  PAYOUT_POLL_MS,
  PAYOUT_READY_SOURCE,
  usePayoutStoreResource,
  type PayoutResourceKey,
} from "@/lib/payouts/payout-live-store";
import { DocumentPayoutService } from "@/lib/services/document-payout-service";
import { isVaultSessionEpochCurrent } from "@/lib/vault/session-epoch";
import { useVault } from "@/lib/vault/vault-context";

export { PAYOUT_READY_SOURCE };
export const PAYOUT_FALLBACK_POLL_MS = PAYOUT_POLL_MS;

// Focus and visibilitychange both fire on one return to the page; like the
// store, one return gets one read.
const RESUME_GAP_MS = 1_000;

type Loader<T> = (token: string) => Promise<T>;

/** The shared resource a payout loader reads; any other loader keeps an entry of its own. */
function resourceFor(load: unknown): PayoutResourceKey | null {
  try {
    const service = DocumentPayoutService as unknown as Partial<Record<string, unknown>>;
    if (load === service.hashcoins) return "wallet";
    if (load === service.account) return "account";
    if (load === service.bankPayouts) return "bank_payouts";
    if (load === service.earnings) return "earnings";
    if (load === service.balance) return "balance";
  } catch {
    // A partial module mock without the service: the loader keeps its own entry.
  }
  return null;
}

/**
 * Reads that skip the server's short display cache: after Stripe's return, an
 * explicit retry, or a return to the page (the bank may have changed in
 * Stripe's own tab). One record per fresh loader, shared by every reader of
 * that resource, because the store reads through whichever reader rendered
 * last.
 */
type FreshReads = {
  /** The owner whose next read must be fresh. */
  owedTo: string | null;
  /** The store's latest read through this loader. */
  flight: { token: string; fresh: boolean; done: boolean } | null;
  /** The last return to the page that the store reads for. */
  resumedAt: number;
  readers: number;
  read: Loader<unknown>;
};

const freshReadsByLoader = new WeakMap<Loader<unknown>, FreshReads>();

/** A fresh loader serves one resource, so it keys the record. */
function freshReadsFor(load: Loader<unknown>, freshLoad: Loader<unknown>): FreshReads {
  const known = freshReadsByLoader.get(freshLoad);
  if (known) return known;
  const reads: FreshReads = {
    owedTo: null, flight: null, resumedAt: Number.NEGATIVE_INFINITY, readers: 0,
    read: (token) => {
      const fresh = reads.owedTo === token;
      if (fresh) reads.owedTo = null;
      const flight = { token, fresh, done: false };
      reads.flight = flight;
      let pending: Promise<unknown>;
      try {
        pending = Promise.resolve((fresh ? freshLoad : load)(token));
      } catch (error) {
        pending = Promise.reject(error);
      }
      const finish = () => { flight.done = true; };
      pending.then(finish, finish);
      return pending;
    },
  };
  freshReadsByLoader.set(freshLoad, reads);
  return reads;
}

/** Nothing owed or remembered outlives the last reader. */
function holdFreshReads(reads: FreshReads): () => void {
  reads.readers += 1;
  return () => {
    reads.readers -= 1;
    if (reads.readers > 0) return;
    reads.owedTo = null;
    reads.flight = null;
    reads.resumedAt = Number.NEGATIVE_INFINITY;
  };
}

/** The next read for this owner skips the display cache. */
function oweFreshRead(reads: FreshReads, token: string): void {
  reads.owedTo = token;
}

/** This owner's display read still on its way, which can't answer a fresh request. */
function displayInFlight(reads: FreshReads, token: string): boolean {
  const flight = reads.flight;
  return flight !== null && flight.token === token && !flight.done && !flight.fresh;
}

/** A return to the page. Runs before the store's own return listeners. */
function noteReturn(reads: FreshReads, token: string, reread: () => void): void {
  const flight = reads.flight;
  if (flight && flight.token === token && !flight.done) {
    // A display read that started before this return can't vouch for the
    // bank: one fresh read queues behind it.
    if (!flight.fresh && reads.owedTo !== token) {
      oweFreshRead(reads, token);
      reread();
    }
    return;
  }
  const now = Date.now();
  if (now - reads.resumedAt < RESUME_GAP_MS) return;
  reads.resumedAt = now;
  // The store's read for this return comes next in the same dispatch and takes it.
  oweFreshRead(reads, token);
}

function pageHidden(): boolean {
  return document.hidden === true || document.visibilityState === "hidden";
}

/**
 * The compact readers' view of the payout store (request review, the price
 * sheet, the Feed's bank cue). Reads are shared with every other reader of the
 * same resource and fenced to the vault session. Changes arrive on the payout
 * bus, never from unrelated consent changes: `refreshOnFeedChange` follows the
 * resource's payout changes, `bankOnly` keeps a loader outside the known
 * resources off request-scoped changes, and `ignoreReadyEvent` skips the
 * account's bank-ready reread. `freshLoad` skips the server's display cache
 * after Stripe's return ("done"), a retry and a return to the page; payout
 * changes and polls keep the cached read.
 */
export function usePayoutSnapshot<T>(load: Loader<T>, {
  active = true, refreshKey = "", bankOnly = false, refreshOnFeedChange = true, ignoreReadyEvent = false, freshLoad,
}: {
  active?: boolean; refreshKey?: string; bankOnly?: boolean; refreshOnFeedChange?: boolean; ignoreReadyEvent?: boolean;
  freshLoad?: Loader<T>;
} = {}) {
  const { vaultOwnerToken } = useVault();
  const owner = active && vaultOwnerToken ? vaultOwnerToken : null;
  const reads = useMemo(
    () => freshLoad ? freshReadsFor(load as Loader<unknown>, freshLoad as Loader<unknown>) : null,
    [load, freshLoad],
  );
  const stripeReturned = refreshKey === "done";
  useEffect(() => (reads && owner ? holdFreshReads(reads) : undefined), [reads, owner]);
  // Declared before the store's effects, so the read they start for Stripe's
  // return is the fresh one.
  useEffect(() => {
    if (reads && owner && stripeReturned) oweFreshRead(reads, owner);
  }, [reads, owner, stripeReturned]);
  const resource = usePayoutStoreResource(resourceFor(load), reads ? (reads.read as Loader<T>) : load, {
    active, refreshKey, bankOnly, refreshOnChange: refreshOnFeedChange, refreshOnReady: !ignoreReadyEvent,
  });
  const { data, failed, loading, error, token, scope, isCurrent: inScope, retry: reread } = resource;
  // Another reader's display read was already on its way: the fresh one queues behind it.
  useEffect(() => {
    if (reads && owner && stripeReturned && reads.owedTo === owner && displayInFlight(reads, owner)) reread();
  }, [reads, owner, stripeReturned, reread]);
  useEffect(() => {
    if (!reads || !owner) return;
    const onReturn = (event: Event) => {
      // Capture also sees each element's focus; only the window's own focus is a return.
      if ((event.type === "focus" && event.target !== event.currentTarget) || pageHidden()) return;
      noteReturn(reads, owner, reread);
    };
    // Capture runs before the store's own return listeners, so its read takes the request.
    window.addEventListener("focus", onReturn, true);
    window.addEventListener("visibilitychange", onReturn, true);
    return () => {
      window.removeEventListener("focus", onReturn, true);
      window.removeEventListener("visibilitychange", onReturn, true);
    };
  }, [reads, owner, reread]);
  const retry = useCallback(() => {
    if (reads && owner) oweFreshRead(reads, owner);
    reread();
  }, [reads, owner, reread]);
  // Fenced like the reads: a reply for a locked or replaced vault session is never current.
  const isCurrent = useCallback(() => inScope() && isVaultSessionEpochCurrent(scope.epoch), [inScope, scope]);
  return { data, failed, loading, error, token, scope, isCurrent, retry };
}
