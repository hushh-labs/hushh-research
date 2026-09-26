"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FilesService, type FilesSettings } from "@/lib/files/service";
import { estimatePodSubtotal } from "@/lib/files/economics";
export type FilesAction = (
  operation: () => Promise<unknown>,
  success: string,
  refresh?: boolean,
) => Promise<void>;
export function FilesSettingsPanel({
  settings,
  signal,
  busy,
  unavailable,
  act,
}: {
  settings: FilesSettings | null;
  signal: AbortSignal;
  busy: boolean;
  unavailable: boolean;
  act: FilesAction;
}) {
  const [usage, setUsage] = useState<number | null>(null);
  const [hours, setHours] = useState(10);
  const [warningGiB, setWarningGiB] = useState(100);
  return (
    <>
      <section className="rounded-2xl border p-5 space-y-2">
        <h2 className="font-semibold">Trash and retention</h2>
        <p className="text-sm text-muted-foreground">
          Trash is reversible and retains your stored files. Moving a file to
          Trash does not request physical deletion or reduce storage charges.
        </p>
        {settings?.retention ? (
          <p className="text-sm text-muted-foreground">
            Your bucket currently has a{" "}
            {Math.ceil(settings.retention.retentionSeconds / 86400)}-day minimum
            retention
            {settings.retention.retentionLocked ? " (locked)" : ""},{" "}
            {Math.ceil(settings.retention.softDeleteSeconds / 86400)}-day
            soft-delete retention, and object versioning{" "}
            {settings.retention.versioning ? "enabled" : "disabled"}. Retained
            versions can remain after a cloud deletion request.
          </p>
        ) : null}
      </section>
      <section className="rounded-2xl border p-5 space-y-3">
        <h2 className="font-semibold">Storage and cost estimate</h2>
        <Button
          variant="outline"
          disabled={busy || unavailable}
          onClick={() =>
            void act(
              async () => {
                let next = "",
                  bytes = 0;
                do {
                  const page = await FilesService.usagePage(next, signal);
                  bytes += page.bytes;
                  next = page.cursor;
                  signal.throwIfAborted();
                } while (next);
                setUsage(bytes);
              },
              "Storage checked",
              false,
            )
          }
        >
          Check storage
        </Button>
        {usage !== null ? (
          <p className="text-sm">
            {(usage / 1024 ** 3).toFixed(2)} GiB uploaded, including Trash.
            Retained cloud versions and incomplete orphan chunks are additional.
          </p>
        ) : null}
        <div className="flex flex-wrap gap-4">
          <label className="text-sm">
            Estimated active hours/month
            <Input
              type="number"
              min="0"
              value={hours}
              onChange={(event) =>
                setHours(Math.max(0, Number(event.target.value) || 0))
              }
            />
          </label>
          <label className="text-sm">
            Storage warning (GiB)
            <Input
              type="number"
              min="1"
              value={warningGiB}
              onChange={(event) =>
                setWarningGiB(Math.max(1, Number(event.target.value) || 1))
              }
            />
          </label>
        </div>
        {usage !== null ? (
          <p className="font-medium">
            Illustrative subtotal: $
            {estimatePodSubtotal(usage, hours).subtotal.toFixed(2)}/month
          </p>
        ) : null}
        {usage !== null && usage / 1024 ** 3 >= warningGiB ? (
          <p role="status" className="text-sm">
            Your selected storage warning threshold has been reached. Service
            continues normally.
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground">
          Estimate includes regional Standard storage, 1 vCPU/1 GiB active
          compute and one KMS key version. It excludes model usage, downloads,
          retained versions, operations and other cloud services. Active time
          includes background work and open connections. This warning applies to
          this view; it is not a spending cap.
        </p>
      </section>
      {settings ? (
        <section className="rounded-2xl border p-5 space-y-3">
          <h2 className="font-semibold">Files Agent</h2>
          <p className="text-sm text-muted-foreground">
            Allow your private agent to read and organize this library.
            Interactive requests use your selected model provider. Background
            organization uses Google Vertex AI in your own cloud project. You
            can pause analysis at any time.
          </p>
          <label className="flex items-center gap-3 text-sm">
            <input
              type="checkbox"
              checked={settings.analysis}
              disabled={busy}
              onChange={(event) =>
                void act(
                  () =>
                    FilesService.configure(
                      {
                        ...settings,
                        analysis: event.target.checked,
                        automatic: event.target.checked && settings.automatic,
                      },
                      signal,
                    ),
                  "Analysis preference saved",
                )
              }
            />
            Allow library analysis
          </label>
          <label className="flex items-center gap-3 text-sm">
            <input
              type="checkbox"
              checked={settings.automatic}
              disabled={
                busy || !settings.analysis || !settings.backgroundAvailable
              }
              onChange={(event) =>
                void act(
                  () =>
                    FilesService.configure(
                      { ...settings, automatic: event.target.checked },
                      signal,
                    ),
                  "Organization preference saved",
                )
              }
            />
            Automatically organize new uploads using Vertex AI
          </label>
          {!settings.backgroundAvailable ? (
            <p className="text-xs text-muted-foreground">
              Background organization requires the Files worker setup in your
              cloud.
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            Storage grows with your cloud configuration. Trash and retained
            versions can still incur storage charges.
          </p>
        </section>
      ) : null}
    </>
  );
}
