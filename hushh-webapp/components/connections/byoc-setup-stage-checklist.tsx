import type { ReactNode } from "react";

import type { SetupJobProgress, SetupStage } from "@/lib/one/cloud-setup-stages";

/**
 * The live checklist of a background cloud job. It owns the screen while the
 * job runs: nothing competes with it, no form, no dead buttons, no guessing.
 */
export function SetupStageChecklist({
  title,
  stages,
  job,
  footnote = "This runs on its own. You can go back to Setup and continue the other steps; this page and the setup list will show when your cloud is ready.",
}: {
  title: string;
  stages: readonly SetupStage[];
  job: SetupJobProgress;
  footnote?: ReactNode;
}) {
  const reached = new Set(job.stages.map((entry) => entry.stage));
  return (
    <div
      className="space-y-3 rounded-2xl border border-[var(--app-border)] p-4"
      data-testid="byoc-setup-progress"
      aria-live="polite"
    >
      <p className="text-sm font-semibold">{title}</p>
      <ul className="space-y-1.5">
        {stages.map((stage) => {
          const isCurrent = job.stage === stage.id;
          const isDone = reached.has(stage.id) && !isCurrent;
          return (
            <li key={stage.id} className="flex items-center gap-2 text-sm">
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
      <p className="text-xs text-[var(--app-text-secondary)]">{footnote}</p>
    </div>
  );
}
