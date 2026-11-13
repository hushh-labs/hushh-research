"use client";

import { CommerceFundingControls } from "./scope-commerce-account-controls";
import { useScopeCommerceAccount } from "./use-scope-commerce-account";
import { useCommerceSession } from "./use-commerce-session";
import { COMMERCE_SANDBOX_COPY } from "@/lib/services/scope-commerce-sandbox";
import { Button } from "@/components/ui/button";
import { formatCommerceMoney as money, type ScopeQuote } from "@/lib/services/scope-commerce-service";

export function ScopeCommerceBuyerReview({ requestId, refreshRequest, quote, balance, expired, busy: requestBusy, enabled, reviewPrice, purchase }: {
  requestId: string; refreshRequest: () => Promise<void>;
  quote: ScopeQuote | null; balance: number | undefined; expired: boolean; busy: boolean; enabled: boolean;
  reviewPrice: () => Promise<void>; purchase: () => Promise<void>;
}) {
  const funding = useScopeCommerceAccount({ active: enabled });
  const { capture } = useCommerceSession(`request-funding:${requestId}`, enabled);
  const busy = requestBusy || funding.busy || funding.hostedPending;
  const checkout = () => {
    const current = capture();
    void funding.checkout()?.then(async () => { if (current()) await refreshRequest(); });
  };
  const shortfall = quote && balance !== undefined ? Math.max(0, quote.amount_cents - balance) : null;
  return <div className="space-y-3">
    {balance !== undefined ? <p data-consent-role="body" className="text-sm tabular-nums">Your balance: {money(balance)}</p> : <p data-consent-role="status" role="status" className="text-sm">Check your balance before confirming.</p>}
    {!quote ? <Button data-consent-role="compact-action" disabled={busy || !enabled} variant="outline" data-consent-quiet-action="true" onClick={() => void reviewPrice()}>Review price</Button> : null}
    {quote ? <div className="space-y-3">
      <p data-consent-role="row-title" className="text-sm font-semibold tabular-nums">{money(quote.amount_cents)} for {quote.duration_seconds / 3600} hours</p>
      <p data-consent-role="body" className="text-sm tabular-nums">Confirm by <time dateTime={quote.expires_at}>{new Date(quote.expires_at).toLocaleString()}</time>.</p>
      {expired ? <p data-consent-role="status" role="status" className="text-sm">Price expired. Request access again for a new approval.</p> : null}
      {shortfall !== null && shortfall > 0 ? <p data-consent-role="status" role="status" className="text-sm">You need {money(shortfall)} more to continue.</p> : null}
      <p data-consent-role="disclosure" className="text-xs text-muted-foreground">This reserves funds from your balance. Access starts after the owner shares. If they end access early, unused time is refunded. Not using access isn't refundable.</p>
      <Button data-consent-role="primary-action" disabled={busy || !enabled || expired || shortfall === null || shortfall > 0} onClick={() => void purchase()}>Confirm {quote.amount_cents === 0 ? "free access" : `${money(quote.amount_cents)} from balance`}</Button>
    </div> : null}
    {enabled && ((shortfall !== null && shortfall > 0) || funding.hostedPending) ? <section aria-label="Fund this sharing request" className="space-y-3">
      {funding.account?.sandboxVerified === true ? <p data-consent-role="status" role="status" className="text-sm">{COMMERCE_SANDBOX_COPY}</p> : null}
      {funding.message ? <p data-consent-role="status" role="status" className="text-sm">{funding.message}</p> : null}
      {funding.hostedPending ? <>
        <p data-consent-role="status" role="status" className="text-sm">Finish checkout in Stripe, then return here to confirm access.</p>
        <Button data-consent-role="compact-action" variant="ghost" onClick={funding.cancelHosted}>Close Stripe window</Button>
      </> : funding.loading ? <p data-consent-role="status" role="status" className="text-sm">Checking payments…</p> : <CommerceFundingControls
        enabled={!expired && funding.account?.readiness?.capabilities.start_funding === true}
        busy={busy} amount={funding.amount} changeAmount={funding.changeAmount} checkout={checkout} />}
    </section> : null}
  </div>;
}
