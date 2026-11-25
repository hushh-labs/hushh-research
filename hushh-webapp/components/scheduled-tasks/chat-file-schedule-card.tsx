"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SurfaceCard } from "@/components/app-ui/surfaces";
import { localScheduleInput, type FileScheduleProposal } from "@/lib/agent/file-schedule-proposal";
import { FilesService, type FileEntry } from "@/lib/files/service";
import { withUnlockedFilesConnection } from "@/lib/files/use-files-connection";
import { ROUTES } from "@/lib/navigation/routes";
import { FILE_ORGANIZATION_TEMPLATE, PodScheduledTasksClient, scheduledTaskHref, type ScheduledTask } from "@/lib/services/pod-scheduled-tasks";
import { ScheduleFileDialog } from "./schedule-file-dialog";

type FilesCredentials = Omit<Parameters<typeof withUnlockedFilesConnection>[0], "signal">;
type Folder = Pick<FileEntry, "id" | "name">;
type ReviewEntry = Pick<FileEntry, "id" | "name" | "kind" | "revision">;

/** Select exact owner library metadata and keep it in this review, outside the transcript. */
export function ChatFileScheduleCard({ proposal, credentials, onDismiss }: {
  proposal: FileScheduleProposal;
  credentials: FilesCredentials;
  onDismiss: () => void;
}) {
  const client = useMemo(() => new PodScheduledTasksClient(credentials.userId), [credentials.userId]);
  const [choosing, setChoosing] = useState(false);
  const [folderPath, setFolderPath] = useState<Folder[]>([]);
  const [cursor, setCursor] = useState("");
  const [page, setPage] = useState<{ entries: ReviewEntry[]; next: string; analysisRevision: number } | null>(null);
  const [selection, setSelection] = useState<(ReviewEntry & { analysisRevision: number }) | null>(null);
  const [result, setResult] = useState<ScheduledTask | null>(null);
  const [error, setError] = useState("");
  const parent = folderPath.at(-1)?.id ?? "root";

  useEffect(() => {
    if (!choosing) return;
    const request = new AbortController();
    setPage(null);
    setError("");
    void (async () => {
      try {
        const status = await client.status(request.signal);
        if (!status.available || !status.templates.includes(FILE_ORGANIZATION_TEMPLATE)) {
          if (!request.signal.aborted) setError("File scheduling is unavailable on your private agent.");
          return;
        }
        const entries = await withUnlockedFilesConnection({ ...credentials, signal: request.signal }, async hosting => {
          if (hosting !== "pod") throw new Error("SCHEDULE_OWNER_POD_REQUIRED");
          const settings = await FilesService.settings(request.signal);
          if (!settings.analysis || !settings.backgroundAvailable || folderPath.some(folder => settings.excluded.includes(folder.id))) {
            throw new Error("SCHEDULE_FILES_NOT_ELIGIBLE");
          }
          const files = await FilesService.list(parent, cursor, false, request.signal);
          const eligible = files.entries.filter(entry => entry.state === "ready" && !settings.excluded.includes(entry.id));
          return { entries: eligible.map(({ id, name, kind, revision }) => ({ id, name, kind, revision })),
            next: files.cursor, analysisRevision: settings.revision };
        });
        if (!request.signal.aborted) setPage(entries);
      } catch {
        if (!request.signal.aborted) setError("A qualified private Pod and Files analysis permission are required to schedule organization.");
      }
    })();
    return () => request.abort();
  }, [choosing, client, credentials, cursor, folderPath, parent]);

  const verifySelection = async (signal: AbortSignal) => {
    if (!selection) throw new Error("SCHEDULE_FILE_REQUIRED");
    await withUnlockedFilesConnection({ ...credentials, signal }, async hosting => {
      if (hosting !== "pod") throw new Error("SCHEDULE_OWNER_POD_REQUIRED");
      const settings = await FilesService.settings(signal);
      const current = await FilesService.entry(selection.id, signal);
      if (!settings.analysis || !settings.backgroundAvailable || settings.revision !== selection.analysisRevision ||
        current.kind !== "file" || current.state !== "ready" ||
        current.id !== selection.id || current.revision !== selection.revision || current.name !== selection.name ||
        [current.id, ...folderPath.map(folder => folder.id)].some(id => settings.excluded.includes(id))) {
        throw new Error("SCHEDULE_FILE_CHANGED");
      }
    });
  };

  return (
    <SurfaceCard className="my-3 space-y-3 p-4" aria-label="File organization proposal">
      <h3 className="font-medium">{result?.state === "completed" ? "File run completed" :
        result?.state === "running" ? "File run in progress" : result ? "File organization scheduled" : "Organize a file later"}</h3>
      {result ? (
        <>
          <p className="text-sm text-muted-foreground">{result.title}{result.state === "scheduled"
            ? ` · ${new Date(result.next_run_at * 1000).toLocaleString()}` : null}</p>
          <Button asChild variant="outline"><Link href={scheduledTaskHref(result.id)}>View in Tasks</Link></Button>
        </>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">Choose a file and confirm when your private agent should organize it.</p>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => setChoosing(true)}>Choose file</Button>
            <Button variant="ghost" onClick={onDismiss}>Dismiss</Button>
          </div>
        </>
      )}
      <Dialog open={choosing} onOpenChange={setChoosing}>
        <DialogContent className="max-h-[85dvh] overflow-auto sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Choose a file to organize</DialogTitle>
            <DialogDescription>{folderPath.at(-1)?.name ?? "Private Files"}</DialogDescription>
          </DialogHeader>
          {folderPath.length ? <Button variant="outline" onClick={() => {
            setCursor(""); setFolderPath(path => path.slice(0, -1));
          }}>Parent folder</Button> : null}
          {error ? <p role="alert" className="text-sm">{error}</p> : null}
          {!page && !error ? <p role="status" className="text-sm">Checking private Files…</p> : null}
          {page?.entries.length === 0 ? <p className="text-sm">No eligible files or folders on this page.</p> : null}
          {page?.entries.map(entry => (
            <Button key={entry.id} variant="outline" className="h-auto min-h-11 justify-start whitespace-normal break-all text-left" onClick={() => {
              if (entry.kind === "folder") {
                setCursor(""); setFolderPath(path => [...path, entry]);
              } else {
                setSelection({ ...entry, analysisRevision: page.analysisRevision }); setChoosing(false);
              }
            }}>{entry.kind === "folder" ? `Open ${entry.name}` : entry.name}</Button>
          ))}
          {page?.next ? <Button variant="ghost" onClick={() => setCursor(page.next)}>More files</Button> : null}
        </DialogContent>
      </Dialog>
      {selection ? <ScheduleFileDialog file={selection} route={ROUTES.HOME} open
        initialTime={localScheduleInput(proposal.runAt)} reviewedClient={client} beforeConfirm={verifySelection}
        onOpenChange={open => { if (!open) setSelection(null); }} onScheduled={setResult} /> : null}
    </SurfaceCard>
  );
}
