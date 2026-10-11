"use client";

/**
 * Shared payout data for one signed-in owner and vault session.
 *
 * CONTRACT (owned by the live-store lane; signatures are stable):
 * - usePayoutResource(key, load, options) returns the last verified snapshot
 *   for one payout resource plus freshness. Every mount of the same key shares
 *   one read: single flight, one queued follow-up, coalesced invalidations.
 * - Resources refresh only for payout kinds they depend on
 *   (lib/payouts/payout-events.ts), never for unrelated consent changes.
 * - A failed refresh keeps the last verified data; `stale` turns true once the
 *   data is older than the freshness window or the last attempt failed.
 * - usePayoutFreshness() summarises every mounted resource for one short
 *   "Updated 2m ago" / "Updating…" line.
 *
 * This scaffold delegates to the existing per-mount snapshot hook so every
 * lane can build against the final API from the start.
 */
import { useEffect, useRef, useState } from "react";

import { usePayoutSnapshot } from "@/components/consent/document-payout-account";
import {
  dispatchPayoutStateChanged,
  type PayoutChangeSource,
  type PayoutKind,
} from "@/lib/payouts/payout-events";

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

export function usePayoutResource<T>(
  key: PayoutResourceKey,
  load: (token: string) => Promise<T>,
  options: { active?: boolean } = {},
): PayoutResource<T> {
  const snapshot = usePayoutSnapshot(load, {
    active: options.active ?? true,
    ignoreReadyEvent: key !== "account",
  });
  const [lastSuccessAt, setLastSuccessAt] = useState<number | null>(null);
  const seen = useRef<T | null>(null);
  useEffect(() => {
    if (snapshot.data !== null && snapshot.data !== seen.current) {
      seen.current = snapshot.data;
      setLastSuccessAt(Date.now());
    }
  }, [snapshot.data]);
  return {
    ...snapshot,
    lastSuccessAt: snapshot.data === null ? null : lastSuccessAt,
    stale: snapshot.failed,
  };
}

export function usePayoutFreshness(): PayoutFreshness {
  return { lastSuccessAt: null, refreshing: false, failures: 0, online: true, stream: "polling" };
}

/**
 * The document-feed stream manager reports its state here, so freshness and
 * polling cadence follow the real connection ("live" means typed payout frames
 * are arriving; anything else means the store polls).
 */
export function setPayoutStreamState(state: PayoutStreamState): void {
  void state;
}

/** Ask every mounted payout resource that depends on these kinds to reread. */
export function invalidatePayoutResources(
  kinds: readonly PayoutKind[],
  source: PayoutChangeSource = "manual",
): void {
  dispatchPayoutStateChanged({ kinds: [...kinds], source });
}
