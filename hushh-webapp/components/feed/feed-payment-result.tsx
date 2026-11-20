"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import dynamic from "next/dynamic";
import { useAuth } from "@/hooks/use-auth";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { Button } from "@/components/ui/button";
import { EarningReceiptSections } from "@/components/consent/payouts/receipts/receipt-sections";
import { receiptHeader } from "@/components/consent/payouts/receipts/payout-receipt-sheet";
import { formatPaymentMoney } from "@/lib/consent/document-request-payment-view";
import type { FeedPaymentSelection } from "@/lib/feed/payment-result-selection";
import { DocumentRequestPaymentSourceService, type DocumentRequestPayment } from "@/lib/services/document-request-payment-source-service";
import { PayoutActivityService, type EarningReceipt } from "@/lib/services/payout-activity-service";
import { snapshotVaultSessionEpoch, subscribeVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { useVault } from "@/lib/vault/vault-context";

const VaultUnlockDialog = dynamic(() => import("@/components/vault/vault-unlock-dialog").then(module => module.VaultUnlockDialog), { ssr: false });
type Receipt = { payment: DocumentRequestPayment; earning?: never } | { earning: EarningReceipt; payment?: never };
type Result = { key: string; epoch: number; receipt?: Receipt; failed?: boolean };

function paymentStatus(payment: DocumentRequestPayment): string {
  if (payment.reconciliationRequired) return "Payment under review";
  if (payment.status === "refunded" || payment.refundStatus === "succeeded") return payment.refundAmountCents !== null && payment.refundAmountCents < payment.amountCents ? "Partly refunded" : "Refunded";
  if (payment.refundStatus && payment.refundStatus !== "failed") return "Refund pending";
  return { awaiting_payment: "Unpaid", checkout_open: "Unpaid", paid: "Payment confirmed", refunded: "Refunded", expired: "Payment expired" }[payment.status];
}

/** Read-only source receipts. Opening a search result never pays, reconciles,
 * withdraws, or substitutes the Feed's recorded copy for a missing receipt. */
export function FeedPaymentResult({ selection, isCurrent }: { selection: FeedPaymentSelection; isCurrent: () => boolean }) {
  const { user, userId, loading: authLoading, sessionVerificationRequired } = useAuth();
  const vault = useVault();
  const vaultRef = useRef(vault);
  useLayoutEffect(() => { vaultRef.current = vault; }, [vault]);
  const epoch = useSyncExternalStore(subscribeVaultSessionEpoch, snapshotVaultSessionEpoch, () => 0);
  const token = vault.vaultOwnerToken;
  const owner = !authLoading && !sessionVerificationRequired ? userId : null;
  const key = `${owner}:${token}:${selection.audience}:${selection.requestId}`;
  const episode = useRef(0);
  const invalidate = useCallback(() => { episode.current++; }, []);
  const [state, setState] = useState<Result | null>(null);
  const [retry, setRetry] = useState(0);
  const [unlock, setUnlock] = useState(false);
  useEffect(() => {
    const request = ++episode.current;
    const current = () => request === episode.current && isCurrent() && snapshotVaultSessionEpoch() === epoch && vaultRef.current.getVaultOwnerToken() === token;
    if (!token || !owner) return;
    void (async () => {
      try {
        let receipt: Receipt;
        if (selection.audience === "owner") {
          const earning = await PayoutActivityService.item(token, `earning:${selection.requestId}`);
          if (earning.kind !== "earning" || !earning.mode || earning.request && earning.request.id !== selection.requestId) throw new Error("Receipt unavailable");
          receipt = { earning };
        } else {
          const snapshot = await DocumentRequestPaymentSourceService.snapshot(token, owner);
          const payment = snapshot.find(row => row.requestId === selection.requestId);
          if (!payment) throw new Error("Receipt unavailable");
          receipt = { payment };
        }
        if (current()) setState({ key, epoch, receipt });
      } catch { if (current()) setState({ key, epoch, failed: true }); }
    })();
    return invalidate;
  }, [token, owner, selection.audience, selection.requestId, key, epoch, retry, isCurrent, invalidate]);
  const visible = state?.key === key && state.epoch === epoch && isCurrent() ? state : null;
  if (!token) return <><Button variant="secondary" onClick={() => setUnlock(true)}>Unlock to view</Button>
    {user && unlock ? <VaultUnlockDialog user={user} open onOpenChange={setUnlock} onSuccess={() => setUnlock(false)} allowVaultCreation={false} title="Unlock your vault" description="View this receipt securely." /> : null}</>;
  if (!owner || visible?.failed) return <div className="space-y-2"><p role="status" className="text-sm text-muted-foreground">Receipt unavailable</p><Button variant="ghost" onClick={() => setRetry(value => value + 1)}>Try again</Button></div>;
  if (!visible?.receipt) return <p role="status" className="text-sm text-muted-foreground">Checking receipt…</p>;
  const { earning, payment } = visible.receipt;
  if (earning) return <div className="space-y-3"><p className="text-sm">{receiptHeader(earning, false).description}</p><EarningReceiptSections receipt={earning} openItem={() => undefined} /></div>;
  return <SettingsGroup>
    <SettingsRow title={paymentStatus(payment)} trailing={formatPaymentMoney(payment.amountCents)} />
    <SettingsRow title="Mode" trailing={payment.mode === "test" ? "Test payment" : payment.mode === "live" ? "Live payment" : "Legacy record"} />
    {payment.paidAt ? <SettingsRow title="Paid" trailing={new Date(payment.paidAt).toLocaleString()} /> : null}
    {payment.refundAmountCents !== null ? <SettingsRow title="Refund" trailing={formatPaymentMoney(payment.refundAmountCents)} /> : null}
  </SettingsGroup>;
}
