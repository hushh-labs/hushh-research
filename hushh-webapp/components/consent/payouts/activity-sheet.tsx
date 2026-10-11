"use client";

import type { PayoutActivityFilter } from "./activity-card";

export type PayoutActivitySheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialFilter?: PayoutActivityFilter;
};

/**
 * CONTRACT (activity-ui lane): "View all" as a local sheet over Payouts, never
 * a route. Older pages load on demand and survive live refreshes. The coin row
 * opens it with initialFilter "coins" to show the running balance.
 */
export function PayoutActivitySheet(props: PayoutActivitySheetProps) {
  void props;
  return null;
}
