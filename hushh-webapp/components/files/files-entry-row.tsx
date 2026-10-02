"use client";
import { useState } from "react";
import { FolderLock, FileText, MoreHorizontal } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { ActionMenu, type ActionMenuItem } from "@/components/app-ui/action-menu";
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
  const actions: ActionMenuItem[] = [];
  if (!trash) {
    actions.push(
      {
        id: "rename",
        label: "Rename",
        onSelect: () => setEdit({ entry, operation: "rename", value: entry.name }),
      },
      {
        id: "move",
        label: "Move",
        onSelect: () => setEdit({ entry, operation: "move", value: "root" }),
      },
      {
        id: "undo",
        label: "Undo",
        onSelect: () => void act(
          () => FilesService.mutate(entry, "undo", {}, signal),
          "Change undone",
        ),
      },
    );
  }
  if (settings && !trash) {
    const currentSettings = settings;
    actions.push({
      id: "analysis",
      label: currentSettings.excluded.includes(entry.id) ? "Allow analysis" : "Exclude analysis",
      onSelect: () => void act(
        () => FilesService.configure({
          ...currentSettings,
          excluded: currentSettings.excluded.includes(entry.id)
            ? currentSettings.excluded.filter((id) => id !== entry.id)
            : [...currentSettings.excluded, entry.id],
        }, signal),
        "Analysis exclusion saved",
      ),
    });
  }
  if (
    entry.kind === "file" && entry.state === "ready" &&
    settings?.analysis && settings.backgroundAvailable &&
    !settings.excluded.includes(entry.id)
  ) {
    actions.push({
      id: "organize",
      label: "Organize",
      onSelect: () => void act(async () => {
        const job = await FilesService.organize(entry.id, false, signal);
        signal.throwIfAborted();
        setJobs((previous) => ({ ...previous, [entry.id]: job }));
      }, "Organization requested", false),
    });
  }
  actions.push({
    id: trash ? "restore" : "trash",
    label: trash ? "Restore" : "Trash",
    onSelect: () => {
      if (!trash && !window.confirm(
        `Move “${entry.name}” to Trash? Trash keeps its stored bytes; this release does not permanently delete them.`,
      )) return;
      void act(
        () => FilesService.mutate(
          entry,
          trash ? "restore" : "trash",
          { confirmed: true },
          signal,
        ),
        trash ? "File restored" : "Moved to Trash",
      );
    },
  });
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 p-3 sm:gap-3 sm:p-4">
      {entry.kind === "folder" ? (
        <FolderLock className="size-5 shrink-0" />
      ) : (
        <FileText className="size-5 shrink-0" />
      )}
      <div className="min-w-0 flex-[1_1_6rem]">
        {entry.kind === "folder" && !trash ? (
          <button
            className="block max-w-full truncate text-left font-medium"
            disabled={busy}
            onClick={() => onOpen(entry)}
          >
            {entry.name}
          </button>
        ) : (
          <p className="truncate font-medium">{entry.name}</p>
        )}
        <p className="truncate text-xs text-muted-foreground">
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
          size="compact"
          disabled={busy}
          aria-label="Resume upload"
          onClick={() => {
            onResume(entry);
          }}
        >
          <span aria-hidden="true">
            Resume<span className="hidden sm:inline"> upload</span>
          </span>
        </Button>
      ) : entry.kind === "file" && !trash ? (
        <Button
          variant="outline"
          size="compact"
          disabled={busy}
          aria-label={downloads[entry.id] ? "Resume download" : "Download"}
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
          <span aria-hidden="true">
            {downloads[entry.id] ? (
              <>Resume<span className="hidden sm:inline"> download</span></>
            ) : "Download"}
          </span>
        </Button>
      ) : null}
      <ActionMenu
        label={`Actions for ${entry.name}`}
        title={entry.name}
        items={actions.map((action) => ({ ...action, disabled: busy }))}
        trigger={
          <Button
            type="button"
            variant="ghost"
            size="icon-touch"
            disabled={busy}
            aria-label={`Actions for ${entry.name}`}
          >
            <MoreHorizontal className="size-5" aria-hidden="true" />
          </Button>
        }
      />
      {jobs[entry.id] ? (
        <div className="w-full rounded-xl bg-muted/40 p-3 text-sm">
          <p role="status">Organization: {jobs[entry.id]?.state}</p>
          {jobs[entry.id]?.result ? (
            <p>{jobs[entry.id]?.result?.explanation}</p>
          ) : null}
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              variant="ghost"
              size="compact"
              disabled={busy}
              aria-label="Check organization status"
              onClick={() =>
                void act(
                  async () => {
                    const job = await FilesService.job(entry.id, signal);
                    signal.throwIfAborted();
                    setJobs((previous) => ({ ...previous, [entry.id]: job }));
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
              size="compact"
              disabled={busy}
              aria-label="Cancel organization"
              onClick={() => {
                let outcome = "Cancellation requested";
                void act(
                  async () => {
                    const job = await FilesService.organize(entry.id, true, signal);
                    signal.throwIfAborted();
                    setJobs((previous) => ({ ...previous, [entry.id]: job }));
                    if (job.state === "completed") outcome = "Organization already finished";
                    else if (job.state !== "cancelled")
                      throw new Error("Cancellation was not confirmed. Check organization status.");
                  },
                  () => outcome,
                  false,
                );
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
