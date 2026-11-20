"use client";

import { FeedMailResult } from "./feed-mail-result";
import { FeedPaymentResult } from "./feed-payment-result";
import { feedMailSelection } from "@/lib/feed/mail-result-selection";
import { feedPaymentSelection, isFeedPaymentMatch } from "@/lib/feed/payment-result-selection";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { feedResultHref } from "@/lib/feed/result-navigation";
import { armFeedSearchReturn } from "@/lib/feed/feed-search-memory";
import { SettingsDetailPanel } from "@/components/app-ui/settings-ui";
import { Button } from "@/components/ui/button";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { presentFeedItem, presentFeedMilestone } from "@/lib/feed/feed-item-renderers";
import { FeedService, type FeedActivityDetail, type FeedItem } from "@/lib/services/feed-service";

/** A generic workspace is not an exact result. Keep its dated receipt readable. */
function resultDestination(item: FeedItem): { href: string; label: string } | null {
  const view = presentFeedItem(item);
  if (view.recovery) return view.recovery;
  if (!view.href) return null;
  if (!view.exactDestination) return null;
  return { href: view.href, label: view.exactDestination === "request" ? "View request"
    : view.exactDestination === "report" ? "View report" : "View result" };
}

export function FeedActivityDetail({ item, getToken, isCurrent, onClose, routePath = "/one/feed" }: {
  item: FeedItem;
  routePath?: string;
  getToken: () => Promise<string>;
  isCurrent: () => boolean;
  onClose: () => void;
}) {
  const [state, setState] = useState<{ value?: FeedActivityDetail; failed?: boolean }>({});
  const [retry, setRetry] = useState(0);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [earlierFailed, setEarlierFailed] = useState(false);
  const episode = useRef(0);
  const invalidateEpisode = useCallback(() => { episode.current++; }, []);
  useBackLayer(routePath, 2, () => { onClose(); return true; });
  useEffect(() => {
    const request = ++episode.current;
    const current = () => request === episode.current && isCurrent();
    setState({});
    void (async () => {
      try {
        const idToken = await getToken();
        const value = await FeedService.activityDetail({ idToken, itemId: item.id, isEffectCurrent: current });
        if (current()) setState({ value });
      } catch {
        if (current()) setState({ failed: true });
      }
    })();
    return invalidateEpisode;
  }, [item.id, getToken, isCurrent, retry, invalidateEpisode]);
  async function loadEarlier() {
    if (!state.value?.next_cursor || loadingEarlier || !isCurrent()) return;
    const beforeId = state.value.next_cursor;
    const request = episode.current;
    const current = () => request === episode.current && isCurrent();
    setLoadingEarlier(true); setEarlierFailed(false);
    try {
      const idToken = await getToken();
      const result = await FeedService.activityDetail({ idToken, itemId: item.id, beforeId, isEffectCurrent: current });
      if (!current()) return;
      setState(previous => previous.value ? { value: { ...result, milestones: [
        ...new Map([...previous.value.milestones, ...result.milestones].map(step => [step.id, step])).values(),
      ] } } : previous);
    } catch { if (current()) setEarlierFailed(true); }
    finally { if (current()) setLoadingEarlier(false); }
  }
  const selected = state.value?.item ?? item;
  const view = state.value ? presentFeedItem(selected) : null;
  const target = state.value ? resultDestination(selected) : null;
  const mailSelection = state.value ? feedMailSelection(selected) : null;
  const paymentMatch = isFeedPaymentMatch(item);
  const paymentSelection = state.value ? feedPaymentSelection(item, selected) : null;
  const earlier = state.value?.milestones.filter(step => step.id !== selected.id) || [];
  return <SettingsDetailPanel open onOpenChange={open => { if (!open) onClose(); }}
    mobilePresentation="sheet" title={paymentMatch ? "Receipt" : mailSelection ? mailSelection.kind === "request" ? "Request" : "Message" : view?.label || "Activity"} description={mailSelection || paymentMatch ? undefined : view?.description || undefined} headerTextOverflow="wrap">
    <div className="space-y-4 px-4 pb-5" data-testid="feed-activity-detail">
      {!state.value && !state.failed ? <p role="status" className="text-sm text-muted-foreground">Loading…</p> : null}
      {state.failed ? <div className="flex items-center justify-between gap-3"><p role="status" className="text-sm text-muted-foreground">Activity unavailable</p><Button variant="ghost" onClick={() => setRetry(value => value + 1)}>Try again</Button></div> : null}
      {state.value ? <>
        {mailSelection ? <FeedMailResult selection={mailSelection} getToken={getToken} isCurrent={isCurrent} /> : null}
        {paymentSelection ? <FeedPaymentResult selection={paymentSelection} isCurrent={isCurrent} /> : paymentMatch ? <p role="status" className="text-sm text-muted-foreground">Receipt unavailable</p> : null}
        {!paymentMatch ? <time className="block text-xs text-muted-foreground" dateTime={selected.created_at}>{new Date(selected.created_at).toLocaleString()}</time> : null}
        {target && !paymentMatch ? <Button asChild><Link onClick={()=>armFeedSearchReturn(feedResultHref(target.href))} href={feedResultHref(target.href)} prefetch={false}>{target.label}</Link></Button> : null}
        {earlier.length ? <section aria-label="Earlier steps"><h3 className="text-xs text-muted-foreground">Earlier steps</h3>
          <ol className="divide-y">{earlier.map(step => {
            const copy = presentFeedMilestone(step);
            return <li key={step.id} className="flex items-start justify-between gap-4 py-3 text-sm">
              <span className="min-w-0 break-words">{copy.person && copy.description ? copy.description : copy.label}</span>
              <time className="shrink-0 text-xs text-muted-foreground" dateTime={step.created_at}>{new Date(step.created_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</time>
            </li>;
          })}</ol>
          {state.value.next_cursor ? <Button variant="ghost" disabled={loadingEarlier} onClick={() => void loadEarlier()}>{loadingEarlier ? "Loading…" : earlierFailed ? "Try again" : "Earlier steps"}</Button> : null}
        </section> : null}
      </> : null}
    </div>
  </SettingsDetailPanel>;
}
