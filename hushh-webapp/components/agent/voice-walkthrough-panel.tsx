"use client";

import { CheckCircle2, CircleDashed, Loader2, XCircle } from "lucide-react";
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
 * A live list of the steps One is working through, shown alongside the
 * spoken narration when the person has turned on walk-through mode (Voice
 * Settings). Reuses the action-run events that already fire for every
 * action -- solo or part of an authored journey -- rather than requiring a
 * pre-declared multi-step plan: each new call simply appends to, or starts,
 * the visible list.
 *
 * Deliberately hidden for a single-step task: a one-off action already has
 * its own status text in the bar, and this panel earns its place once there
 * is an actual sequence to follow.
 */
export function VoiceWalkthroughPanel({ enabled }: { enabled: boolean }) {
  const runs = useActionRuns();
  const group = enabled ? currentTaskSteps(runs) : [];
  const last = group[group.length - 1] ?? null;
  const active = last ? !isTerminalActionRunPhase(last.phase) : false;

  const [linger, setLinger] = useState(false);
  useEffect(() => {
    if (!enabled || !last) {
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
  }, [enabled, last?.id, last?.phase]);

  if (!enabled || !linger || group.length < 2) return null;

  return (
    <div
      className="agent-approval-glass pointer-events-none w-full max-w-[min(calc(100vw-3rem),392px)] rounded-3xl p-4 text-[#1d1d1f] dark:text-[#f5f5f7]"
      data-testid="voice-walkthrough-panel"
      role="status"
      aria-live="polite"
    >
      <p className="pb-2 text-[13px] font-medium text-muted-foreground">
        Working through this
      </p>
      <ul className="flex flex-col gap-2">
        {group.map((step) => (
          <li key={step.id} className="flex items-center gap-2.5">
            <StepIcon phase={step.phase} />
            <span className={stepTextClass(step.phase)}>{step.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
