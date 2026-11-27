"use client";

import { useEffect, useRef, useState } from "react";
import { ReviewArguments } from "@/components/agent/mcp-call-review-values";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { serverNow } from "@/lib/agent/server-clock";
import { isValidatedAuthSessionOwnerCurrent, snapshotValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { ROUTES } from "@/lib/navigation/routes";
import { ExternalConnectorService } from "@/lib/services/external-connector-service";
import type { PodScheduledTasksClient, ScheduledApprovalReview, ScheduledTask } from "@/lib/services/pod-scheduled-tasks";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";

export function ScheduledRunApprovalDialog({ task, client, vaultOwnerToken, onExit }: {
  task: ScheduledTask;
  client: PodScheduledTasksClient;
  vaultOwnerToken: string;
  onExit: () => void;
}) {
  const [review, setReview] = useState<ScheduledApprovalReview | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const attempted = useRef(false);
  const operation = useRef<{ signal: AbortSignal; isCurrent: () => boolean } | null>(null);

  useEffect(() => {
    const owner = snapshotValidatedAuthSessionOwner();
    const epoch = snapshotVaultSessionEpoch();
    const request = new AbortController();
    const isCurrent = () => !request.signal.aborted && owner !== null &&
      isValidatedAuthSessionOwnerCurrent(owner) && isVaultSessionEpochCurrent(epoch);
    operation.current = { signal: request.signal, isCurrent };
    if (!isCurrent()) {
      setMessage("Unlock your account to review this action.");
      return () => request.abort();
    }
    void client.reviewParkedRun(task, request.signal).then(value => {
      if (isCurrent()) setReview(value);
    }).catch(() => {
      if (isCurrent()) setMessage("This review couldn’t load. Refresh the run to check its current status.");
    });
    return () => request.abort();
  }, [client, task]);

  const close = () => {
    if (!busy) onExit();
    return true;
  };
  useBackLayer(ROUTES.ONE_TASKS, 3, close);

  async function approve() {
    const active = operation.current;
    if (!review?.preview.podReview || !active?.isCurrent() || attempted.current) return;
    if (Date.parse(review.preview.expiresAt) <= serverNow()) {
      setReview(null);
      setMessage("This approval expired. Refresh the run to check its current status.");
      return;
    }
    attempted.current = true;
    setBusy(true);
    setReview(null);
    try {
      const approval = await ExternalConnectorService.confirmMcpCall({
        vaultOwnerToken,
        scheduled: true,
        conversationId: review.preview.podReview.conversationId,
        reference: review.preview,
        signal: active.signal,
        isEffectCurrent: active.isCurrent,
      });
      if (!active.isCurrent()) return;
      await client.continueParkedRun(review, approval, active.signal);
      if (active.isCurrent()) onExit();
    } catch {
      if (active.isCurrent()) {
        setMessage("The outcome couldn’t be confirmed. Refresh the run and check the connected app before trying again.");
      }
    } finally {
      if (active.isCurrent()) setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={open => { if (!open) close(); }}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Review scheduled action</DialogTitle>
          <DialogDescription>Allow this exact connector action once to continue the paused run.</DialogDescription>
        </DialogHeader>
        {review && (
          <div className="space-y-2">
            <p className="break-words text-sm font-medium">{review.preview.connectorLabel} · {review.preview.toolLabel.replaceAll("_", " ")}</p>
            <ReviewArguments args={review.preview.arguments} />
          </div>
        )}
        {message ? (
          <p role="alert" className="text-sm text-muted-foreground">{message}</p>
        ) : !review && (
          <p role="status" className="text-sm text-muted-foreground">{busy ? "Continuing the run…" : "Loading the action for review…"}</p>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={close}>Close</Button>
          {message ? (
            <Button onClick={onExit}>Refresh run</Button>
          ) : (
            <Button disabled={!review || busy} onClick={() => void approve()}>Allow once</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
