"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Upload, RefreshCw } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PkmSettingsShell } from "@/components/profile/pkm-settings-shell";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import { ApiService } from "@/lib/services/api-service";
import { ROUTES } from "@/lib/navigation/routes";
import { FilesEntryRow, type FileEdit } from "./files-entry-row";
import { FilesSettingsPanel } from "./files-settings-panel";
import { FilesOrganizationHistory } from "./files-organization-history";
import {
  FilesService,
  type FileEntry,
  type FilesSettings,
} from "@/lib/files/service";

export function FilesWorkspace() {
  const { user } = useAuth();
  const { vaultKey } = useVault();
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [folders, setFolders] = useState([{ id: "root", name: "Files" }]);
  const [cursor, setCursor] = useState("");
  const [trash, setTrash] = useState(false);
  const [query, setQuery] = useState("");
  const [settings, setSettings] = useState<FilesSettings | null>(null);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [resume, setResume] = useState<FileEntry | undefined>();
  const [edit, setEdit] = useState<FileEdit | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const work = useRef(new AbortController());
  const parent = folders[folders.length - 1]?.id ?? "root";
  const available = Boolean(user?.uid && vaultKey);

  const load = useCallback(
    async (next = "") => {
      if (!available) return;
      const signal = work.current.signal;
      const [page, config] = await Promise.all([
        FilesService.list(parent, next, trash, signal),
        FilesService.settings(signal),
      ]);
      signal.throwIfAborted();
      setEntries((previous) =>
        next ? [...previous, ...page.entries] : page.entries,
      );
      setCursor(page.cursor);
      setSettings(config);
      setMessage("");
    },
    [available, parent, trash],
  );

  useEffect(() => {
    work.current.abort();
    work.current = new AbortController();
    setLoading(true);
    setMessage("");
    setEntries([]);
    setSettings(null);
    setEdit(null);
    setResume(undefined);
    setProgress(null);
    setQuery("");
    setBusy(false);
    const signal = work.current.signal;
    if (available)
      void load()
        .catch(() => {
          if (!signal.aborted)
            setMessage(
              "Your private Files library is not connected. Check your BYOC pod and software version.",
            );
        })
        .finally(() => {
          if (!signal.aborted) setLoading(false);
        });
    return () => work.current.abort();
  }, [available, user?.uid, load]);

  useEffect(() => {
    setFolders([{ id: "root", name: "Files" }]);
    setTrash(false);
  }, [user?.uid, available]);

  const act = async (
    operation: () => Promise<unknown>,
    success: string,
    refresh = true,
  ) => {
    if (busy) return;
    setBusy(true);
    const signal = work.current.signal;
    try {
      await operation();
      signal.throwIfAborted();
      if (refresh) await load();
      signal.throwIfAborted();
      toast.success(success);
    } catch (error) {
      if (!signal.aborted)
        toast.error(
          error instanceof Error
            ? error.message
            : "Could not finish. Try again.",
        );
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  };

  return (
    <PkmSettingsShell
      title="Files"
      description="Your private library, stored in your cloud."
      actions={
        <Button
          variant="outline"
          disabled={!available || busy}
          onClick={() => void act(() => load(), "Files refreshed")}
        >
          <RefreshCw className="mr-2 size-4" />
          Refresh
        </Button>
      }
    >
      {!available ? (
        <p className="text-sm text-muted-foreground">
          Unlock your vault to open Files.
        </p>
      ) : (
        <div className="space-y-5">
          {message ? (
            <div className="rounded-2xl border p-5 space-y-3">
              <p role="status">{message}</p>
              <div className="flex gap-3">
                <Button
                  disabled={busy}
                  onClick={() =>
                    void act(
                      () => ApiService.reconnectOwnerPod(),
                      "Pod connected",
                    )
                  }
                >
                  Reconnect pod
                </Button>
                <Link
                  href={ROUTES.PROFILE_HOSTING}
                  className="text-sm underline"
                >
                  Hosting settings
                </Link>
              </div>
            </div>
          ) : null}
          <div
            className="flex flex-wrap items-center gap-2"
            aria-label="Folder path"
          >
            {folders.map((folder, index) => (
              <Button
                key={folder.id}
                variant="ghost"
                disabled={busy}
                onClick={() => setFolders(folders.slice(0, index + 1))}
              >
                {folder.name}
              </Button>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <Input
              aria-label="Search loaded files"
              placeholder="Search this page"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="flex-1"
            />
            <Button
              disabled={busy || Boolean(message)}
              onClick={() => {
                setResume(undefined);
                input.current?.click();
              }}
            >
              <Upload className="mr-2 size-4" />
              Upload
            </Button>
            <Button
              variant="outline"
              disabled={busy || Boolean(message)}
              onClick={() => setEdit({ operation: "create", value: "" })}
            >
              New folder
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => setTrash(!trash)}
            >
              {trash ? "Library" : "Trash"}
            </Button>
          </div>
          <input
            ref={input}
            type="file"
            className="sr-only"
            aria-label="Choose a file to upload"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (!file) return;
              void act(async () => {
                const signal = work.current.signal;
                await FilesService.upload(
                  file,
                  parent,
                  (received) => {
                    if (!signal.aborted)
                      setProgress(
                        file.size
                          ? Math.round((received / file.size) * 100)
                          : 100,
                      );
                  },
                  signal,
                  resume,
                );
                signal.throwIfAborted();
                setProgress(null);
                setResume(undefined);
              }, "Upload complete");
            }}
          />
          {progress !== null ? (
            <div role="status" className="space-y-2">
              <progress className="w-full" max={100} value={progress} />
              <p className="text-sm text-muted-foreground">
                Upload {progress}%
              </p>
            </div>
          ) : null}
          {edit ? (
            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void act(async () => {
                  if (edit.operation === "create")
                    await FilesService.createFolder(
                      edit.value,
                      parent,
                      work.current.signal,
                    );
                  else if (edit.entry)
                    await FilesService.mutate(
                      edit.entry,
                      edit.operation,
                      edit.operation === "rename"
                        ? { name: edit.value }
                        : { parent: edit.value },
                      work.current.signal,
                    );
                  setEdit(null);
                }, "Files updated");
              }}
            >
              {edit.operation === "move" ? (
                <select
                  aria-label="Destination folder"
                  className="min-w-0 flex-1 rounded-xl border bg-background p-2"
                  value={edit.value}
                  onChange={(event) =>
                    setEdit({ ...edit, value: event.target.value })
                  }
                >
                  {[
                    ...folders,
                    ...entries.filter(
                      (item) =>
                        item.kind === "folder" &&
                        item.state === "ready" &&
                        item.id !== edit.entry?.id,
                    ),
                  ]
                    .filter(
                      (item, index, all) =>
                        all.findIndex((other) => other.id === item.id) ===
                        index,
                    )
                    .map((folder) => (
                      <option key={folder.id} value={folder.id}>
                        {folder.name}
                      </option>
                    ))}
                </select>
              ) : (
                <Input
                  autoFocus
                  aria-label="Name"
                  value={edit.value}
                  onChange={(event) =>
                    setEdit({ ...edit, value: event.target.value })
                  }
                />
              )}
              <Button disabled={busy}>Save</Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setEdit(null)}
              >
                Cancel
              </Button>
            </form>
          ) : null}
          {loading ? (
            <p role="status" className="text-sm text-muted-foreground">
              Opening Files…
            </p>
          ) : null}
          <div className="divide-y rounded-2xl border">
            {entries
              .filter((entry) =>
                entry.name
                  .toLocaleLowerCase()
                  .includes(query.toLocaleLowerCase()),
              )
              .map((entry) => (
                <FilesEntryRow
                  key={`${user?.uid}:${parent}:${entry.id}`}
                  entry={entry}
                  busy={busy}
                  trash={trash}
                  signal={work.current.signal}
                  settings={settings}
                  act={act}
                  setEdit={setEdit}
                  onOpen={(folder) =>
                    setFolders([
                      ...folders,
                      { id: folder.id, name: folder.name },
                    ])
                  }
                  onResume={(file) => {
                    setResume(file);
                    input.current?.click();
                  }}
                />
              ))}
            {!entries.length && !message && !loading ? (
              <p className="p-6 text-sm text-muted-foreground">
                {trash
                  ? "No trashed files in this folder."
                  : "Upload a file or create your first folder."}
              </p>
            ) : null}
          </div>
          {cursor ? (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void act(() => load(cursor), "More files loaded", false)
              }
            >
              Load more
            </Button>
          ) : null}
          {user?.uid ? (
            <FilesOrganizationHistory key={user.uid} ownerId={user.uid} />
          ) : null}
          <FilesSettingsPanel
            key={user?.uid}
            settings={settings}
            signal={work.current.signal}
            busy={busy}
            unavailable={Boolean(message)}
            act={act}
          />
        </div>
      )}
    </PkmSettingsShell>
  );
}
