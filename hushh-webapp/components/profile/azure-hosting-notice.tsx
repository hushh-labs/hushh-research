"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/lib/morphy-ux/morphy";
import { useAzureSetupStartedSignal, useAzureSignIn } from "@/lib/one/azure-sign-in";
import { ApiService } from "@/lib/services/api-service";
import type { AzureHosting } from "@/lib/services/azure-byoc-contract";

/**
 * The Azure hosting card's one sentence and one action when Microsoft removed the
 * agent's hosting space (its 90-day idle policy for Container Apps environments).
 *
 * The rebuild is the owner-approved setup in adopt mode: the hub keeps the agent's
 * identity, vault and storage and re-creates only the hosting space and the agent.
 * A running rebuild is followed to its terminal status whatever the hosting reads
 * mid-job (the agent is not built yet, or its grant has not applied). Every other
 * state, and any read that fails, renders nothing: this card never invents a
 * problem or shows a raw error.
 */

export const HOSTING_RECLAIMED_SENTENCE =
  "Microsoft removed your agent’s hosting space after a long idle period. Your memory and keys are safe.";
export const HOSTING_UNCONFIRMED_SENTENCE =
  "Hussh can no longer see your agent’s hosting space in Azure. If Microsoft removed it after a long idle period, your memory and keys are still in your subscription.";
export const REBUILDING_SENTENCE =
  "Rebuilding your agent’s hosting space. This takes a few minutes; your memory and keys stay where they are.";
export const REBUILD_FAILED_FALLBACK =
  "The rebuild did not finish. Your memory and keys are untouched; try again.";
export const REBUILD_STOPPED_FALLBACK = "The rebuild did not finish. Your memory and keys are untouched.";

const POLL_MS = 10_000;

function actionLabel(hosting: AzureHosting): string {
  if (hosting.rebuild?.status === "failed") return "Try again";
  return hosting.state === "hosting_reclaimed" ? "Rebuild it" : "Check and rebuild";
}

export function AzureHostingNotice({ onRebuilt }: { onRebuilt?: () => void }) {
  const [hosting, setHosting] = useState<AzureHosting | null>(null);
  const [handedOff, setHandedOff] = useState(false);
  const wasRunning = useRef(false);
  const mounted = useRef(true);
  const signIn = useAzureSignIn();

  const read = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const next = await ApiService.getAzureHosting({ signal });
        if (!mounted.current) return;
        setHosting(next);
        setHandedOff(false);
        // Only the rebuild's own terminal status ends the follow: mid-job the hosting
        // reads agent_removed or agent_unreadable while the job is still running. A
        // finished rebuild gives the card above news, so refresh it once; a refused
        // one stays here with its own sentence.
        const runningNow = next.rebuild?.status === "running";
        if (wasRunning.current && !runningNow && next.rebuild?.status !== "failed") onRebuilt?.();
        wasRunning.current = runningNow;
      } catch {
        // An unreadable hosting state says nothing; the card above already shows hosting.
      }
    },
    [onRebuilt],
  );

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void read(controller.signal);
    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, [read]);

  // The Microsoft popup hands back as a setup; acknowledge it and follow the rebuild.
  const onStarted = useCallback(() => {
    setHandedOff(true);
    void read();
  }, [read]);
  useAzureSetupStartedSignal(onStarted, "setup");

  const running = handedOff || hosting?.rebuild?.status === "running";
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void read(), POLL_MS);
    return () => clearInterval(timer);
  }, [running, read]);

  if (running) {
    return (
      <p role="status" className="text-sm text-muted-foreground" data-testid="azure-hosting-notice">
        {REBUILDING_SENTENCE}
      </p>
    );
  }
  if (!hosting) return null;
  const failed = hosting.rebuild?.status === "failed";
  if (!hosting.rebuildable) {
    // The rebuild's last word outside the rebuildable states, such as a refused
    // hand-off once the agent was built. No button: there is nothing to rebuild.
    return failed ? (
      <p role="status" className="text-sm text-muted-foreground" data-testid="azure-hosting-notice">
        {hosting.rebuild?.message ?? REBUILD_STOPPED_FALLBACK}
      </p>
    ) : null;
  }
  // The owner's own check found the agent still there: say so, and do not offer it again.
  const offerAction = !failed || hosting.rebuild?.retryable !== false;
  return (
    <div className="space-y-2" data-testid="azure-hosting-notice">
      <p className="text-sm text-muted-foreground">
        {hosting.state === "hosting_reclaimed" ? HOSTING_RECLAIMED_SENTENCE : HOSTING_UNCONFIRMED_SENTENCE}
      </p>
      {failed ? (
        <p className="text-sm text-muted-foreground">{hosting.rebuild?.message ?? REBUILD_FAILED_FALLBACK}</p>
      ) : null}
      {offerAction ? (
        <Button disabled={signIn.starting} onClick={() => void signIn.start("rebuild")}>
          {signIn.starting ? "Opening Microsoft sign-in…" : actionLabel(hosting)}
        </Button>
      ) : null}
      {signIn.error || signIn.notice ? (
        <p role="alert" className="text-sm text-muted-foreground">
          {signIn.error ?? signIn.notice}
        </p>
      ) : null}
    </div>
  );
}
