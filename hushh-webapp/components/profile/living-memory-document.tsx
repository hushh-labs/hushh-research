"use client";

import { useId, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ROUTES } from "@/lib/navigation/routes";
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
  type LiveMirrorSource,
  type LiveMirrorView,
} from "@/lib/pkm/live-mirror-contract";
import {
  formatLiveMirrorDateTime,
  LIVE_MIRROR_HISTORY_FOOTER,
  liveMirrorCount,
  liveMirrorFactStateLabel,
  liveMirrorGapText,
  liveMirrorHistoryAction,
  liveMirrorHistoryDetail,
  liveMirrorRecordRows,
  liveMirrorSourceDescription,
  liveMirrorSourceStateLabel,
  liveMirrorStatus,
  type LiveMirrorStatusCopy,
} from "@/lib/pkm/live-mirror-presentation";
import { useLiveMirrorView } from "@/lib/pkm/use-live-mirror-view";

const PAGE_SIZE = 50;

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

function LiveMirrorPanel({ view, title }: { view: LiveMirrorView; title: ReactNode }) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [recordLimits, setRecordLimits] = useState<Partial<Record<string, number>>>({});
  const [historyLimit, setHistoryLimit] = useState(PAGE_SIZE);
  const records = liveMirrorRecordRows(view.facts);
  const selected = selectedKey ? records.find(record => record.key === selectedKey) ?? null : null;
  const groups = LIVE_MIRROR_KINDS
    .map(kind => ({ kind, records: records.filter(record => record.kind === kind) }))
    .filter(group => group.records.length > 0);
  const living = view.sources.filter(source => source.group === "living");
  const saved = view.sources.filter(source => source.group === "saved");
  const entries = view.history.entries;
  const sourceRow = (source: LiveMirrorSource) => (
    <SettingsRow key={source.id} title={source.label} description={liveMirrorSourceDescription(source, view.evaluatedAt)}
      trailing={liveMirrorSourceStateLabel(source.state)} />
  );
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
          <SettingsGroup title="Sources" embedded separatorInset headingClassName="mt-0">
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
                      chevron onClick={() => setSelectedKey(record.key)} />
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
          <SettingsGroup embedded separatorInset>
            {entries.length === 0
              ? <SettingsRow title="No changes yet" />
              : entries.slice(0, historyLimit).map(entry => <HistoryRow key={entry.sequence} entry={entry} facts={view.facts} />)}
          </SettingsGroup>
          {entries.length > historyLimit
            ? <ShowMore label="Show more changes" onClick={() => setHistoryLimit(limit => limit + PAGE_SIZE)} />
            : null}
          {view.history.droppedCount > 0
            ? <Footnote className="px-1">{`${liveMirrorCount(view.history.droppedCount, "older change")} not kept`}</Footnote>
            : null}
          <Footnote className="px-1">{LIVE_MIRROR_HISTORY_FOOTER}</Footnote>
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
        description={selected?.ref}
        mobilePresentation="sheet"
        showCloseButton={false}
        desktopMaxWidthClassName="sm:!max-w-[480px]"
        footer={<Button type="button" size="standard" className="w-full" onClick={() => setSelectedKey(null)}>Done</Button>}
      >
        {selected ? (
          <div className="min-w-0 space-y-3">
            <SettingsGroup embedded separatorInset>
              {selected.fields.map(field => <SettingsRow key={field.key} title={field.label} description={field.value} />)}
            </SettingsGroup>
            <SettingsGroup embedded separatorInset>
              <SettingsRow title="From" trailing={LIVE_MIRROR_SOURCE_LABELS[selected.kind]} />
              <SettingsRow title="Version" trailing={String(selected.revision)} />
              <SettingsRow title="Changed" trailing={<DateTime at={selected.sourceUpdatedAt} />} />
              <SettingsRow title="Checked" trailing={<DateTime at={selected.verifiedAt} />} />
              <SettingsRow title="Saved" trailing={<DateTime at={selected.capturedAt} />} />
            </SettingsGroup>
          </div>
        ) : null}
      </SettingsDetailPanel>
    </>
  );
}

/**
 * Profile's Live Mirror: one owner- and vault-epoch-fenced view of current
 * records, observed history and the Markdown preview. A lock shows only a
 * status line, and a different owner or epoch never shows the prior view.
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
