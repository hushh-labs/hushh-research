"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { useDrivePacketSession } from "@/components/consent/drive-packet-catalog";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { Button } from "@/components/ui/button";
import { FolderRowIcon } from "@/components/icons/agents/row-icons";
import { DriveGroupService, type DriveGroupOverview, type DriveGroupPage, type DriveGroupFile, type DriveShelf } from "@/lib/services/drive-group-service";
import { openExternalUrl } from "@/lib/utils/browser-navigation";
import { usePathname } from "next/navigation";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { morphyToast } from "@/lib/morphy-ux/morphy";

type Value = { overview: DriveGroupOverview | null; selected: DriveShelf | null; page: DriveGroupPage | null;
  loading: boolean; saving: boolean; failed: "overview" | "files" | "processing" | null };
const empty = (): Value => ({ overview: null, selected: null, page: null, loading: false, saving: false, failed: null });

/** Retained by the connector owner across web/native body replacement. */
export function useDriveDataPackets(active: boolean, connection: string, background: boolean | null) {
  const session = useDrivePacketSession(`drive-groups:${connection}`);
  const lease = useMemo(() => ({ live: false, active, key: session.key, read: 0, page: 0, lock: false, selected: null as DriveShelf | null,
    token: session.token, guard: session.guard }), [active, session.key, session.token, session.guard]);
  const [stored, setStored] = useState<{ lease: typeof lease; value: Value } | null>(null);
  const value = stored?.lease === lease ? stored.value : empty();
  useLayoutEffect(() => { lease.live = active && !!lease.token; return () => { lease.live = false; lease.read++; lease.page++; }; }, [active, lease]);
  const current = useCallback(() => { if (!lease.live || !lease.token) throw new Error("inactive"); lease.guard(); }, [lease]);
  const change = useCallback((update: (value: Value) => Value) => {
    try { current(); } catch { return; }
    setStored(previous => ({ lease, value: update(previous?.lease === lease ? previous.value : empty()) }));
  }, [current, lease]);
  const refresh = useCallback(async () => {
    if (!lease.token || lease.lock) return;
    try { current(); } catch { return; }
    const attempt = ++lease.read;
    const guard = () => { current(); if (attempt !== lease.read) throw new Error("superseded"); };
    try {
      const overview = await DriveGroupService.overview(lease.token, guard);
      guard(); change(value => ({ ...value, overview, failed: value.failed === "files" ? value.failed : null }));
    } catch { try { guard(); change(value => ({ ...value, failed: "overview" })); } catch { /* Retired owner. */ } }
  }, [change, current, lease]);
  useEffect(() => {
    if (!active || !lease.token) return;
    void refresh();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 15000);
    return () => clearInterval(timer);
  }, [active, lease, refresh]);
  const load = useCallback(async (selected: DriveShelf, cursor = 0) => {
    if (!lease.token) return;
    try { current(); } catch { return; }
    lease.selected = selected;
    const attempt = ++lease.page;
    const guard = () => { current(); if (attempt !== lease.page || lease.selected !== selected) throw new Error("superseded"); };
    change(value => ({ ...value, selected, page: cursor ? value.page : null, loading: true, failed: null }));
    try {
      const page = await DriveGroupService.files(lease.token, selected, cursor, guard);
      guard(); change(value => ({ ...value, page: cursor && value.page ? { ...page,
        items: [...value.page.items.filter(old => !page.items.some(item => item.ref === old.ref)), ...page.items] } : page }));
    } catch { try { guard(); change(value => ({ ...value, failed: "files" })); } catch { /* Retired page. */ } }
    finally { try { guard(); change(value => ({ ...value, loading: false })); } catch { /* Retired page. */ } }
  }, [change, current, lease]);
  const close = useCallback(() => {
    lease.page++; lease.selected = null;
    change(value => ({ ...value, selected: null, page: null, loading: false, failed: value.failed === "files" ? null : value.failed }));
  }, [change, lease]);
  const toggle = async () => {
    if (!value.overview || !lease.token || lease.lock || !value.overview.status.enabled && background !== true) return;
    try { current(); } catch { return; }
    lease.lock = true; ++lease.read;
    change(value => ({ ...value, saving: true, failed: null }));
    try {
      const operation = DriveGroupService.setProcessing(lease.token, !value.overview.status.enabled, current);
      void morphyToast.promise(operation, { loading: "Saving…", success: "Saved", error: "Couldn’t save data packet preparation." });
      const overview = await operation;
      current(); change(value => ({ ...value, overview }));
    } catch { try { current(); change(value => ({ ...value, failed: "processing" })); } catch { /* Retired write. */ } }
    finally { lease.lock = false; change(value => ({ ...value, saving: false })); }
  };
  const status = value.overview?.status;
  const caption = !status ? "Checking data packets…" : !status.enabled ? "Prepare four folders from your Drive. Files stay in Drive." :
    background === false || status.state === "paused" ? "Preparation is paused while Background Drive access is off." :
    status.state === "ready" ? `${status.indexedFiles.toLocaleString()} files indexed.` :
    status.state === "incomplete" || status.limited ? "Some files still need checking. Saved files are shown below." :
    `${status.indexedFiles.toLocaleString()} files indexed. Preparation is continuing…`;
  return { ...value, caption, refresh, open: (key: DriveShelf) => { void load(key); }, close,
    retry: () => value.selected ? load(value.selected) : refresh(),
    more: () => value.selected && value.page?.nextCursor !== null && value.page?.nextCursor !== undefined ? load(value.selected, value.page.nextCursor) : Promise.resolve(),
    toggle, canToggle: !!status && !value.saving && (status.enabled || background === true), mutationPending: () => lease.lock,
    openFile: (file: DriveGroupFile) => { try { current(); if (lease.selected !== value.selected || !value.page?.items.some(item => item.ref === file.ref && item.viewUrl === file.viewUrl)) return; openExternalUrl(file.viewUrl); } catch { /* Retired owner. */ } },
    selectedName: value.selected === "kept" ? "Not sorted yet" : value.overview?.groups.find(group => group.shelf === value.selected)?.name ?? "Data packets",
  };
}
export type DriveDataPacketsModel = ReturnType<typeof useDriveDataPackets>;

export const DRIVE_GROUP_DISCLOSURE = "Read the first 200 KiB of supported files to suggest folders. Encrypted text starts and embeddings may be kept for files not sorted yet. Suggestions can be wrong. This does not move or share your files.";

export function DriveDataPacketsView({ model }: { model: DriveDataPacketsModel }) {
  const { overview, selected, page, loading, saving, failed } = model;
  const pathname = usePathname();
  useBackLayer(pathname, selected ? 4 : 0, () => { model.close(); return true; });
  return <section aria-label="Data packets" className="space-y-3">
    <h3 className="px-1 text-sm font-semibold text-muted-foreground">Data packets</h3>
    <p className="px-1 text-sm text-muted-foreground" role="status">{model.caption}</p>
    {overview && <SettingsGroup density="compact">{overview.groups.map(group => <SettingsRow key={group.shelf}
      icon={FolderRowIcon} title={group.name} trailing={overview.status.counts[group.shelf].toLocaleString()} chevron
      ariaLabel={`Open ${group.name}`} onClick={() => model.open(group.shelf)} />)}</SettingsGroup>}
    {overview && <>
      <Button variant="ghost" size="compact" onClick={() => model.open("kept")}>Not sorted yet · {overview.status.counts.kept.toLocaleString()}</Button>
      {selected && <div className="space-y-2 rounded-2xl border border-border p-3" aria-label={model.selectedName}>
        <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="font-semibold">{model.selectedName}</h4>
          <Button variant="ghost" size="compact" onClick={model.close}>Back to data packets</Button></div>
        {page && <p className="text-xs text-muted-foreground">{page.total.toLocaleString()} indexed files</p>}
        {!!page?.items.length && <SettingsGroup density="compact">{page.items.map(file => <SettingsRow key={file.ref} title={file.title}
          description={file.day ?? undefined} chevron ariaLabel={`Open ${file.title} in Google Drive`} onClick={() => model.openFile(file)} />)}</SettingsGroup>}
        {page && !page.items.length && !loading && <p className="text-sm text-muted-foreground">No indexed files in this folder yet.</p>}
        {loading && <p role="status" className="text-sm text-muted-foreground">Loading files…</p>}
        {failed === "files" && <p role="alert" className="text-sm">Couldn’t load files. <Button variant="ghost" size="compact" onClick={() => void model.retry()}>Retry files</Button></p>}
        {page?.nextCursor !== null && page?.nextCursor !== undefined && <Button variant="outline" size="compact" disabled={loading} onClick={() => void model.more()}>Load more files</Button>}
      </div>}
      {!overview.status.enabled && <p className="px-1 text-xs text-muted-foreground">{DRIVE_GROUP_DISCLOSURE}</p>}
      <Button variant="outline" size="compact" disabled={!model.canToggle} onClick={() => void model.toggle()}>
        {saving ? "Saving…" : overview.status.enabled ? "Pause data packets" : "Prepare data packets"}</Button>
      {!overview.status.enabled && !model.canToggle && <p className="px-1 text-xs text-muted-foreground">Turn on Background Drive access first.</p>}
    </>}
    {failed === "overview" && <p role="alert" className="text-sm">Couldn’t check data packets. <Button variant="ghost" size="compact" disabled={saving} onClick={() => void model.refresh()}>Retry data packets</Button></p>}
  </section>;
}
