"use client";

import type { ReactNode } from "react";

/** "coins" = everything that moves the coin balance: earnings, cash-outs and adjustments. */
export type PayoutActivityFilter = "all" | "earning" | "redemption" | "deposit" | "adjustment" | "coins";

export type PayoutActivityCardProps = {
  /** One freshness line from the live store, shown in the card header. */
  freshness?: ReactNode;
  /** Newest rows shown before "View all". */
  limit?: number;
};

/**
 * CONTRACT (activity-ui lane): the "Activity" card. Filter (All ▾), the newest
 * rows, and "View all"; each row opens its receipt. It owns its own paged data
 * (merged by item id, never reset by a refresh), its receipt sheet and its
 * View all sheet. Real activity by default; test records only behind a filter.
 */
export function PayoutActivityCard(props: PayoutActivityCardProps) {
  void props;
  return null;
}
