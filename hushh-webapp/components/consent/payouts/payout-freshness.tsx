"use client";

import { useEffect, useState } from "react";

import { PAYOUT_KINDS } from "@/lib/payouts/payout-events";
import { invalidatePayoutResources, PAYOUT_FRESH_MS, usePayoutFreshness } from "@/lib/payouts/payout-live-store";
import { useCoarseClock } from "@/lib/perf/use-periodic-task";
import { cn } from "@/lib/utils";

// The shared idle clock: one wake every 30 s while the page is visible.
const TICK_MS = 30_000;
// A read that lands sooner never flashes the line.
const UPDATING_DELAY_MS = 400;
// Data this recent is not worth an "Updating…".
const UPDATING_MIN_AGE_MS = 10_000;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** "Updated 2m ago", in the stale-cache-timestamp style. */
export function payoutUpdatedLabel(lastSuccessAt: number, now: number): string {
  const age = Math.max(0, now - lastSuccessAt);
  if (age < MINUTE_MS) return "Updated just now";
  if (age < HOUR_MS) return `Updated ${Math.min(59, Math.round(age / MINUTE_MS))}m ago`;
  if (age < DAY_MS) return `Updated ${Math.min(23, Math.round(age / HOUR_MS))}h ago`;
  return `Updated ${Math.round(age / DAY_MS)}d ago`;
}

/**
 * CONTRACT (live-store lane): one short freshness line for the whole Payouts
 * screen ("Updating…", "Updated 2m ago", "Offline · Updated 5m ago",
 * "Couldn't update" with Retry). Hidden while everything is fresh.
 *
 * Inline content only: it sits inside a group's description line. Assistive
 * tech hears only a move into "Couldn't update" or "Offline"; the minutes
 * ticking by and "Updating…" stay quiet.
 */
export function PayoutFreshness({ className }: { className?: string }) {
  const { lastSuccessAt, refreshing, failures, online } = usePayoutFreshness();
  // The clock only re-renders the line; the age is read now.
  useCoarseClock(TICK_MS);
  const now = Date.now();
  const age = lastSuccessAt === null ? null : Math.max(0, now - lastSuccessAt);
  const updatingWanted = online && refreshing && age !== null && (age > UPDATING_MIN_AGE_MS || failures > 0);
  const [updatingShown, setUpdatingShown] = useState(false);
  useEffect(() => {
    if (!updatingWanted) {
      setUpdatingShown(false);
      return;
    }
    const timer = window.setTimeout(() => setUpdatingShown(true), UPDATING_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [updatingWanted]);

  // Nothing on screen yet: each card shows its own loading or failure.
  const updated = lastSuccessAt === null ? null : payoutUpdatedLabel(lastSuccessAt, now);
  // After a failed read, "Updated just now" reads as that read's success: an
  // age under a minute goes unsaid, and the line names it from 1m on.
  const sinceLastGood = failures > 0 && age !== null && age < MINUTE_MS ? null : updated;
  let notice: "Offline" | "Couldn't update" | null = null;
  let detail: string | null = null;
  if (updated !== null && age !== null) {
    if (!online) {
      notice = "Offline";
      detail = updated;
    } else if (updatingWanted && updatingShown) {
      detail = "Updating…";
    } else if (failures >= 2) {
      notice = "Couldn't update";
      detail = sinceLastGood;
    } else if (failures > 0 || age > PAYOUT_FRESH_MS) {
      detail = sinceLastGood;
    }
  }

  return (
    <span className={cn("[overflow-wrap:anywhere]", className)} data-testid="payout-freshness">
      <span role="status" aria-live="polite">{notice ?? ""}</span>
      {detail ? <span>{notice ? ` · ${detail}` : detail}</span> : null}
      {notice === "Couldn't update" ? (
        <button
          type="button"
          data-consent-role="utility"
          onClick={() => invalidatePayoutResources(PAYOUT_KINDS, "manual")}
          className="relative ml-2 rounded-sm font-semibold text-[color:var(--app-accent)] after:absolute after:-inset-x-3 after:-inset-y-[13px] after:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)]"
        >
          Retry
        </button>
      ) : null}
    </span>
  );
}
