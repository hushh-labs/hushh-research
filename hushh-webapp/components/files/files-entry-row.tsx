"use client";
import { FilesLocalError } from "@/lib/files/local-error";
import { useEffect, useRef, useState } from "react";
import {
  FolderLock,
  FileText,
  MoreHorizontal,
  Download,
  Check,
  X,
} from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  ActionMenu,
  type ActionMenuItem,
} from "@/components/app-ui/action-menu";
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
  ancestorExcluded,
  act,
  onOpen,
  onResume,
  setEdit,
  rename,
  onRenameChange,
  onRenameSave,
  onRenameCancel,
}: {
  entry: FileEntry;
  busy: boolean;
  trash: boolean;
  signal: AbortSignal;
  settings: FilesSettings | null;
  ancestorExcluded: boolean;
  act: FilesAction;
  onOpen: (entry: FileEntry) => void;
  onResume: (entry: FileEntry) => void;
  setEdit: (edit: FileEdit) => void;
  rename: string | null;
  onRenameChange: (name: string) => void;
  onRenameSave: () => void;
  onRenameCancel: () => void;
}) {
  const nameInput = useRef<HTMLInputElement>(null);
  const renaming = rename !== null;
  useEffect(() => {
    if (!renaming) return;
    nameInput.current?.focus();
    const extension = entry.kind === "file" ? entry.name.lastIndexOf(".") : -1;
    nameInput.current?.setSelectionRange(
      0,
      extension > 0 ? extension : entry.name.length,
    );
  }, [renaming, entry.id, entry.kind, entry.name]);
  const [confirmTrash, setConfirmTrash] = useState(false);
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
        onSelect: () =>
          setEdit({ entry, operation: "rename", value: entry.name }),
      },
      {
        id: "move",
        label: "Move",
        onSelect: () => setEdit({ entry, operation: "move", value: "root" }),
      },
      {
        id: "undo",
        label: "Undo",
        onSelect: () =>
          void act(
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
      label: currentSettings.excluded.includes(entry.id)
        ? ancestorExcluded
          ? "Remove exclusion"
          : "Allow analysis"
        : "Exclude analysis",
      onSelect: () =>
        void act(
          () =>
            FilesService.configure(
              {
                ...currentSettings,
                excluded: currentSettings.excluded.includes(entry.id)
                  ? currentSettings.excluded.filter((id) => id !== entry.id)
                  : [...currentSettings.excluded, entry.id],
              },
              signal,
            ),
          "Analysis exclusion saved",
        ),
    });
  }
  if (
    entry.kind === "file" &&
    entry.state === "ready" &&
    settings?.analysis &&
    settings.backgroundAvailable &&
    !ancestorExcluded &&
    !settings.excluded.includes(entry.id)
  ) {
    actions.push({
      id: "organize",
      label: "Organize",
      onSelect: () =>
        void act(
          async () => {
            const job = await FilesService.organize(entry.id, false, signal);
            signal.throwIfAborted();
            setJobs((previous) => ({ ...previous, [entry.id]: job }));
          },
          "Organization requested",
          false,
        ),
    });
  }
  actions.push({
    id: trash ? "restore" : "trash",
    label: trash ? "Restore" : "Trash",
    onSelect: () => {
      if (!trash) {
        setConfirmTrash(true);
        return;
      }
      void act(
        () =>
          FilesService.mutate(entry, "restore", { confirmed: true }, signal),
        "File restored",
      );
    },
  });
  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-2 px-3 py-2 sm:gap-3 sm:px-4"
      data-file-row={entry.id}
    >
      {entry.kind === "folder" ? (
        <FolderLock className="size-5 shrink-0" />
      ) : (
        <FileText className="size-5 shrink-0" />
      )}
      {renaming ? (
        <form
          className="flex min-w-0 flex-1 items-center gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            if (!busy && rename.trim() && rename !== entry.name) onRenameSave();
          }}
        >
          <Input
            ref={nameInput}
            aria-label="Name"
            value={rename}
            disabled={busy}
            onChange={(event) => onRenameChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                if (!busy) onRenameCancel();
              }
            }}
          />
          <Button
            type="submit"
            variant="ghost"
            size="icon-touch"
            aria-label="Save name"
            disabled={busy || !rename.trim() || rename === entry.name}
          >
            <Check className="size-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-touch"
            aria-label="Cancel rename"
            disabled={busy}
            onClick={onRenameCancel}
          >
            <X className="size-4" />
          </Button>
        </form>
      ) : (
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
            {entry.state !== "ready" ? ` · ${entry.state}` : ""}
            {entry.organization &&
            ["pending_delivery", "queued", "running"].includes(
              entry.organization.state,
            )
              ? " · Organizing"
              : ""}
          </p>
        </div>
      )}
      {!renaming &&
        (entry.state === "uploading" ? (
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
            variant="ghost"
            size="icon-touch"
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
            <Download className="size-4" aria-hidden="true" />
          </Button>
        ) : null)}
      {!renaming && (
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
      )}
      <AlertDialog open={confirmTrash} onOpenChange={setConfirmTrash}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Move to Trash?</AlertDialogTitle>
            <AlertDialogDescription>
              You can restore “{entry.name}” later. Moving it to Trash does not
              permanently delete it or reduce storage usage.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep file</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={() =>
                void act(
                  () =>
                    FilesService.mutate(
                      entry,
                      "trash",
                      { confirmed: true },
                      signal,
                    ),
                  "Moved to Trash",
                )
              }
            >
              Move to Trash
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
                    const job = await FilesService.organize(
                      entry.id,
                      true,
                      signal,
                    );
                    signal.throwIfAborted();
                    setJobs((previous) => ({ ...previous, [entry.id]: job }));
                    if (job.state === "completed")
                      outcome = "Organization already finished";
                    else if (job.state !== "cancelled")
                      throw new FilesLocalError(
                        "Cancellation was not confirmed. Check organization status.",
                      );
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

export function FilesFolderDraft({
  value,
  busy,
  onChange,
  onSave,
  onCancel,
}: {
  value: string;
  busy: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <form
      className="flex min-w-0 items-center gap-2 px-3 py-2 sm:px-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      <FolderLock className="size-5 shrink-0" />
      <Input
        autoFocus
        aria-label="Name"
        placeholder="Folder name"
        value={value}
        disabled={busy}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !busy) {
            event.preventDefault();
            onCancel();
          }
        }}
      />
      <Button
        type="submit"
        variant="ghost"
        size="icon-touch"
        aria-label="Save"
        disabled={busy || !value.trim()}
      >
        <Check className="size-4" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-touch"
        aria-label="Cancel"
        disabled={busy}
        onClick={() => onCancel()}
      >
        <X className="size-4" />
      </Button>
    </form>
  );
}
