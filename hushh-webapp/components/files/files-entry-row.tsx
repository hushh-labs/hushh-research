"use client";
import { useState } from "react";
import { FolderLock, FileText } from "@/components/icons";
import { Button } from "@/components/ui/button";
import {
  FilesService,
  DownloadPaused,
  type DownloadCheckpoint,
  type FileEntry,
  type FilesSettings,
  type OrganizationJob,
} from "@/lib/files/service";
import type { FilesAction } from "./files-settings-panel";
export type FileEdit = {
  entry?: FileEntry;
  operation: "rename" | "move" | "create";
  value: string;
};
export function FilesEntryRow({
  entry,
  busy,
  trash,
  signal,
  settings,
  act,
  onOpen,
  onResume,
  setEdit,
}: {
  entry: FileEntry;
  busy: boolean;
  trash: boolean;
  signal: AbortSignal;
  settings: FilesSettings | null;
  act: FilesAction;
  onOpen: (entry: FileEntry) => void;
  onResume: (entry: FileEntry) => void;
  setEdit: (edit: FileEdit) => void;
}) {
  const [downloads, setDownloads] = useState<
    Record<string, DownloadCheckpoint>
  >({});
  const [jobs, setJobs] = useState<Record<string, OrganizationJob>>(
    entry.organization
      ? { [entry.id]: { id: entry.id, ...entry.organization } }
      : {},
  );
  return (
    <div className="flex flex-wrap items-center gap-3 p-4">
      {entry.kind === "folder" ? (
        <FolderLock className="size-5 shrink-0" />
      ) : (
        <FileText className="size-5 shrink-0" />
      )}
      <div className="min-w-0 flex-1">
        <button
          className="max-w-full truncate text-left font-medium"
          disabled={busy || entry.kind !== "folder" || trash}
          onClick={() => onOpen(entry)}
        >
          {entry.name}
        </button>
        <p className="text-xs text-muted-foreground">
          {entry.kind === "folder"
            ? "Folder"
            : `${(entry.size / 1024 / 1024).toFixed(1)} MB`}{" "}
          · {entry.state}
          {entry.organization ? ` · ${entry.organization.state}` : ""}
        </p>
      </div>
      {entry.state === "uploading" ? (
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => {
            onResume(entry);
          }}
        >
          Resume upload
        </Button>
      ) : entry.kind === "file" && !trash ? (
        <Button
          variant="outline"
          disabled={busy}
          onClick={() =>
            void act(
              () =>
                (async () => {
                  try {
                    await FilesService.download(
                      entry,
                      signal,
                      downloads[entry.id],
                    );
                    setDownloads((previous) => {
                      const next = { ...previous };
                      delete next[entry.id];
                      return next;
                    });
                  } catch (error) {
                    if (error instanceof DownloadPaused && !signal.aborted)
                      setDownloads((previous) => ({
                        ...previous,
                        [entry.id]: error.checkpoint,
                      }));
                    throw error;
                  }
                })(),
              "File saved",
              false,
            )
          }
        >
          {downloads[entry.id] ? "Resume download" : "Download"}
        </Button>
      ) : null}
      {!trash ? (
        <>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() =>
              setEdit({
                entry,
                operation: "rename",
                value: entry.name,
              })
            }
          >
            Rename
          </Button>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => setEdit({ entry, operation: "move", value: "root" })}
          >
            Move
          </Button>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() =>
              void act(
                () => FilesService.mutate(entry, "undo", {}, signal),
                "Change undone",
              )
            }
          >
            Undo
          </Button>
        </>
      ) : null}
      {settings && !trash ? (
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() =>
            void act(
              () =>
                FilesService.configure(
                  {
                    ...settings,
                    excluded: settings.excluded.includes(entry.id)
                      ? settings.excluded.filter((id) => id !== entry.id)
                      : [...settings.excluded, entry.id],
                  },
                  signal,
                ),
              "Analysis exclusion saved",
            )
          }
        >
          {settings.excluded.includes(entry.id)
            ? "Allow analysis"
            : "Exclude analysis"}
        </Button>
      ) : null}
      {entry.kind === "file" &&
      entry.state === "ready" &&
      settings?.analysis &&
      settings.backgroundAvailable &&
      !settings.excluded.includes(entry.id) ? (
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() =>
            void act(
              async () => {
                const job = await FilesService.organize(
                  entry.id,
                  false,
                  signal,
                );
                signal.throwIfAborted();
                setJobs((previous) => ({
                  ...previous,
                  [entry.id]: job,
                }));
              },
              "Organization requested",
              false,
            )
          }
        >
          Organize
        </Button>
      ) : null}
      {jobs[entry.id] ? (
        <div className="w-full rounded-xl bg-muted/40 p-3 text-sm">
          <p role="status">Organization: {jobs[entry.id]?.state}</p>
          {jobs[entry.id]?.result ? (
            <p>{jobs[entry.id]?.result?.explanation}</p>
          ) : null}
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() =>
              void act(
                async () => {
                  const job = await FilesService.job(entry.id, signal);
                  signal.throwIfAborted();
                  setJobs((previous) => ({
                    ...previous,
                    [entry.id]: job,
                  }));
                },
                "Organization status refreshed",
                false,
              )
            }
          >
            Check status
          </Button>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() =>
              void act(
                async () => {
                  const job = await FilesService.organize(
                    entry.id,
                    true,
                    signal,
                  );
                  signal.throwIfAborted();
                  setJobs((previous) => ({
                    ...previous,
                    [entry.id]: job,
                  }));
                },
                "Organization cancelled",
                false,
              )
            }
          >
            Cancel organization
          </Button>
        </div>
      ) : null}
      <Button
        variant="ghost"
        disabled={busy}
        onClick={() => {
          if (
            trash ||
            window.confirm(
              `Move “${entry.name}” to Trash? Trash keeps its stored bytes; this release does not permanently delete them.`,
            )
          )
            void act(
              () =>
                FilesService.mutate(
                  entry,
                  trash ? "restore" : "trash",
                  { confirmed: true },
                  signal,
                ),
              trash ? "File restored" : "Moved to Trash",
            );
        }}
      >
        {trash ? "Restore" : "Trash"}
      </Button>
    </div>
  );
}
