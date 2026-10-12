"use client";

import {
  PAYOUT_POLL_MS,
  PAYOUT_READY_SOURCE,
  usePayoutStoreResource,
  type PayoutResourceKey,
} from "@/lib/payouts/payout-live-store";
import { DocumentPayoutService } from "@/lib/services/document-payout-service";

export { PAYOUT_READY_SOURCE };
export const PAYOUT_FALLBACK_POLL_MS = PAYOUT_POLL_MS;

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
 * The compact readers' view of the payout store (request review, the price
 * sheet, the Feed's bank cue). Reads are shared with every other reader of the
 * same resource and fenced to the vault session. Changes arrive on the payout
 * bus, never from unrelated consent changes: `refreshOnFeedChange` follows the
 * resource's payout changes, `bankOnly` keeps a loader outside the known
 * resources off request-scoped changes, and `ignoreReadyEvent` skips the
 * account's bank-ready reread.
 */
export function usePayoutSnapshot<T>(load: (token: string) => Promise<T>, {
  active = true, refreshKey = "", bankOnly = false, refreshOnFeedChange = true, ignoreReadyEvent = false,
}: { active?: boolean; refreshKey?: string; bankOnly?: boolean; refreshOnFeedChange?: boolean; ignoreReadyEvent?: boolean } = {}) {
  const resource = usePayoutStoreResource(resourceFor(load), load, {
    active, refreshKey, bankOnly, refreshOnChange: refreshOnFeedChange, refreshOnReady: !ignoreReadyEvent,
  });
  const { data, failed, loading, error, token, scope, isCurrent, retry } = resource;
  return { data, failed, loading, error, token, scope, isCurrent, retry };
}
