"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { RefreshCw } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { FilesService, type OrganizationJob } from "@/lib/files/service";

/** Paginated encrypted job records survive navigation and pod restarts. */
export function FilesOrganizationHistory({ ownerId }: { ownerId: string }) {
  const [entries, setEntries] = useState<OrganizationJob[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [cursor, setCursor] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [controller, setController] = useState(() => new AbortController());
  useEffect(() => {
    const operation = new AbortController();
    setController(operation);
    setEntries([]);
    setNames({});
    setCursor("");
    setMessage("");
    setBusy(true);
    void FilesService.history("", operation.signal)
      .then((result) => {
        operation.signal.throwIfAborted();
        setEntries(result.entries);
        setCursor(result.cursor);
        setMessage(
          result.entries.length ? "" : "No organization jobs recorded.",
        );
      })
      .catch(() => {
        if (!operation.signal.aborted)
          setMessage("Activity could not load. Try refreshing.");
      })
      .finally(() => {
        if (!operation.signal.aborted) setBusy(false);
      });
    return () => operation.abort();
  }, [ownerId]);

  async function load(next = "") {
    const result = await FilesService.history(next, controller.signal);
    controller.signal.throwIfAborted();
    setEntries((previous) =>
      next ? [...previous, ...result.entries] : result.entries,
    );
    setCursor(result.cursor);
    setMessage(result.entries.length ? "" : "No organization jobs recorded.");
  }
  async function act(operation: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    try {
      await operation();
    } catch {
      if (!controller.signal.aborted)
        toast.error(
          "Organization history is unavailable. Reconnect your pod and try again.",
        );
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button
          variant="ghost"
          size="icon-touch"
          aria-label="Refresh activity"
          disabled={busy}
          onClick={() => void act(() => load())}
        >
          <RefreshCw className="size-4" />
        </Button>
      </div>

      {message ? (
        <p role="status" className="text-sm">
          {message}
        </p>
      ) : null}
      {entries.map((job) => (
        <article className="rounded-xl bg-muted/40 p-3 text-sm" key={job.id}>
          {names[job.id] ? (
            <p className="truncate font-medium">{names[job.id]}</p>
          ) : (
            <Button
              variant="ghost"
              size="compact"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  const file = await FilesService.entry(
                    job.file ?? job.id,
                    controller.signal,
                  );
                  controller.signal.throwIfAborted();
                  setNames((current) => ({ ...current, [job.id]: file.name }));
                })
              }
            >
              Show file name
            </Button>
          )}
          <p className="text-muted-foreground">
            {job.state.replaceAll("_", " ")}
          </p>
          {job.result ? (
            <p className="mt-1 text-muted-foreground">
              {job.result.explanation}
            </p>
          ) : null}
          {job.state === "pending_delivery" ? (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await FilesService.organize(job.id, false, controller.signal);
                  await load();
                })
              }
            >
              Retry delivery
            </Button>
          ) : null}
          {["pending_delivery", "queued", "running"].includes(job.state) ? (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await FilesService.organize(job.id, true, controller.signal);
                  await load();
                })
              }
            >
              Cancel organization
            </Button>
          ) : null}
          {job.state === "review_required" ? (
            <p className="mt-2 text-muted-foreground">
              Review this file before requesting organization again; the
              previous outcome is uncertain.
            </p>
          ) : null}
          {job.history?.length ? (
            <details className="mt-2">
              <summary>Previous attempts</summary>
              {job.history.map((attempt, index) => (
                <p key={index}>
                  {attempt.state.replaceAll("_", " ")}
                  {attempt.result ? ` — ${attempt.result.explanation}` : ""}
                </p>
              ))}
            </details>
          ) : null}
        </article>
      ))}
      {cursor ? (
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => void act(() => load(cursor))}
        >
          Load more
        </Button>
      ) : null}
    </section>
  );
}
