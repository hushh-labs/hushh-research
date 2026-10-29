"use client";

import Link from "next/link";
import { useId, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ROUTES } from "@/lib/navigation/routes";
import { SettingsDetailPanel, SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { Footnote, Headline, RowDescription, SectionLabel } from "@/components/app-ui/typography";
import { LiveActivityToday, useLiveActivityTodayCount } from "@/components/profile/live-activity-today";
import { LiveMirrorClaimLines } from "@/components/profile/live-mirror-preview";
import { SafeMarkdown } from "@/components/profile/safe-markdown";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  LIVE_MEMORY_BOUNDARY_COPY,
  LIVE_MIRROR_HIDDEN_PREDICATES,
  LIVE_MIRROR_KINDS,
  LIVE_MIRROR_SOURCE_LABELS,
  type LiveMirrorConflict,
  type LiveMirrorFact,
  type LiveMirrorHistoryEntry,
  type LiveMirrorSource,
  type LiveMirrorSourceRoute,
  type LiveMirrorView,
} from "@/lib/pkm/live-mirror-contract";
import {
  formatLiveMirrorDateTime,
  LIVE_MIRROR_HISTORY_FOOTER,
  liveMirrorClaimText,
  liveMirrorConflictKey,
  liveMirrorCount,
  liveMirrorFactStateLabel,
  liveMirrorFixRoutes,
  liveMirrorGapText,
  liveMirrorHistoryAction,
  liveMirrorHistoryDetail,
  liveMirrorRecordRows,
  liveMirrorSourceDescription,
  liveMirrorSourceRoute,
  liveMirrorSourceStateLabel,
  liveMirrorStatus,
  type LiveMirrorRecordRow,
  type LiveMirrorStatusCopy,
} from "@/lib/pkm/live-mirror-presentation";
import { useLiveMirrorView } from "@/lib/pkm/use-live-mirror-view";

const PAGE_SIZE = 50;
const HIDDEN_PREDICATES = new Set<string>(LIVE_MIRROR_HIDDEN_PREDICATES);

/** What Source details shows: one record or one disagreement, found again on every render. */
type Selection = { type: "record" | "conflict"; key: string };

function DateTime({ at }: { at: string | null }) {
  const text = formatLiveMirrorDateTime(at);
  if (!at || !text) return <span>Unknown</span>;
  return <time dateTime={at}>{text}</time>;
}

/** Only the headline is a live region; the ticking check time sits outside it. */
function StatusLine({ status }: { status: LiveMirrorStatusCopy }) {
  return (
    <div className="min-w-0 space-y-0.5 px-1">
      <Headline as="p" role="status" className="[overflow-wrap:anywhere]">{status.headline}</Headline>
      {status.sub ? <RowDescription className="[overflow-wrap:anywhere]">{status.sub}</RowDescription> : null}
    </div>
  );
}

function ShowMore({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <div className="flex justify-center pt-2">
      <Button type="button" variant="secondary" size="standard" aria-label={label} onClick={onClick}>Show more</Button>
    </div>
  );
}

function HistoryRow({ entry, facts }: { entry: LiveMirrorHistoryEntry; facts: readonly LiveMirrorFact[] }) {
  if (entry.gap) {
    return <SettingsRow title={entry.ref} description={<>
      <span>{liveMirrorGapText(entry.gap)}</span><span> · </span><DateTime at={entry.capturedAt} />
    </>} />;
  }
  const detail = liveMirrorHistoryDetail(entry, facts);
  return <SettingsRow title={entry.ref} trailing={entry.current ? "Now" : "Earlier"} description={<>
    <span>{liveMirrorHistoryAction(entry)}</span><span> · </span><DateTime at={entry.capturedAt} />
    {detail ? <><span> · </span><span>{detail}</span></> : null}
  </>} />;
}

/** A disagreement's identity: its predicate and where each claim came from, so it holds while values change. */
/**
 * Corrections happen at the source, never in the mirror or its Markdown. Each
 * link is titled by where it goes ("Edit profile") and closes the sheet first.
 */
function FixLinks({ routes, onNavigate }: { routes: readonly LiveMirrorSourceRoute[]; onNavigate: () => void }) {
  if (routes.length === 0) return null;
  return (
    <SettingsGroup embedded separatorInset>
      {routes.map(route => (
        <SettingsRow key={route.href} asChild chevron title={route.label}>
          <Link href={route.href} onClick={onNavigate} />
        </SettingsRow>
      ))}
    </SettingsGroup>
  );
}

function RecordDetails({ record, onNavigate }: { record: LiveMirrorRecordRow; onNavigate: () => void }) {
  const route = liveMirrorSourceRoute(record.kind);
  return (
    <div className="min-w-0 space-y-3">
      <SettingsGroup embedded separatorInset>
        {record.fields.map(field => <SettingsRow key={field.key} title={field.label} description={field.value} />)}
      </SettingsGroup>
      <SettingsGroup embedded separatorInset>
        <SettingsRow title="From" trailing={LIVE_MIRROR_SOURCE_LABELS[record.kind]} />
        <SettingsRow title="Version" trailing={String(record.revision)} />
        <SettingsRow title="Changed" trailing={<DateTime at={record.sourceUpdatedAt} />} />
        <SettingsRow title="Checked" trailing={<DateTime at={record.verifiedAt} />} />
        <SettingsRow title="Saved" trailing={<DateTime at={record.capturedAt} />} />
      </SettingsGroup>
      <FixLinks routes={route ? [route] : []} onNavigate={onNavigate} />
    </div>
  );
}

/**
 * Every claim with its source, worded by the shared claim formatter, then one
 * link to each place a side is corrected, in claim order: memory.md for what
 * the owner wrote, else the screen that owns the source.
 */
function ConflictDetails({ conflict, now, onNavigate }: { conflict: LiveMirrorConflict; now: string; onNavigate: () => void }) {
  return (
    <div className="min-w-0 space-y-3">
      <SettingsGroup embedded separatorInset>
        {conflict.claims.map((claim, index) => {
          const { label, value, detail } = liveMirrorClaimText(claim, conflict.predicate, now);
          return <SettingsRow key={`${claim.source}:${index}`} title={`${label}: ${value}`} description={detail ?? undefined} />;
        })}
      </SettingsGroup>
      <FixLinks routes={liveMirrorFixRoutes([conflict])} onNavigate={onNavigate} />
    </div>
  );
}

function LiveMirrorPanel({ view, title }: { view: LiveMirrorView; title: ReactNode }) {
  const [selection, setSelection] = useState<Selection | null>(null);
  const [recordLimits, setRecordLimits] = useState<Partial<Record<string, number>>>({});
  const [historyLimit, setHistoryLimit] = useState(PAGE_SIZE);
  const records = liveMirrorRecordRows(view.facts);
  // Other people's identifiers never render, not even inside a disagreement.
  const conflicts = (view.conflicts ?? []).filter(conflict => !HIDDEN_PREDICATES.has(conflict.predicate));
  const selectedRecord = selection?.type === "record" ? records.find(record => record.key === selection.key) ?? null : null;
  const selectedConflict = selection?.type === "conflict"
    ? conflicts.find(conflict => liveMirrorConflictKey(conflict) === selection.key) ?? null
    : null;
  const closeDetails = () => setSelection(null);
  const groups = LIVE_MIRROR_KINDS
    .map(kind => ({ kind, records: records.filter(record => record.kind === kind) }))
    .filter(group => group.records.length > 0);
  const living = view.sources.filter(source => source.group === "living");
  const saved = view.sources.filter(source => source.group === "saved");
  const entries = view.history.entries;
  const todayCount = useLiveActivityTodayCount();
  const sourceRow = (source: LiveMirrorSource) => {
    const description = liveMirrorSourceDescription(source, view.evaluatedAt);
    const state = liveMirrorSourceStateLabel(source.state);
    const route = source.kind ? liveMirrorSourceRoute(source.kind) : null;
    if (!route) return <SettingsRow key={source.id} title={source.label} description={description} trailing={state} />;
    // The whole row goes where this source's values are changed; its state keeps the right-hand column.
    return (
      <SettingsRow key={source.id} asChild chevron title={source.label} trailing={state} description={<>
        {description ? <span className="block">{description}</span> : null}
        <span className="block font-medium text-[color:var(--app-accent-deep)]">{route.label}</span>
      </>}>
        <Link href={route.href} />
      </SettingsRow>
    );
  };
  return (
    <>
      {title}
      <StatusLine status={liveMirrorStatus(view.overall, view)} />
      <Footnote className="px-1">{LIVE_MEMORY_BOUNDARY_COPY}</Footnote>
      <Tabs defaultValue="facts" className="min-w-0 gap-3">
        <TabsList className="w-full">
          <TabsTrigger value="facts" className="min-h-11">Facts</TabsTrigger>
          <TabsTrigger value="history" className="min-h-11">History</TabsTrigger>
          <TabsTrigger value="preview" className="min-h-11">Preview</TabsTrigger>
        </TabsList>
        <TabsContent value="facts" className="min-w-0">
          {conflicts.length > 0 ? (
            // Every claim stays visible with its source; no value is chosen or
            // hidden. The heading names the state once, so rows carry no badge.
            <SettingsGroup title="Sources disagree" embedded separatorInset headingClassName="mt-0">
              {conflicts.map((conflict, index) => {
                const key = liveMirrorConflictKey(conflict);
                return (
                  <SettingsRow key={`${key}:${index}`} title={conflict.label}
                    description={<LiveMirrorClaimLines conflict={conflict} now={view.evaluatedAt} />}
                    chevron onClick={() => setSelection({ type: "conflict", key })} />
                );
              })}
            </SettingsGroup>
          ) : null}
          <SettingsGroup title="Sources" embedded separatorInset headingClassName={conflicts.length > 0 ? undefined : "mt-0"}>
            {living.map(sourceRow)}
          </SettingsGroup>
          {groups.map(group => {
            const limit = recordLimits[group.kind] ?? PAGE_SIZE;
            const label = LIVE_MIRROR_SOURCE_LABELS[group.kind];
            return (
              <div key={group.kind} className="min-w-0">
                <SettingsGroup title={label} embedded separatorInset>
                  {group.records.slice(0, limit).map(record => (
                    <SettingsRow key={record.key} title={record.ref} description={record.summary}
                      trailing={liveMirrorFactStateLabel(record.state) ?? undefined}
                      chevron onClick={() => setSelection({ type: "record", key: record.key })} />
                  ))}
                </SettingsGroup>
                {group.records.length > limit ? (
                  <ShowMore label={`Show more ${label}`}
                    onClick={() => setRecordLimits(current => ({ ...current, [group.kind]: limit + PAGE_SIZE }))} />
                ) : null}
              </div>
            );
          })}
          {saved.length ? <SettingsGroup title="Saved details" embedded separatorInset>{saved.map(sourceRow)}</SettingsGroup> : null}
        </TabsContent>
        <TabsContent value="history" className="min-w-0 space-y-3">
          <LiveActivityToday />
          {entries.length > 0 || todayCount === 0 ? (
            <SettingsGroup embedded separatorInset>
              {entries.length === 0
                ? <SettingsRow title="No changes yet" />
                : entries.slice(0, historyLimit).map(entry => <HistoryRow key={entry.sequence} entry={entry} facts={view.facts} />)}
            </SettingsGroup>
          ) : null}
          {entries.length > historyLimit
            ? <ShowMore label="Show more changes" onClick={() => setHistoryLimit(limit => limit + PAGE_SIZE)} />
            : null}
          {view.history.droppedCount > 0
            ? <Footnote className="px-1">{`${liveMirrorCount(view.history.droppedCount, "older change")} not kept`}</Footnote>
            : null}
          <Footnote className="px-1">{LIVE_MIRROR_HISTORY_FOOTER}</Footnote>
        </TabsContent>
        <TabsContent value="preview" className="min-w-0">
          {view.markdown.trim() ? (
            // "live-mirror-markdown" keeps money table cells on one line so the table scrolls on a phone.
            <div aria-label="Live memory preview" className="soul-memory-document live-mirror-markdown min-w-0 px-1">
              <SafeMarkdown markdown={view.markdown} gfm linkPolicy="internal" />
            </div>
          ) : <Footnote className="px-1">Nothing to preview yet</Footnote>}
        </TabsContent>
      </Tabs>
      <SettingsDetailPanel
        open={selectedRecord !== null || selectedConflict !== null}
        onOpenChange={(open) => { if (!open) closeDetails(); }}
        title="Source details"
        description={selectedRecord?.ref ?? selectedConflict?.label}
        mobilePresentation="sheet"
        showCloseButton={false}
        desktopMaxWidthClassName="sm:!max-w-[480px]"
        footer={<Button type="button" size="standard" className="w-full" onClick={closeDetails}>Done</Button>}
      >
        {selectedRecord ? <RecordDetails record={selectedRecord} onNavigate={closeDetails} />
          : selectedConflict ? <ConflictDetails conflict={selectedConflict} now={view.evaluatedAt} onNavigate={closeDetails} /> : null}
      </SettingsDetailPanel>
    </>
  );
}

/**
 * Profile's Live Mirror: one owner- and vault-epoch-fenced view of current
 * records, disagreements, observed history and the Markdown preview. A lock
 * shows only a status line, and a different owner or epoch never shows the
 * prior view. Corrections go to the source; nothing here writes the mirror.
 */
export function LivingMemoryDocument() {
  const router = useRouter();
  const state = useLiveMirrorView();
  const headingId = useId();
  if (state.status === "locked") {
    return <section aria-label="Live memory" className="min-w-0"><StatusLine status={liveMirrorStatus("locked")} /></section>;
  }
  const title = <>
    <SectionLabel as="h2" id={headingId} className="px-1">Live memory</SectionLabel>
    <SettingsGroup embedded separatorInset>
      <SettingsRow title="Saved and Add" description="Open saved memories, sharing and prices."
        voiceControlId="profile_memory_workspace" voiceActionId="route.one_pkm"
        chevron onClick={() => router.push(ROUTES.PKM)} />
    </SettingsGroup>
  </>;
  return (
    <section aria-labelledby={headingId} className="min-w-0 space-y-3">
      {state.status === "loading" ? (
        <>
          {title}
          <StatusLine status={liveMirrorStatus("loading")} />
          <Footnote className="px-1">{LIVE_MEMORY_BOUNDARY_COPY}</Footnote>
        </>
      ) : (
        // Local selection and paging never carry across owners or vault epochs.
        <LiveMirrorPanel key={`${state.view.ownerId}:${state.view.vaultEpoch}`} view={state.view} title={title} />
      )}
    </section>
  );
}
