"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { feedResultHref } from "@/lib/feed/result-navigation";
import { armFeedSearchReturn } from "@/lib/feed/feed-search-memory";
import { Banknote, FileChartColumn, Landmark, Search, TrendingUp, Users } from "@/components/icons";
import { FeedEntityIcon } from "./feed-entity-icon";
import { Button } from "@/components/ui/button";
import { AdvisorReviewService } from "@/lib/advisor-review/service";
import {
  financeFeedRecords,
  searchFinanceFeedRecords,
  type FinanceFeedRecord,
} from "@/lib/feed/finance-records";
import { historicalFundingTerms, loadHistoricalFunding } from "@/lib/feed/historical-funding";
import { vaultConnections } from "@/lib/kai/plaid-vault/vault-sync";
import { buildKaiReconnectRoute, historicalFundingFeedHref } from "@/lib/navigation/routes";
import { useFinanceShareContext } from "@/lib/finance-sharing/use-finance-share-context";
import { KaiHistoryService } from "@/lib/services/kai-history-service";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";

const RECORD_ICON = {
  statement: FileChartColumn,
  analysis: TrendingUp,
  advisor: Users,
  institution: Landmark,
  transfer: Banknote,
} as const;

type FinanceSearchOptions = {
  initialRecords?: FinanceFeedRecord[];
  onRecords?: (records: FinanceFeedRecord[]) => void;
  scope?: string;
  query?: string;
  person?: string;
  fromAt?: string | null;
  beforeAt?: string | null;
  excludedHrefs?: ReadonlySet<string>;
  excludedOperations?: ReadonlySet<string>;
  requestRevision?: number;
  onResultCount?: (count: number | null) => void;
};

export function FeedFinanceSearch(options: FinanceSearchOptions = {}) {
  const { capture, ready, session } = useFinanceShareContext();
  return ready ? <UnlockedFinanceSearch key={session} capture={capture} {...options} /> : null;
}

function UnlockedFinanceSearch({ capture, initialRecords, onRecords, scope, query: suppliedQuery, person, fromAt, beforeAt, excludedHrefs, excludedOperations, requestRevision, onResultCount }: FinanceSearchOptions & {
  capture: ReturnType<typeof useFinanceShareContext>["capture"];
}) {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<FinanceFeedRecord[] | null>(initialRecords ?? null);
  const restored = useRef(initialRecords !== undefined);
  const [status, setStatus] = useState("");
  const generation = useRef(0);
  useEffect(()=>{ if(result) onRecords?.(result); },[result,onRecords]);
  const invalidateSearch = useCallback(() => { generation.current++; }, []);

  const search = useCallback(async () => {
    const requestGeneration = ++generation.current;
    const context = capture();
    const terms = (suppliedQuery ?? query).trim();
    if (!context?.isCurrent() || (!terms && suppliedQuery === undefined)) return;
    const { userId, vaultKey, vaultOwnerToken } = context;
    setResult(null);
    setStatus("Searching…");
    const fundingQuery = historicalFundingTerms(terms);
    const values = await Promise.allSettled([
      PersonalKnowledgeModelService.loadDomainData({ userId, vaultKey, vaultOwnerToken, domain: "financial" }),
      KaiHistoryService.getAllHistory({ userId, vaultKey, vaultOwnerToken }),
      AdvisorReviewService.history(context),
      fundingQuery ? loadHistoricalFunding(context, { query: fundingQuery }) : Promise.resolve([]),
    ]);
    if (requestGeneration !== generation.current) return;
    if (!context.isCurrent()) { setResult([]); setStatus("Search paused"); return; }
    const [financial, analyses, reviews, transfers] = values;
    const records = financeFeedRecords(
      financial.status === "fulfilled" ? financial.value : null,
      analyses.status === "fulfilled" ? analyses.value : {},
      reviews.status === "fulfilled" ? reviews.value.items : [],
      Object.entries(vaultConnections(financial.status === "fulfilled" ? financial.value : null))
        .map(([id, item]) => {
          const connectionName = item.institution_name || "Linked institution";
          const status = item.status === "active" ? "Active" :
            item.reconnect_required_at ? "Sign-in needed" : "Check connection";
          return {
            kind: "institution" as const,
            href: buildKaiReconnectRoute(id),
            title: `${connectionName} · ${status}`,
            timestamp: item.reconnect_required_at || item.last_refreshed_at || item.linked_at || null,
            searchable: [connectionName, status, "institution connection"],
          };
        }),
    );
    const matching = terms ? searchFinanceFeedRecords(records, terms) : records;
    if (transfers.status === "fulfilled") {
      for (const transfer of transfers.value) {
        matching.push({
          kind: "transfer",
          href: historicalFundingFeedHref(transfer.itemId),
          title: `${transfer.direction.charAt(0).toUpperCase()}${transfer.direction.slice(1)} ${transfer.status}`,
          timestamp: transfer.recordedAt,
          searchable: [],
        });
      }
    }
    setResult(matching.filter(entry => {
      const instant = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
      return (scope !== "advisor" || entry.kind === "advisor") && (scope !== "finance" || entry.kind !== "advisor") && (!person || entry.person?.toLocaleLowerCase().includes(person.toLocaleLowerCase().trim()))
        && (!fromAt || instant >= Date.parse(fromAt)) && (!beforeAt || instant < Date.parse(beforeAt));
    }).sort((a, b) => (Date.parse(b.timestamp || "") || 0) - (Date.parse(a.timestamp || "") || 0)));
    setStatus(values.some(value => value.status === "rejected") ? "Some records couldn’t be checked." : "");
  }, [capture, suppliedQuery, query, person, fromAt, beforeAt, scope]);

  useEffect(() => {
    if (restored.current) { restored.current=false; return; }
    if (suppliedQuery !== undefined) void search();
    return invalidateSearch;
  }, [suppliedQuery, requestRevision, search, invalidateSearch]);

  useEffect(() => {
    const resume = () => { if (!document.hidden && suppliedQuery !== undefined) void search(); };
    document.addEventListener("visibilitychange", resume);
    return () => document.removeEventListener("visibilitychange", resume);
  }, [suppliedQuery, search]);

  const visible = result?.filter(entry => !excludedHrefs?.has(entry.href)
    && (!entry.operationKey || !excludedOperations?.has(entry.operationKey)));
  useEffect(() => { onResultCount?.(result === null ? null : visible?.length || 0); }, [onResultCount, result, visible?.length]);
  return (
    <section aria-label="Find an earlier Finance record" className="space-y-2 px-4 py-2">
      {suppliedQuery === undefined ? <form role="search" className="flex flex-wrap items-end gap-2" onSubmit={event => { event.preventDefault(); void search(); }}>
        <label className="flex flex-1 flex-col gap-1 text-sm">
          <span className="sr-only">Search Finance activity</span>
          <input
            className="min-w-0 rounded-lg border bg-background px-3 py-2"
            placeholder="Search Finance"
            maxLength={120}
            value={query}
            onChange={event => {
              generation.current++;
              setQuery(event.target.value);
              setResult(null);
              setStatus("");
            }}
          />
        </label>
        <Button type="submit" variant="ghost" size="icon" aria-label="Search Finance activity" disabled={!query.trim()} className="size-11 shrink-0 text-accent"><Search className="size-5" aria-hidden="true" /></Button>
      </form> : null}
      {status ? <p role="status" className="text-sm text-muted-foreground">{status}</p> : null}
      {suppliedQuery === undefined && result?.length === 0 ? <p className="text-sm text-muted-foreground">No matching records.</p> : null}
      {visible?.length ? <ul className="divide-y">
        {visible.map(entry => <li key={entry.href}>
          <Link onClick={()=>armFeedSearchReturn(feedResultHref(entry.href))} href={feedResultHref(entry.href)} prefetch={false} className="grid grid-cols-[22px_minmax(0,1fr)] items-center gap-2 py-3 text-sm">
            <FeedEntityIcon icon={RECORD_ICON[entry.kind] || FileChartColumn} symbol={entry.symbol} />
            <span className="min-w-0 break-words [overflow-wrap:anywhere]">
              <span data-slot="feed-search-title">{entry.title}</span>
              {entry.timestamp ? <time className="block text-xs text-muted-foreground" dateTime={entry.timestamp}>{new Date(entry.timestamp).toLocaleDateString()}</time> : null}
            </span>
          </Link>
        </li>)}
      </ul> : null}
    </section>
  );
}
