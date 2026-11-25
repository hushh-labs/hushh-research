"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { formatCommerceMoney as money, formatCommerceMicroUsd, type ScopeCommerceRequest, type NegativeNetAcknowledgement } from "@/lib/services/scope-commerce-service";

export function ScopeCommerceOwnerReview({ request, busy, unlocked, prepare }: {
  request: ScopeCommerceRequest; busy: boolean; unlocked: boolean;
  prepare: (acknowledgement?: NegativeNetAcknowledgement) => Promise<void>;
}) {
  const [acknowledgedBinding, setAcknowledgedBinding] = useState<string | null>(null);
  const checkboxId = useId();
  const purchase = request.purchase;
  if (!purchase) return null;
  const terms = request.negative_net_acknowledgement;
  const negative = (purchase.net_earnings_micro_usd ?? 0) < 0;
  const accepted = Boolean(terms && acknowledgedBinding === terms.binding);
  const canPrepare = ["reserved", "preparing"].includes(purchase.status);
  return <div className="space-y-3">
    <dl data-consent-facts className="grid grid-cols-2 gap-2 text-sm">
      <dt data-consent-role="fact-label">Price</dt><dd data-consent-role="fact-value">{money(purchase.amount_cents)}</dd>
      {purchase.processing_fee_micro_usd !== undefined ? <><dt data-consent-role="fact-label">Payment fees</dt><dd data-consent-role="fact-value">{formatCommerceMicroUsd(purchase.processing_fee_micro_usd)}</dd></> : null}
      {purchase.net_earnings_micro_usd !== undefined ? <><dt data-consent-role="fact-label">Net earnings</dt><dd data-consent-role="fact-value">{formatCommerceMicroUsd(purchase.net_earnings_micro_usd)}</dd></> : null}
    </dl>
    {negative ? <p data-consent-role="status" role="status" className="text-sm">Fees exceed this price. Sharing can reduce your earnings or leave an amount owed.</p> : null}
    {canPrepare ? <>
      <p data-consent-role={unlocked ? "body" : "status"} role={unlocked ? undefined : "status"} className="text-sm">{unlocked ? "Only the approved information is encrypted and shared." : "Unlock your vault to share the approved information."}</p>
      {negative && terms ? <label htmlFor={checkboxId} data-consent-role="disclosure" className="flex min-h-11 items-start gap-3 py-2 text-sm">
        <Checkbox id={checkboxId} checked={accepted} disabled={busy} onCheckedChange={checked => setAcknowledgedBinding(checked === true ? terms.binding : null)} />
        <span>I accept net earnings of {formatCommerceMicroUsd(terms.net_earnings_micro_usd)} and any debt from these fees.</span>
      </label> : null}
      {negative && !terms ? <p data-consent-role="status" role="status" className="text-sm">Check again to review the exact fees.</p> : null}
      <Button data-consent-role="primary-action" disabled={busy || !unlocked || (negative && !accepted)} onClick={() => void prepare(negative && terms ? { version: 1, binding: terms.binding, acknowledged: true } : undefined)}>Share approved information</Button>
    </> : null}
  </div>;
}
