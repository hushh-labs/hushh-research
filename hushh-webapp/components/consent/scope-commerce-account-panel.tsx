"use client";

import { useEffect, useState } from "react";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { useCommerceAccountBackLayer } from "@/components/consent/use-commerce-session";

import { Button } from "@/components/ui/button";
import { SettingsGroup } from "@/components/app-ui/settings-ui";
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from "@/components/ui/alert-dialog";
import { formatCommerceMoney as money, formatCommerceMicroUsd, commerceWithdrawalStatusCopy, commerceReadinessCopy } from "@/lib/services/scope-commerce-service";
import { ScopeCommerceActivity } from "@/components/consent/scope-commerce-activity";
import { CommerceBalanceSummary, CommerceFundingControls, CommercePayoutControls } from "@/components/consent/scope-commerce-account-controls";
import { useScopeCommerceAccount } from "@/components/consent/use-scope-commerce-account";
import { COMMERCE_SANDBOX_COPY } from "@/lib/services/scope-commerce-sandbox";

/** Account-level funds and earning controls; every movement requires a human gesture. */
export function ScopeCommerceAccountPanel() {
  const state = useScopeCommerceAccount();
  const { user, account, busy, message, review } = state;
  const userId = user?.uid;
  const [expanded, setExpanded] = useState({ owner: user?.uid, value: state.onboardingRefresh ? "payouts" : "" });
  useEffect(() => { if (state.onboardingRefresh && userId) setExpanded({ owner: userId, value: "payouts" }); }, [state.onboardingRefresh, userId]);
  const section = expanded.owner === user?.uid ? expanded.value : "";
  useCommerceAccountBackLayer(section ? 1 : 0, () => {
    setExpanded({ owner: user?.uid, value: "" });
    return true;
  });
  if (!user) return null;
  return <SettingsGroup title="Information access" description="Purchase balance and earnings from sharing your information." className="consent-presentation-surface">
    <div className="space-y-4 px-4 py-3" data-consent-presentation="profile-payments">
      {message ? <p data-consent-role="status" role="status" className="text-sm">{message}</p> : null}
      {state.hostedPending ? <div className="space-y-2">
        <p data-consent-role="status" role="status" className="text-sm">Complete Stripe in its secure window. Your One session stays here; payment status is checked when you return.</p>
        <Button data-consent-role="compact-action" variant="ghost" data-consent-quiet-action="true" onClick={state.cancelHosted}>Close Stripe window</Button>
      </div> : null}
      {account?.sandboxVerified === true ? <p data-consent-role="status" role="status" className="text-sm">{COMMERCE_SANDBOX_COPY}</p> : null}
      {account ? <p data-consent-role="status" role="status" className="text-sm">{commerceReadinessCopy(account.readiness)}</p> : null}
      {account?.enabled === false && !account.managed_balances ? <p data-consent-role="status" role="status" className="text-sm">New purchases and funding are currently unavailable. Your sharing history remains below.</p> : null}
      {!account ? <Button data-consent-role="compact-action" variant="outline" data-consent-quiet-action="true" disabled={busy} onClick={() => void state.refresh()}>Check payments</Button> : <>
        {account.balance ? <CommerceBalanceSummary account={account} /> : null}
        <Accordion type="single" collapsible value={section} onValueChange={value => setExpanded({ owner: user.uid, value })}>
          {account.balance ? <>
            <AccordionItem value="funding"><AccordionTrigger>Add funds</AccordionTrigger><AccordionContent>
              <CommerceFundingControls enabled={account.readiness?.capabilities.start_funding === true} busy={busy} amount={state.amount} changeAmount={state.changeAmount} checkout={() => void state.checkout()} />
            </AccordionContent></AccordionItem>
            <AccordionItem value="payouts"><AccordionTrigger>{account.seller.onboarded && account.seller.eligible ? "Withdraw information-access earnings" : "Set up information-access payouts"}</AccordionTrigger><AccordionContent>
              <CommercePayoutControls account={account} busy={busy} country={state.country} changeCountry={state.changeCountry} expiredLink={state.onboardingRefresh}
                onboarding={() => void state.onboarding()} management={() => void state.managePayoutAccount()} withdrawal={() => void state.withdrawal()} />
              {account.recent_withdrawals?.length ? <div className="space-y-3 pt-4">
                <p data-consent-role="secondary-heading" className="text-sm font-medium">Recent withdrawals</p>
                {account.recent_withdrawals.map(withdrawal => <div key={withdrawal.id} className="space-y-1 text-sm">
                  <p data-consent-role="body" className="tabular-nums">{money(withdrawal.net_cents)} · {new Date(withdrawal.created_at).toLocaleString()}</p>
                  <p data-consent-role="status" role="status">{commerceWithdrawalStatusCopy(withdrawal.status)}</p>
                  <p data-consent-role="helper" className="text-xs text-muted-foreground">{withdrawal.fees_final ? "Final" : "Reserved"} costs: {formatCommerceMicroUsd(withdrawal.fee_micro_usd)}.</p>
                </div>)}
              </div> : null}
            </AccordionContent></AccordionItem>
            {account.funding_lots.some(lot => lot.refundable_cents > 0) ? <AccordionItem value="refunds"><AccordionTrigger>Refund unused balance</AccordionTrigger><AccordionContent className="space-y-2">
              <p data-consent-role="body" className="text-sm text-muted-foreground">Returns to the original payment method.</p>
              {account.funding_lots.filter(lot => lot.refundable_cents > 0).map(lot => <Button data-consent-role="compact-action" key={lot.id} variant="outline" data-consent-quiet-action="true" disabled={busy} onClick={() => void state.refund(lot.id, lot.refundable_cents)}>Review refund of {money(lot.refundable_cents)}</Button>)}
            </AccordionContent></AccordionItem> : null}
          </> : null}
          <AccordionItem value="history"><AccordionTrigger>History</AccordionTrigger><AccordionContent>
            <ScopeCommerceActivity key={user.uid} />
          </AccordionContent></AccordionItem>
        </Accordion>
        <Button data-consent-role="compact-action" variant="ghost" data-consent-quiet-action="true" disabled={busy} onClick={() => void state.refresh()}>Refresh payment status</Button>
      </>}
    </div>
    <AlertDialog open={Boolean(review)} onOpenChange={open => { if (!open) state.closeReview(); }}>
      <AlertDialogContent className="consent-presentation-surface"><AlertDialogHeader>
        <AlertDialogTitle>{review?.kind === "withdraw" ? "Confirm withdrawal" : "Confirm balance refund"}</AlertDialogTitle>
        <AlertDialogDescription>{review ? <>
          Amount {money(review.preview.amount_cents)}. {review.kind === "withdraw" ? "Estimated processing cost reserve" : "Refund processing costs"} {money(review.preview.fee_cents)}. You receive {money(review.preview.net_cents)}.
          {review.kind === "withdraw" ? " Final costs are reconciled from provider receipts." : " The refund returns to your original payment method."}
          {" "}{review.preview.blocked_reason || "Review these costs before continuing."}
          {account?.sandboxVerified === true ? ` ${COMMERCE_SANDBOX_COPY}` : ""}
        </> : null}</AlertDialogDescription>
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
