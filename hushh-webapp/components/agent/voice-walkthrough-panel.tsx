"use client";

import { CheckCircle2, CircleDashed, Loader2, X, XCircle } from "lucide-react";
import { useEffect, useState } from "react";

import {
  isTerminalActionRunPhase,
  useActionRuns,
  type ActionRun,
} from "@/lib/interaction/interaction-intent-coordinator";

/**
 * Actions whose handler may attach a `subject` once it resolves who the
 * action is about (see the handlers themselves, and `parseVoiceSubject`).
 * Named here so a solo run of one of these earns the panel for its whole
 * processing time -- the loading beat is exactly what "who is this going
 * to" needs to show before the subject is known, and subject only arrives
 * once the handler has already returned. A step outside this list stays on
 * the original rule: a one-off action already has its own status text in
 * the bar.
 */
const SUBJECT_CAPABLE_ACTION_IDS = new Set([
  "connect.send_request",
  "location.select_share_recipient",
  "location.select_ask_recipient",
  "location.share_selected",
  "location.send_request",
]);

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
 * Deliberately hidden for a single-step task that never touches a person: a
 * one-off action already has its own status text in the bar, and this panel
 * earns its place once there is an actual sequence to follow, or once a
 * subject-capable step gives it something the bar's one-line pill can't show.
 */
export function VoiceWalkthroughPanel({
  enabled,
  onCancel,
}: {
  enabled: boolean;
  /** Aborts whatever the last step is still doing. Only ever called while
   * that step is active -- there is nothing left to abort once it settles. */
  onCancel?: () => void;
}) {
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

  // Tracks the run explicitly dismissed, by id rather than a plain boolean --
  // cancelling flips `last.phase`, which re-runs the linger effect above and
  // would otherwise re-open the card for its own "cancelled" state right
  // after this closes it. Keyed to the id so the NEXT step (a new run) is
  // unaffected by a dismissal aimed at the one before it.
  const [dismissedId, setDismissedId] = useState<string | null>(null);
  const dismissed = last ? last.id === dismissedId : false;

  // A single step still earns its place here once it either has named who
  // it is about, or belongs to an action that might -- "who am I sending
  // this to" is exactly the thing the bar's own one-line status pill has no
  // room for, and it needs to show WHILE that resolves, not only after.
  const hasSubject = group.some(
    (step) => step.subject || SUBJECT_CAPABLE_ACTION_IDS.has(step.actionId),
  );
  if (!enabled || !linger || dismissed || (group.length < 2 && !hasSubject)) {
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
              <span className={stepTextClass(step.phase)}>{step.label}</span>
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
