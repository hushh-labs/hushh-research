"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { SetupStageChecklist } from "@/components/connections/byoc-setup-stage-checklist";
import { Button } from "@/components/ui/button";
import { ROUTES } from "@/lib/navigation/routes";
import { AZURE_UPGRADE_FIRST_STAGE, azureChecklistStages } from "@/lib/one/cloud-setup-stages";
import { ApiService } from "@/lib/services/api-service";

type SetupStatus = Awaited<ReturnType<typeof ApiService.getByocSetupStatus>>;

const POLL_INTERVAL_MS = 2_000;
const RETRY_INTERVAL_MS = 4_000;
/** A missed read or a job not yet visible is not a verdict; three in a row is. */
const MAX_UNSETTLED_READS = 3;

function useAzureUpgradeJob(): { job: SetupStatus | null; unreadable: boolean } {
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
        if (status.status === "none") {
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
  }, []);

  return { job, unreadable };
}

const softwareUpdatesLink = (
  <Link
    className="min-h-11 self-start text-sm underline underline-offset-4"
    href={ROUTES.PROFILE_SOFTWARE_UPDATES}
  >
    Open Software updates
  </Link>
);

/**
 * The approved update's progress, read from the same setup-status record the
 * setup checklist uses. Only the update's own tail of stages is shown.
 */
export function AzureUpgradeProgress({
  onRetry,
  retrying = false,
}: {
  onRetry: () => void | Promise<void>;
  retrying?: boolean;
}) {
  const { job, unreadable } = useAzureUpgradeJob();

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
  if (job.status === "recorded") {
    return (
      <div className="flex flex-col gap-2" data-testid="azure-upgrade-done">
        <p className="text-sm font-semibold">Your agent is updated</p>
        {softwareUpdatesLink}
      </div>
    );
  }
  if (job.status === "failed" || job.stale) {
    return (
      <div
        role="alert"
        className="flex flex-col gap-1.5 rounded-[var(--app-card-radius-compact)] border border-destructive/30 bg-destructive/5 px-4 py-3"
        data-testid="azure-upgrade-failed"
      >
        <p className="text-sm font-semibold text-destructive">The update did not finish</p>
        <p className="text-sm text-destructive">
          {job.stale
            ? "The update stopped partway (our side restarted) before it was confirmed."
            : job.errorMessage || "The update stopped before it was confirmed."}
        </p>
        <Button
          type="button"
          variant="outline"
          className="self-start"
          disabled={retrying}
          onClick={() => void onRetry()}
          data-testid="azure-upgrade-retry"
        >
          {retrying ? "Opening Microsoft sign-in…" : "Try the update again"}
        </Button>
      </div>
    );
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
