"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScopeCommerceService, formatCommerceMoney as money, formatCommerceMicroUsd, commerceActivityStatusCopy, type CommerceActivityItem, type CommerceActivityPage, type CommerceActivityView } from "@/lib/services/scope-commerce-service";
import { useCommerceRead } from "@/components/consent/use-commerce-session";
import { CommerceTime } from "@/components/consent/scope-commerce-timeline";

const VIEWS: Array<{ value: CommerceActivityView; label: string }> = [
  { value: "purchases", label: "Purchases" }, { value: "sales", label: "Sales" }, { value: "transactions", label: "Transactions" },
];
const PENDING = new Set(["awaiting_payment", "reserved", "preparing", "staged", "armed", "active", "queued", "dispatching", "refund_pending", "manual_review", "pending", "processing", "unknown", "transferred"]);

function ActivityEntry({ item }: { item: CommerceActivityItem }) {
  return <li className="space-y-3 border-b py-4 last:border-b-0">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div><p className="font-medium">{item.scope_label || item.kind.replaceAll("_", " ")}</p>
        {item.counterpart ? <p className="text-sm text-muted-foreground">{item.counterpart.label}</p> : null}</div>
      <p className="text-sm font-medium">{item.direction === "incoming" ? "Incoming" : item.direction === "outgoing" ? "Outgoing" : "Amount"}: {money(item.amount_cents)}</p>
    </div>
    <p role="status" className="text-sm">{commerceActivityStatusCopy(item.kind, item.status)}</p>
    <dl className="grid gap-3 text-sm sm:grid-cols-2">
      {item.purchase_id ? <div><dt className="text-muted-foreground">Gross agreed price</dt><dd>{money(item.gross_cents)}</dd></div> : null}
      {item.processing_fee_micro_usd !== null ? <div><dt className="text-muted-foreground">Attributed processing costs</dt><dd>{formatCommerceMicroUsd(item.processing_fee_micro_usd)}</dd></div> : null}
      {item.net_earnings_micro_usd !== null ? <div><dt className="text-muted-foreground">Net earnings</dt><dd>{formatCommerceMicroUsd(item.net_earnings_micro_usd)}</dd></div> : null}
      {item.refunded_cents !== null ? <div><dt className="text-muted-foreground">Refunded</dt><dd>{money(item.refunded_cents)}</dd></div> : null}
      <CommerceTime label="Created" value={item.created_at} />
      <CommerceTime label="Prepare by" value={item.fulfillment_deadline} />
      <CommerceTime label="Access starts" value={item.activation_at} />
      <CommerceTime label="Access ends" value={item.expires_at} />
      <CommerceTime label="Earnings mature" value={item.matures_at} />
    </dl>
    {item.next_action ? <Link className="inline-flex min-h-11 items-center text-sm underline" href={item.next_action.href}>{item.next_action.label}</Link> : null}
  </li>;
}

/** Existing account destination, with authoritative owner-scoped keyset history. */
export function ScopeCommerceActivity() {
  const [view, setView] = useState<CommerceActivityView>("purchases");
  const [extension, setExtension] = useState<{ base: CommerceActivityPage; items: CommerceActivityItem[]; cursor: string | null } | null>(null);
  const load = useCallback((token: string) => ScopeCommerceService.activity(token, view), [view]);
  const { user, data, refresh, loading, error, capture } = useCommerceRead(`activity:${view}`, load, value => extension?.base !== value && value.items.some(item => PENDING.has(item.status)));
  const [moreError, setMoreError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const inFlight = useRef(false);
  const currentBase = useRef(data);
  useLayoutEffect(() => { currentBase.current = data; }, [data]);
  const extra = extension?.base === data ? extension : null;
  const items = [...(data?.items || []), ...(extra?.items || [])];
  const nextCursor = extra ? extra.cursor : data?.next_cursor;
  async function loadMore() {
    if (!user || !data || !nextCursor || inFlight.current) return;
    const current = capture(); const currentView = capture(false); const base = data; const requestedCursor = nextCursor;
    inFlight.current = true; setLoadingMore(true); setMoreError(null);
    try {
      const token = await user.getIdToken();
      if (!current()) return;
      const page = await ScopeCommerceService.activity(token, view, requestedCursor);
      if (!current() || currentBase.current !== base) return;
      if (page.next_cursor === requestedCursor) throw new Error("The payment history cursor did not advance.");
      setExtension(previous => {
        const prior = previous?.base === base ? previous.items : [];
        const known = new Set([...base.items, ...prior].map(item => item.id));
        return { base, items: [...prior, ...page.items.filter(item => !known.has(item.id))], cursor: page.next_cursor };
      });
    } catch { if (current()) setMoreError("More payment history could not be checked. Try again."); }
    finally { inFlight.current = false; if (currentView()) setLoadingMore(false); }
  }
  return <div className="space-y-3 border-t pt-4">
    <Tabs value={view} onValueChange={value => {
      if (VIEWS.some(tab => tab.value === value)) { setView(value as CommerceActivityView); setMoreError(null); setLoadingMore(false); }
    }}>
      <TabsList className="w-full" aria-label="Payment history">{VIEWS.map(tab => <TabsTrigger key={tab.value} value={tab.value}>{tab.label}</TabsTrigger>)}</TabsList>
    <TabsContent value={view} aria-label={`${VIEWS.find(tab => tab.value === view)?.label} history`} aria-busy={loading || loadingMore}>
      {error || moreError ? <p role="status" className="text-sm">{error || moreError}</p> : null}
      {!data && loading ? <p role="status" className="text-sm">Checking payment history…</p> : null}
      {data && items.length === 0 ? <p className="text-sm text-muted-foreground">No {view} yet.</p> : null}
      {extra ? <p className="text-xs text-muted-foreground">Showing older entries. Refresh returns to the latest activity.</p> : null}
      {items.length ? <ul>{items.map(item => <ActivityEntry key={item.id} item={item} />)}</ul> : null}
      <div className="flex flex-wrap gap-2">
        {nextCursor ? <Button variant="outline" disabled={loading || loadingMore} onClick={() => void loadMore()}>Load more {view}</Button> : null}
        <Button variant="ghost" disabled={loading || loadingMore} onClick={() => void refresh()}>Refresh {view}</Button>
      </div>
    </TabsContent>
    </Tabs>
  </div>;
}
