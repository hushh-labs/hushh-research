"use client";

import { useEffect, useState } from "react";

import type { AgentUpdateStatus } from "@/lib/feed/agent-update-status";
import { isApprovedNotStarted } from "@/lib/one/agent-update-approval";
import { ownerCloudProvider } from "@/lib/one/owner-cloud";
import { ApiService } from "@/lib/services/api-service";

/** How often a running update job is re-read until it settles. */
export const AZURE_UPDATE_JOB_RECHECK_MS = 5_000;

export const AZURE_UPDATE_AWAITING_LABEL = "Approved. Waiting for your Microsoft sign-in";

/**
 * Whether an Azure agent's update is approved and still waiting for the
 * owner's Microsoft sign-in, the only thing that can start it.
 *
 * The hub reports an approved update as `scheduled` both before that sign-in
 * and while the job it starts copies the new image, so the setup-status job
 * decides: a running job means the update is moving; no running job means it
 * waits for the person. Until that job has been read once the answer is
 * `false`, so the page never claims the person must act while it is unsure.
 * A failed read counts as "not running": the approval is on record, and
 * continuing to Microsoft is safe because the hub never doubles a running job.
 */
export function useAzureUpdateAwaitingSignIn(input: {
  deploymentTarget: unknown;
  update: AgentUpdateStatus;
}): boolean {
  const candidate =
    ownerCloudProvider(input.deploymentTarget) === "azure" && isApprovedNotStarted(input.update);
  const key = candidate ? (input.update.operationId ?? input.update.releaseId ?? "approved") : null;
  const [verdict, setVerdict] = useState<{ key: string; jobRunning: boolean } | null>(null);

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const read = async () => {
      const job = await ApiService.getByocSetupStatus().catch(() => null);
      if (cancelled) return;
      const jobRunning = job?.status === "running" && !job.stale;
      setVerdict({ key, jobRunning });
      if (jobRunning) timer = setTimeout(() => void read(), AZURE_UPDATE_JOB_RECHECK_MS);
    };
    void read();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [key]);

  return key !== null && verdict?.key === key && !verdict.jobRunning;
}
