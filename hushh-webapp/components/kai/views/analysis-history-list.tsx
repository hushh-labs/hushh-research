"use client";

import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, MoreHorizontal, Search, Trash2 } from "@/components/icons";
import { SettingsGroup } from "@/components/app-ui/settings-ui";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { toInvestorDecisionLabel } from "@/lib/copy/investor-language";
import type { AnalysisHistoryEntry } from "@/lib/services/kai-history-service";
import type { HistoryEntryWithVersion } from "./columns";
import styles from "@/components/kai/shared/finance-workspace.module.css";

type HistoryActions = {
  onOpen: (entry: AnalysisHistoryEntry) => void;
  onVersions: (ticker: string) => void;
  onDelete: (entry: AnalysisHistoryEntry) => void;
  onDeleteTicker: (ticker: string) => void;
};

export function HistoryEntryRow({ entry, ...actions }: { entry: HistoryEntryWithVersion } & HistoryActions) {
  const raw = entry.raw_card as Record<string, unknown> | undefined;
  const owns = typeof raw?.owns_position === "boolean" ? raw.owns_position : typeof raw?.is_position_owned === "boolean" ? raw.is_position_owned : null;
  const decision = toInvestorDecisionLabel(entry.decision, owns);
  const time = Date.parse(entry.timestamp);
  const date = Number.isFinite(time) ? new Date(time).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "Date unavailable";
  const confidence = Number.isFinite(entry.confidence) ? `${Math.round(entry.confidence > 1 ? entry.confidence : entry.confidence * 100)}% confidence` : "Confidence unavailable";
  return <div className={styles.historyRow}>
    <button type="button" className={styles.historyPrimary} onClick={() => actions.onOpen(entry)} aria-label={`Open ${entry.ticker} analysis`}>
      <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1"><span className="text-sm font-semibold">{entry.ticker}</span><span className="text-xs text-muted-foreground">{decision.label}{raw?.analysis_degraded ? " · Limited analysis" : ""}</span></span>
      {entry.companyName ? <span className={styles.description}>{entry.companyName}</span> : null}
      <span className={styles.description}>{date} · {confidence} · Version {entry.version}</span>
    </button>
    <ShellActionSurface variant="pill" onClick={() => actions.onVersions(entry.ticker)} aria-label={`Versions for ${entry.ticker}`}>Versions</ShellActionSurface>
    <DropdownMenu><DropdownMenuTrigger asChild><ShellActionSurface variant="icon" aria-label={`Actions for ${entry.ticker}`}><MoreHorizontal className="h-4 w-4" /></ShellActionSurface></DropdownMenuTrigger>
      <DropdownMenuContent align="end" className={styles.detail}>
        <DropdownMenuItem onSelect={() => actions.onDelete(entry)}><Trash2 className="mr-2 h-4 w-4" />Delete this version</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => actions.onDeleteTicker(entry.ticker)} className="text-destructive">Delete all {entry.ticker} versions</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  </div>;
}

export function AnalysisHistoryList({ entries, ...actions }: { entries: HistoryEntryWithVersion[] } & HistoryActions) {
  const [query, setQuery] = useState("");
  const [decision, setDecision] = useState("all");
  const [pageSize, setPageSize] = useState(10);
  const [page, setPage] = useState(1);
  const filtered = useMemo(() => entries.filter(entry =>
    `${entry.ticker} ${entry.companyName || ""} ${entry.searchText || ""}`.toLowerCase().includes(query.trim().toLowerCase()) &&
    (decision === "all" || (decision === "hold" ? ["hold", "watch"].includes(entry.decision.toLowerCase()) : entry.decision.toLowerCase() === decision))), [entries, query, decision]);
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pages);
  return <div className={`${styles.detail} space-y-4`} data-no-route-swipe data-testid="analysis-history-list">
    <div className={styles.toolbar}><div className="relative w-full min-w-0"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
      <Input type="search" aria-label="Search saved analyses" placeholder="Search ticker or company" className="pl-10" value={query} onChange={event => { setQuery(event.target.value); setPage(1); }} /></div></div>
    <Select value={decision} onValueChange={value => { setDecision(value); setPage(1); }}><SelectTrigger aria-label="Saved decision" className="h-11 w-full"><SelectValue /></SelectTrigger><SelectContent>
      {([['all', 'All decisions'], ['buy', 'Buy'], ['hold', 'Hold / Watch'], ['reduce', 'Reduce']] as const).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}
    </SelectContent></Select>
    <SettingsGroup embedded>{filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize).map(entry => <HistoryEntryRow key={entry.ticker} entry={entry} {...actions} />)}
      {!filtered.length ? <p className="p-5 text-sm text-muted-foreground">No saved analyses match these filters.</p> : null}</SettingsGroup>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className={styles.description}>{filtered.length} {filtered.length === 1 ? "company" : "companies"} · Page {currentPage} of {pages}</p>
      <div className="flex items-center gap-2"><Select value={String(pageSize)} onValueChange={value => { setPageSize(Number(value)); setPage(1); }}><SelectTrigger aria-label="Analyses per page" className="h-11 w-auto"><SelectValue /></SelectTrigger><SelectContent>{[10,20,30].map(size => <SelectItem key={size} value={String(size)}>{size} per page</SelectItem>)}</SelectContent></Select>
        <ShellActionSurface variant="icon" aria-label="Previous history page" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}><ChevronLeft className="h-4 w-4" /></ShellActionSurface>
        <ShellActionSurface variant="icon" aria-label="Next history page" disabled={currentPage === pages} onClick={() => setPage(currentPage + 1)}><ChevronRight className="h-4 w-4" /></ShellActionSurface>
      </div>
    </div>
  </div>;
}
