"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { X } from "@/components/icons";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/use-mobile";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import { type ComputerUseBinding, type ComputerUsePhase, type ComputerUseTransport, isComputerUseTerminal } from "@/lib/computer-use/contracts";
import { ComputerUseTaskController } from "@/lib/computer-use/task-controller";
import { ComputerUsePreview } from "./computer-use-preview";
import { ComputerUseReview } from "./computer-use-review";
import { ComputerUseSessions } from "./computer-use-sessions";

const PHASE_COPY: Record<ComputerUsePhase, string> = {
  unavailable: "Browser unavailable on this private agent.",
  running: "Working in the browser.",
  needs_owner: "Waiting for you.",
  outcome_uncertain: "An action may have completed. Review it before continuing.",
  completed: "Browser task complete.",
  cancelled: "Browser task stopped.",
};

/** Mount in One's task area with the current admitted pod transport. */
export function ComputerUseTaskCard({ binding, transport }: {
  binding: ComputerUseBinding;
  transport: ComputerUseTransport;
}) {
  const { ownerId, podId, incarnation, taskId, environment } = binding;
  const controller = useMemo(() => new ComputerUseTaskController({ ownerId, podId, incarnation, taskId, environment }, transport),
    [ownerId, podId, incarnation, taskId, environment, transport]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const mobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const [reviewId, setReviewId] = useState<string | null>(null);

  useEffect(() => {
    controller.connect();
    void controller.refresh().catch(() => undefined);
    const interval = setInterval(() => {
      const current = controller.getSnapshot();
      if (document.hidden || current.pending || !current.snapshot
        || isComputerUseTerminal(current.snapshot.phase)) return;
      void controller.refresh().catch(() => undefined);
    }, 2_000);
    const visibility = () => {
      if (!document.hidden && !controller.getSnapshot().pending) {
        void controller.refresh().catch(() => undefined);
      }
    };
    document.addEventListener("visibilitychange", visibility);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", visibility);
      controller.dispose();
    };
  }, [controller]);

  const snapshot = state.snapshot;
  const usable = state.verified && snapshot?.capability === "ready" && !isComputerUseTerminal(snapshot.phase);
  const canPreview = usable && snapshot?.review?.purpose !== "model_process";
  const message = !state.verified && !state.pending ? "Couldn’t reach the browser. Check again to reconnect."
    : snapshot?.controlOwner === "owner" ? "You’re in control. Agent paused."
    : snapshot ? PHASE_COPY[snapshot.phase] : "Checking browser availability…";

  function control(action: "takeover" | "resume" | "cancel"): void {
    const labels = {
      takeover: ["Pausing the agent…", "You’re in control."],
      resume: ["Resuming the agent…", "Agent resumed."],
      cancel: ["Stopping the browser task…", "Browser task stopped."],
    } as const;
    const operation = controller.control(action);
    morphyToast.promise(operation, {
      loading: labels[action][0], success: labels[action][1],
      error: "Couldn’t confirm that change. Check the browser before continuing.",
    });
    void operation.catch(() => undefined);
  }

  function confirmReview(id: string): void {
    const operation = controller.review(id);
    morphyToast.promise(operation, {
      loading: "Confirming your choice…", success: "Choice confirmed.",
      error: "This request couldn’t be confirmed. Review the current request and try again.",
    });
    void operation.then(() => setReviewId(null)).catch(() => undefined);
  }

  const controls = (
    <div className="flex flex-wrap items-center gap-2" aria-busy={state.pending}>
      {snapshot?.controlOwner === "owner" ? (
        <ShellActionSurface variant="pill" className="min-h-11" disabled={!usable || state.pending || Boolean(snapshot?.review)} onClick={() => control("resume")}>
          Resume agent
        </ShellActionSurface>
      ) : (
        <ShellActionSurface variant="pill" className="min-h-11" disabled={!canPreview || state.pending} onClick={() => control("takeover")}>
          Take control
        </ShellActionSurface>
      )}
      <ShellActionSurface variant="pill" className="min-h-11" disabled={!usable || state.controlling} onClick={() => control("cancel")}>
        Stop
      </ShellActionSurface>
      {usable && snapshot?.controlOwner === "owner" && snapshot.rememberedSessionsAvailable
        && snapshot.approvedOrigins?.length ? (
          <ComputerUseSessions key={snapshot.controlEpoch} controller={controller} snapshot={snapshot} pending={state.pending} />
        ) : null}
    </div>
  );

  return (
    <section className="w-full min-w-0 space-y-3 rounded-[var(--app-card-radius-compact)] border border-[color:var(--app-separator)] p-4" aria-label="Browser task">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">Browser</h3>
          <p className="text-sm text-muted-foreground" role="status">{message}</p>
        </div>
        {!state.verified ? (
          <ShellActionSurface variant="pill" className="min-h-11" disabled={state.pending}
            onClick={() => { void controller.refresh().catch(() => morphyToast.error("Browser is unavailable. Try again in a moment.")); }}>
            Check again
          </ShellActionSurface>
        ) : (
          <ShellActionSurface variant="pill" className="min-h-11" disabled={!canPreview}
            onClick={() => setOpen(true)} aria-expanded={open}>
            View browser
          </ShellActionSurface>
        )}
      </div>
      {usable && snapshot?.review ? (
        <div className="flex flex-wrap items-center gap-2">
          <ShellActionSurface variant="pill" className="min-h-11" disabled={state.pending}
            onClick={() => setReviewId(snapshot.review?.id ?? null)}>Review request</ShellActionSurface>
          {!open ? <ShellActionSurface variant="pill" className="min-h-11" disabled={state.controlling}
            onClick={() => control("cancel")}>Stop</ShellActionSurface> : null}
          <ComputerUseReview review={snapshot.review} pending={state.pending}
            open={reviewId === snapshot.review.id} onClose={() => setReviewId(null)} onConfirm={confirmReview} />
        </div>
      ) : null}
      {open && !mobile ? (
        <aside className="flex min-h-0 flex-col gap-3" aria-label="Browser preview">
          <div className="flex items-center justify-between gap-3">
            {controls}
            <ShellActionSurface className="size-11" aria-label="Close browser preview" onClick={() => setOpen(false)}>
              <X className="size-4" aria-hidden />
            </ShellActionSurface>
          </div>
          <ComputerUsePreview controller={controller} />
        </aside>
      ) : null}
      {mobile ? (
        <Sheet open={open} onOpenChange={setOpen} modal>
          <SheetContent side="bottom" dragDismiss={false} contentDragDismiss={false}
            className="flex max-h-[90dvh] flex-col gap-3 overflow-hidden p-4">
            <SheetHeader className="p-0 pr-10 text-left">
              <SheetTitle>Browser</SheetTitle>
              <SheetDescription>{message}</SheetDescription>
            </SheetHeader>
            {controls}
            <div className="min-h-0 flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom,0px)]">
              <ComputerUsePreview controller={controller} />
            </div>
          </SheetContent>
        </Sheet>
      ) : null}
    </section>
  );
}
