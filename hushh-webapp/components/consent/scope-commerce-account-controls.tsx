import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { formatCommerceMoney as money, type CommerceAccount } from "@/lib/services/scope-commerce-service";

export function CommerceBalanceSummary({ account }: { account: CommerceAccount }) {
  return <>
    <dl className="grid grid-cols-2 gap-2 text-sm">
      <dt>Purchase balance</dt><dd>{money(account.balance.available_cents)}</dd>
      {account.balance.reserved_cents ? <><dt>Reserved for access</dt><dd>{money(account.balance.reserved_cents)}</dd></> : null}
      {account.balance.frozen_cents ? <><dt>Under payment review</dt><dd>{money(account.balance.frozen_cents)}</dd></> : null}
      <dt>Information-access earnings</dt><dd>{money(account.earnings.available_cents)}</dd>
      {account.earnings.pending_cents ? <><dt>Pending earnings</dt><dd>{money(account.earnings.pending_cents)}</dd></> : null}
      {account.earnings.withdrawing_cents ? <><dt>Withdrawal in progress</dt><dd>{money(account.earnings.withdrawing_cents)}</dd></> : null}
      {account.earnings.debt_cents ? <><dt>Unrecovered costs</dt><dd>{money(account.earnings.debt_cents)}</dd></> : null}
    </dl>
  </>;
}

export function CommerceFundingControls({ enabled, busy, amount, changeAmount, checkout }: {
  enabled: boolean; busy: boolean; amount: string; changeAmount: (value: string) => void; checkout: () => void;
}) {
  if (!enabled) return <p className="text-xs text-muted-foreground">Funding is unavailable. Check Payouts and History for existing activity, or Refund unused balance when funds are refundable.</p>;
  return <div className="space-y-[var(--app-form-related-gap)]">
    <label className="block space-y-[var(--app-form-field-gap)] text-sm">Add to balance (USD)
      <Input inputMode="decimal" value={amount} onChange={event => changeAmount(event.target.value)} disabled={busy} />
    </label>
    <p className="text-xs text-muted-foreground">$0.50–$1,000 per funding payment. Suggested: $10. Funding does not approve or buy access.</p>
    <Button disabled={busy} onClick={checkout}>Continue to secure checkout</Button>
  </div>;
}

export function CommercePayoutControls({ account, busy, country, changeCountry, expiredLink, onboarding, management, withdrawal }: {
  account: CommerceAccount; busy: boolean; country: string; changeCountry: (value: string) => void;
  expiredLink: boolean; onboarding: () => void; management: () => void; withdrawal: () => void;
}) {
  const ready = account.seller.onboarded && account.seller.eligible;
  const canOnboard = account.readiness?.capabilities.start_onboarding === true;
  const savedCountry = account.seller.country || country;
  return <div className="space-y-[var(--app-form-related-gap)]">
    <p className="text-sm">{ready ? "Your payout account is ready." : "Complete payout setup before charging for information."}</p>
    {ready ? <Button variant="outline" disabled={busy} onClick={management}>Manage payout account</Button> : null}
    {!ready ? <>
      <p className="text-xs text-muted-foreground">Stripe verifies your individual identity, payout method and earning activity. No company is required. Stripe tool access is separate.</p>
      <p className="text-xs text-muted-foreground">{expiredLink ? "Your payout setup link expired. Get a new authenticated link to continue." : "Continue here if your setup link expires."}</p>
      <label className="block space-y-[var(--app-form-field-gap)] text-sm">Payout country (two-letter code)
        <Input value={savedCountry} maxLength={2} onChange={event => changeCountry(event.target.value.toUpperCase())} disabled={busy || Boolean(account.seller.country)} />
      </label>
      <Button variant="outline" disabled={busy || !canOnboard || !/^[A-Z]{2}$/.test(savedCountry)} onClick={onboarding}>{expiredLink ? "Get a new payout setup link" : account.seller.onboarded ? "Continue payout setup with Stripe" : "Set up payouts with Stripe"}</Button>
    </> : null}
    <p className="text-xs text-muted-foreground">Pending earnings mature when access ends. Early revocation refunds unused time; nonreturned costs may create debt.</p>
    <p className="text-xs text-muted-foreground">Country eligibility and payout costs are checked before withdrawal. Minimum net payout: {money(account.payout.minimum_net_cents)}.</p>
    <Button variant="outline" disabled={busy || !ready || account.earnings.available_cents <= 0} onClick={withdrawal}>Review withdrawal</Button>
  </div>;
}
