import type { ReactNode } from "react";

import { azureFreeTrialNotice } from "@/lib/one/azure-subscription-offer";
import { setupProgressRows, type SetupJobProgress, type SetupStage } from "@/lib/one/cloud-setup-stages";

/**
 * The one plain line for an Azure free trial, read from the setup record, or
 * nothing. Shown while setup runs and on the connected state after it.
 */
export function AzureFreeTrialNote({
  stages,
}: {
  stages: SetupJobProgress["stages"] | null | undefined;
}) {
  const notice = azureFreeTrialNotice(stages);
  if (!notice) return null;
  return (
    <p className="text-sm" role="note" data-testid="azure-free-trial-note">
      {notice}
    </p>
  );
}

/**
 * The live checklist of a background cloud job. It owns the screen while the
 * job runs: nothing competes with it, no form, no dead buttons, no guessing.
 */
export function SetupStageChecklist({
  title,
  stages,
  job,
  footnote = "You can continue the other setup steps while your cloud is prepared.",
}: {
  title: string;
  stages: readonly SetupStage[];
  job: SetupJobProgress;
  footnote?: ReactNode;
}) {
  const progress = setupProgressRows(stages, job);
  return (
    <div
      className="space-y-3 rounded-2xl border border-[var(--app-border)] p-4"
      data-testid="byoc-setup-progress"
      aria-live="polite"
    >
      <p className="text-sm font-semibold">{title}</p>
      <ul className="space-y-1.5">
        {progress.map((stage) => {
          const isCurrent = stage.state === "current";
          const isDone = stage.state === "complete";
          return (
            <li key={stage.id} className="flex items-center gap-2 text-sm" aria-current={isCurrent ? "step" : undefined}>
              <span aria-hidden className="w-4 text-center">
                {isDone ? "✓" : isCurrent ? "•" : ""}
              </span>
              <span
                className={
                  isDone
                    ? "text-[var(--app-text-secondary)]"
                    : isCurrent
                      ? "font-medium"
                      : "text-[var(--app-text-secondary)] opacity-60"
                }
              >
                {stage.label}
                {isCurrent ? "…" : ""}
              </span>
            </li>
          );
        })}
      </ul>
      <AzureFreeTrialNote stages={job.stages} />
      <p className="text-xs text-[var(--app-text-secondary)]">{footnote}</p>
    </div>
  );
}
