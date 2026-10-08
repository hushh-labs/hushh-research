"use client";

import { Button } from "@/components/ui/button";
import { SettingsGroup } from "@/components/app-ui/settings-ui";
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from "@/components/ui/alert-dialog";
import { formatCommerceMoney as money, formatCommerceMicroUsd, commerceWithdrawalStatusCopy, commerceReadinessCopy } from "@/lib/services/scope-commerce-service";
import { ScopeCommerceActivity } from "@/components/consent/scope-commerce-activity";
import { CommerceBalanceSummary, CommerceFundingControls, CommercePayoutControls } from "@/components/consent/scope-commerce-account-controls";
import { useScopeCommerceAccount } from "@/components/consent/use-scope-commerce-account";

/** Account-level funds and earning controls; every movement requires a human gesture. */
export function ScopeCommerceAccountPanel() {
  const state = useScopeCommerceAccount();
  const { user, account, busy, message, review } = state;
  if (!user) return null;
  return <SettingsGroup title="Payments and earnings" description="1 USD = 100 Hussh coins. Fund your balance to pay for approved information.">
    <div className="space-y-4 px-4 py-3">
      {message ? <p role="status" className="text-sm">{message}</p> : null}
      {account ? <p role="status" className="text-sm">{commerceReadinessCopy(account.readiness)}</p> : null}
      {account?.enabled === false && !account.managed_balances ? <p role="status" className="text-sm">New purchases and funding are currently unavailable. Your sharing history remains below.</p> : null}
      {!account ? <Button variant="outline" disabled={busy} onClick={() => void state.refresh()}>Check payments</Button> : <>
        {account.balance ? <>
        <CommerceBalanceSummary account={account} />
        <CommerceFundingControls enabled={account.readiness?.capabilities.start_funding === true} busy={busy} amount={state.amount} changeAmount={state.changeAmount} checkout={() => void state.checkout()} />
        <CommercePayoutControls account={account} busy={busy} country={state.country} changeCountry={state.changeCountry} expiredLink={state.onboardingRefresh}
          onboarding={() => void state.onboarding()} withdrawal={() => void state.withdrawal()} />
        {account.funding_lots.some(lot => lot.refundable_cents > 0) ? <div className="space-y-2 border-t pt-4">
          <p className="text-sm">Refund unused balance to its original payment method</p>
          {account.funding_lots.filter(lot => lot.refundable_cents > 0).map(lot => <Button key={lot.id} variant="outline" disabled={busy} onClick={() => void state.refund(lot.id, lot.refundable_cents)}>Review refund of {money(lot.refundable_cents)}</Button>)}
        </div> : null}
        </> : null}
        <ScopeCommerceActivity key={user.uid} />
        {account.recent_withdrawals?.length ? <div className="space-y-3 border-t pt-4">
          <p className="text-sm font-medium">Recent withdrawals</p>
          {account.recent_withdrawals.map(withdrawal => <div key={withdrawal.id} className="space-y-1 text-sm">
            <p>{money(withdrawal.net_cents)} · {new Date(withdrawal.created_at).toLocaleString()}</p>
            <p role="status">{commerceWithdrawalStatusCopy(withdrawal.status)}</p>
            <p className="text-xs text-muted-foreground">{withdrawal.fees_final ? "Final" : "Current attributed"} costs: {formatCommerceMicroUsd(withdrawal.fee_micro_usd)}.</p>
          </div>)}
        </div> : null}
        <Button variant="ghost" disabled={busy} onClick={() => void state.refresh()}>Refresh payment status</Button>
      </>}
    </div>
    <AlertDialog open={Boolean(review)} onOpenChange={open => { if (!open) state.closeReview(); }}>
      <AlertDialogContent><AlertDialogHeader>
        <AlertDialogTitle>{review?.kind === "withdraw" ? "Confirm withdrawal" : "Confirm balance refund"}</AlertDialogTitle>
        <AlertDialogDescription>{review ? <>Amount {money(review.preview.amount_cents)}. Processing costs {money(review.preview.fee_cents)}. You receive {money(review.preview.net_cents)}. {review.preview.blocked_reason || "Review these costs before continuing."}</> : null}</AlertDialogDescription>
      </AlertDialogHeader><AlertDialogFooter>
        <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
        <AlertDialogAction disabled={busy || Boolean(review?.preview.blocked_reason)} onClick={event => {
          event.preventDefault();
          if (!review) return;
          void state.confirmTransfer();
        }}>Confirm {review?.kind === "withdraw" ? "withdrawal" : "refund"}</AlertDialogAction>
      </AlertDialogFooter></AlertDialogContent>
    </AlertDialog>
  </SettingsGroup>;
}
