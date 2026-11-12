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
    {balance !== undefined ? <p data-consent-role="body" className="text-sm tabular-nums">Available funded balance: {money(balance)}.</p> : <p data-consent-role="status" role="status" className="text-sm">Refresh to check your balance before confirming.</p>}
    {!quote ? <Button data-consent-role="compact-action" disabled={busy || !enabled} variant="outline" data-consent-quiet-action="true" onClick={() => void reviewPrice()}>Review exact price</Button> : null}
    {quote ? <div className="space-y-3">
      <p data-consent-role="row-title" className="text-sm font-semibold tabular-nums">Total buyer price: {money(quote.amount_cents)}</p>
      <p data-consent-role="body" className="text-sm tabular-nums">Approved access: {quote.duration_seconds / 3600} hours. Quote valid until <time dateTime={quote.expires_at}>{new Date(quote.expires_at).toLocaleString()}</time>.</p>
      {expired ? <p data-consent-role="status" role="status" className="text-sm">Quote expired. Request access again so the owner can approve new terms.</p> : null}
      {shortfall !== null && shortfall > 0 ? <p data-consent-role="status" role="status" className="text-sm">You need {money(shortfall)} more in your funded balance. Adding funds does not purchase this information.</p> : null}
      <p data-consent-role="disclosure" className="text-xs text-muted-foreground">Confirming reserves this amount from your funded balance. An agent cannot spend it for you. Access starts only after the owner prepares the information. Earlier owner revocation refunds unused calendar time; nonuse does not.</p>
      <Button data-consent-role="primary-action" disabled={busy || !enabled || expired || shortfall === null || shortfall > 0} onClick={() => void purchase()}>Confirm {quote.amount_cents === 0 ? "free access" : `${money(quote.amount_cents)} from balance`}</Button>
    </div> : null}
    {enabled && ((shortfall !== null && shortfall > 0) || funding.hostedPending) ? <section aria-label="Fund this sharing request" className="space-y-3">
      {funding.account?.sandboxVerified === true ? <p data-consent-role="status" role="status" className="text-sm">{COMMERCE_SANDBOX_COPY}</p> : null}
      {funding.message ? <p data-consent-role="status" role="status" className="text-sm">{funding.message}</p> : null}
      {funding.hostedPending ? <>
        <p data-consent-role="status" role="status" className="text-sm">Complete Stripe in its secure window, then return here to confirm the exact price.</p>
        <Button data-consent-role="compact-action" variant="ghost" onClick={funding.cancelHosted}>Close Stripe window</Button>
      </> : funding.loading ? <p data-consent-role="status" role="status" className="text-sm">Checking funding availability…</p> : <CommerceFundingControls
        enabled={!expired && funding.account?.readiness?.capabilities.start_funding === true}
        busy={busy} amount={funding.amount} changeAmount={funding.changeAmount} checkout={checkout} />}
    </section> : null}
  </div>;
}
