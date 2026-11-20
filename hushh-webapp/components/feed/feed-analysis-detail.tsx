"use client";

import { useEffect, useState } from "react";
import { AppPageContentRegion, AppPageShell } from "@/components/app-ui/app-page-shell";
import { Button } from "@/components/ui/button";
import { HistoryDetailView } from "@/components/kai/views/history-detail-view";
import { useFinanceShareContext } from "@/lib/finance-sharing/use-finance-share-context";
import { KaiHistoryService, findAnalysisHistoryEntryByRouteId, type AnalysisHistoryEntry } from "@/lib/services/kai-history-service";

/** Exact existing report; background Finance tasks cannot substitute another run. */
export function FeedAnalysisDetail({ id }: { id: string }) {
  const { capture, ready, session } = useFinanceShareContext();
  const [state, setState] = useState<{ session: string; entry: AnalysisHistoryEntry | null; failed?: boolean } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const valid = Boolean(id && id.length <= 300);
  useEffect(() => {
    const resume = () => { setState(null); if (!document.hidden) setAttempt(value => value + 1); };
    document.addEventListener("visibilitychange", resume);
    return () => document.removeEventListener("visibilitychange", resume);
  }, []);
  useEffect(() => {
    if (!ready || !valid) return;
    const context = capture();
    if (!context?.isCurrent()) return;
    let active = true;
    setState(null);
    void KaiHistoryService.getAllHistory(context).then(history => {
      if (active && context.isCurrent()) setState({ session, entry: findAnalysisHistoryEntryByRouteId(history, id) });
    }).catch(() => { if (active && context.isCurrent()) setState({ session, entry: null, failed: true }); });
    return () => { active = false; };
  }, [attempt, capture, id, ready, session, valid]);
  const current = ready && valid && state?.session === session ? state : null;
  return <AppPageShell as="main" width="reading"><AppPageContentRegion>
    <article className="space-y-4 py-5" data-testid="feed-analysis-detail">
      <h1 className="px-4 text-xl font-semibold">{current?.entry ? `${current.entry.ticker} analysis` : "Analysis"}</h1>
      {current?.entry ? <HistoryDetailView entry={current.entry} embedded showHeader={false} /> : <p role="status" className="px-4 text-sm text-muted-foreground">{!valid ? "Report unavailable" : !ready ? "Unlock your vault to view this report." : !current ? "Loading…" : current.failed ? "Report couldn’t be loaded." : "Report unavailable on this device."}</p>}
      {current?.failed ? <Button variant="ghost" onClick={() => setAttempt(value => value + 1)}>Try again</Button> : null}
    </article>
  </AppPageContentRegion></AppPageShell>;
}
