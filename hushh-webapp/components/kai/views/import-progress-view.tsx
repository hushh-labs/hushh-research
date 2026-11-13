"use client";

import { useEffect, useState } from "react";
import { PortfolioReviewFrame } from "./portfolio-review-layout";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { Button } from "@/components/ui/button";
import { useCoarseClock } from "@/lib/perf/use-periodic-task";
import type { LiveHoldingPreview } from "@/lib/kai/import/live-holdings-preview";
import { ImportReviewPlaceholder } from "./import-review-placeholder";
import { AppStreamProgressMeter } from "@/components/app-ui/stream-progress-panel";

const stageLabels = {
  idle: "Preparing your statement",
  uploading: "Uploading your statement",
  indexing: "Reading your statement",
  scanning: "Reading your statement",
  thinking: "Reading your statement",
  extracting: "Finding holdings",
  normalizing: "Checking holdings",
  validating: "Checking holdings",
  complete: "Ready to review",
  error: "Statement import stopped",
} as const;

export type ImportStage = keyof typeof stageLabels;

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
  complete: [100, 100],
  error: [0, 0],
} as const satisfies Record<keyof typeof stageLabels, readonly [number, number]>;

const EASE_SECONDS = 15;
const STILL_WORKING_AFTER_SECONDS = 8;

function useImportProgress(stage: keyof typeof stageLabels) {
  // The shared clock wakes every consumer together, after a frame and never
  // while the page is hidden, instead of a timer of this component's own.
  const now = Math.max(Date.now(), useCoarseClock(1_000));
  const [began] = useState(() => Date.now());
  const [current, setCurrent] = useState({ stage, at: Date.now() });
  const failed = stage === "error";

  useEffect(() => {
    setCurrent({ stage, at: Date.now() });
  }, [stage]);

  const [start, ceiling] = stageRange[stage];
  const inStage = current.stage === stage ? Math.max(0, now - current.at) / 1000 : 0;
  const percent = Math.round(start + (ceiling - start) * (1 - Math.exp(-inStage / EASE_SECONDS)));
  return { percent, slow: !failed && (now - began) / 1000 >= STILL_WORKING_AFTER_SECONDS };
}

function fileSizeLabel(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

interface ImportProgressViewProps {
  stage: keyof typeof stageLabels;
  errorMessage?: string;
  /** The statement being read, shown at once so the card says what is happening to what. */
  fileName?: string;
  fileSize?: number;
  /** Holdings the server has confirmed so far; they fill the placeholder list as they arrive. */
  liveHoldings?: readonly LiveHoldingPreview[];
  holdingsTotal?: number;
  onCancel?: () => void;
  onRetry?: () => void;
}

export function ImportProgressStatus({ stage, fileName, fileSize, errorMessage }: Pick<ImportProgressViewProps, "stage" | "fileName" | "fileSize" | "errorMessage">) {
  const { percent, slow } = useImportProgress(stage);
  const failed = stage === "error";
  return <section aria-label="Statement import status" className="space-y-2">
    <div role="status" className="min-h-10 ui-text-row-description text-muted-foreground">
      <p>{failed ? errorMessage || "Try again or choose a different statement." : stage === "complete" ? "Ready to review" : slow ? `${stageLabels[stage]}. Still working. Larger statements take a little longer.` : stageLabels[stage]}</p>
      <p className="min-h-4 truncate">{fileName}{typeof fileSize === "number" && fileSize > 0 ? ` · ${fileSizeLabel(fileSize)}` : ""}</p>
    </div>
    {!failed ? <AppStreamProgressMeter value={percent} label="Statement import progress" className="h-1.5 bg-muted" indicatorClassName="bg-[var(--app-accent)] motion-safe:duration-300 motion-safe:ease-out" /> : null}
  </section>;
}

export function ImportProgressView({ stage, errorMessage, fileName, fileSize, liveHoldings, holdingsTotal, onCancel, onRetry }: ImportProgressViewProps) {
  const failed = stage === "error";
  return <PortfolioReviewFrame
    status={<ImportProgressStatus stage={stage} fileName={fileName} fileSize={fileSize} errorMessage={errorMessage} />}
    actions={<div className="flex min-h-11 items-center gap-2">
      {onCancel ? <ShellActionSurface variant="pill" className="min-h-11" onClick={onCancel}>{failed ? "Back" : "Cancel"}</ShellActionSurface> : null}
      {failed && onRetry ? <Button size="compact" onClick={onRetry}>Try again</Button> : null}
    </div>}
  >
    {!failed ? <ImportReviewPlaceholder rows={liveHoldings} total={holdingsTotal} /> : null}
  </PortfolioReviewFrame>;
}
