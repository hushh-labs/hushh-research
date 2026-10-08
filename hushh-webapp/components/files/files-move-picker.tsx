"use client";

import { useEffect, useRef, useState } from "react";
import { FolderLock } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { FilesService, type FileEntry } from "@/lib/files/service";

type Folder = { id: string; name: string };

export function FilesMovePicker({
  entry,
  signal,
  onDestinationChange,
  onLoadingChange,
}: {
  entry: FileEntry;
  signal: AbortSignal;
  onDestinationChange: (id: string) => void;
  onLoadingChange: (loading: boolean) => void;
}) {
  const [path, setPath] = useState<Folder[]>([{ id: "root", name: "Files" }]);
  const [folders, setFolders] = useState<FileEntry[]>([]);
  const [cursor, setCursor] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const request = useRef<AbortController | null>(null);
  const current = path[path.length - 1]!;

  useEffect(() => {
    const controller = new AbortController();
    request.current = controller;
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort);
    if (signal.aborted) controller.abort();
    setFolders([]);
    setCursor("");
    setError(false);
    setLoading(true);
    onLoadingChange(true);
    void FilesService.list(current.id, "", false, controller.signal)
      .then((page) => {
        if (controller.signal.aborted) return;
        setFolders(page.entries);
        setCursor(page.cursor);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
          onLoadingChange(false);
        }
      });
    return () => {
      controller.abort();
      signal.removeEventListener("abort", abort);
      if (request.current === controller) request.current = null;
    };
  }, [current.id, retry, signal, onLoadingChange]);

  const loadMore = async () => {
    const controller = request.current;
    if (!controller || controller.signal.aborted || !cursor || loading) return;
    setLoading(true);
    onLoadingChange(true);
    setError(false);
    try {
      const page = await FilesService.list(
        current.id,
        cursor,
        false,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setFolders((previous) => [...previous, ...page.entries]);
      setCursor(page.cursor);
    } catch {
      if (!controller.signal.aborted) setError(true);
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
        onLoadingChange(false);
      }
    }
  };

  const open = (folder: Folder, index?: number) => {
    if (folder.id === current.id) return;
    request.current?.abort();
    setFolders([]);
    setCursor("");
    setError(false);
    setLoading(true);
    onLoadingChange(true);
    setPath((previous) =>
      index === undefined ? [...previous, folder] : previous.slice(0, index + 1),
    );
    onDestinationChange(folder.id);
  };

  return (
    <div
      className="min-w-0 space-y-2"
      role="group"
      aria-label="Destination folder"
    >
      <p className="text-sm text-muted-foreground">Move to</p>
      <div
        className="flex flex-wrap gap-1"
        role="group"
        aria-label="Destination path"
      >
        {path.map((folder, index) => (
          <Button
            key={folder.id}
            type="button"
            size="compact"
            variant="ghost"
            onClick={() => open(folder, index)}
          >
            {folder.name}
          </Button>
        ))}
      </div>
      <div
        className="max-h-48 overflow-y-auto rounded-xl border"
        role="group"
        aria-label="Folders"
      >
        {folders
          .filter((folder) =>
            folder.kind === "folder" &&
            folder.state === "ready" &&
            folder.id !== entry.id,
          )
          .map((folder) => (
            <button
              key={folder.id}
              type="button"
              className="flex min-h-11 w-full items-center gap-2 border-b px-3 text-left text-sm last:border-b-0 hover:bg-muted/50"
              onClick={() => open(folder)}
              aria-label={`Open ${folder.name}`}
            >
              <FolderLock className="size-4 shrink-0" aria-hidden="true" />
              <span className="truncate">{folder.name}</span>
            </button>
          ))}
        {!loading && !error && !folders.some((folder) =>
          folder.kind === "folder" &&
          folder.state === "ready" &&
          folder.id !== entry.id,
        ) ? (
          <p className="px-3 py-2 text-sm text-muted-foreground">
            {cursor ? "No folders on this page." : "No folders here."}
          </p>
        ) : null}
      </div>
      {loading ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading folders…
        </p>
      ) : null}
      {error ? (
        <div className="flex items-center gap-2 text-sm">
          <span role="alert">Could not load folders.</span>
          <Button
            type="button"
            size="compact"
            variant="ghost"
            onClick={() =>
              cursor ? void loadMore() : setRetry((value) => value + 1)
            }
          >
            Retry
          </Button>
        </div>
      ) : null}
      {cursor && !error ? (
        <Button
          type="button"
          size="compact"
          variant="outline"
          disabled={loading}
          onClick={() => void loadMore()}
        >
          Load more folders
        </Button>
      ) : null}
    </div>
  );
}
