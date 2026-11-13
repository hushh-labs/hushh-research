"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { ArrowRight, ConsentAgentIcon } from "@/components/icons";
import { ProfilePaymentsLink } from "@/components/profile/profile-account-link";
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
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const listParams = new URLSearchParams(searchParams.toString());
  listParams.delete("commerceRequestId");
  const listHref = `/one/consent${listParams.size ? `?${listParams}` : ""}`;
  const focused = searchParams.get("commerceRequestId") === requestId;
  useBackLayer(pathname, user && focused ? 1 : 0, () => {
    router.replace(listHref, { scroll: false });
    return true;
  }, { commerceRequestId: requestId });
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
  return <>
    {focused ? <Link className="inline-flex min-h-11 items-center text-sm text-muted-foreground underline" href={listHref}>See all sharing</Link> : null}
    <SectionCard title={!ended && purchase?.status === "active" ? request?.role === "owner" ? "You’re sharing" : "Shared with you" : "Sharing details"} action={<ConsentAgentIcon aria-hidden="true" className="h-7 w-7" />} className="consent-presentation-surface">
    <div className="space-y-4" data-consent-presentation="commerce-review">
      {!request && !message ? <p data-consent-role="status" role="status" className="text-sm">Loading sharing details…</p> : null}
      {message ? <p data-consent-role="status" role="status" className="text-sm">{message}</p> : null}
      {request ? <>
        <dl data-consent-facts className="grid gap-3 text-sm sm:grid-cols-2">
          <div><dt data-consent-role="fact-label" className="text-muted-foreground">Information</dt><dd data-consent-role="fact-value">{request.scope_label || "Approved information"}</dd></div>
          <div><dt data-consent-role="fact-label" className="text-muted-foreground">{request.role === "owner" ? "Shared with" : "Shared by"}</dt><dd data-consent-role="fact-value">{request.counterpart_label || "Approved person"}</dd></div>
          {request.recipient_label ? <div><dt data-consent-role="fact-label" className="text-muted-foreground">Receiving app</dt><dd data-consent-role="fact-value">{request.recipient_label}</dd></div> : null}
          <div className="sm:col-span-2"><dt data-consent-role="fact-label" className="text-muted-foreground">Purpose</dt><dd data-consent-role="fact-value">{request.purpose}</dd></div>
          <div><dt data-consent-role="fact-label" className="text-muted-foreground">Duration</dt><dd data-consent-role="fact-value">{request.duration_seconds / 3600} hours</dd></div>
          {request.refresh_policy ? <div><dt data-consent-role="fact-label" className="text-muted-foreground">Updates</dt><dd data-consent-role="fact-value">{request.refresh_policy === "snapshot" ? "Not included" : request.refresh_policy === "continuous_until_expiry" ? "Until access ends" : "Not confirmed"}</dd></div> : null}
          {request.role === "payer" && purchase && purchase.status !== "awaiting_payment" ? <div><dt data-consent-role="fact-label" className="text-muted-foreground">Price</dt><dd data-consent-role="fact-value">{money(purchase.amount_cents)}</dd></div> : null}
        </dl>
        {!ended ? <ScopeCommerceTimeline request={request} /> : null}
        <p data-consent-role="status" role="status" className="text-sm">{ended ? "Sharing ended. Check payment history for any refund." : purchase ? scopeCommerceStatusCopy(purchase.status, request.role) : free ? "Free access follows the owner's approval. Check Consent for its status." : "Waiting for owner approval."}</p>
        {!ended && request.role === "payer" && purchase?.status === "active" && request.counterpart_person_ref ? <Button data-consent-role="primary-action" className="w-full sm:w-auto" asChild><Link href={`/people/${request.counterpart_person_ref}`}>Open shared information<ArrowRight aria-hidden="true" className="h-4 w-4" /></Link></Button> : null}
        {!purchase && request.role === "owner" ? <Link className="inline-flex min-h-11 items-center text-sm underline" href={`/one/consent?requestId=${encodeURIComponent(requestId)}`}>Review request</Link> : null}
        {!free && !enabled ? <div className="space-y-2 text-sm"><p data-consent-role="body">{commerceReadinessCopy(state.readiness)}</p><ProfilePaymentsLink className="inline-flex min-h-11 items-center underline">Payments and earnings</ProfilePaymentsLink></div> : null}
        {request.tariff && !purchase ? <p data-consent-role="helper" className="text-xs text-muted-foreground">Rate: {money(request.tariff.price_cents)} per {request.tariff.base_duration_seconds / 3600} hours. Review the total before confirming.</p> : null}
        {request.role === "owner" && purchase?.expires_at ? <p data-consent-role="helper" className="text-xs text-muted-foreground">Earnings are pending until access ends. Bank payout is separate.</p> : null}
        {request.role === "owner" && !ended ? <ScopeCommerceOwnerReview key={purchase?.id || requestId} request={request} busy={busy} unlocked={Boolean(vaultKey)} prepare={state.prepare} /> : null}
        {!ended && request.role === "payer" && purchase?.status === "awaiting_payment" ? <ScopeCommerceBuyerReview key={`${user.uid}:${requestId}`} requestId={requestId} refreshRequest={state.refresh} quote={quote} balance={state.availableBalance} expired={quoteExpired} busy={busy} enabled={enabled} reviewPrice={state.reviewPrice} purchase={state.purchase} /> : null}
      </> : null}
      <AlertDialog open={endReview} onOpenChange={setEndReview}>
        <AlertDialogContent className="consent-presentation-surface"><AlertDialogHeader>
          <AlertDialogTitle>{request?.role === "owner" ? "End sharing?" : "Cancel this request?"}</AlertDialogTitle>
          <AlertDialogDescription>{request?.role === "payer" ? "The full reserved amount returns to your balance." : beforeActivation ? "The full reserved amount returns to the buyer's balance. Unrecovered payment fees remain your responsibility and may leave an amount owed." : "The buyer is refunded for unused time. Unrecovered payment fees remain your responsibility and may leave an amount owed. Not using access doesn't create a refund."}</AlertDialogDescription>
        </AlertDialogHeader><AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>{request?.role === "owner" ? "Keep sharing" : "Keep request"}</AlertDialogCancel>
          <AlertDialogAction disabled={busy || !canEnd} onClick={event => {
            event.preventDefault();
            void state.end().then(() => setEndReview(false));
          }}>{request?.role === "owner" ? "End sharing" : "Cancel request"}</AlertDialogAction>
        </AlertDialogFooter></AlertDialogContent>
      </AlertDialog>
      <div className="flex flex-wrap items-center gap-2">
        {canEnd && request ? <Button data-consent-role="compact-action" variant="outline" disabled={busy || (request.role === "owner" && !vaultKey)} onClick={() => setEndReview(true)}>{request.role === "owner" ? "End sharing" : "Cancel request"}</Button> : null}
        <Button data-consent-role="compact-action" disabled={busy} variant="ghost" data-consent-quiet-action="true" onClick={() => void state.refresh()}>Check again</Button>
      </div>
    </div>
  </SectionCard></>;
}
