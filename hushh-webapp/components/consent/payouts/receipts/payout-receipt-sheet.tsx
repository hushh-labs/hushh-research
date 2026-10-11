"use client";

export type PayoutReceiptSheetProps = {
  /**
   * An activity item id from GET /api/one/payouts/activity, e.g.
   * "earning:<request uuid>", "redemption:<uuid>", "deposit:po_…".
   */
  itemId: string | null;
  onOpenChange: (open: boolean) => void;
};

/**
 * CONTRACT (activity-ui lane): one compact receipt sheet for any activity item:
 * related request and amount, coins and fee breakdown, transfer and bank
 * payout stages with times, masked bank, reference and any required action.
 * A live refresh updates an open receipt in place and never closes it.
 */
export function PayoutReceiptSheet(props: PayoutReceiptSheetProps) {
  void props;
  return null;
}
