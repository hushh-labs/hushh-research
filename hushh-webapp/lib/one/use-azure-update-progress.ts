"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  approveAgentUpdate,
  openAzureUpdateSignInPopup,
  type AgentUpdateApproval,
} from "@/lib/one/agent-update-approval";
import {
  azureUpdateVerdict,
  isUpdateJobRecord,
  type AzureUpdateVerdict,
} from "@/lib/one/azure-update-outcome";
import {
  azureSignInErrorMessage,
  isAzureSignInAvailable,
  openSignInPopup,
  POPUP_WATCH_MS,
  startAzureSignIn,
  useAzureSetupStartedSignal,
  type AzureSignInStarted,
} from "@/lib/one/azure-sign-in";
import { AZURE_UPDATE_JOB_RECHECK_MS } from "@/lib/one/azure-update-sign-in";
import { ApiService } from "@/lib/services/api-service";

/** Past this, a forgotten tab stops asking and says it could not confirm. */
export const AZURE_UPDATE_FOLLOW_CEILING_MS = 15 * 60_000;

type AgentStatus = Awaited<ReturnType<typeof ApiService.getPersonalAgentStatus>>;
type SetupStatus = Awaited<ReturnType<typeof ApiService.getByocSetupStatus>>;

export type AzureUpdateOutcome =
  | Exclude<AzureUpdateVerdict, { kind: "updated" }>
  | { kind: "updated"; version: string | null; releasedAt: string | null }
  | { kind: "unconfirmed" };

export type AzureUpdateFollow = {
  jobId: string | null;
  approvedVersion: string | null;
  /**
   * This update's job, already read to its end (failed or stale) by the caller:
   * used as it is and never read again, so only the agent's status is polled.
   */
  settledJob?: SetupStatus;
};

/** One read of what speaks about the update: the agent's status and this update's job. */
async function readUpdate(
  follow: AzureUpdateFollow,
): Promise<{ status: AgentStatus | null; job: SetupStatus | null }> {
  const statusRead = ApiService.getPersonalAgentStatus().catch(() => null);
  if (follow.settledJob) return { status: await statusRead, job: follow.settledJob };
  const [status, job] = await Promise.all([
    statusRead,
    follow.jobId ? ApiService.getByocSetupStatus().catch(() => null) : null,
  ]);
  return { status, job: isUpdateJobRecord(job, follow.jobId) ? job : null };
}

/** A settled verdict as shown, with the release date when the status names it. */
function settledOutcome(
  verdict: Exclude<AzureUpdateVerdict, { kind: "updating" }>,
  status: AgentStatus | null,
): AzureUpdateOutcome {
  if (verdict.kind !== "updated") return verdict;
  const offered = status?.availableRelease;
  return { ...verdict, releasedAt: offered?.version === verdict.version ? offered.releasedAt : null };
}

/**
 * Read one update's job and the agent's status at a gentle interval until the
 * update settles (`azureUpdateVerdict`), or the ceiling passes. `follow` must
 * be stable: a new object starts a new follow.
 */
export function useAzureUpdateOutcome(
  follow: AzureUpdateFollow | null,
  { intervalMs = AZURE_UPDATE_JOB_RECHECK_MS, onSettled }: { intervalMs?: number; onSettled?: () => void } = {},
): AzureUpdateOutcome | null {
  const [outcome, setOutcome] = useState<{ follow: AzureUpdateFollow; value: AzureUpdateOutcome } | null>(null);
  const settled = useRef(onSettled);
  useEffect(() => {
    settled.current = onSettled;
  }, [onSettled]);

  useEffect(() => {
    if (!follow) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const startedAt = Date.now();
    let approvedVersion = follow.approvedVersion;
    const show = (value: AzureUpdateOutcome) => setOutcome({ follow, value });
    const read = async () => {
      const { status, job } = await readUpdate(follow);
      if (cancelled) return;
      // Without the release the person approved, the one on offer is it.
      approvedVersion ??= status?.availableRelease?.version ?? null;
      const verdict = azureUpdateVerdict({ approvedVersion, status, job });
      if (verdict.kind !== "updating") {
        show(settledOutcome(verdict, status));
        settled.current?.();
      } else if (Date.now() - startedAt >= AZURE_UPDATE_FOLLOW_CEILING_MS) {
        show({ kind: "unconfirmed" });
      } else {
        show(verdict);
        timer = setTimeout(() => void read(), intervalMs);
      }
    };
    void read();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [follow, intervalMs]);

  return follow && outcome?.follow === follow ? outcome.value : null;
}

export type AzureUpdateProgress =
  | { kind: "idle" }
  | { kind: "signing_in" }
  | { kind: "closed" }
  | AzureUpdateOutcome;

const IDLE: AzureUpdateProgress = { kind: "idle" };

/** The parts of the agent's status an approval needs: its home and the release on offer. */
type ApprovingAgent =
  | { deploymentTarget?: string | null; availableRelease?: { version: string } | null }
  | null
  | undefined;

type WatchSignIn = (popup: Window, version: string | null) => void;

/**
 * Notices a Microsoft popup closed before its hand-back. `markHandedOff` ends the
 * watch: from then on a closed popup is expected, not a stop.
 */
function usePopupCloseWatch(onClosed: () => void) {
  const watch = useRef<ReturnType<typeof setInterval> | null>(null);
  const handedOff = useRef(false);
  const closed = useRef(onClosed);
  useEffect(() => {
    closed.current = onClosed;
  }, [onClosed]);

  const stop = useCallback(() => {
    if (watch.current) clearInterval(watch.current);
    watch.current = null;
  }, []);
  useEffect(() => stop, [stop]);

  const start = useCallback(
    (popup: Window) => {
      stop();
      handedOff.current = false;
      watch.current = setInterval(() => {
        if (handedOff.current) return stop();
        if (!popup.closed) return;
        stop();
        closed.current();
      }, POPUP_WATCH_MS);
    },
    [stop],
  );
  const markHandedOff = useCallback(() => {
    handedOff.current = true;
    stop();
  }, [stop]);
  return { start, stop, markHandedOff };
}

/**
 * Approve the offered update from a click. The Microsoft popup opens before the
 * first await (blockers need the gesture); `watchSignIn` then follows it.
 */
function useApproveInPlace(watchSignIn: WatchSignIn) {
  return useCallback(
    async (input: {
      agent: ApprovingAgent;
      releaseId: string;
      idempotencyKey: string;
    }): Promise<AgentUpdateApproval> => {
      const deploymentTarget = input.agent?.deploymentTarget;
      const popup = openAzureUpdateSignInPopup(deploymentTarget);
      const approval = await approveAgentUpdate({
        deploymentTarget,
        releaseId: input.releaseId,
        idempotencyKey: input.idempotencyKey,
        popup,
      });
      if (popup && approval === "signing_in_popup") {
        watchSignIn(popup, input.agent?.availableRelease?.version ?? null);
      }
      return approval;
    },
    [watchSignIn],
  );
}

/** Restart the update's sign-in beside the app; the approval is already on record. */
function useRetryInPlace(watchSignIn: WatchSignIn, showError: (message: string | null) => void) {
  const inFlight = useRef(false);
  const [retrying, setRetrying] = useState(false);
  const retry = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setRetrying(true);
    showError(null);
    // Opened before the first await: popup blockers need the click's gesture.
    const popup = isAzureSignInAvailable() ? openSignInPopup() : null;
    try {
      const where = await startAzureSignIn("upgrade", undefined, popup);
      if (popup && where === "popup") watchSignIn(popup, null);
    } catch (cause) {
      popup?.close();
      showError(azureSignInErrorMessage(cause, "upgrade"));
    } finally {
      inFlight.current = false;
      setRetrying(false);
    }
  }, [showError, watchSignIn]);
  return { retry, retrying };
}

/**
 * An Azure update followed from where the person approved it (the profile pane
 * or the Feed card), so approving never sends them to another route.
 *
 * `watchSignIn` takes the Microsoft popup the click opened. The popup's return
 * page hands back over `useAzureSetupStartedSignal` with the update's job, and
 * from then on the job and the agent status say how it went. A popup closed
 * before that hand-back started nothing.
 */
export function useAzureUpdateProgress({ onSettled }: { onSettled?: () => void } = {}) {
  const [phase, setPhase] = useState<AzureUpdateProgress>(IDLE);
  const [follow, setFollow] = useState<AzureUpdateFollow | null>(null);
  const [signInError, setSignInError] = useState<string | null>(null);
  const approvedVersion = useRef<string | null>(null);
  // The job being followed. A ref, because the popup repeats its hand-back
  // faster than a render can land.
  const followedJob = useRef<string | null | undefined>(undefined);
  const outcome = useAzureUpdateOutcome(follow, { onSettled });
  const showClosed = useCallback(() => setPhase({ kind: "closed" }), []);
  const { start: startWatch, stop: stopWatch, markHandedOff } = usePopupCloseWatch(showClosed);

  const watchSignIn = useCallback<WatchSignIn>(
    (popup, version) => {
      followedJob.current = undefined;
      if (version !== null) approvedVersion.current = version;
      setSignInError(null);
      setFollow(null);
      setPhase({ kind: "signing_in" });
      startWatch(popup);
    },
    [startWatch],
  );

  useAzureSetupStartedSignal((started: AzureSignInStarted) => {
    // The popup repeats its hand-back until answered: follow each job once.
    if (followedJob.current === started.jobId) return;
    followedJob.current = started.jobId;
    markHandedOff();
    setSignInError(null);
    setPhase({ kind: "updating", confirming: false });
    setFollow({ jobId: started.jobId, approvedVersion: approvedVersion.current });
  }, "upgrade");

  const approve = useApproveInPlace(watchSignIn);
  const { retry, retrying } = useRetryInPlace(watchSignIn, setSignInError);

  const dismiss = useCallback(() => {
    stopWatch();
    followedJob.current = undefined;
    setFollow(null);
    setSignInError(null);
    setPhase(IDLE);
  }, [stopWatch]);

  const progress: AzureUpdateProgress = follow && outcome ? outcome : phase;
  return { progress, signInError, retrying, approve, watchSignIn, retry, dismiss };
}

export type AzureUpdateProgressState = ReturnType<typeof useAzureUpdateProgress>;
