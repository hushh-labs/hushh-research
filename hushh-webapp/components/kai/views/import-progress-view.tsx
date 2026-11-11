"use client";

import { useEffect, useState } from "react";
import { AppPageContentRegion } from "@/components/app-ui/app-page-shell";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { FileChartColumn, Loader2 } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const stageLabels = {
  idle: "Preparing your statement",
  uploading: "Uploading your statement",
  indexing: "Reading your statement",
  scanning: "Reading your statement",
  thinking: "Reading your statement",
  extracting: "Finding holdings",
  normalizing: "Checking holdings",
  validating: "Checking holdings",
  error: "Statement import stopped",
} as const;

export type ImportStage = keyof typeof stageLabels | "complete";

// Where the bar sits while a stage runs: it starts at the first number and
// eases toward the second, never reaching the next stage's start, so it only
// ever moves forward. The extraction stage is the long one, so it gets the
// widest range. This is an estimate shown for reassurance, not a measurement.
const stageRange = {
  idle: [3, 8],
  uploading: [10, 24],
  indexing: [26, 36],
  scanning: [38, 46],
  thinking: [48, 56],
  extracting: [58, 88],
  normalizing: [90, 94],
  validating: [95, 98],
  error: [0, 0],
} as const satisfies Record<keyof typeof stageLabels, readonly [number, number]>;

const EASE_SECONDS = 15;
const STILL_WORKING_AFTER_SECONDS = 8;

function useImportProgress(stage: keyof typeof stageLabels) {
  const [now, setNow] = useState(() => Date.now());
  const [began] = useState(() => Date.now());
  const [current, setCurrent] = useState({ stage, at: Date.now() });
  const failed = stage === "error";

  useEffect(() => {
    setCurrent({ stage, at: Date.now() });
  }, [stage]);
  useEffect(() => {
    if (failed) return;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [failed]);

  const [start, ceiling] = stageRange[stage];
  const inStage = current.stage === stage ? Math.max(0, now - current.at) / 1000 : 0;
  const percent = Math.round(start + (ceiling - start) * (1 - Math.exp(-inStage / EASE_SECONDS)));
  return { percent, slow: !failed && (now - began) / 1000 >= STILL_WORKING_AFTER_SECONDS };
}

interface ImportProgressViewProps {
  stage: keyof typeof stageLabels;
  errorMessage?: string;
  onCancel?: () => void;
  onRetry?: () => void;
}

export function ImportProgressView({
  stage,
  errorMessage,
  onCancel,
  onRetry,
}: ImportProgressViewProps) {
  const failed = stage === "error";
  const StatusIcon = failed ? FileChartColumn : Loader2;
  const retry = failed ? onRetry : undefined;
  const { percent, slow } = useImportProgress(stage);

  return (
    <AppPageContentRegion className="app-type-compact">
      <section aria-labelledby="statement-import-title" className="mx-auto w-full max-w-lg space-y-4 rounded-[var(--app-card-radius-standard)] bg-[var(--app-card-surface-default)] p-4 sm:p-5">
        <div className="flex items-start gap-3">
          <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted">
            <StatusIcon className={cn("size-4", !failed && "motion-safe:animate-spin")} aria-hidden="true" />
          </div>
          <div className="min-w-0 space-y-0.5" role="status">
            <h1 id="statement-import-title" className="ui-text-section-label">
              {stageLabels[stage]}
            </h1>
            {failed ? (
              <p className="ui-text-row-description text-muted-foreground">
                {errorMessage || "Try again or choose a different statement."}
              </p>
            ) : slow ? (
              <p className="ui-text-row-description text-muted-foreground">
                Still working. Larger statements take a little longer.
              </p>
            ) : null}
          </div>
        </div>
        {failed ? null : (
          <div
            role="progressbar"
            aria-label="Statement import progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
          >
            <div
              className="h-full rounded-full bg-[var(--app-accent)] motion-safe:transition-[width] motion-safe:duration-500 motion-safe:ease-out"
              style={{ width: `${percent}%` }}
            />
          </div>
        )}
        {onCancel || retry ? (
          <div className="flex flex-wrap items-center justify-end gap-2">
            {onCancel ? <ShellActionSurface variant="pill" className="min-h-11" onClick={onCancel}>{failed ? "Back" : "Cancel"}</ShellActionSurface> : null}
            {retry ? <Button size="compact" onClick={retry}>Try again</Button> : null}
          </div>
        ) : null}
      </section>
    </AppPageContentRegion>
  );
}
