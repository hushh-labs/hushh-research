"use client";

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useScopeCommerceAccount } from "@/components/consent/use-scope-commerce-account";
import { useScopeCommerceActivity } from "@/components/consent/scope-commerce-activity";
import { useAnswerPayoutAccountModel } from "@/components/consent/answer-payout-account";
import { parseCommerceReturn } from "@/lib/services/scope-commerce-return";
import { parseCommerceDollarInput, formatCommerceMoney as money, formatCommerceMicroUsd, commerceActivityStatusCopy, commerceWithdrawalStatusCopy, commerceReadinessCopy } from "@/lib/services/scope-commerce-service";
import { COMMERCE_SANDBOX_COPY } from "@/lib/services/scope-commerce-sandbox";
import { snapshotValidatedAuthSessionOwner, isValidatedAuthSessionOwnerCurrent } from "@/lib/auth/session-owner";
import { snapshotVaultSessionEpoch, isVaultSessionEpochCurrent } from "@/lib/vault/session-epoch";
import type { NativeDrawerRow, NativeDrawerSection, NativeProfilePage } from "@/lib/capacitor/native-drawers";
import { NativePaymentsEditor } from "./native-payments-editor";
import type { NativePaymentsScene } from "@/lib/capacitor/native-profile-payments-scene";
import { useNativePayouts } from "./use-native-payouts";

type Panel = "funding" | "payouts" | "refunds" | "history" | null;
/** Compose, never pool, information-access, Answer and document financial owners. */
export function useNativePayments(enabled: boolean, native: boolean, owner: string) {
  const pathname = usePathname(), query = useSearchParams(), router = useRouter();
  const answerReturn = parseCommerceReturn(`${pathname}?${query}`)?.source === "answers";
  const commerce = useScopeCommerceAccount({ active: enabled });
  const answer = useAnswerPayoutAccountModel(enabled && answerReturn);
  const document = useNativePayouts(native);
  const auth = snapshotValidatedAuthSessionOwner(), epoch = snapshotVaultSessionEpoch();
  const visit = useMemo(() => ({ enabled, owner, auth, epoch, live: false,
    handles: new Map<string, string>() }), [enabled, owner, auth?.generation, epoch]);
  const [admittedVisit, setAdmittedVisit] = useState<typeof visit>();
  const current = useCallback(() => visit.enabled && visit.live && !!visit.auth && isValidatedAuthSessionOwnerCurrent(visit.auth) && isVaultSessionEpochCurrent(visit.epoch), [visit]);
  const [stored, setStored] = useState<{ visit: typeof visit; panel: Panel; receipt: string | null; page: number; form: NativePaymentsScene | null }>();
  const local = stored?.visit === visit ? stored : { visit, panel: null, receipt: null, page: 0, form: null };
  const input = useRef<{ visit: typeof visit; scene: NativePaymentsScene; value: string; baseline: string; revision: number } | null>(null);
  useLayoutEffect(() => { visit.live = true; setAdmittedVisit(visit); return () => { visit.live = false; visit.handles.clear(); if (input.current?.visit === visit) input.current = null; }; }, [visit]);
  const change = (patch: Partial<Omit<typeof local, "visit">>) => { if (current()) setStored({ ...local, ...patch }); };
  const history = useScopeCommerceActivity(enabled && native && local.panel === "history");
  const rows = new Map<string, () => Promise<void>>();
  const handle = (key: string) => { let id = visit.handles.get(key); if (!id) { id = crypto.randomUUID(); visit.handles.set(key, id); } return id; };
  const read = (key: string, label: string, detail?: string): NativeDrawerRow => ({ id: handle(key), label, ...(detail ? { detail } : {}), enabled: true, readOnly: true });
  const action = (key: string, label: string, run: () => void | Promise<unknown>, disabled = false): NativeDrawerRow => {
    const id = handle(key); rows.set(id, async () => { if (current() && !disabled) await run(); }); return { id, label, enabled: admittedVisit === visit && !disabled, chevron: true };
  };
  const a = commerce.account;
  const commerceRows: NativeDrawerRow[] = [];
  if (commerce.message) commerceRows.push(read("commerce-message", commerce.message));
  if (a?.sandboxVerified === true) commerceRows.push(read("commerce-sandbox", COMMERCE_SANDBOX_COPY));
  if (a) {
    commerceRows.push(read("commerce-readiness", commerceReadinessCopy(a.readiness)));
    if (a.enabled === false && !a.managed_balances) commerceRows.push(read("commerce-disabled", "New purchases and funding are currently unavailable. Your sharing history remains below."));
    if (a.balance) {
      commerceRows.push(read("commerce-balance", "Purchase balance", money(a.balance.available_cents)), read("commerce-earnings", "Information-access earnings", money(a.earnings.available_cents)));
      for (const [key, label, cents] of [
        ["reserved", "Reserved for access", a.balance.reserved_cents], ["frozen", "Under payment review", a.balance.frozen_cents],
        ["pending", "Pending earnings", a.earnings.pending_cents], ["withdrawing", "Withdrawal in progress", a.earnings.withdrawing_cents], ["debt", "Unrecovered costs", a.earnings.debt_cents],
      ] as const) if (cents) commerceRows.push(read(`commerce-${key}`, label, money(cents)));
      commerceRows.push(action("commerce-funding", "Add funds", () => change({ panel: "funding", page: 0 })),
        action("commerce-payouts", a.seller.onboarded && a.seller.eligible ? "Withdraw information-access earnings" : "Set up information-access payouts", () => change({ panel: "payouts", page: 0 })));
      if (a.funding_lots.some(lot => lot.refundable_cents > 0)) commerceRows.push(action("commerce-refunds", "Refund unused balance", () => change({ panel: "refunds", page: 0 })));
    }
    commerceRows.push(action("commerce-history", "History", () => change({ panel: "history", page: 0 })), action("commerce-refresh", "Refresh payment status", commerce.refresh, commerce.busy));
  } else commerceRows.push(read("commerce-state", commerce.loading ? "Checking payment status…" : "Payment status unavailable"), action("commerce-retry", "Check payments", commerce.refresh, commerce.busy));
  if (commerce.hostedPending) commerceRows.push(read("commerce-hosted", "Complete Stripe in its secure window. Your One session stays here; payment status is checked when you return."), action("commerce-hosted-cancel", "Close Stripe window", commerce.cancelHosted));
  const answerRows: NativeDrawerRow[] = [];
  if (answerReturn) {
    if (answer.status.data?.payouts === false) answerRows.push(read("answer-disabled", "Answer payout setup opens once paid answers are switched on here. Approving still records the price; nothing is charged or paid out until then."));
    else answerRows.push(action("answer-manage", answer.action.busy || answer.hosted.hostedPending ? "Checking payout setup…" : "Manage answer payouts", answer.manage, !answer.status.user || answer.action.busy || answer.hosted.hostedPending),
      read("answer-fees", "Answer earnings deduct Hushh’s 3% fee and Stripe’s actual processing fee. Stripe verifies your identity and bank; you do not need a separate company."));
    if (answer.status.data?.stripeMode) answerRows.push(read("answer-mode", answer.status.data.stripeMode === "test" ? "Test payout setup. No real money moves." : "Live answer payout setup."));
    if (answer.action.message || answer.status.error) answerRows.push(read("answer-message", answer.action.message || answer.status.error!));
  }
  const root: NativeProfilePage = { id: "payouts", title: "Payments and earnings", sections: [
    { id: "commerce-section", title: "Information access", rows: commerceRows }, ...(answerReturn ? [{ id: "answer-section", title: "Answer payout setup", rows: answerRows }] : []),
    ...(document.pages[0]?.sections ?? []),
  ] };
  const pages: NativeProfilePage[] = [root];
  for (const [id, command] of document.rows) rows.set(id, async () => { await command(); });
  const busy = commerce.busy || answer.action.busy || document.busy;
  const openEditor = (scene: NativePaymentsScene) => {
    if (!current() || busy) return;
    const value = scene === "payment-funding" ? commerce.amount : commerce.country;
    input.current = { visit, scene, value, baseline: value, revision: 0 }; change({ form: scene });
  };
  if (local.panel === "funding") pages.push({ id: "commerce-funding", title: "Add funds", sections: [{ id: "commerce-funding-section", rows: [
    ...(a?.readiness?.capabilities.start_funding === true ? [action("commerce-amount", "Add to balance (USD)", () => openEditor("payment-funding"), busy), read("commerce-amount-value", "Amount", commerce.amount || "Not entered"),
      read("commerce-funding-policy", "$0.50–$1,000 per funding payment. Funding does not approve or buy access."), action("commerce-checkout", "Continue to secure checkout", commerce.checkout, busy)] :
      [read("commerce-funding-disabled", "Funding is unavailable. Check Payouts and History for existing activity, or Refund unused balance when funds are refundable.")]),
  ] }] });
  else if (local.panel === "payouts") {
    const ready = a?.seller.onboarded && a.seller.eligible, country = a?.seller.country || commerce.country;
    pages.push({ id: "commerce-payouts", title: "Information-access payouts", sections: [{ id: "commerce-payouts-section", rows: [
      read("commerce-payout-state", ready ? "Your payout account is ready." : "Complete payout setup before charging for information."),
      ...(ready ? [action("commerce-bank-manage", "Manage payout account", commerce.managePayoutAccount, busy)] : [
        read("commerce-payout-provider", "Stripe verifies your individual identity, payout method and earning activity. No company is required. Stripe tool access is separate."),
        read("commerce-payout-return", commerce.onboardingRefresh ? "Your payout setup link expired. Get a new authenticated link to continue." : "Continue here if your setup link expires."),
        action("commerce-country", `Payout country · ${country}`, () => openEditor("payment-country"), busy || !!a?.seller.country),
        action("commerce-onboarding", commerce.onboardingRefresh ? "Get a new payout setup link" : a?.seller.onboarded ? "Continue payout setup with Stripe" : "Set up payouts with Stripe", commerce.onboarding,
          busy || a?.readiness?.capabilities.start_onboarding !== true || !/^[A-Z]{2}$/.test(country)),
      ]),
      read("commerce-maturity", "Pending earnings mature when access ends. Early revocation refunds unused time; nonreturned costs may create debt."),
      ...(a ? [read("commerce-minimum", `Country eligibility and payout costs are checked before withdrawal. Minimum net payout: ${money(a.payout.minimum_net_cents)}.`),
        action("commerce-withdraw", "Review withdrawal", commerce.withdrawal, busy || !ready || a.earnings.available_cents <= 0)] : []),
      ...(a?.recent_withdrawals ?? []).slice(effectivePage(a?.recent_withdrawals?.length ?? 0) * 30, (effectivePage(a?.recent_withdrawals?.length ?? 0) + 1) * 30).flatMap((item, index) => [read(`commerce-withdrawal-${index}`, money(item.net_cents),
        `${commerceWithdrawalStatusCopy(item.status)} · ${new Date(item.created_at).toLocaleString()} · ${item.fees_final ? "Final" : "Reserved"} costs: ${formatCommerceMicroUsd(item.fee_micro_usd)}`)]),
      ...pageControls((a?.recent_withdrawals ?? []).length),
    ] }] });
  } else if (local.panel === "refunds") {
    const lots = a?.funding_lots.filter(lot => lot.refundable_cents > 0) ?? [];
    pages.push({ id: "commerce-refunds", title: "Refund unused balance", sections: [{ id: "commerce-refund-section", rows: [read("commerce-refund-policy", "Returns to the original payment method."),
      ...lots.slice(effectivePage(lots.length) * 30, (effectivePage(lots.length) + 1) * 30).map(lot => action(`commerce-lot-${lot.id}`, `Review refund of ${money(lot.refundable_cents)}`, () => commerce.refund(lot.id, lot.refundable_cents), busy)), ...pageControls(lots.length),
    ] }] });
  } else if (local.panel === "history") {
    const options = (["purchases", "sales", "transactions"] as const).map(value => {
      const row = action(`commerce-history-${value}`, value[0]!.toUpperCase() + value.slice(1), () => { history.changeView(value); change({ page: 0, receipt: null }); });
      return { id: row.id, label: row.label, selected: history.view === value };
    });
    pages.push({ id: "commerce-history", title: "History", sections: [{ id: "commerce-history-section", rows: [
      { id: handle("commerce-history-tabs"), label: "Payment history", enabled: true, options },
      ...(history.error || history.moreError ? [read("commerce-history-error", history.error || history.moreError!)] : []),
      ...(!history.data && history.loading ? [read("commerce-history-loading", "Checking payment history…")] : []),
      ...(history.data && !history.items.length ? [read("commerce-history-empty", `No ${history.view} yet.`)] : []),
      ...(history.extra ? [read("commerce-history-older", "Showing older entries. Refresh returns to the latest activity.")] : []),
      ...history.items.slice(effectivePage(history.items.length) * 30, (effectivePage(history.items.length) + 1) * 30).map(item => ({ ...action(`commerce-history-item-${item.id}`, item.scope_label || item.kind.replaceAll("_", " "), () => change({ receipt: item.id })),
        detail: [item.counterpart?.label, commerceActivityStatusCopy(item.kind, item.status), money(item.amount_cents)].filter(Boolean).join(" · ") })),
      ...pageControls(history.items.length),
      ...(history.nextCursor ? [action("commerce-history-more", `Load more ${history.view}`, history.loadMore, history.loading || history.loadingMore)] : []),
      action("commerce-history-refresh", `Refresh ${history.view}`, () => { change({ page: 0, receipt: null }); return history.refresh(); }, history.loading || history.loadingMore),
    ] }] });
    const receipt = history.items.find(item => item.id === local.receipt);
    if (local.receipt) pages.push({ id: "commerce-receipt", title: "Receipt", sections: [{ id: "commerce-receipt-section", rows: receipt ? [
      read("commerce-receipt-status", commerceActivityStatusCopy(receipt.kind, receipt.status)), read("commerce-receipt-amount", receipt.direction === "incoming" ? "Incoming" : receipt.direction === "outgoing" ? "Outgoing" : "Amount", money(receipt.amount_cents)),
      ...(receipt.purchase_id ? [read("commerce-receipt-gross", "Gross agreed price", money(receipt.gross_cents))] : []),
      ...([['processing_fee_micro_usd', "Attributed processing costs"], ['net_earnings_micro_usd', "Net earnings"]] as const).flatMap(([key, label]) => receipt[key] !== null ? [read(`commerce-receipt-${key}`, label, formatCommerceMicroUsd(receipt[key]!))] : []),
      ...(receipt.refunded_cents !== null ? [read("commerce-receipt-refund", "Refunded", money(receipt.refunded_cents))] : []),
      ...([['created_at', "Created"], ['fulfillment_deadline', "Prepare by"], ['activation_at', "Access starts"], ['expires_at', "Access ends"], ['matures_at', "Earnings mature"]] as const)
        .flatMap(([key, label]) => receipt[key] ? [read(`commerce-receipt-${key}`, label, new Date(receipt[key]!).toLocaleString())] : []),
      ...(receipt.next_action ? [action("commerce-receipt-next", receipt.next_action.label, () => router.push(receipt.next_action!.href))] : []),
    ] : [read("commerce-receipt-unavailable", "Receipt unavailable. Go back and refresh History.")] }] });
  } else pages.push(...document.pages.slice(1));
  if (commerce.review) {
    const review = commerce.review, p = review.preview;
    pages.push({ id: "commerce-review", title: review.kind === "withdraw" ? "Confirm withdrawal" : "Confirm balance refund", sections: [{ id: "commerce-review-section", rows: [
      read("commerce-review-terms", `Amount ${money(p.amount_cents)}. ${review.kind === "withdraw" ? "Estimated processing cost reserve" : "Refund processing costs"} ${money(p.fee_cents)}. You receive ${money(p.net_cents)}.`,
        `${review.kind === "withdraw" ? "Final costs are reconciled from provider receipts." : "The refund returns to your original payment method."} ${p.blocked_reason || "Review these costs before continuing."}`),
      ...(a?.sandboxVerified === true ? [read("commerce-review-sandbox", COMMERCE_SANDBOX_COPY)] : []),
      action("commerce-review-cancel", "Cancel", commerce.closeReview, busy), action("commerce-review-confirm", `Confirm ${review.kind === "withdraw" ? "withdrawal" : "refund"}`, commerce.confirmTransfer, busy || !!p.blocked_reason),
    ] }] });
  }
  function effectivePage(length: number) { return Math.min(local.page, Math.max(0, Math.ceil(length / 30) - 1)); }
  function pageControls(length: number) { const page = effectivePage(length); return [...(page > 0 ? [action("commerce-page-previous", "Previous", () => change({ page: page - 1 }))] : []),
    ...((page + 1) * 30 < length ? [action("commerce-page-next", "More", () => change({ page: page + 1 }))] : [])]; }
  const closeEditor = (restore: boolean) => {
    const field = input.current;
    if (!current() || busy || !field || field.visit !== visit) return;
    if (!restore) { if (field.scene === "payment-funding") commerce.changeAmount(field.value); else commerce.changeCountry(field.value); }
    input.current = null; change({ form: null });
  };
  const back = () => {
    if (busy) return true;
    if (commerce.review) { commerce.closeReview(); return true; }
    if (local.form) { closeEditor(true); return true; }
    if (local.receipt) { change({ receipt: null }); return true; }
    if (local.panel) { change({ panel: null, page: 0 }); return true; }
    return document.back();
  };
  const reset = () => { if (busy) return false; commerce.closeReview(); closeEditor(true); change({ panel: null, receipt: null, page: 0, form: null }); document.reset(); return true; };
  const field = input.current?.visit === visit ? input.current : null;
  const validValue = () => { if (!field) return false; if (field.scene === "payment-country") return /^[A-Z]{2}$/.test(field.value); try { parseCommerceDollarInput(field.value, 50); return true; } catch { return false; } };
  if (commerce.message && pages.length > 1) {
    const last = pages.at(-1)!;
    pages[pages.length - 1] = { ...last, sections: [...last.sections, { id: "payments-operation-state", rows: [read("payments-operation-message", commerce.message)] }] };
  }
  if (commerce.hostedPending && pages.length > 1) {
    const last = pages.at(-1)!;
    pages[pages.length - 1] = { ...last, sections: [...last.sections, { id: "payments-hosted-state", rows: [
      read("payments-hosted-message", "Complete Stripe in its secure window. Your One session stays here."), action("payments-hosted-cancel", "Close Stripe window", commerce.cancelHosted),
    ] }] };
  }
  const presentedPages = busy ? pages.map(page => ({ ...page, sections: page.sections.map(section => ({ ...section,
    rows: section.rows.map(row => row.readOnly || [handle("commerce-hosted-cancel"), handle("payments-hosted-cancel")].includes(row.id) ? row : { ...row, enabled: false }) })) })) : pages;
  return { commerce, answer, pages: presentedPages, rows, busy, nested: pages.length > 1, back, reset,
    onPresented: () => { if (!local.panel && !commerce.review && !local.form) document.onPresented(); },
    ancestor: (choice: { rowId?: string }) => { if (busy) return false; if (choice.rowId === "payouts") return reset(); return document.ancestor(choice); },
    formScene: local.form,
    editor: (destinationId: string, onFallback: () => void) => field && local.form ? <NativePaymentsEditor owner={owner} destinationId={destinationId} scene={local.form}
      onClose={() => closeEditor(true)} onSaved={() => closeEditor(false)} onFallback={onFallback} model={{ current,
        draft: { value: field.value }, inputRevision: () => field.revision, mutationPending: () => busy, busy, canSave: validValue(), error: null,
        changeDraft: (draft, expected) => {
          if (!current() || busy || input.current !== field || expected !== undefined && expected !== field.revision || typeof draft.value !== "string" || draft.value.length > (field.scene === "payment-country" ? 2 : 64)) return false;
          field.value = field.scene === "payment-country" ? draft.value.toUpperCase() : draft.value; field.revision++;
          change({ form: field.scene });
          return true;
        }, save: async () => current() && !busy && validValue(),
      }} /> : null,
  };
}
