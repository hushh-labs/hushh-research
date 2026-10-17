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
    <dl className="grid grid-cols-2 gap-2 text-sm">
      <dt>Gross agreed price</dt><dd>{money(purchase.amount_cents)}</dd>
      {purchase.processing_fee_micro_usd !== undefined ? <><dt>Attributed processing costs</dt><dd>{formatCommerceMicroUsd(purchase.processing_fee_micro_usd)}</dd></> : null}
      {purchase.net_earnings_micro_usd !== undefined ? <><dt>Net earnings</dt><dd>{formatCommerceMicroUsd(purchase.net_earnings_micro_usd)}</dd></> : null}
    </dl>
    {negative ? <p role="status" className="text-sm">Processing costs exceed this price. Completing this sharing agreement can reduce your earnings or create a debt. A one-cent price is allowed.</p> : null}
    {canPrepare ? <>
      <p className="text-sm">Prepare the exact encrypted information with your vault unlocked. The buyer waits for this step before access starts.</p>
      {!unlocked ? <p role="status" className="text-sm">Unlock your vault to prepare this information.</p> : null}
      {negative && terms ? <label htmlFor={checkboxId} className="flex min-h-11 items-start gap-3 py-2 text-sm">
        <Checkbox id={checkboxId} checked={accepted} disabled={busy} onCheckedChange={checked => setAcknowledgedBinding(checked === true ? terms.binding : null)} />
        <span>I accept net earnings of {formatCommerceMicroUsd(terms.net_earnings_micro_usd)} and the possible debt from these processing costs.</span>
      </label> : null}
      {negative && !terms ? <p role="status" className="text-sm">Refresh to review the exact costs before preparing information.</p> : null}
      <Button disabled={busy || !unlocked || (negative && !accepted)} onClick={() => void prepare(negative && terms ? { version: 1, binding: terms.binding, acknowledged: true } : undefined)}>Prepare encrypted information</Button>
    </> : null}
  </div>;
}
