"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Lock } from "@/components/icons";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/use-mobile";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import {
  type ComputerUseBinding,
  type ComputerUsePhase,
  type ComputerUseSnapshot,
  type ComputerUseTransport,
  isComputerUseActivelyStreaming,
  isComputerUseTerminal,
} from "@/lib/computer-use/contracts";
import { ComputerUseTaskController } from "@/lib/computer-use/task-controller";
import { ComputerUseReview } from "./computer-use-review";
import { ComputerUseSessions } from "./computer-use-sessions";
import {
  extractVerifiedDomain,
  useWorkspaceSplitPaneHost,
  WorkspaceSplitPaneSurface,
} from "./workspace-split-pane";
import { useBackLayer } from "@/lib/navigation/back-layers";

const PHASE_COPY: Record<ComputerUsePhase, string> = {
  unavailable: "Browser unavailable on Agent One.",
  running: "Working in the browser.",
  needs_owner: "Waiting for you.",
  outcome_uncertain: "An action may have completed. Review it before continuing.",
  completed: "Browser task complete.",
  cancelled: "Browser task stopped.",
};

/** Mount in One's task area with the current admitted pod transport. */
export function ComputerUseTaskCard({
  binding,
  transport,
  route = "/",
  openReviewSignal = 0,
  onDownloadSaved,
  onTerminalSnapshot,
  onSnapshotChange,
}: {
  binding: ComputerUseBinding;
  transport: ComputerUseTransport;
  route?: string;
  openReviewSignal?: number;
  onDownloadSaved?: (receipt: { fileId: string; name: string }) => void;
  onTerminalSnapshot?: (snapshot: ComputerUseSnapshot) => void;
  onSnapshotChange?: (snapshot: ComputerUseSnapshot) => void;
}) {
  const { ownerId, podId, incarnation, taskId, environment } = binding;
  const controller = useMemo(() => new ComputerUseTaskController({ ownerId, podId, incarnation, taskId, environment }, transport),
    [ownerId, podId, incarnation, taskId, environment, transport]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const mobile = useIsMobile();
  const splitPaneHost = useWorkspaceSplitPaneHost();
  const [open, setOpen] = useState(false);
  const [reviewId, setReviewId] = useState<string | null>(null);
  const lastOpenSignalRef = useRef(openReviewSignal);
  const openedTaskRef = useRef<string | null>(null);
  const taskIdentity = JSON.stringify([ownerId, podId, incarnation, taskId, environment]);
  useBackLayer(route, reviewId ? 4 : open ? 3 : 0, () => {
    if (reviewId) setReviewId(null);
    else if (open) setOpen(false);
    else return false;
    return true;
  });

  useEffect(() => {
    controller.connect();
    void controller.refresh().catch(() => undefined);
    const interval = setInterval(() => {
      const current = controller.getSnapshot();
      if (document.hidden || current.pending || !isComputerUseActivelyStreaming(current.snapshot)) return;
      void controller.refresh().catch(() => undefined);
    }, 2_000);
    const visibility = () => {
      const current = controller.getSnapshot();
      if (!document.hidden && !current.pending && (!current.verified || isComputerUseActivelyStreaming(current.snapshot))) {
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
  useEffect(() => {
    if (state.verified && snapshot) onSnapshotChange?.(snapshot);
  }, [onSnapshotChange, snapshot, state.verified]);
  useEffect(() => {
    if (
      !state.verified || !isComputerUseActivelyStreaming(snapshot) || !snapshot?.approvedOrigins?.length
      || snapshot.review?.purpose === "model_process" || openedTaskRef.current === taskIdentity
    ) return;
    // Approved origins appear only after processing consent, unlike a worker wait.
    // Show actual work once, including reconnects. Status refreshes must respect
    // an owner's Close or Back instead of opening the same task again.
    openedTaskRef.current = taskIdentity;
    setOpen(true);
  }, [snapshot, state.verified, taskIdentity]);
  useEffect(() => {
    if (snapshot && isComputerUseTerminal(snapshot.phase)) {
      onTerminalSnapshot?.(snapshot);
    }
  }, [snapshot, onTerminalSnapshot]);
  useEffect(() => {
    if (openReviewSignal === lastOpenSignalRef.current) return;
    lastOpenSignalRef.current = openReviewSignal;
    if (openReviewSignal <= 0) return;
    if (snapshot?.review) setReviewId(snapshot.review.id);
    else setOpen(true);
  }, [openReviewSignal, snapshot]);
  const usable = state.verified && snapshot?.capability === "ready" && !isComputerUseTerminal(snapshot.phase);
  const canPreview = usable && Boolean(snapshot?.approvedOrigins?.length) && snapshot?.review?.purpose !== "model_process";
  const verifiedDomain = extractVerifiedDomain(snapshot);
  const message = !state.verified && !state.pending ? "Couldn’t reach the browser. Check again to reconnect."
    : snapshot?.code === "BROWSER_MODEL_RATE_LIMITED" ? "Your AI is busy. Try this task again later."
    : snapshot?.code === "BROWSER_WAITING_FOR_WORKER" ? "Waiting for current background work to finish…"
    : snapshot?.code === "BROWSER_DOWNLOAD_READY" ? "Download ready to save."
    : snapshot?.controlOwner === "owner" ? "You’re in control. Agent paused."
    : snapshot ? PHASE_COPY[snapshot.phase] : "Checking browser availability…";

  const control = useCallback((action: "takeover" | "resume" | "cancel"): void => {
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
  }, [controller]);

  const saveDownloadById = useCallback((downloadId: string): void => {
    void controller.saveDownload(downloadId).then(
      (saved) => {
        morphyToast.info("Saved to Files.");
        onDownloadSaved?.(saved);
      },
      () => morphyToast.error("Couldn’t verify the save. Check Files before trying again."),
    );
  }, [controller, onDownloadSaved]);

  function confirmReview(id: string): void {
    const operation = controller.review(id);
    morphyToast.promise(operation, {
      loading: "Confirming your choice…", success: "Choice confirmed.",
      error: "This request couldn’t be confirmed. Review the current request and try again.",
    });
    void operation.then(() => setReviewId(null)).catch(() => undefined);
  }

  const controls = useMemo(() => (
    <div className="flex flex-wrap items-center gap-2" aria-busy={state.pending}>
      {snapshot?.controlOwner === "owner" ? (
        <ShellActionSurface variant="pill" className="min-h-11" disabled={!usable || state.pending || Boolean(snapshot?.review) || snapshot.goalCompleted} onClick={() => control("resume")}>
          {snapshot.goalCompleted ? "Task finished" : "Resume agent"}
        </ShellActionSurface>
      ) : (
        <ShellActionSurface variant="pill" className="min-h-11" disabled={!canPreview || state.pending} onClick={() => control("takeover")}>
          Take control
        </ShellActionSurface>
      )}
      <ShellActionSurface variant="pill" className="min-h-11" disabled={!usable} onClick={() => control("cancel")}>
        Stop
      </ShellActionSurface>
      {usable && snapshot?.controlOwner === "owner" && !snapshot.publicResearchOnly && snapshot.rememberedSessionsAvailable
        && snapshot.approvedOrigins?.length ? (
          <ComputerUseSessions key={snapshot.controlEpoch} controller={controller} snapshot={snapshot} pending={state.pending} />
        ) : null}
    </div>
  ), [canPreview, control, controller, snapshot, state.pending, usable]);

  const renderSplitPaneContent = useCallback(
    (showMobileHeaderClose: boolean) => (
      <WorkspaceSplitPaneSurface
        controller={controller}
        snapshot={snapshot}
        verified={state.verified}
        canPreview={canPreview}
        statusMessage={message}
        controls={controls}
        onClose={() => setOpen(false)}
        onOpenReview={snapshot?.review ? () => setReviewId(snapshot.review?.id ?? null) : undefined}
        onSaveDownload={saveDownloadById}
        downloadPending={state.pending}
        showMobileHeaderClose={showMobileHeaderClose}
      />
    ),
    [canPreview, controller, controls, message, saveDownloadById, snapshot, state.pending, state.verified],
  );

  useEffect(() => {
    if (!splitPaneHost) return;
    if (open && !mobile) {
      splitPaneHost.setPane({
        id: taskId,
        render: () => renderSplitPaneContent(false),
      });
    } else {
      splitPaneHost.clearPane(taskId);
    }
    return () => {
      splitPaneHost.clearPane(taskId);
    };
  }, [mobile, open, renderSplitPaneContent, splitPaneHost, taskId]);

  return (
    <section className="w-full min-w-0 space-y-3 rounded-[var(--app-card-radius-compact)] border border-[color:var(--app-separator)] p-4" aria-label="Browser task">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">Browser</h3>
          <p className="text-sm text-muted-foreground" role="status">{message}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
        {usable && !open ? (
          <ShellActionSurface variant="pill" className="min-h-11" onClick={() => control("cancel")}>
            Stop
          </ShellActionSurface>
        ) : null}
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
      </div>
      {usable && snapshot?.phase === "needs_owner" && snapshot.controlOwner !== "owner" ? (
        <div
          data-testid="browser-protected-entry-card"
          className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--app-card-radius-compact)] border border-[color:var(--app-separator)] bg-foreground/[0.03] px-3 py-2.5 text-sm"
        >
          <div className="flex min-w-0 flex-1 items-start gap-2">
            <Lock className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
            <div className="min-w-0">
              <p className="font-medium text-foreground">
                {verifiedDomain ? `Waiting on ${verifiedDomain}` : "Protected sign-in or confirmation"}
              </p>
              <p className="text-xs text-muted-foreground">
                Model screen viewing stays off while you take control.
              </p>
            </div>
          </div>
          {canPreview ? (
            <ShellActionSurface
              variant="pill"
              className="min-h-10"
              disabled={state.pending}
              onClick={() => {
                setOpen(true);
                control("takeover");
              }}
            >
              Sign in privately
            </ShellActionSurface>
          ) : null}
        </div>
      ) : null}
      {state.verified && snapshot?.phase === "completed" && snapshot.summary ? (
        <p className="whitespace-pre-wrap break-words text-sm">{snapshot.summary}</p>
      ) : null}
      {usable && snapshot?.downloads?.map(download => (
        <div key={download.id} className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1 break-words text-sm">{download.name}</span>
          <ShellActionSurface variant="pill" className="min-h-11" disabled={state.pending}
            onClick={() => saveDownloadById(download.id)}>Save to Files</ShellActionSurface>
        </div>
      ))}
      {usable && snapshot?.review ? (
        <div className="flex flex-wrap items-center gap-2">
          <ShellActionSurface variant="pill" className="min-h-11" disabled={state.pending}
            onClick={() => setReviewId(snapshot.review?.id ?? null)}>Review request</ShellActionSurface>
          <ComputerUseReview review={snapshot.review} pending={state.pending}
            open={reviewId === snapshot.review.id} onClose={() => setReviewId(null)} onConfirm={confirmReview} />
        </div>
      ) : null}
      {open && !mobile && !splitPaneHost ? (
        <aside className="flex min-h-0 flex-col gap-3" aria-label="Browser preview">
          {renderSplitPaneContent(false)}
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
            <div className="min-h-0 flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom,0px)]">
              {renderSplitPaneContent(true)}
            </div>
          </SheetContent>
        </Sheet>
      ) : null}
    </section>
  );
}
