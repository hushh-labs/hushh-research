"use client";

import { useLayoutEffect, useMemo, useState } from "react";
import { nativePrivacyObservation, subscribeNativePrivacyObservation } from "@/lib/capacitor/session-privacy";
import type { NativeDrawerRow, NativeProfilePage } from "@/lib/capacitor/native-drawers";
import { usePayoutResource } from "@/lib/payouts/payout-live-store";
import { holdReasonCopy } from "@/lib/payouts/review-copy";
import { DocumentPayoutService } from "@/lib/services/document-payout-service";
import type { PayoutActivityMode, PayoutActivityQueryKind, PayoutReceipt } from "@/lib/services/payout-activity-service";
import { usePayoutBank, verificationCopy, payoutBankActions } from "@/components/consent/payouts/payout-bank-row";
import { useHashcoinRedeem } from "@/components/consent/payouts/redeem-action";
import { usePayoutActivity } from "@/components/consent/payouts/use-payout-activity";
import { coinSummary, firstHold, holdDetail } from "@/components/consent/payouts/your-money-card";
import { coins, money } from "@/components/consent/payouts/payout-format";
import { redemptionCopy } from "@/components/consent/payouts/redemption-copy";
import { activityAmount, activityDescription, activityTitle, ACTIVITY_FILTER_LABELS, receiptDay } from "@/components/consent/payouts/receipts/activity-copy";
import { receiptHeader, usePayoutReceipt } from "@/components/consent/payouts/receipts/payout-receipt-sheet";
import type { PayoutReceiptAction } from "@/components/consent/payouts/receipts/receipt-ui";
import { projectNativePayoutReceipt } from "./native-payout-receipt";

export const NATIVE_PAYOUT_RECEIPT_PAGES = ["payout-receipt-1", "payout-receipt-2", "payout-receipt-3", "payout-receipt-4", "payout-receipt-5", "payout-receipt-6"] as const;
class PayoutVisit {
  private live = false;
  private step: { action: PayoutReceiptAction; generation: number } | null = null;
  readonly handles = new Map<string, string>();
  constructor(readonly enabled: boolean, readonly scope: unknown) {}
  activate() { this.live = this.enabled; }
  retire() { this.live = false; this.step = null; this.handles.clear(); }
  isCurrent() { return this.live; }
  queueStep(action: PayoutReceiptAction) {
    const privacy = nativePrivacyObservation().state;
    if (this.live && privacy?.shielded === false && privacy.appIsActive) this.step = { action, generation: privacy.generation };
  }
  reconcilePrivacy() {
    const privacy = nativePrivacyObservation().state;
    if (!privacy || privacy.shielded || !privacy.appIsActive || this.step?.generation !== privacy.generation) this.step = null;
  }
  takeStep() { this.reconcilePrivacy(); const step = this.step; this.step = null; return this.live ? step?.action ?? null : null; }
  handle(id: string) { let value = this.handles.get(id); if (!value) { value = crypto.randomUUID(); this.handles.set(id, value); } return value; }
}
type ReceiptVisit = { id: string; test: boolean; page: number };
type LocalState = { panel: "activity" | "stripe" | null; filter: PayoutActivityQueryKind; mode: PayoutActivityMode; activityPage: number; receipts: ReceiptVisit[] };
const initial = (): LocalState => ({ panel: null, filter: "all", mode: "live", activityPage: 0, receipts: [] });

/** Native presentation of the same financial owners as DocumentHashcoinPayouts.
 * No provider calls, amount validation, polling loop or retry policy is added. */
export function useNativePayouts(active: boolean) {
  const wallet = usePayoutResource("wallet", DocumentPayoutService.hashcoins, { active });
  const balance = usePayoutResource("balance", DocumentPayoutService.balance, { active });
  const bank = usePayoutBank({ active, handleReturn: true });
  const accountState = { account: bank.account, loading: bank.resource.loading, failed: bank.resource.failed, stripeMode: bank.stripeMode };
  const redeem = useHashcoinRedeem(wallet, accountState);
  const visit = useMemo(() => new PayoutVisit(active, wallet.scope), [active, wallet.scope]);
  const [state, setState] = useState<{ visit: PayoutVisit; value: LocalState } | null>(null);
  const local = state?.visit === visit ? state.value : initial();
  const [cache, setCache] = useState<{ visit: PayoutVisit; receipts: Map<string, PayoutReceipt> } | null>(null);
  useLayoutEffect(() => { visit.activate(); return () => visit.retire(); }, [visit]);
  useLayoutEffect(() => subscribeNativePrivacyObservation(() => visit.reconcilePrivacy()), [visit]);
  useLayoutEffect(() => { setState(null); setCache(null); }, [visit]);
  const change = (update: (value: LocalState) => LocalState) => {
    if (!visit.isCurrent() || !wallet.isCurrent()) return;
    setState(previous => ({ visit, value: update(previous?.visit === visit ? previous.value : initial()) }));
  };
  const top = local.receipts.at(-1);
  const receipt = usePayoutReceipt(active ? top?.id ?? null : null);
  useLayoutEffect(() => {
    if (!active || !receipt.receipt) return;
    const item = receipt.receipt;
    setCache(previous => ({ visit, receipts: new Map([...(previous?.visit === visit ? previous.receipts : []), [item.id, item]]) }));
  }, [active, receipt.receipt, visit]);
  const activity = usePayoutActivity({ kind: local.filter, mode: local.mode, pageSize: 20,
    active: active && local.panel !== "stripe" && local.receipts.length === 0, syncTail: local.panel === "activity" });
  const actions = new Map<string, () => void | Promise<void>>();
  const bind = (id: string, action: () => void | Promise<void>) => { actions.set(id, () => { if (visit.isCurrent() && wallet.isCurrent()) return action(); }); };
  const read = (id: string, label: string, detail?: string): NativeDrawerRow => ({ id, label, ...(detail ? { detail } : {}), enabled: true, readOnly: true });
  const openReceipt = (id: string, test: boolean) => change(value => value.receipts.some(item => item.id === id) || value.receipts.length >= NATIVE_PAYOUT_RECEIPT_PAGES.length ? value
    : { ...value, receipts: [...value.receipts, { id, test, page: 0 }] });
  const takeStep = (action: PayoutReceiptAction) => {
    if (!visit.isCurrent() || !wallet.isCurrent()) return;
    visit.queueStep(action);
    change(() => initial());
  };
  const data = wallet.data;
  const rootRows: NativeDrawerRow[] = [
    { id: "payout-coins", label: data ? coins(data.live.balanceCoins) : "Hussh Coins", detail: data ? coinSummary(data.live, redeem.liveRedeemEnabled, accountState) : wallet.loading ? "Loading…" : "Balance unavailable",
      enabled: !wallet.loading, chevron: true, artworkId: "account-wallet", ...(data?.live.amountCents ? { trailing: money(data.live.amountCents) } : {}) },
  ];
  bind("payout-coins", () => change(value => ({ ...value, panel: "activity", filter: "coins", mode: "live", activityPage: 0 })));
  const hold = data ? firstHold(data.live) : null;
  if (hold) rootRows.push({ ...read("payout-hold", holdReasonCopy(hold.reason), holdDetail(hold)), artworkId: "payout-review" });
  if (wallet.failed) {
    const outdated = wallet.error instanceof Error && wallet.error.name === "PayoutContractError";
    rootRows.push({ id: "payout-wallet-retry", label: outdated ? "Update the app to read this balance" : data ? "Couldn't refresh balance · Retry" : "Couldn't load balance · Retry", enabled: !outdated, readOnly: outdated });
    bind("payout-wallet-retry", wallet.retry);
  }
  const stripe = balance.data;
  if (stripe?.accountLinked && stripe.stripeMode === "live" && stripe.inStripeCents > 0) {
    rootRows.push({ id: "payout-stripe", label: "In Stripe", detail: stripe.pendingCents > 0 ? "Settling" : "Available", trailing: money(stripe.inStripeCents), enabled: true, chevron: true, artworkId: "payout-progress" });
    bind("payout-stripe", () => change(value => ({ ...value, panel: "stripe" })));
  }
  if (bank.shown) {
    rootRows.push({ id: "payout-bank", label: bank.linked ? "Bank linked" : "Payout bank", detail: bank.resource.failed ? "Bank status unavailable" : bank.bankCheckUnavailable ? "Bank check unavailable" : bank.bankLabel ?? (bank.stripeMode === "test" ? "Test payouts" : "US payouts"),
      trailing: bank.resource.loading ? "Checking…" : bank.busyAction ? "Opening…" : bank.retryBankCheck ? "Retry" : bank.label,
      enabled: !bank.resource.loading && !bank.busyAction, chevron: true, artworkId: "payouts" });
    bind("payout-bank", payoutBankActions(bank).manageBank);
    if (bank.verification && bank.verification.state !== "none") {
      const inReview = bank.verification.state === "in_review";
      rootRows.push({ id: "payout-verify", label: "Verify details", detail: verificationCopy(bank.verification), enabled: inReview || !bank.busyAction && !bank.resource.failed, readOnly: inReview, chevron: !inReview, artworkId: "payout-review" });
      bind("payout-verify", payoutBankActions(bank).verifyDetails);
    }
    if (bank.bankCheckUnavailable || bank.resource.failed && bank.canManage) {
      rootRows.push({ id: "payout-bank-retry", label: "Retry bank check", enabled: !bank.busyAction }); bind("payout-bank-retry", bank.resource.retry);
    }
    if (bank.actionError) rootRows.push(read("payout-bank-error", bank.actionError.text));
  }
  const redeemRows: NativeDrawerRow[] = [];
  const shown = redeem.redeemAmount >= 1 || !redeem.newRedemption || redeem.busy || redeem.refreshing;
  if (redeem.sandboxEnabled) redeemRows.push(read("payout-test-balance", "Test balance", data ? `${coins(data.sandbox.availableCoins)} · Your real Hussh Coins stay unchanged.` : "Loading…"));
  if ((redeem.liveRedeemEnabled || redeem.sandboxEnabled) && shown) {
    const blocked = redeem.busy || redeem.refreshing || wallet.failed || !data || redeem.held ||
      (redeem.liveRedeemEnabled ? redeem.newRedemption && (redeem.redeemAmount < 1 || !!redeem.cashOutBlocked || !redeem.fresh)
        : !redeem.retryIntent && !redeem.unsettled && data.sandbox.availableCoins < 1) || !!(redeem.unsettled && !redeem.unsettled.clientRequestId && !redeem.retryIntent);
    redeemRows.push({ id: "payout-redeem", label: redeem.busy ? "Checking…" : redeem.refreshing || redeem.awaitingWallet ? "Updating balance…" : !redeem.newRedemption ? redeem.sandboxEnabled ? "Check test redemption" : "Check transfer" : `${redeem.sandboxEnabled ? "Test redeem" : "Redeem"} ${money(redeem.redeemAmount)}`, enabled: !blocked, pending: redeem.busy });
    bind("payout-redeem", async () => { if (!blocked) await redeem.redeem(); });
  }
  if (redeem.cashOutBlocked) redeemRows.push(read("payout-blocked", redeem.cashOutBlocked));
  if (redeem.held) redeemRows.push(read("payout-held", redeem.sandboxEnabled ? "Test balance under review." : "Balance under review."));
  if (redeem.last) {
    const last = redeem.last;
    redeemRows.push({ id: "payout-last", label: redemptionCopy(last), enabled: true, chevron: true }); bind("payout-last", () => openReceipt(`redemption:${last.id}`, last.stripeMode === "test"));
  }
  if (redeem.error) redeemRows.push(read("payout-redeem-error", redeem.error));
  if (redeem.sandboxEnabled && data?.redemptionHistory?.length) {
    for (const [index, item] of data.redemptionHistory.entries()) redeemRows.push(read(`payout-test-history-${index}`,
      item.status === "succeeded" ? "Test transfer completed" : item.status === "failed" ? "Test transfer failed" : "Test transfer pending",
      [item.createdAt ? new Date(item.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : null, money(item.amountCoins)].filter(Boolean).join(" · ")));
  }
  const activityRows: NativeDrawerRow[] = [];
  if (activity.loading) activityRows.push(read("payout-activity-loading", "Loading activity…"));
  if (activity.failed) {
    const outdated = activity.error instanceof Error && activity.error.name === "PayoutContractError";
    activityRows.push({ id: "payout-activity-retry", label: outdated ? "Update the app to read activity" : activity.initialized ? "Couldn't update activity · Retry" : "Couldn't load activity · Retry", enabled: !outdated, readOnly: outdated }); bind("payout-activity-retry", activity.retry);
  }
  if (activity.initialized && activity.items.length === 0) activityRows.push(read("payout-activity-empty", "No activity yet"));
  const activityPage = Math.min(local.activityPage, Math.max(0, Math.ceil(activity.items.length / 20) - 1));
  for (const item of local.panel === "activity" ? activity.items.slice(activityPage * 20, (activityPage + 1) * 20) : activity.items.slice(0, 5)) {
    const id = visit.handle(item.id), amount = activityAmount(item);
    activityRows.push({ id, label: activityTitle(item), detail: activityDescription(item, local.filter === "coins"), ...(amount ? { trailing: amount } : {}), enabled: true, chevron: true,
      artworkId: ({ earning: "payout-receipt", redemption: "account-wallet", deposit: "payouts", adjustment: "payout-warning" })[item.kind] }); bind(id, () => openReceipt(item.id, item.test));
  }
  const root: NativeProfilePage = { id: "payouts", title: "Payouts", sections: [{ id: "payout-your-money", title: "Your money", rows: rootRows },
    ...(redeemRows.length ? [{ id: "payout-redeeming", title: redeem.sandboxEnabled ? "Payout sandbox" : "Redeem Hussh Coins", rows: redeemRows }] : []),
    { id: "payout-activity-entry", title: "Activity", rows: [...(!local.panel && !local.receipts.length ? activityRows : []), { id: "payout-activity-open", label: "View all activity", enabled: true, chevron: true }] }] };
  bind("payout-activity-open", () => change(value => ({ ...value, panel: "activity" })));
  const pages: NativeProfilePage[] = [root];
  if (local.panel === "activity") {
    const filters = Object.entries(ACTIVITY_FILTER_LABELS) as [PayoutActivityQueryKind, string][];
    const controls: NativeDrawerRow[] = [
      { id: "payout-filter", label: "Activity", enabled: true, options: filters.map(([kind, label]) => ({ id: `payout-filter-${kind}`, label, selected: local.filter === kind })) },
      { id: "payout-mode", label: "Show", enabled: true, options: (["live", "test"] as const).map(mode => ({ id: `payout-mode-${mode}`, label: mode === "test" ? "Test activity" : "Real activity", selected: local.mode === mode })) },
    ];
    for (const [kind] of filters) bind(`payout-filter-${kind}`, () => change(value => ({ ...value, filter: kind, activityPage: 0 })));
    for (const mode of ["live", "test"] as const) bind(`payout-mode-${mode}`, () => change(value => ({ ...value, mode, activityPage: 0 })));
    if (activityPage > 0) {
      activityRows.push({ id: "payout-previous", label: "Previous activity", enabled: true });
      bind("payout-previous", () => change(value => ({ ...value, activityPage: activityPage - 1 })));
    }
    if ((activityPage + 1) * 20 < activity.items.length) {
      activityRows.push({ id: "payout-next", label: "Next activity", enabled: true });
      bind("payout-next", () => change(value => ({ ...value, activityPage: activityPage + 1 })));
    } else if (activity.hasMore) {
      activityRows.push({ id: "payout-more", label: activity.loadingMore ? "Loading…" : activity.moreFailed ? "Couldn't load more · Retry" : "Load more", enabled: !activity.loadingMore, pending: activity.loadingMore }); bind("payout-more", activity.loadMore);
    }
    pages.push({ id: "payout-activity", title: "Activity", sections: [{ id: "payout-activity-filters", rows: controls }, { id: "payout-activity-items", rows: activityRows }] });
  } else if (local.panel === "stripe") {
    const rows = stripe ? [read("payout-stripe-updated", "Stripe sends it to your bank on your payout schedule."),
      ...(stripe.availableCents !== 0 ? [read("payout-stripe-available", "Available", money(stripe.availableCents))] : []),
      ...(stripe.pendingCents !== 0 ? [read("payout-stripe-pending", "Settling", [money(stripe.pendingCents),
        stripe.pendingCents > 0 && stripe.nextAvailableOn ? stripe.nextAvailableCents !== null && stripe.nextAvailableCents > 0 && stripe.nextAvailableCents < stripe.pendingCents
          ? `${money(stripe.nextAvailableCents)} available ${receiptDay(stripe.nextAvailableOn)}` : `Available ${receiptDay(stripe.nextAvailableOn)}` : null].filter(Boolean).join(" · "))] : []),
      ...(stripe.availableCents === 0 && stripe.pendingCents === 0 ? [read("payout-stripe-empty", "Nothing in Stripe right now")] : [])] : [read("payout-stripe-unavailable", "Balance unavailable")];
    pages.push({ id: "payout-stripe", title: "In Stripe", sections: [{ id: "payout-stripe-details", rows }] });
  }
  for (const [index, selection] of local.receipts.entries()) {
    const pageId = NATIVE_PAYOUT_RECEIPT_PAGES[index]!;
    const cached = cache?.visit === visit ? cache.receipts.get(selection.id) : undefined;
    const item = index === local.receipts.length - 1 ? receipt.receipt ?? cached : cached;
    const header = item ? receiptHeader(item, selection.test) : null;
    const rows = item ? [read(`${pageId}-status`, header!.description), ...projectNativePayoutReceipt(item, `${pageId}-body`, actions,
      id => openReceipt(id, selection.test), takeStep, id => local.receipts.length < NATIVE_PAYOUT_RECEIPT_PAGES.length && !local.receipts.some(value => value.id === id))] :
      [read(`${pageId}-loading`, receipt.missing ? "This activity isn't available." : receipt.failed ? "Couldn't load this receipt." : "Loading receipt…")];
    if (index === local.receipts.length - 1 && receipt.failed && !receipt.missing) {
      rows.push({ id: `${pageId}-retry`, label: "Retry receipt", enabled: true }); bind(`${pageId}-retry`, receipt.retry);
    }
    const receiptPage = Math.min(selection.page, Math.max(0, Math.ceil(rows.length / 40) - 1));
    const visible = rows.slice(receiptPage * 40, (receiptPage + 1) * 40);
    const changeReceiptPage = (page: number) => change(value => ({ ...value, receipts: value.receipts.map((entry, at) => at === index ? { ...entry, page } : entry) }));
    if (receiptPage > 0) { visible.push({ id: `${pageId}-previous`, label: "Previous details", enabled: true }); bind(`${pageId}-previous`, () => changeReceiptPage(receiptPage - 1)); }
    if ((receiptPage + 1) * 40 < rows.length) { visible.push({ id: `${pageId}-next`, label: "More details", enabled: true }); bind(`${pageId}-next`, () => changeReceiptPage(receiptPage + 1)); }
    pages.push({ id: pageId, title: header?.title ?? "Receipt", sections: [{ id: `${pageId}-section`, rows: visible }] });
  }
  const back = () => {
    if (!visit.isCurrent()) return false;
    if (redeem.busy || bank.busyAction) return true;
    if (local.receipts.length) { change(value => ({ ...value, receipts: value.receipts.slice(0, -1) })); return true; }
    if (local.panel) { change(value => ({ ...value, panel: null })); return true; }
    return false;
  };
  const onPresented = () => {
    if (local.panel || local.receipts.length || !visit.isCurrent() || !wallet.isCurrent()) return;
    // The receipt stack has actually returned before its next step opens a
    // provider. Consume once; compatible content acknowledgements never replay.
    const step = visit.takeStep();
    const commands = payoutBankActions(bank);
    if (step === "manage_bank") commands.manageBank(); else if (step === "verify") commands.verifyDetails();
  };
  const ancestor = (choice: { rowId?: string }) => {
    if (!visit.isCurrent() || redeem.busy || bank.busyAction) return false;
    const index = pages.findIndex(page => page.id === choice.rowId);
    if (index < 0 || index >= pages.length - 2) return false;
    if (choice.rowId === "payouts") change(value => ({ ...value, panel: null, receipts: [] }));
    else if (choice.rowId === "payout-activity" || choice.rowId === "payout-stripe") change(value => ({ ...value, receipts: [] }));
    else {
      const target = NATIVE_PAYOUT_RECEIPT_PAGES.findIndex(id => id === choice.rowId);
      if (target < 0) return false;
      change(value => ({ ...value, receipts: value.receipts.slice(0, target + 1) }));
    }
    return true;
  };
  return { pages, rows: actions, back, ancestor, onPresented, nested: !!local.panel || local.receipts.length > 0, reset: () => change(() => initial()), busy: redeem.busy || bank.busyAction !== null };
}
