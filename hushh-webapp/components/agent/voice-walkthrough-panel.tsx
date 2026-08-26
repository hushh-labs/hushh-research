"use client";

import { CheckCircle2, CircleDashed, Loader2, X, XCircle } from "lucide-react";
import { useEffect, useState } from "react";

import {
  isTerminalActionRunPhase,
  useActionRuns,
  type ActionRun,
} from "@/lib/interaction/interaction-intent-coordinator";

/**
 * Steps arriving within this long of the previous step's last update are
 * shown as one task even without a shared `goalId` -- an authored journey
 * aside, most multi-action requests are just One calling one action after
 * another in quick succession, and there is no other signal that ties them
 * together.
 */
const WALKTHROUGH_GROUP_GAP_MS = 8_000;
/**
 * How long a finished group stays on screen before it clears, so a task that
 * just settled still gets a visible "done" beat instead of vanishing the
 * instant its last step does.
 */
const WALKTHROUGH_LINGER_MS = 4_000;

/**
 * Walk backward from the newest run, gathering every run that either shares
 * its `goalId` with the run ahead of it or arrived within the group gap --
 * the current task, in order. Stops at the first run that matches neither,
 * since that run belongs to whatever came before this task started.
 */
export function currentTaskSteps(runs: readonly ActionRun[]): ActionRun[] {
  const last = runs[runs.length - 1];
  if (!last) return [];
  const group: ActionRun[] = [last];
  for (let index = runs.length - 2; index >= 0; index -= 1) {
    const run = runs[index];
    const next = group[0];
    if (!run || !next) break;
    const sameGoal = Boolean(run.goalId) && run.goalId === next.goalId;
    const withinGap = next.createdAtMs - run.updatedAtMs <= WALKTHROUGH_GROUP_GAP_MS;
    if (!sameGoal && !withinGap) break;
    group.unshift(run);
  }
  return group;
}

function StepIcon({ phase }: { phase: ActionRun["phase"] }) {
  if (phase === "completed") {
    return <CheckCircle2 className="size-4 shrink-0 text-emerald-500" aria-hidden="true" />;
  }
  if (phase === "failed" || phase === "blocked") {
    return <XCircle className="size-4 shrink-0 text-destructive" aria-hidden="true" />;
  }
  if (phase === "cancelled") {
    return <CircleDashed className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />;
  }
  return <Loader2 className="size-4 shrink-0 animate-spin text-primary" aria-hidden="true" />;
}

function stepTextClass(phase: ActionRun["phase"]): string {
  if (phase === "failed" || phase === "blocked") return "truncate text-[13px] text-destructive";
  if (phase === "cancelled") return "truncate text-[13px] text-muted-foreground";
  if (phase === "completed") return "truncate text-[13px] text-muted-foreground";
  return "truncate text-[13px] font-medium text-foreground";
}

/**
 * A card showing the action(s) One just worked through, alongside the
 * spoken narration. Every action earns its own card this way, not just
 * multi-step ones -- reuses the action-run events that already fire for
 * every action, solo or part of an authored journey, rather than requiring
 * a pre-declared multi-step plan.
 *
 * `enabled` (Walk-through mode, Voice Settings) controls only whether
 * *multiple* steps of one task get grouped into a single running panel --
 * it does not gate whether a card shows at all. A single action's own
 * result is always worth a card: that is exactly what "who is this going
 * to" needs to show, and the bar's one-line pill has no room for a name.
 */
export function VoiceWalkthroughPanel({
  enabled,
  onCancel,
}: {
  /** Groups multiple steps of one task into a single panel when true;
   * when false, each step still gets shown, just one at a time. */
  enabled: boolean;
  /** Aborts whatever the last step is still doing. Only ever called while
   * that step is active -- there is nothing left to abort once it settles. */
  onCancel?: () => void;
}) {
  const runs = useActionRuns();
  const lastRun = runs[runs.length - 1] ?? null;
  const group = enabled ? currentTaskSteps(runs) : lastRun ? [lastRun] : [];
  const last = group[group.length - 1] ?? null;
  const active = last ? !isTerminalActionRunPhase(last.phase) : false;

  const [linger, setLinger] = useState(false);
  useEffect(() => {
    if (!last) {
      setLinger(false);
      return;
    }
    if (active) {
      setLinger(true);
      return;
    }
    setLinger(true);
    const timer = setTimeout(() => setLinger(false), WALKTHROUGH_LINGER_MS);
    return () => clearTimeout(timer);
    // Only the settled run's identity and phase should re-arm the timer --
    // re-running it on every unrelated snapshot would restart the clock on
    // every step of a task still in progress.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [last?.id, last?.phase]);

  // Tracks the run explicitly dismissed, by id rather than a plain boolean --
  // cancelling flips `last.phase`, which re-runs the linger effect above and
  // would otherwise re-open the card for its own "cancelled" state right
  // after this closes it. Keyed to the id so the NEXT step (a new run) is
  // unaffected by a dismissal aimed at the one before it.
  const [dismissedId, setDismissedId] = useState<string | null>(null);
  const dismissed = last ? last.id === dismissedId : false;

  if (!linger || dismissed || group.length === 0) {
    return null;
  }

  // Closing always dismisses the card. While the last step is still running
  // there is a real task to stop, so this doubles as cancelling it; once it
  // has settled there is nothing left to abort and this only hides the card
  // before its linger timer would have.
  const handleClose = () => {
    if (active) onCancel?.();
    if (last) setDismissedId(last.id);
  };

  return (
    <div
      className="agent-approval-glass pointer-events-none w-full max-w-[min(calc(100vw-3rem),392px)] rounded-3xl p-4 text-[#1d1d1f] dark:text-[#f5f5f7]"
      data-testid="voice-walkthrough-panel"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center justify-between gap-2 pb-2">
        <p className="text-[13px] font-medium text-muted-foreground">
          Working through this
        </p>
        <button
          type="button"
          onClick={handleClose}
          aria-label={active ? "Stop this task" : "Dismiss"}
          className="pointer-events-auto flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.1]"
        >
          <X className="size-3.5" aria-hidden="true" />
        </button>
      </div>
      <ul className="flex flex-col gap-2">
        {group.map((step) => (
          <li key={step.id} className="flex flex-col gap-1">
            <div className="flex items-center gap-2.5">
              <StepIcon phase={step.phase} />
              {/* message over label: label is a static per-action-type name
                  ("Leave a circle"), message is the specific, current
                  sentence ("Preparing Leave a circle" while running,
                  "Left Family." once it settles) -- the card's whole job is
                  showing what actually happened, not just which kind of
                  action it was. */}
              <span className={stepTextClass(step.phase)}>{step.message || step.label}</span>
            </div>
            {step.subject ? (
              <div className="ml-[26px] flex min-w-0 flex-col">
                <span className="truncate text-xs font-medium text-foreground">
                  {step.subject.name}
                </span>
                {step.subject.detail ? (
                  <span className="truncate text-[11px] text-muted-foreground">
                    {step.subject.detail}
                  </span>
                ) : null}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
