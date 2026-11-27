"use client";

import Link from "next/link";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { SurfaceCard } from "@/components/app-ui/surfaces";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { GoalEditor } from "./goal-editor";
import { isValidatedAuthSessionOwnerCurrent, snapshotValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { ROUTES } from "@/lib/navigation/routes";
import { GoalsPkmService, type GoalPlanInput } from "@/lib/services/goals-pkm-service";
import type { TodoWriteParams } from "@/lib/services/todo-list-pkm-service";
import type { TodoItem } from "@/lib/todos/todo-list-model";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";

export function ChatGoalPlanCard({ proposal, credentials, onDismiss, onSettled, onEditorOpenChange, hidden }: {
  proposal: GoalPlanInput;
  credentials: TodoWriteParams;
  onDismiss: () => void;
  onSettled?: () => void;
  onEditorOpenChange?: (open: boolean) => void;
  hidden?: boolean;
}) {
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    onEditorOpenChange?.(open);
    return () => onEditorOpenChange?.(false);
  }, [onEditorOpenChange, open]);
  const [saved, setSaved] = useState(false);
  const [tasks, setTasks] = useState<TodoItem[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draftId] = useState(() => crypto.randomUUID());
  const [admission] = useState(() => ({
    owner: snapshotValidatedAuthSessionOwner(),
    epoch: snapshotVaultSessionEpoch(),
  }));
  const reviewVersion = useRef(0);
  const inFlight = useRef(false);
  useEffect(() => () => { reviewVersion.current += 1; }, []);

  function currentReview() {
    const { owner, epoch } = admission;
    const version = reviewVersion.current;
    return () => reviewVersion.current === version && owner?.userId === credentials.userId &&
      isValidatedAuthSessionOwnerCurrent(owner) && isVaultSessionEpochCurrent(epoch);
  }

  function close() {
    if (!inFlight.current) {
      reviewVersion.current += 1;
      setOpen(false);
    }
    return true;
  }

  useBackLayer(ROUTES.HOME, open ? 3 : 0, close);

  async function loadReview() {
    const current = currentReview();
    if (!current()) return;
    setOpen(true);
    setTasks(null);
    setError(null);
    try {
      const workspace = await GoalsPkmService.loadWorkspace(credentials);
      if (current()) setTasks(workspace.tasks.filter(task => task.status !== "deleted"));
    } catch {
      if (current()) setError("Couldn’t load your saved tasks.");
    }
  }

  async function save(plan: GoalPlanInput) {
    const current = currentReview();
    if (inFlight.current || !current()) return;
    inFlight.current = true;
    setSaving(true);
    setError(null);
    try {
      const { result } = await GoalsPkmService.create(
        { ...plan, category: plan.category?.trim() || null },
        { ...credentials, confirmedByUser: true, draftId },
      );
      if (!current()) return;
      if (!result.success) throw new Error("GOAL_SAVE_UNCONFIRMED");
      setOpen(false);
      setSaved(true);
      onSettled?.();
      setTasks(null);
    } catch {
      if (current()) setError("Couldn’t confirm the save. Check your plan and try again.");
    } finally {
      inFlight.current = false;
      if (current()) setSaving(false);
    }
  }

  return (
    <div hidden={hidden && !saved}>
    <SurfaceCard className="my-3 space-y-3 p-4" aria-label="Goal proposal">
      <h3 className="font-medium">{saved ? "Goal saved" : "Review your goal"}</h3>
      {!saved ? <p className="break-words text-sm text-muted-foreground">{proposal.title}</p> : null}
      <div className="flex flex-wrap gap-2">
        {saved ? (
          <>
            <Button asChild variant="outline"><Link href={ROUTES.ONE_GOALS}>Open Goals</Link></Button>
            <Button asChild variant="outline"><Link href={ROUTES.ONE_TASKS}>Open Tasks</Link></Button>
          </>
        ) : (
          <>
            <Button onClick={() => void loadReview()}>Review plan</Button>
            <Button variant="ghost" onClick={onDismiss}>Dismiss goal proposal</Button>
          </>
        )}
      </div>
      <Dialog open={open} onOpenChange={value => { if (!value) close(); }}>
        <DialogContent className="max-h-[85dvh] overflow-y-auto p-0 sm:max-w-xl" showCloseButton={!saving}>
          <DialogHeader className="px-4 pt-4 sm:px-5 sm:pt-5">
            <DialogTitle>Review goal plan</DialogTitle>
            <DialogDescription>Save the goal and its chosen tasks to your vault.</DialogDescription>
          </DialogHeader>
          {tasks ? (
            <GoalEditor initial={proposal} tasks={tasks} editing={false} saving={saving} error={error}
              onCancel={close} onSave={plan => void save(plan)} />
          ) : error ? (
            <div className="space-y-3 p-4">
              <p role="alert">{error}</p>
              <Button variant="outline" onClick={() => void loadReview()}>Retry</Button>
            </div>
          ) : <p role="status" className="p-4 text-sm">Checking your saved tasks…</p>}
        </DialogContent>
      </Dialog>
    </SurfaceCard>
    </div>
  );
}
