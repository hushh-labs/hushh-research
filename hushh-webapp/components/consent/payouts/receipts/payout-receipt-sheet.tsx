"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";

import { AdaptiveDetailSurface, SettingsPresentationProvider } from "@/components/app-ui/settings-ui";
import { HelperText } from "@/components/app-ui/typography";
import accountStyles from "@/components/profile/profile-your-account.module.css";
import { Button } from "@/lib/morphy-ux/button";
import { payoutChangeTouches, subscribePayoutStateChanged } from "@/lib/payouts/payout-events";
import { usePayoutFreshness } from "@/lib/payouts/payout-live-store";
import { usePeriodicTask } from "@/lib/perf/use-periodic-task";
import {
  PayoutActivityService,
  parsePayoutActivityItemId,
  type PayoutReceipt,
} from "@/lib/services/payout-activity-service";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { useVault } from "@/lib/vault/vault-context";

import { ACTIVITY_CHANGE_KINDS, ACTIVITY_POLL_GAP_MS, ACTIVITY_REFRESH_MS } from "../use-payout-activity";
import {
  adjustmentTitle,
  depositTitle,
  dollars,
  earningTitle,
  kindLabel,
  redemptionTitle,
  signedDollars,
} from "./activity-copy";
import {
  AdjustmentReceiptSections,
  DepositReceiptSections,
  EarningReceiptSections,
  RedemptionReceiptSections,
  type OpenLinkedItem,
} from "./receipt-sections";
import { useOpenerFocus, type PayoutReceiptAction } from "./receipt-ui";

export type PayoutReceiptSheetProps = {
  /**
   * An activity item id from GET /api/one/payouts/activity, e.g.
   * "earning:<request uuid>", "redemption:<uuid>", "deposit:po_…".
   */
  itemId: string | null;
  onOpenChange: (open: boolean) => void;
  /** The row came from test activity: label it, so it never reads as real money. */
  test?: boolean;
  /**
   * Takes a review's next step on Payouts ("Update your bank", "Verify
   * details"). The receipt closes first. Without it, the step only reads.
   */
  onAction?: (action: PayoutReceiptAction) => void;
};

type ReceiptState = { key: string; receipt: PayoutReceipt | null; failed: boolean; missing: boolean };

/** Reads one receipt by id, and again on payout changes, keeping the last good copy. */
export function usePayoutReceipt(itemId: string | null) {
  const { vaultOwnerToken: token } = useVault();
  const { stream } = usePayoutFreshness();
  const key = itemId && token ? `${token}|${itemId}` : null;
  const [state, setState] = useState<ReceiptState | null>(null);
  const [attempt, setAttempt] = useState(0);
  const pollNow = useRef<(() => void) | null>(null);
  const instance = useId();

  useEffect(() => {
    if (!key || !token || !itemId) return;
    const epoch = snapshotVaultSessionEpoch();
    let cancelled = false;
    let pending = false;
    let queued = false;
    let startedAt = Number.NEGATIVE_INFINITY;
    const current = () => !cancelled && isVaultSessionEpochCurrent(epoch);
    const load = async () => {
      if (!current()) return;
      if (pending) { queued = true; return; }
      pending = true;
      startedAt = Date.now();
      try {
        const receipt = await PayoutActivityService.item(token, itemId);
        if (current()) setState({ key, receipt, failed: false, missing: false });
      } catch (error) {
        const missing = error instanceof Error && error.name === "ApiError" && (error as { status?: unknown }).status === 404;
        if (current()) {
          setState((previous) => ({ key, receipt: previous?.key === key ? previous.receipt : null, failed: true, missing }));
        }
      } finally {
        pending = false;
        if (queued && current()) { queued = false; void load(); }
      }
    };
    // A read in flight or just started is fresh enough for a fallback read
    // (one return to the page can run the same due task twice).
    pollNow.current = () => {
      if (!pending && Date.now() - startedAt >= ACTIVITY_POLL_GAP_MS) void load();
    };
    void load();
    const unsubscribe = subscribePayoutStateChanged((detail) => {
      if (payoutChangeTouches(detail, ACTIVITY_CHANGE_KINDS)) void load();
    });
    return () => {
      cancelled = true;
      pollNow.current = null;
      unsubscribe();
    };
  }, [key, token, itemId, attempt]);

  usePeriodicTask(`payout-receipt:${instance}`, ACTIVITY_REFRESH_MS, () => pollNow.current?.(), {
    enabled: Boolean(key) && stream !== "live",
  });
  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  const view = state && state.key === key ? state : null;
  return {
    receipt: view?.receipt ?? null,
    failed: view?.failed ?? false,
    missing: view?.missing ?? false,
    loading: Boolean(key) && !view,
    retry,
  };
}

export function receiptHeader(receipt: PayoutReceipt, test: boolean): { title: string; description: string } {
  switch (receipt.kind) {
    case "earning": {
      const cents = receipt.coins ?? receipt.breakdown?.netCents ?? null;
      const status = receipt.review && receipt.status !== "reversed" ? "Under review" : earningTitle(receipt.status);
      return { title: cents === null ? kindLabel("earning") : dollars(cents), description: test ? `Test payment · ${status}` : status };
    }
    case "redemption": {
      const status = redemptionTitle(receipt.status, receipt.reversal?.status ?? null);
      return { title: dollars(receipt.amountCents), description: receipt.mode === "test" ? `Test · ${status}` : status };
    }
    case "deposit":
      return { title: dollars(receipt.amountCents), description: test ? `Test · ${depositTitle(receipt.status)}` : depositTitle(receipt.status) };
    case "adjustment": {
      const cents = receipt.type === "earning_reversed" ? -receipt.coins : receipt.coins;
      return { title: signedDollars(cents), description: test ? `Test · ${adjustmentTitle(receipt.type)}` : adjustmentTitle(receipt.type) };
    }
  }
}

const NO_ANCESTORS: readonly string[] = [];

/**
 * CONTRACT (activity-ui lane): one compact receipt sheet for any activity item:
 * related request and amount, coins and fee breakdown, transfer and bank
 * payout stages with times, masked bank, reference and any required action.
 * A live refresh updates an open receipt in place and never closes it.
 */
export function PayoutReceiptSheet(props: PayoutReceiptSheetProps) {
  return <ReceiptSheet {...props} ancestors={NO_ANCESTORS} />;
}

function ReceiptSheet({ itemId, onOpenChange, test = false, onAction, ancestors }: PayoutReceiptSheetProps & { ancestors: readonly string[] }) {
  const { receipt, failed, missing, loading, retry } = usePayoutReceipt(itemId);
  const parsed = parsePayoutActivityItemId(itemId);
  // A linked receipt opens over this one; Back closes it first.
  const [linked, setLinked] = useState<{ parent: string; id: string } | null>(null);
  const linkedId = linked && linked.parent === itemId ? linked.id : null;
  // Closing this receipt closes what was opened over it, so reopening starts clean.
  useEffect(() => { if (!itemId) setLinked(null); }, [itemId]);
  const opener = useOpenerFocus();
  const chain = itemId ? [...ancestors, itemId] : ancestors;
  const openItem: OpenLinkedItem = (id) => (chain.includes(id) || !itemId ? undefined : () => {
    opener.remember();
    setLinked({ parent: itemId, id });
  });
  const header = receipt ? receiptHeader(receipt, test) : null;
  // A next step leaves the receipt: it closes (and any receipt beneath it) before Payouts acts.
  const takeStep = onAction ? (action: PayoutReceiptAction) => { onOpenChange(false); onAction(action); } : undefined;
  return (
    <AdaptiveDetailSurface
      open={itemId !== null}
      onOpenChange={onOpenChange}
      eyebrow={header && parsed ? kindLabel(parsed.kind) : undefined}
      title={header?.title ?? (parsed ? kindLabel(parsed.kind) : "Activity")}
      description={header?.description}
      mobilePresentation="sheet"
      desktopMaxWidthClassName="sm:!max-w-[520px]"
      surfaceClassName={`${accountStyles.walletContent} consent-presentation-surface`}
    >
      <SettingsPresentationProvider density="compact" separatorInset>
        <div onClickCapture={opener.capture}>
          {loading ? <HelperText role="status" className="px-1 py-3">Loading…</HelperText> : null}
          {!receipt && missing ? <HelperText role="status" className="px-1 py-3">This activity isn't available.</HelperText> : null}
          {!receipt && failed && !missing ? (
            <div className="space-y-2 px-1 py-3">
              <HelperText role="alert">Couldn't load this receipt.</HelperText>
              <Button data-consent-role="compact-action" type="button" size="compact" variant="none" effect="fade" data-consent-quiet-action="true" onClick={retry}>Retry</Button>
            </div>
          ) : null}
          {receipt?.kind === "earning" ? <EarningReceiptSections receipt={receipt} openItem={openItem} onAction={takeStep} /> : null}
          {receipt?.kind === "redemption" ? <RedemptionReceiptSections receipt={receipt} openItem={openItem} onAction={takeStep} /> : null}
          {receipt?.kind === "deposit" ? <DepositReceiptSections receipt={receipt} openItem={openItem} onAction={takeStep} /> : null}
          {receipt?.kind === "adjustment" ? <AdjustmentReceiptSections receipt={receipt} openItem={openItem} /> : null}
        </div>
      </SettingsPresentationProvider>
      <ReceiptSheet itemId={linkedId} test={test} ancestors={chain} onAction={takeStep}
        onOpenChange={(open) => { if (!open) { setLinked(null); opener.restore(); } }} />
    </AdaptiveDetailSurface>
  );
}
