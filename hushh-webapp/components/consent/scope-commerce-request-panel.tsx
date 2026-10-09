"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ProfileAccountLink } from "@/components/profile/profile-account-link";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { SectionCard } from "@/lib/morphy-ux/ui/surface-primitives";
import { scopeCommerceStatusCopy, formatCommerceMoney as money, commerceReadinessCopy } from "@/lib/services/scope-commerce-service";
import { useCoarseClock } from "@/lib/perf/use-periodic-task";
import { useScopeCommerceRequest } from "@/components/consent/use-scope-commerce-request";
import { ScopeCommerceTimeline } from "@/components/consent/scope-commerce-timeline";
import { ScopeCommerceOwnerReview } from "@/components/consent/scope-commerce-owner-review";
import { ScopeCommerceBuyerReview } from "@/components/consent/scope-commerce-buyer-review";

/** Human-only review stays on the existing consent destination. */
export function ScopeCommerceRequestPanel({ requestId }: { requestId: string }) {
  const state = useScopeCommerceRequest(requestId);
  const { user, request, quote, busy, enabled, message, ended, vaultKey } = state;
  const [endReview, setEndReview] = useState(false);
  const now = useCoarseClock(1000);
  useEffect(() => setEndReview(false), [user, requestId]);
  const purchase = request?.purchase;
  const free = Boolean(request && !purchase && (!request.tariff || request.tariff.price_cents === 0));
  const beforeActivation = !purchase?.activation_at || Date.parse(purchase.activation_at) > now;
  const pending = Boolean(purchase && ["awaiting_payment", "reserved", "preparing", "staged", "armed"].includes(purchase.status));
  const canEnd = !ended && Boolean(purchase && (
    request?.role === "owner" ? pending || purchase.status === "active" : pending && beforeActivation
  ));
  const quoteExpired = Boolean(quote && Date.parse(quote.expires_at) <= now);
  if (!user) return null;
  return <SectionCard title={free ? "Free sharing review" : "Sharing request review"} description="Review who receives the approved information, the access term and any payment terms.">
    <div className="space-y-4">
      {message ? <p role="status" className="text-sm">{message}</p> : null}
      {request ? <>
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div><dt className="text-muted-foreground">Sharing section</dt><dd>{request.scope_label || "Approved information section"}</dd></div>
          <div><dt className="text-muted-foreground">{request.role === "owner" ? "Recipient" : "Information owner"}</dt><dd>{request.counterpart_label || "Approved person"}</dd></div>
          {request.recipient_label ? <div><dt className="text-muted-foreground">Receiving application</dt><dd>{request.recipient_label}</dd></div> : null}
          <div><dt className="text-muted-foreground">Purpose</dt><dd>{request.purpose}</dd></div>
          <div><dt className="text-muted-foreground">Access term</dt><dd>{request.duration_seconds / 3600} hours</dd></div>
          {request.refresh_policy ? <div><dt className="text-muted-foreground">Refresh policy</dt><dd>{request.refresh_policy}</dd></div> : null}
        </dl>
        <ScopeCommerceTimeline request={request} />
        <p role="status" className="text-sm">{ended ? "Sharing ended. The server confirmed the change and reconciled the buyer balance." : purchase ? scopeCommerceStatusCopy(purchase.status) : free ? "This request is free. Access follows the owner's consent; check Consent for its current status. No Stripe account or funded balance is needed." : "Waiting for the owner to approve exact sharing terms."}</p>
        {!purchase && request.role === "owner" ? <Link className="inline-flex min-h-11 items-center text-sm underline" href={`/one/consent?requestId=${encodeURIComponent(requestId)}`}>Review this request in Consent</Link> : null}
        {!free && !enabled ? <div className="space-y-2 text-sm"><p>{commerceReadinessCopy(state.readiness)}</p><ProfileAccountLink className="inline-flex min-h-11 items-center underline">Review payment availability in Account</ProfileAccountLink></div> : null}
        {purchase && ["staged", "armed"].includes(purchase.status) ? <p className="text-sm">Preparation is complete. Access remains unavailable until the scheduled start shown above.</p> : null}
        {request.tariff ? <p className="text-xs text-muted-foreground">Base price {money(request.tariff.price_cents)} for {request.tariff.base_duration_seconds / 3600} hours. The final approved term is prorated by the server.</p> : null}
        {request.role === "owner" && !ended ? <ScopeCommerceOwnerReview key={purchase?.id || requestId} request={request} busy={busy} unlocked={Boolean(vaultKey)} prepare={state.prepare} /> : null}
        {!ended && request.role === "payer" && purchase?.status === "awaiting_payment" ? <ScopeCommerceBuyerReview quote={quote} balance={state.availableBalance} expired={quoteExpired} busy={busy} enabled={enabled} reviewPrice={state.reviewPrice} purchase={state.purchase} /> : null}
        {canEnd ? <Button variant="outline" disabled={busy || (request.role === "owner" && !vaultKey)} onClick={() => setEndReview(true)}>{request.role === "owner" ? "End sharing" : "Cancel before activation"}</Button> : null}
      </> : null}
      <AlertDialog open={endReview} onOpenChange={setEndReview}>
        <AlertDialogContent><AlertDialogHeader>
          <AlertDialogTitle>{request?.role === "owner" ? "End this sharing agreement?" : "Cancel before access starts?"}</AlertDialogTitle>
          <AlertDialogDescription>Before activation, the full reserved amount returns to the buyer balance. After activation, owner revocation refunds unused calendar time. Nonuse does not create a refund. The owner bears unrecovered processing costs, which may reduce earnings or create debt.</AlertDialogDescription>
        </AlertDialogHeader><AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Keep sharing</AlertDialogCancel>
          <AlertDialogAction disabled={busy || !canEnd} onClick={event => {
            event.preventDefault();
            void state.end().then(() => setEndReview(false));
          }}>Confirm end of sharing</AlertDialogAction>
        </AlertDialogFooter></AlertDialogContent>
      </AlertDialog>
      <Button disabled={busy} variant="ghost" onClick={() => void state.refresh()}>Refresh sharing request</Button>
    </div>
  </SectionCard>;
}
