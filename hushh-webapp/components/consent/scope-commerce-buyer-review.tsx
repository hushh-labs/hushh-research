import Link from "next/link";
import { Button } from "@/components/ui/button";
import { formatCommerceMoney as money, type ScopeQuote } from "@/lib/services/scope-commerce-service";

export function ScopeCommerceBuyerReview({ quote, balance, expired, busy, enabled, reviewPrice, purchase }: {
  quote: ScopeQuote | null; balance: number | undefined; expired: boolean; busy: boolean; enabled: boolean;
  reviewPrice: () => Promise<void>; purchase: () => Promise<void>;
}) {
  const shortfall = quote && balance !== undefined ? Math.max(0, quote.amount_cents - balance) : null;
  return <div className="space-y-3">
    {!enabled ? <p role="status" className="text-sm">New paid purchases are unavailable. Review payment availability and existing funds in Account.</p> : null}
    {balance !== undefined ? <p className="text-sm">Available funded balance: {money(balance)}.</p> : <p role="status" className="text-sm">Refresh to check your balance before confirming.</p>}
    <Button disabled={busy || !enabled || expired} variant="outline" onClick={() => void reviewPrice()}>Review exact price</Button>
    {quote ? <div className="space-y-3 rounded-[var(--app-card-radius-feature)] border p-3">
      <p className="text-sm font-semibold">Total buyer price: {money(quote.amount_cents)}</p>
      <p className="text-sm">Approved access: {quote.duration_seconds / 3600} hours. Quote valid until <time dateTime={quote.expires_at}>{new Date(quote.expires_at).toLocaleString()}</time>.</p>
      {expired ? <p role="status" className="text-sm">Quote expired. Request access again so the owner can approve new terms.</p> : null}
      {shortfall !== null && shortfall > 0 ? <p role="status" className="text-sm">You need {money(shortfall)} more in your funded balance. Adding funds does not purchase this information.</p> : null}
      <p className="text-xs text-muted-foreground">Confirming reserves this amount from your funded balance. An agent cannot spend it for you. Access starts only after the owner prepares the information. Earlier owner revocation refunds unused calendar time; nonuse does not.</p>
      <Button disabled={busy || !enabled || expired || shortfall === null || shortfall > 0} onClick={() => void purchase()}>Confirm {quote.amount_cents === 0 ? "free access" : `${money(quote.amount_cents)} from balance`}</Button>
    </div> : null}
    <Link className="inline-flex min-h-11 items-center text-sm underline" href="/one/profile/account">Add funds or manage payments in Account</Link>
  </div>;
}
