"use client";

import { useState } from "react";

import { AdaptiveDetailSurface, SettingsGroup, SettingsPresentationProvider, SettingsRow } from "@/components/app-ui/settings-ui";
import { HelperText } from "@/components/app-ui/typography";
import { ProfileInnerWarningIcon } from "@/components/profile/profile-inner-icons";
import { ProfileSecondaryReceiptIcon } from "@/components/profile/profile-secondary-icons";
import { ProfileAccountBankIcon, ProfileAccountWalletIcon } from "@/components/profile/profile-your-account-icons";
import accountStyles from "@/components/profile/profile-your-account.module.css";
import { Button } from "@/lib/morphy-ux/button";
import { useCoarseClock } from "@/lib/perf/use-periodic-task";
import type { PayoutActivityItem, PayoutActivityKind } from "@/lib/services/payout-activity-service";
import { useVault } from "@/lib/vault/vault-context";

import type { PayoutActivityFilter } from "./activity-card";
import { PayoutActivityFilterMenu } from "./activity-filter";
import { payoutUpdatedLabel } from "./payout-freshness";
import { activityAmount, activityDescription, activityTitle } from "./receipts/activity-copy";
import { PayoutReceiptSheet } from "./receipts/payout-receipt-sheet";
import { useOpenerFocus, type PayoutReceiptAction } from "./receipts/receipt-ui";
import { usePayoutActivity } from "./use-payout-activity";

export type PayoutActivitySheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialFilter?: PayoutActivityFilter;
  /** Opens on test activity, e.g. when the card was showing it. */
  initialTestActivity?: boolean;
  /** A receipt's next step, taken on Payouts once the receipt closes. */
  onAction?: (action: PayoutReceiptAction) => void;
};

const PAGE_SIZE = 20;
const KIND_ICONS: Record<PayoutActivityKind, typeof ProfileAccountWalletIcon> = {
  earning: ProfileSecondaryReceiptIcon,
  redemption: ProfileAccountWalletIcon,
  deposit: ProfileAccountBankIcon,
  adjustment: ProfileInnerWarningIcon,
};

/** Activity rows for a SettingsGroup; each opens its receipt. */
export function PayoutActivityRows({ items, showBalance = false, onOpen }: {
  items: readonly PayoutActivityItem[];
  showBalance?: boolean;
  onOpen: (item: PayoutActivityItem) => void;
}) {
  return (
    <>
      {items.map((item) => {
        const amount = activityAmount(item);
        return (
          <SettingsRow key={item.id} icon={KIND_ICONS[item.kind]} iconTone="capability" title={activityTitle(item)}
            description={activityDescription(item, showBalance)} chevron onClick={() => onOpen(item)}
            trailing={amount ? <span className="tabular-nums">{amount}</span> : undefined} />
        );
      })}
    </>
  );
}

/**
 * A refresh failed after rows were shown: they stay, with their age and a
 * Retry, so an old state never reads as current.
 */
export function PayoutActivityRefreshFailedRow({ lastSuccessAt, onRetry }: {
  lastSuccessAt: number | null;
  onRetry: () => void;
}) {
  // The shared 30 s idle clock only re-renders the age; the age is read now.
  useCoarseClock(30_000);
  return (
    <SettingsRow title="Couldn't update" onClick={onRetry}
      description={lastSuccessAt === null ? undefined : payoutUpdatedLabel(lastSuccessAt, Date.now())}
      trailing={<span className="profile-account-inline-action">Retry</span>} />
  );
}

/**
 * CONTRACT (activity-ui lane): "View all" as a local sheet over Payouts, never
 * a route. Older pages load on demand and survive live refreshes. The coin row
 * opens it with initialFilter "coins" to show the running balance.
 */
export function PayoutActivitySheet({ open, onOpenChange, initialFilter = "all", initialTestActivity = false, onAction }: PayoutActivitySheetProps) {
  return (
    <AdaptiveDetailSurface
      open={open}
      onOpenChange={onOpenChange}
      title="Activity"
      mobilePresentation="sheet"
      desktopMaxWidthClassName="sm:!max-w-[520px]"
      surfaceClassName={accountStyles.walletContent}
    >
      {/* Mounted only while open, so each opening starts from its own filter. */}
      <ActivitySheetBody initialFilter={initialFilter} initialTestActivity={initialTestActivity} onAction={onAction} />
    </AdaptiveDetailSurface>
  );
}

function ActivitySheetBody({ initialFilter, initialTestActivity, onAction }: {
  initialFilter: PayoutActivityFilter; initialTestActivity: boolean; onAction?: (action: PayoutReceiptAction) => void;
}) {
  const { vaultOwnerToken } = useVault();
  const [filter, setFilter] = useState<PayoutActivityFilter>(initialFilter);
  const [testActivity, setTestActivity] = useState(initialTestActivity);
  const activity = usePayoutActivity({ kind: filter, mode: testActivity ? "test" : "live", pageSize: PAGE_SIZE, syncTail: true });
  const [receipt, setReceipt] = useState<{ scope: string; id: string; test: boolean } | null>(null);
  const opener = useOpenerFocus();
  const openReceipt = receipt && receipt.scope === vaultOwnerToken ? receipt : null;
  return (
    <SettingsPresentationProvider density="compact" separatorInset>
      <div onClickCapture={opener.capture}>
        <SettingsGroup title="History"
          titleAction={<PayoutActivityFilterMenu value={filter} onValueChange={setFilter} includeCoins
            testActivity={testActivity} onTestActivityChange={setTestActivity} />}>
          {activity.loading ? <HelperText role="status" className="p-4">Loading activity…</HelperText> : null}
          {!activity.initialized && activity.failed ? (
            <SettingsRow title="Couldn't load activity" onClick={activity.retry}
              trailing={<span className="profile-account-inline-action">Retry</span>} />
          ) : null}
          {activity.initialized && activity.failed
            ? <PayoutActivityRefreshFailedRow lastSuccessAt={activity.lastSuccessAt} onRetry={activity.retry} /> : null}
          {activity.initialized && activity.items.length === 0 ? <SettingsRow title="No activity yet" /> : null}
          <PayoutActivityRows items={activity.items} showBalance={filter === "coins"} onOpen={(item) => {
            if (!vaultOwnerToken) return;
            opener.remember();
            setReceipt({ scope: vaultOwnerToken, id: item.id, test: item.test });
          }} />
        </SettingsGroup>
        {activity.hasMore ? (
          <div className="flex flex-col items-center gap-1 pt-3">
            <Button type="button" size="standard" variant="none" effect="fade" disabled={activity.loadingMore}
              onClick={activity.loadMore}>
              {activity.loadingMore ? "Loading…" : "Load more"}
            </Button>
            {activity.moreFailed ? <HelperText role="alert">Couldn't load more. Try again.</HelperText> : null}
          </div>
        ) : null}
      </div>
      <PayoutReceiptSheet itemId={openReceipt?.id ?? null} test={openReceipt?.test} onAction={onAction}
        onOpenChange={(next) => { if (!next) { setReceipt(null); opener.restore(); } }} />
    </SettingsPresentationProvider>
  );
}
