"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AppPageContentRegion, AppPageShell } from "@/components/app-ui/app-page-shell";
import { FeedPage } from "@/components/feed/feed-page";
import { fundingStatusCopy, loadHistoricalFunding, type HistoricalFunding } from "@/lib/feed/historical-funding";
import { useFinanceShareContext } from "@/lib/finance-sharing/use-finance-share-context";
import { FeedFinanceRecordDetail } from "./feed-finance-record-detail";

export function FeedWithRecordDetail() {
  const params = useSearchParams();
  const id = params.get("funding_event");
  const statement = params.get("statement_id");
  const institution = params.get("institution_id");
  if (id !== null) return <FundingDetail key={id} id={id} />;
  if (statement !== null) return <FeedFinanceRecordDetail key={`statement:${statement}`} kind="statement" id={statement} />;
  if (institution !== null) return <FeedFinanceRecordDetail key={`institution:${institution}`} kind="institution" id={institution} />;
  return <FeedPage />;
}

function FundingDetail({ id }: { id: string }) {
  const { capture, ready, session } = useFinanceShareContext();
  const [record, setRecord] = useState<{
    session: string;
    value: HistoricalFunding | null;
    failed?: boolean;
  } | null>(null);
  const valid = /^[1-9]\d{0,18}$/.test(id);
  useEffect(() => {
    if (!ready || !valid) return;
    const context = capture();
    if (!context?.isCurrent()) return;
    let active = true;
    void loadHistoricalFunding(context, { item_id: id }).then(items => {
      if (active && context.isCurrent()) setRecord({ session, value: items[0] || null });
    }).catch(() => {
      if (active && context.isCurrent()) setRecord({ session, value: null, failed: true });
    });
    return () => { active = false; };
  }, [capture, id, ready, session, valid]);

  const result = record?.session === session && ready && valid ? record.value : null;
  return <AppPageShell as="main" width="reading">
    <AppPageContentRegion>
      <article className="space-y-3 p-4">
        <h1 className="text-xl font-semibold">{result ? `Your ${result.direction} ${fundingStatusCopy(result.status)}` : "Transfer history"}</h1>
        {result ? <>
          <p className="text-sm text-muted-foreground">These are the dates One recorded the updates.</p>
          <ol className="divide-y">
            {result.milestones.map(event => <li key={event.status} className="flex flex-wrap justify-between gap-1 py-3 capitalize">
              <span>{event.status}</span>
              <time dateTime={event.recordedAt}>{new Date(event.recordedAt).toLocaleString()}</time>
            </li>)}
          </ol>
        </> : <p role="status">{!valid ? "This transfer record is unavailable."
          : !ready ? "Unlock your vault to view this transfer."
          : record?.session !== session ? "Loading transfer history…"
          : record.failed ? "Transfer history couldn’t be loaded."
          : "This transfer record is no longer in Feed."}</p>}
      </article>
    </AppPageContentRegion>
  </AppPageShell>;
}
