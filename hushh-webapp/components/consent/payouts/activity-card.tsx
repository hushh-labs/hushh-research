"use client";

import { useState, type ReactNode } from "react";

import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { HelperText } from "@/components/app-ui/typography";
import { ProfilePaneHistoryIcon } from "@/components/profile/profile-pane-icons";
import { isNative } from "@/lib/capacitor/platform";
import { reloadWindow } from "@/lib/utils/browser-navigation";
import { useVault } from "@/lib/vault/vault-context";

import { PayoutActivityFilterMenu } from "./activity-filter";
import { PayoutActivityRefreshFailedRow, PayoutActivityRows, PayoutActivitySheet } from "./activity-sheet";
import { PayoutReceiptSheet } from "./receipts/payout-receipt-sheet";
import { useOpenerFocus, type PayoutReceiptAction } from "./receipts/receipt-ui";
import { usePayoutActivity } from "./use-payout-activity";

/** "coins" = everything that moves the coin balance: earnings, cash-outs and adjustments. */
export type PayoutActivityFilter = "all" | "earning" | "redemption" | "deposit" | "adjustment" | "coins";

export type PayoutActivityCardProps = {
  /** One freshness line from the live store, shown in the card header. */
  freshness?: ReactNode;
  /** Newest rows shown before "View all". */
  limit?: number;
  /**
   * Takes a receipt's next step ("Update your bank", "Verify details") with
   * the Payouts bank actions. The receipt, and View all over it, close first.
   * Without it, receipts offer no action.
   */
  onAction?: (action: PayoutReceiptAction) => void;
};

/**
 * CONTRACT (activity-ui lane): the "Activity" card. Filter (All ▾), the newest
 * rows, and "View all"; each row opens its receipt. It owns its own paged data
 * (merged by item id, never reset by a refresh), its receipt sheet and its
 * View all sheet. Real activity by default; test records only behind a filter.
 *
 * Receipts and View all are local state, never a route: Back closes the
 * topmost sheet, and closing returns focus to the row that opened it. Both
 * close when the vault owner changes.
 */
export function PayoutActivityCard({ freshness, limit: requested = 5, onAction }: PayoutActivityCardProps) {
  const { vaultOwnerToken } = useVault();
  const [filter, setFilter] = useState<PayoutActivityFilter>("all");
  const [testActivity, setTestActivity] = useState(false);
  // The activity API pages 1-50 rows.
  const limit = Math.min(Math.max(Math.trunc(requested) || 5, 1), 50);
  const [receipt, setReceipt] = useState<{ scope: string; id: string; test: boolean } | null>(null);
  const [viewAllScope, setViewAllScope] = useState<string | null>(null);
  const viewAllOpen = Boolean(vaultOwnerToken) && viewAllScope === vaultOwnerToken;
  // View all reads the same activity; the card under it rests and reads once when it closes.
  const activity = usePayoutActivity({
    kind: filter, mode: testActivity ? "test" : "live", pageSize: limit, active: !viewAllOpen,
  });
  const opener = useOpenerFocus();
  if (!vaultOwnerToken) return null;
  const closeViewAll = () => { setViewAllScope(null); opener.restore(); };
  // The step happens on Payouts, so View all closes too, showing the bank row it uses.
  const viewAllAction = onAction ? (action: PayoutReceiptAction) => { closeViewAll(); onAction(action); } : undefined;
  const openReceipt = receipt && receipt.scope === vaultOwnerToken ? receipt : null;
  const rows = activity.items.slice(0, limit);
  // This build can't read the activity contract; a newer one can.
  const outdated = activity.error instanceof Error && activity.error.name === "PayoutContractError";
  const native = outdated && isNative();
  return (
    <section aria-label="Payout activity" onClickCapture={opener.capture}>
      <SettingsGroup title="Activity" density="compact" description={freshness}
        titleAction={<PayoutActivityFilterMenu value={filter} onValueChange={setFilter}
          testActivity={testActivity} onTestActivityChange={setTestActivity} />}>
        {activity.loading ? <HelperText role="status" className="p-4">Loading activity…</HelperText> : null}
        {!activity.initialized && activity.failed ? (
          <SettingsRow title="Couldn't load activity" description={native ? "Update the app." : undefined}
            onClick={native ? undefined : outdated ? reloadWindow : activity.retry}
            trailing={native ? undefined : <span className="profile-account-inline-action">{outdated ? "Reload" : "Retry"}</span>} />
        ) : null}
        {activity.initialized && activity.failed
          ? <PayoutActivityRefreshFailedRow lastSuccessAt={activity.lastSuccessAt} onRetry={activity.retry} /> : null}
        {activity.initialized && rows.length === 0 ? <SettingsRow title="No activity yet" /> : null}
        <PayoutActivityRows items={rows} onOpen={(item) => {
          opener.remember();
          setReceipt({ scope: vaultOwnerToken, id: item.id, test: item.test });
        }} />
        {rows.length > 0 ? (
          <SettingsRow icon={ProfilePaneHistoryIcon} iconTone="capability" title="View all" chevron onClick={() => {
            opener.remember();
            setViewAllScope(vaultOwnerToken);
          }} />
        ) : null}
      </SettingsGroup>
      <PayoutActivitySheet open={viewAllOpen} initialFilter={filter} initialTestActivity={testActivity}
        onAction={viewAllAction} onOpenChange={(open) => { if (!open) closeViewAll(); }} />
      <PayoutReceiptSheet itemId={openReceipt?.id ?? null} test={openReceipt?.test} onAction={onAction}
        onOpenChange={(open) => { if (!open) { setReceipt(null); opener.restore(); } }} />
    </section>
  );
}
