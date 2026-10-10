"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import { Button } from "@/components/ui/button";
import { useBackLayer } from "@/lib/navigation/back-layers";
import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { FilesActivationPanel } from "./files-activation-panel";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import { ApiService } from "@/lib/services/api-service";
import { FilesLocalError } from "@/lib/files/local-error";
import { ROUTES } from "@/lib/navigation/routes";
import { FilesToolbar } from "./files-toolbar";
import { FilesMoveDialog, FilesDetailsDialog } from "./files-workspace-dialogs";
import {
  FilesEntryRow,
  FilesFolderDraft,
  type FileEdit,
} from "./files-entry-row";
import {
  FilesService,
  type FileEntry,
  type FilesSettings,
} from "@/lib/files/service";

function transientFilesRead(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  return (
    error instanceof Error &&
    /^(?:FILES_UNAVAILABLE|POD_DIRECT_UNAVAILABLE|ENDPOINT_UNAVAILABLE):(429|502|503|504)$/.test(
      error.message,
    )
  );
}

export function FilesWorkspace() {
  const { user } = useAuth();
  const { vaultKey } = useVault();
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [folders, setFolders] = useState([{ id: "root", name: "Files" }]);
  const [cursor, setCursor] = useState("");
  const [trash, setTrash] = useState(false);
  const [query, setQuery] = useState("");
  const [panel, setPanel] = useState<"activity" | "settings" | null>(null);
  const [settings, setSettings] = useState<FilesSettings | null>(null);
  const [filesActivationAvailable, setFilesActivationAvailable] =
    useState(false);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [resume, setResume] = useState<FileEntry | undefined>();
  const [edit, setEdit] = useState<FileEdit | null>(null);
  const [movePickerLoading, setMovePickerLoading] = useState(true);
  const input = useRef<HTMLInputElement>(null);
  const work = useRef(new AbortController());
  const actionPending = useRef(false);
  const parent = folders[folders.length - 1]?.id ?? "root";
  const available = Boolean(user?.uid && vaultKey);
  const visibleEntries = entries.filter((entry) =>
    entry.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );

  const load = useCallback(
    async (next = "") => {
      if (!available) return;
      const signal = work.current.signal;
      // Existing owner pods may admit one request at a time. Finish the
      // library read before asking that same pod for settings.
      const page = await FilesService.list(parent, next, trash, signal);
      signal.throwIfAborted();
      const config = await FilesService.settings(signal);
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
    actionPending.current = false;
    const signal = work.current.signal;
    if (available)
      void (async () => {
        for (const delay of [600, 1800, 0]) {
          try {
            await load();
            return;
          } catch (error) {
            signal.throwIfAborted();
            if (!delay || !transientFilesRead(error)) throw error;
            // Retry only idempotent reads during a cold pod connection.
            await new Promise((resolve) => setTimeout(resolve, delay));
            signal.throwIfAborted();
          }
        }
      })()
        .catch((error: unknown) => {
          if (!signal.aborted)
            setMessage(
              error instanceof Error && error.message === "FILES_NOT_ENABLED"
                ? "Files is not enabled on this pod. Review setup below."
                : "Your private Files library is not connected. Check your BYOC pod and software version.",
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
    setPanel(null);
  }, [user?.uid, available]);

  useEffect(() => {
    if (!user?.uid) return;
    let cancelled = false;
    void ApiService.getPersonalAgentStatus()
      .then((status) => {
        if (!cancelled) {
          setFilesActivationAvailable(status.filesActivationAvailable === true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFilesActivationAvailable(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [user?.uid]);

  useBackLayer(
    ROUTES.ONE_FILES,
    edit ? 2 : folders.length > 1 || trash ? 1 : 0,
    () => {
      if (busy) return true;
      if (edit) setEdit(null);
      else if (trash) setTrash(false);
      else if (folders.length > 1)
        setFolders((current) => current.slice(0, -1));
      else return false;
      return true;
    },
  );

  const act = async (
    operation: () => Promise<unknown>,
    success: string | (() => string),
    refresh = true,
  ) => {
    if (actionPending.current) return;
    actionPending.current = true;
    setBusy(true);
    const signal = work.current.signal;
    const request = (async () => {
      await operation();
      signal.throwIfAborted();
      if (refresh) await load();
      signal.throwIfAborted();
      return typeof success === "function" ? success() : success;
    })();
    const notification = morphyToast.promise(request, {
      loading: "Updating Files…",
      success: (result) => (signal.aborted ? undefined : result),
      error: (error) =>
        signal.aborted
          ? undefined
          : error instanceof FilesLocalError
            ? error.message
            : "Could not finish. Check your Files connection and try again.",
    });
    const retireNotification = () => {
      if (typeof notification === "string" || typeof notification === "number")
        morphyToast.dismiss(notification);
    };
    signal.addEventListener("abort", retireNotification, { once: true });
    try {
      await notification.unwrap();
    } catch {
      // The shared notification owns the settled action result.
    } finally {
      signal.removeEventListener("abort", retireNotification);
      if (!signal.aborted) {
        actionPending.current = false;
        setBusy(false);
      }
    }
  };

  const saveEdit = () => {
    if (!edit || busy || !edit.value.trim()) return;
    const current = edit;
    const signal = work.current.signal;
    void act(async () => {
      if (current.operation === "create")
        await FilesService.createFolder(current.value.trim(), parent, signal);
      else if (current.entry)
        await FilesService.mutate(
          current.entry,
          current.operation,
          current.operation === "rename"
            ? { name: current.value.trim() }
            : { parent: current.value },
          signal,
        );
      signal.throwIfAborted();
      setEdit(null);
    }, "Files updated");
  };
  const goUp = () => {
    if (trash) setTrash(false);
    else
      setFolders((current) =>
        current.length > 1 ? current.slice(0, -1) : current,
      );
  };

  return (
    <AppPageShell as="div" width="reading" fitContent>
      <AppPageHeaderRegion>
        <PageHeader title="Files" titleVisuallyHidden className="sr-only" />
      </AppPageHeaderRegion>
      <AppPageContentRegion>
        {!available ? (
          <p className="text-sm text-muted-foreground">
            Unlock your vault to open Files.
          </p>
        ) : (
          <div className="min-w-0">
            <section className="min-w-0 space-y-3" aria-label="File explorer">
              {message ? (
                <div className="rounded-2xl border p-5 space-y-3">
                  <p role="status">{message}</p>
                  <div className="flex flex-wrap gap-3">
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
              <FilesToolbar
                folders={folders}
                trash={trash}
                query={query}
                loading={loading}
                locked={busy || Boolean(edit)}
                blocked={Boolean(message)}
                onUp={goUp}
                onFolder={(index) => {
                  setTrash(false);
                  setFolders(folders.slice(0, index + 1));
                }}
                onTrash={() => setTrash(!trash)}
                onSettings={() => setPanel("settings")}
                onActivity={() => setPanel("activity")}
                onQuery={setQuery}
                onRefresh={() =>
                  void act(() => load(), "Files refreshed", false)
                }
                onUpload={() => {
                  setResume(undefined);
                  input.current?.click();
                }}
                onNewFolder={() => setEdit({ operation: "create", value: "" })}
              />
              <input
                ref={input}
                type="file"
                className="sr-only"
                aria-label="Choose a file to upload"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (!file) return;
                  let uploadOutcome = "Upload complete";
                  void act(
                    async () => {
                      const signal = work.current.signal;
                      try {
                        const uploaded = await FilesService.upload(
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
                        if (uploaded?.organization?.state === "unconfirmed")
                          uploadOutcome =
                            "Upload complete; organization could not be confirmed";
                        else if (
                          uploaded?.organization?.state === "pending_delivery"
                        )
                          uploadOutcome =
                            "Upload complete; organization is awaiting delivery";
                      } catch (error) {
                        // Creation may have committed before a chunk failed. Discover
                        // that retained entry so Resume reuses its identity and bytes.
                        if (!signal.aborted)
                          await load().catch(() => undefined);
                        throw error;
                      }
                      signal.throwIfAborted();
                      setProgress(null);
                      setResume(undefined);
                    },
                    () => uploadOutcome,
                  );
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
              {loading ? (
                <p role="status" className="text-sm text-muted-foreground">
                  Opening Files…
                </p>
              ) : null}
              <div
                className="divide-y rounded-2xl border"
                aria-label={trash ? "Trash" : "Files and folders"}
              >
                {edit?.operation === "create" ? (
                  <FilesFolderDraft
                    value={edit.value}
                    busy={busy}
                    onChange={(value) => setEdit({ ...edit, value })}
                    onSave={saveEdit}
                    onCancel={() => setEdit(null)}
                  />
                ) : null}
                {visibleEntries.map((entry) => (
                  <FilesEntryRow
                    key={`${user?.uid}:${parent}:${entry.id}`}
                    entry={entry}
                    busy={
                      busy ||
                      Boolean(
                        edit &&
                        !(
                          edit.operation === "rename" &&
                          edit.entry?.id === entry.id
                        ),
                      )
                    }
                    trash={trash}
                    signal={work.current.signal}
                    settings={settings}
                    ancestorExcluded={folders.some((folder) =>
                      settings?.excluded.includes(folder.id),
                    )}
                    rename={
                      edit?.operation === "rename" &&
                      edit.entry?.id === entry.id
                        ? edit.value
                        : null
                    }
                    onRenameChange={(value) =>
                      setEdit((current) =>
                        current ? { ...current, value } : null,
                      )
                    }
                    onRenameSave={saveEdit}
                    onRenameCancel={() => setEdit(null)}
                    act={act}
                    setEdit={(next) => {
                      if (next.operation === "move") setMovePickerLoading(true);
                      setEdit(next);
                    }}
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
                {!visibleEntries.length && !message && !loading ? (
                  <p className="p-6 text-sm text-muted-foreground">
                    {query
                      ? "No matches on this page. Load more files to search another page."
                      : trash
                        ? "No trashed files in this folder."
                        : "Upload a file or create your first folder."}
                  </p>
                ) : null}
              </div>
              {cursor ? (
                <Button
                  variant="outline"
                  disabled={busy || Boolean(edit)}
                  onClick={() =>
                    void act(() => load(cursor), "More files loaded", false)
                  }
                >
                  Load more
                </Button>
              ) : null}
            </section>
            {message && filesActivationAvailable ? (
              <FilesActivationPanel
                disabled={busy}
                onScheduled={() => void load().catch(() => undefined)}
              />
            ) : null}
          </div>
        )}
        <FilesMoveDialog
          edit={edit}
          signal={work.current.signal}
          busy={busy}
          loading={movePickerLoading}
          onCancel={() => setEdit(null)}
          onSave={saveEdit}
          onLoadingChange={setMovePickerLoading}
          onDestinationChange={(value) =>
            setEdit((current) => (current ? { ...current, value } : null))
          }
        />
        <FilesDetailsDialog
          panel={available ? panel : null}
          ownerId={user?.uid}
          signal={work.current.signal}
          settings={settings}
          busy={busy || Boolean(edit)}
          unavailable={!available || Boolean(message)}
          act={act}
          onClose={() => setPanel(null)}
        />
      </AppPageContentRegion>
    </AppPageShell>
  );
}
