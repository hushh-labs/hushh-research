"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AppPageContentRegion, AppPageShell } from "@/components/app-ui/app-page-shell";
import { Button } from "@/components/ui/button";
import { useFinanceShareContext } from "@/lib/finance-sharing/use-finance-share-context";
import { getStatementSnapshotOptions } from "@/lib/kai/brokerage/financial-sources";
import { vaultConnections } from "@/lib/kai/plaid-vault/vault-sync";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";
import { armFeedSearchReturn } from "@/lib/feed/feed-search-memory";
import { feedResultHref } from "@/lib/feed/result-navigation";

type RecordDetail = { title: string; facts: Array<[string, string]> };

/** Selects existing owner records without changing the active portfolio or connection. */
export function FeedFinanceRecordDetail({ kind, id }: { kind: "statement" | "institution"; id: string }) {
  const { capture, ready, session } = useFinanceShareContext();
  const [state, setState] = useState<{ session: string; record: RecordDetail | null; failed?: boolean } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const resume = () => { setState(null); if (!document.hidden) setAttempt(value => value + 1); };
    document.addEventListener("visibilitychange", resume);
    return () => document.removeEventListener("visibilitychange", resume);
  }, []);
  const valid = id.length > 0 && id.length <= 200;
  useEffect(() => {
    if (!ready || !valid) return;
    let active = true;
    const context = capture();
    if (!context?.isCurrent()) return;
    setState(null);
    void PersonalKnowledgeModelService.loadDomainData({ ...context, domain: "financial" }).then(financial => {
      if (!active || !context.isCurrent()) return;
      let record: RecordDetail | null = null;
      if (kind === "statement") {
        const statement = getStatementSnapshotOptions(financial).find(item => item.id === id);
        if (statement) record = { title: statement.brokerage || "Saved statement", facts: [
          ["Statement date", statement.statementPeriodEnd || ""],
          ["Saved", statement.importedAt ? new Date(statement.importedAt).toLocaleString() : ""],
        ].filter((fact): fact is [string, string] => Boolean(fact[1])) };
      } else {
        const connection = vaultConnections(financial)[id];
        if (connection) record = { title: connection.institution_name || "Linked institution", facts: [
          ["Connection", connection.status === "needs_relink" ? "Sign-in needed" : "Connected"],
          ["Last refreshed", connection.last_refreshed_at ? new Date(connection.last_refreshed_at).toLocaleString() : ""],
        ].filter((fact): fact is [string, string] => Boolean(fact[1])) };
      }
      setState({ session, record });
    }).catch(() => { if (active && context.isCurrent()) setState({ session, record: null, failed: true }); });
    return () => { active = false; };
  }, [attempt, capture, id, kind, ready, session, valid]);
  const current = ready && valid && state?.session === session ? state : null;
  const record = current?.record;
  const sources = feedResultHref("/one/kai/portfolio/sources");
  return <AppPageShell as="main" width="reading"><AppPageContentRegion>
    <article className="space-y-5 px-4 py-5" data-testid="feed-finance-record-detail">
      <h1 className="text-xl font-semibold">{record?.title || (kind === "statement" ? "Statement" : "Institution")}</h1>
      {record ? <>
        <dl className="space-y-3">{record.facts.map(([label, value]) => <div key={label} className="flex flex-wrap justify-between gap-2 text-sm"><dt className="text-muted-foreground">{label}</dt><dd>{value}</dd></div>)}</dl>
        <Button asChild variant="ghost"><Link href={sources} onClick={() => armFeedSearchReturn(sources)}>View sources</Link></Button>
      </> : <p role="status" className="text-sm text-muted-foreground">{!valid ? "Record unavailable" : !ready ? "Unlock your vault to view this record." : !current ? "Loading…" : current.failed ? "Record couldn’t be loaded." : "Record no longer available."}</p>}
      {current?.failed ? <Button variant="ghost" onClick={() => setAttempt(value => value + 1)}>Try again</Button> : null}
    </article>
  </AppPageContentRegion></AppPageShell>;
}
