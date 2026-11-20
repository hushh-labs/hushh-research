"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { SettingsDetailPanel, SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { FileText } from "@/components/icons";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { useFinanceShareContext } from "@/lib/finance-sharing/use-finance-share-context";
import { useAuth } from "@/hooks/use-auth";
import { buildConsentCenterHref } from "@/lib/consent/consent-sheet-route";
import { armFeedSearchReturn } from "@/lib/feed/feed-search-memory";
import { feedResultHref } from "@/lib/feed/result-navigation";
import { DriveSharedFileSearchService, type SharedFileAudience, type SharedFileMatch, type SharedFileSearchCriteria } from "@/lib/services/drive-shared-file-search-service";

type Page = { files: SharedFileMatch[]; cursor: string | null; failed?: boolean; checked?: boolean };
type Selection = Pick<SharedFileMatch, "requestId" | "fileRef" | "audience">;
type Options = { criteria: SharedFileSearchCriteria; revision?: number; onCount: (count: number | null) => void };
const AUDIENCES: SharedFileAudience[] = ["owner", "requester"];
const VaultUnlockDialog = dynamic(() => import("@/components/vault/vault-unlock-dialog").then(module => module.VaultUnlockDialog), { ssr: false });

/** Reuse the canonical owner/vault capture. Filenames never enter Feed metadata,
 * route parameters, persistent caches, or the Firebase-only activity endpoint. */
export function FeedDriveSearch(options: Options) {
  const { ready, session, capture } = useFinanceShareContext();
  const { user } = useAuth();
  const [unlock, setUnlock] = useState(false);
  const { query, personRef, fromAt, beforeAt } = options.criteria;
  const criteria = useMemo(() => ({ query, personRef, fromAt, beforeAt }), [query, personRef, fromAt, beforeAt]);
  return ready ? <UnlockedFileSearch key={`${session}:${JSON.stringify(criteria)}`} capture={capture} {...options} criteria={criteria} /> : <>
    <Button variant="ghost" onClick={() => setUnlock(true)}>Unlock to search files</Button>
    {user && unlock ? <VaultUnlockDialog user={user} open onOpenChange={setUnlock} onSuccess={() => setUnlock(false)} allowVaultCreation={false} title="Unlock your vault" description="Search permitted filenames." /> : null}
  </>;
}

function UnlockedFileSearch({ criteria, revision, onCount, capture }: Options & { capture: ReturnType<typeof useFinanceShareContext>["capture"] }) {
  const [pages, setPages] = useState<Partial<Record<SharedFileAudience, Page>>>({});
  const [busy, setBusy] = useState(true);
  const [visibilityRevision, setVisibilityRevision] = useState(0);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [detail, setDetail] = useState<{ key: string; file?: SharedFileMatch; failed?: boolean } | null>(null);
  const generation = useRef(0), detailGeneration = useRef(0);
  const pagesRef = useRef(pages);
  useLayoutEffect(() => { pagesRef.current = pages; }, [pages]);
  const search = useCallback(async (append = false) => {
    const context = capture();
    if (!context || !context.isCurrent()) return;
    const request = ++generation.current;
    const current = () => generation.current === request && context.isCurrent();
    setBusy(true);
    const old = pagesRef.current;
    const roles = AUDIENCES.filter(role => !append || old[role]?.cursor || old[role]?.failed);
    const result = await Promise.allSettled(roles.map(async audience => ({ audience,
      page: await DriveSharedFileSearchService.search(context.vaultOwnerToken, audience, criteria, append ? old[audience]?.cursor ?? null : null),
    })));
    if (!current()) return;
    const next = { ...(append ? old : {}) };
    result.forEach((value, index) => {
      const audience = roles[index];
      if (value.status === "rejected") { next[audience] = { files: append ? old[audience]?.files || [] : [], cursor: old[audience]?.cursor || null, failed: true, checked: true }; return; }
      const { files, nextCursor } = value.value.page;
      next[audience] = { files: [...new Map([...(append ? old[audience]?.files || [] : []), ...files].map(file => [file.fileRef, file])).values()], cursor: nextCursor, checked: true };
    });
    setPages(next); setBusy(false);
  }, [capture, criteria]);
  const invalidate = useCallback(() => { generation.current++; detailGeneration.current++; }, []);
  const invalidateDetail = useCallback(() => { detailGeneration.current++; }, []);
  useEffect(() => {
    void search();
    return invalidate;
  }, [search, revision, visibilityRevision, invalidate]);
  useEffect(() => {
    const resume = () => {
      generation.current++; detailGeneration.current++;
      setPages({}); setDetail(null); setBusy(true);
      if (!document.hidden) setVisibilityRevision(value => value + 1);
    };
    document.addEventListener("visibilitychange", resume);
    return () => document.removeEventListener("visibilitychange", resume);
  }, []);
  const files = AUDIENCES.flatMap(audience => pages[audience]?.files || []).sort((a,b) => Date.parse(b.recordedAt)-Date.parse(a.recordedAt));
  const more = AUDIENCES.some(audience => pages[audience]?.cursor);
  const failed = AUDIENCES.some(audience => pages[audience]?.failed);
  useEffect(() => { onCount(busy || more || failed ? null : files.length); }, [onCount, busy, more, failed, files.length]);
  const close = useCallback(() => { detailGeneration.current++; setSelection(null); setDetail(null); return true; }, []);
  useBackLayer("/one/feed", selection ? 2 : 0, close);
  useEffect(() => {
    if (!selection) return;
    const context = capture();
    if (!context || !context.isCurrent()) return;
    const request = ++detailGeneration.current;
    const key = JSON.stringify(selection);
    const current = () => detailGeneration.current === request && context.isCurrent();
    setDetail(null);
    void DriveSharedFileSearchService.open(context.vaultOwnerToken, selection)
      .then(file => { if (current()) setDetail({ key, file }); })
      .catch(() => { if (current()) setDetail({ key, failed: true }); });
    return invalidateDetail;
  }, [selection, capture, visibilityRevision, invalidateDetail]);
  const visible = selection && detail?.key === JSON.stringify(selection) ? detail : null;
  const requestHref = visible?.file ? feedResultHref(buildConsentCenterHref("pending", { requestId: `document_share_request:${visible.file.requestId}`,
    ...(visible.file.audience === "requester" ? { requestView: "sent" as const } : {}), from: "/one/feed" })) : null;
  return <section aria-label="Matching files" className="space-y-2">
    {files.length ? <SettingsGroup separatorInset>{files.map(file => <SettingsRow key={`${file.audience}:${file.fileRef}`} icon={FileText} title={file.name}
      description={`Drive · ${new Date(file.recordedAt).toLocaleDateString()}`} chevron onClick={() => setSelection({ requestId: file.requestId, fileRef: file.fileRef, audience: file.audience })} />)}</SettingsGroup> : null}
    {failed ? <p role="status" className="text-xs text-muted-foreground">Some files couldn’t be checked.</p> : null}
    {busy ? <p role="status" className="text-xs text-muted-foreground">Searching files…</p> : more || failed ? <Button variant="ghost" onClick={() => void search(true)}>{failed ? "Retry files" : "More files"}</Button> : null}
    {selection ? <SettingsDetailPanel open onOpenChange={open => { if (!open) close(); }} mobilePresentation="sheet" title={visible?.file?.name || "File"} headerTextOverflow="wrap">
      <div className="space-y-3 px-4 pb-5">
        {!visible ? <p role="status" className="text-sm text-muted-foreground">Checking access…</p> : visible.failed ? <p role="status" className="text-sm text-muted-foreground">File unavailable</p> : visible.file ? <>
          <p className="text-sm text-muted-foreground">{visible.file.status === "access_changed" ? "Sharing changed" : "Shared"}</p>
          <Button asChild><a href={visible.file.openUrl} target="_blank" rel="noopener noreferrer">Open file</a></Button>
          {requestHref ? <Button asChild variant="ghost"><Link href={requestHref} onClick={() => armFeedSearchReturn(requestHref)} prefetch={false}>View request</Link></Button> : null}
        </> : null}
      </div>
    </SettingsDetailPanel> : null}
  </section>;
}
