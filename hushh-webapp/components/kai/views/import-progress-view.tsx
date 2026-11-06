"use client";

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
            ) : null}
          </div>
        </div>
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
