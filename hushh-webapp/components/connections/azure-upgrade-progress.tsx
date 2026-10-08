"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { SetupStageChecklist } from "@/components/connections/byoc-setup-stage-checklist";
import { Button } from "@/components/ui/button";
import { ROUTES } from "@/lib/navigation/routes";
import { AZURE_UPDATE_COPY, azureUpdatedLabel } from "@/lib/one/azure-update-outcome";
import { AZURE_UPGRADE_FIRST_STAGE, azureChecklistStages } from "@/lib/one/cloud-setup-stages";
import { useAzureUpdateOutcome, type AzureUpdateOutcome } from "@/lib/one/use-azure-update-progress";
import { ApiService } from "@/lib/services/api-service";

type SetupStatus = Awaited<ReturnType<typeof ApiService.getByocSetupStatus>>;

const POLL_INTERVAL_MS = 2_000;
const RETRY_INTERVAL_MS = 4_000;
/** A missed read or a job not yet visible is not a verdict; three in a row is. */
const MAX_UNSETTLED_READS = 3;

/**
 * Whether a setup-status record is the update this page started. The record
 * holds the person's latest job, which may be an earlier setup or another
 * attempt: only a record naming this job id is its progress or its result.
 */
function isUpgradeJobRecord(status: SetupStatus, jobId: string): boolean {
  return status.status !== "none" && Boolean(jobId) && status.jobId === jobId;
}

function useAzureUpgradeJob(jobId: string): { job: SetupStatus | null; unreadable: boolean } {
  const [job, setJob] = useState<SetupStatus | null>(null);
  const [unreadable, setUnreadable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unsettled = 0;
    const retryOrGiveUp = () => {
      unsettled += 1;
      if (unsettled < MAX_UNSETTLED_READS) {
        timer = setTimeout(() => void poll(), RETRY_INTERVAL_MS);
      } else {
        setUnreadable(true);
      }
    };
    const poll = async () => {
      try {
        const status = await ApiService.getByocSetupStatus();
        if (cancelled) return;
        if (!isUpgradeJobRecord(status, jobId)) {
          retryOrGiveUp();
          return;
        }
        unsettled = 0;
        setJob(status);
        if (status.status === "running" && !status.stale) {
          timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
        }
      } catch {
        if (!cancelled) retryOrGiveUp();
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [jobId]);

  return { job, unreadable };
}

/**
 * A job read to failed or stale is not yet the update's outcome: the hub's
 * recovery may still record the new release (2026-10-05: the job failed on a
 * revision that was not ready, and the release was recorded about 40 seconds
 * later). From then on the agent's status decides, by the same rule the
 * profile pane and the Feed use (`azureUpdateVerdict`). The job is not re-read.
 */
function useFailedJobOutcome(jobId: string, job: SetupStatus | null): AzureUpdateOutcome | null {
  const settledJob = job && (job.status === "failed" || job.stale) ? job : null;
  const follow = useMemo(
    () => (settledJob ? { jobId, approvedVersion: null, settledJob } : null),
    [jobId, settledJob],
  );
  return useAzureUpdateOutcome(follow);
}

const softwareUpdatesLink = (
  <Link
    className="min-h-11 self-start text-sm underline underline-offset-4"
    href={ROUTES.PROFILE_SOFTWARE_UPDATES}
  >
    Open Software updates
  </Link>
);

function UpgradeDone({ label }: { label: string }) {
  return (
    <div className="flex flex-col gap-2" data-testid="azure-upgrade-done">
      <p className="text-sm font-semibold">{label}</p>
      {softwareUpdatesLink}
    </div>
  );
}

function UpgradeFailed({
  message,
  onRetry,
  retrying,
}: {
  message: string;
  onRetry: () => void | Promise<void>;
  retrying: boolean;
}) {
  return (
    <div
      role="alert"
      className="flex flex-col gap-1.5 rounded-[var(--app-card-radius-compact)] border border-destructive/30 bg-destructive/5 px-4 py-3"
      data-testid="azure-upgrade-failed"
    >
      <p className="text-sm font-semibold text-destructive">{AZURE_UPDATE_COPY.failed}</p>
      <p className="text-sm text-destructive">{message}</p>
      <Button
        type="button"
        variant="outline"
        className="self-start"
        disabled={retrying}
        onClick={() => void onRetry()}
        data-testid="azure-upgrade-retry"
      >
        {retrying ? "Opening Microsoft sign-in…" : AZURE_UPDATE_COPY.retry}
      </Button>
    </div>
  );
}

/** The failed or stale job's outcome, once the agent's status has spoken. */
function FailedJobOutcome({
  outcome,
  onRetry,
  retrying,
}: {
  outcome: AzureUpdateOutcome | null;
  onRetry: () => void | Promise<void>;
  retrying: boolean;
}) {
  if (outcome?.kind === "updated") {
    return <UpgradeDone label={azureUpdatedLabel(outcome.version, outcome.releasedAt)} />;
  }
  if (outcome?.kind === "failed") {
    return <UpgradeFailed message={outcome.message} onRetry={onRetry} retrying={retrying} />;
  }
  if (outcome?.kind === "unconfirmed") {
    return (
      <div className="flex flex-col gap-2" data-testid="azure-upgrade-unconfirmed">
        <p className="text-sm text-[var(--app-text-secondary)]">{AZURE_UPDATE_COPY.unconfirmed}</p>
        {softwareUpdatesLink}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1" aria-live="polite" data-testid="azure-upgrade-confirming">
      <p className="text-sm font-semibold">{AZURE_UPDATE_COPY.updating}</p>
      <p className="text-sm text-[var(--app-text-secondary)]">{AZURE_UPDATE_COPY.confirming}</p>
    </div>
  );
}

/**
 * The approved update's progress, read from the same setup-status record the
 * setup checklist uses. Only the update's own tail of stages is shown, and
 * only from a record of the job the sign-in started (`jobId`). A failed job
 * reads as updated, confirming, or failed by the agent's status.
 */
export function AzureUpgradeProgress({
  jobId,
  onRetry,
  retrying = false,
}: {
  jobId: string;
  onRetry: () => void | Promise<void>;
  retrying?: boolean;
}) {
  const { job, unreadable } = useAzureUpgradeJob(jobId);
  const failedOutcome = useFailedJobOutcome(jobId, job);

  if (unreadable) {
    return (
      <div className="flex flex-col gap-2" data-testid="azure-upgrade-unreadable">
        <p className="text-sm text-[var(--app-text-secondary)]">
          We couldn&rsquo;t read the update&rsquo;s progress. Check Software updates in
          a moment.
        </p>
        {softwareUpdatesLink}
      </div>
    );
  }
  if (!job) return <HushhLoader label="Checking your update…" variant="inline" />;
  if (job.status === "recorded") return <UpgradeDone label="Your agent is updated" />;
  if (job.status === "failed" || job.stale) {
    return <FailedJobOutcome outcome={failedOutcome} onRetry={onRetry} retrying={retrying} />;
  }
  return (
    <SetupStageChecklist
      title="In your Azure subscription"
      stages={azureChecklistStages(job, AZURE_UPGRADE_FIRST_STAGE)}
      job={job}
      footnote="This runs on its own. You can leave this page and check Software updates later."
    />
  );
}
