"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { FilesService, type OrganizationJob } from "@/lib/files/service";

/** Paginated encrypted job records survive navigation and pod restarts. */
export function FilesOrganizationHistory({ ownerId }: { ownerId: string }) {
  const [entries, setEntries] = useState<OrganizationJob[]>([]);
  const [cursor, setCursor] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [controller, setController] = useState(() => new AbortController());
  useEffect(() => {
    const operation = new AbortController();
    setController(operation);
    setEntries([]);
    setCursor("");
    setMessage("");
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
    <section className="space-y-3 rounded-2xl border p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-semibold">Organization history</h2>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => void act(() => load())}
        >
          Refresh history
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Jobs remain available after you close the app. A paused delivery can be
        retried without creating a duplicate task. Uncertain completed work
        requires review.
      </p>
      {message ? (
        <p role="status" className="text-sm">
          {message}
        </p>
      ) : null}
      {entries.map((job) => (
        <article className="rounded-xl bg-muted/40 p-3 text-sm" key={job.id}>
          <p className="font-medium">{job.state.replaceAll("_", " ")}</p>
          {job.result ? (
            <p className="mt-1 text-muted-foreground">
              {job.result.explanation}
            </p>
          ) : null}
          <p className="mt-1 text-xs text-muted-foreground">
            File reference {job.id.slice(0, 8)}
          </p>
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
