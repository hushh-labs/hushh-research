"use client";

import { useId, useState, type ReactNode } from "react";
import { SettingsDetailPanel, SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { Footnote, Headline, RowDescription, SectionLabel } from "@/components/app-ui/typography";
import { SafeMarkdown } from "@/components/profile/safe-markdown";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  LIVE_MEMORY_BOUNDARY_COPY,
  LIVE_MIRROR_KINDS,
  LIVE_MIRROR_SOURCE_LABELS,
  type LiveMirrorFact,
  type LiveMirrorHistoryEntry,
  type LiveMirrorOverall,
  type LiveMirrorSource,
  type LiveMirrorSourceState,
  type LiveMirrorView,
} from "@/lib/pkm/live-mirror-contract";
import {
  compareLiveMirrorFacts,
  formatLiveMirrorValue,
  LIVE_MIRROR_OVERALL_HEADLINES,
  waitingText,
} from "@/lib/pkm/live-mirror-projection";
import { useLiveMirrorView } from "@/lib/pkm/use-live-mirror-view";

const PAGE_SIZE = 50;
const SOURCE_STATE_LABELS: Record<LiveMirrorSourceState, string> = {
  current: "Current",
  updating: "Updating",
  stale: "Out of date",
  unavailable: "Unavailable",
  withheld: "Withheld",
  conflict: "Needs review",
  not_checked: "Not checked",
};
const DATE_TIME = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function ago(at: string, now: string): string {
  const minutes = Math.floor(Math.max(0, Date.parse(now) - Date.parse(at)) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

function duration(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  return `${Math.round(ms / 3_600_000)} hr`;
}

function DateTime({ at }: { at: string | null }) {
  if (!at || !Number.isFinite(Date.parse(at))) return <span>Unknown</span>;
  return <time dateTime={at}>{DATE_TIME.format(new Date(at))}</time>;
}

function statusSub(view: LiveMirrorView): string | null {
  const at = view.lastVerifiedAt;
  switch (view.overall) {
    case "current": return at ? `Checked ${ago(at, view.evaluatedAt)}` : null;
    case "updating": return "Checking your latest change";
    case "stale": return at ? `Last checked ${ago(at, view.evaluatedAt)}` : null;
    case "partial": return "Showing what we could check";
    case "conflict": return "Two sources disagree";
    case "empty": return "New changes will show here";
    default: return null;
  }
}

function StatusLine({ overall, sub }: { overall: LiveMirrorOverall; sub?: string | null }) {
  return (
    <div role="status" className="min-w-0 space-y-0.5 px-1">
      <Headline as="p" className="[overflow-wrap:anywhere]">{LIVE_MIRROR_OVERALL_HEADLINES[overall]}</Headline>
      {sub ? <RowDescription>{sub}</RowDescription> : null}
    </div>
  );
}

function sourceDescription(source: LiveMirrorSource, now: string): string | undefined {
  const at = source.verifiedAt ? ago(source.verifiedAt, now) : null;
  const parts: string[] = [];
  if (source.state === "unavailable") parts.push(at ? `Couldn’t check · last ${at}` : "Couldn’t check");
  else if (source.state === "withheld") parts.push("Kept out of memory");
  else if (source.state === "stale") parts.push(at ? `Last checked ${at}` : "Not checked yet");
  else if (source.state !== "not_checked" && at) parts.push(`Checked ${at}`);
  if (source.state !== "withheld" && source.withheld.length > 0) parts.push("Some details kept out");
  const waiting = waitingText(source.pendingChanges);
  if (waiting) parts.push(waiting);
  if (source.lastLagMs !== null && source.state !== "unavailable") parts.push(`Updated ${duration(source.lastLagMs)} after change`);
  return parts.length ? parts.join(" · ") : undefined;
}

function factTitle(fact: LiveMirrorFact): string {
  return fact.kind === "profile" ? fact.label : `${fact.ref} · ${fact.label}`;
}

function FactValue({ fact }: { fact: LiveMirrorFact }) {
  if (fact.state === "conflicted") return <span>Sources disagree</span>;
  const lastKnown = fact.state === "stale" || fact.state === "unavailable";
  return <><span>{formatLiveMirrorValue(fact.predicate, fact.value)}</span>{lastKnown ? <span> · Last known</span> : null}</>;
}

function ShowMore({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <div className="flex justify-center pt-2">
      <Button type="button" variant="secondary" size="standard" aria-label={label} onClick={onClick}>Show more</Button>
    </div>
  );
}

function HistoryRow({ entry }: { entry: LiveMirrorHistoryEntry }) {
  if (entry.gap) {
    const count = entry.gap.committedChanges;
    return <SettingsRow title={entry.ref} description={<>
      <span>{count === null ? "Some changes may be missing." : `${count} ${count === 1 ? "change" : "changes"} made. Only the latest seen.`}</span>
      <span> · </span><DateTime at={entry.capturedAt} />
    </>} />;
  }
  const action = entry.operation === "delete" ? "Removed" : entry.revision === 1 ? "Added" : "Changed";
  const detail = entry.redacted
    ? "Details hidden"
    : entry.changes.map(change => `${change.label}: ${formatLiveMirrorValue(change.predicate, change.value)}`).join(", ");
  return <SettingsRow title={entry.ref} trailing={entry.current ? "Now" : "Earlier"} description={<>
    <span>{action}</span><span> · </span><DateTime at={entry.capturedAt} />
    {detail ? <><span> · </span><span>{detail}</span></> : null}
  </>} />;
}

function LiveMirrorPanel({ view, title }: { view: LiveMirrorView; title: ReactNode }) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [factLimits, setFactLimits] = useState<Partial<Record<string, number>>>({});
  const [historyLimit, setHistoryLimit] = useState(PAGE_SIZE);
  const selected = selectedKey ? view.facts.find(fact => fact.key === selectedKey) ?? null : null;
  const facts = [...view.facts].sort(compareLiveMirrorFacts);
  const groups = LIVE_MIRROR_KINDS
    .map(kind => ({ kind, facts: facts.filter(fact => fact.kind === kind) }))
    .filter(group => group.facts.length > 0);
  const living = view.sources.filter(source => source.group === "living");
  const saved = view.sources.filter(source => source.group === "saved");
  const entries = view.history.entries;
  const sourceRow = (source: LiveMirrorSource) => (
    <SettingsRow key={source.id} title={source.label} description={sourceDescription(source, view.evaluatedAt)}
      trailing={SOURCE_STATE_LABELS[source.state]} />
  );
  return (
    <>
      {title}
      <StatusLine overall={view.overall} sub={statusSub(view)} />
      <Footnote className="px-1">{LIVE_MEMORY_BOUNDARY_COPY}</Footnote>
      <Tabs defaultValue="facts" className="min-w-0 gap-3">
        <TabsList className="w-full">
          <TabsTrigger value="facts" className="min-h-11">Facts</TabsTrigger>
          <TabsTrigger value="history" className="min-h-11">History</TabsTrigger>
          <TabsTrigger value="preview" className="min-h-11">Preview</TabsTrigger>
        </TabsList>
        <TabsContent value="facts" className="min-w-0">
          <SettingsGroup title="Sources" embedded separatorInset headingClassName="mt-0">
            {living.map(sourceRow)}
          </SettingsGroup>
          {groups.map(group => {
            const limit = factLimits[group.kind] ?? PAGE_SIZE;
            const label = LIVE_MIRROR_SOURCE_LABELS[group.kind];
            return (
              <div key={group.kind} className="min-w-0">
                <SettingsGroup title={label} embedded separatorInset>
                  {group.facts.slice(0, limit).map(fact => (
                    <SettingsRow key={fact.key} title={factTitle(fact)} description={<FactValue fact={fact} />}
                      chevron onClick={() => setSelectedKey(fact.key)} />
                  ))}
                </SettingsGroup>
                {group.facts.length > limit ? (
                  <ShowMore label={`Show more ${label}`}
                    onClick={() => setFactLimits(current => ({ ...current, [group.kind]: limit + PAGE_SIZE }))} />
                ) : null}
              </div>
            );
          })}
          {saved.length ? <SettingsGroup title="Saved details" embedded separatorInset>{saved.map(sourceRow)}</SettingsGroup> : null}
        </TabsContent>
        <TabsContent value="history" className="min-w-0 space-y-3">
          <SettingsGroup embedded separatorInset>
            {entries.length === 0
              ? <SettingsRow title="No changes yet" />
              : entries.slice(0, historyLimit).map(entry => <HistoryRow key={entry.sequence} entry={entry} />)}
          </SettingsGroup>
          {entries.length > historyLimit
            ? <ShowMore label="Show more changes" onClick={() => setHistoryLimit(limit => limit + PAGE_SIZE)} />
            : null}
          {view.history.droppedCount > 0 ? <Footnote className="px-1">{`${view.history.droppedCount} older changes not kept`}</Footnote> : null}
          <Footnote className="px-1">Only changes seen while open</Footnote>
        </TabsContent>
        <TabsContent value="preview" className="min-w-0">
          {view.markdown.trim()
            ? <div aria-label="Live memory preview" className="soul-memory-document min-w-0 px-1"><SafeMarkdown markdown={view.markdown} gfm={false} /></div>
            : <Footnote className="px-1">Nothing to preview yet</Footnote>}
        </TabsContent>
      </Tabs>
      <SettingsDetailPanel
        open={selected !== null}
        onOpenChange={(open) => { if (!open) setSelectedKey(null); }}
        title="Source details"
        description={selected ? factTitle(selected) : undefined}
        mobilePresentation="sheet"
        showCloseButton={false}
        desktopMaxWidthClassName="sm:!max-w-[480px]"
        footer={<Button type="button" size="standard" className="w-full" onClick={() => setSelectedKey(null)}>Done</Button>}
      >
        {selected ? (
          <SettingsGroup embedded separatorInset>
            <SettingsRow title="From" trailing={LIVE_MIRROR_SOURCE_LABELS[selected.kind]} />
            <SettingsRow title="Version" trailing={String(selected.revision)} />
            <SettingsRow title="Changed" trailing={<DateTime at={selected.sourceUpdatedAt} />} />
            <SettingsRow title="Checked" trailing={<DateTime at={selected.verifiedAt} />} />
            <SettingsRow title="Saved" trailing={<DateTime at={selected.capturedAt} />} />
          </SettingsGroup>
        ) : null}
      </SettingsDetailPanel>
    </>
  );
}

/**
 * Profile's Live Mirror: one owner- and vault-epoch-fenced view of current
 * facts, observed history and the Markdown preview. A lock shows only a
 * status line, and a different owner or epoch never shows the prior view.
 */
export function LivingMemoryDocument() {
  const state = useLiveMirrorView();
  const headingId = useId();
  if (state.status === "locked") {
    return <section aria-label="Live memory" className="min-w-0"><StatusLine overall="locked" sub="Unlock to see it" /></section>;
  }
  const title = <SectionLabel as="h2" id={headingId} className="px-1">Live memory</SectionLabel>;
  return (
    <section aria-labelledby={headingId} className="min-w-0 space-y-3">
      {state.status === "loading" ? (
        <>
          {title}
          <StatusLine overall="loading" />
          <Footnote className="px-1">{LIVE_MEMORY_BOUNDARY_COPY}</Footnote>
        </>
      ) : (
        // Local selection and paging never carry across owners or vault epochs.
        <LiveMirrorPanel key={`${state.view.ownerId}:${state.view.vaultEpoch}`} view={state.view} title={title} />
      )}
    </section>
  );
}
