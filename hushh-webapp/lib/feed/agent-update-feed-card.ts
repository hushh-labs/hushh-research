"use client";

import { useCallback, useMemo, useRef } from "react";

import { Download } from "@/components/icons";
import { updateActivityLabel, type AgentUpdateStatus } from "@/lib/feed/agent-update-status";
import type { FeedActionButton, FeedActionable } from "@/lib/feed/use-feed-actionables";
import { ROUTES } from "@/lib/navigation/routes";
import { UPDATE_POPUP_CLOSED_NOTICE } from "@/lib/one/azure-sign-in";
import { AZURE_UPDATE_COPY, azureUpdatedLabel } from "@/lib/one/azure-update-outcome";
import {
  useAzureUpdateProgress,
  type AzureUpdateProgress,
} from "@/lib/one/use-azure-update-progress";
import { ApiService } from "@/lib/services/api-service";

/** The Feed's software-update card, before the Feed orders it among the others. */
export type AgentUpdateFeedCard = Omit<FeedActionable, "sortAt">;

type CardBody = Pick<FeedActionable, "title" | "description" | "actions"> &
  Partial<Pick<FeedActionable, "href" | "updateProgress">>;

/**
 * An Azure update approved from this card, in the card's own words: waiting
 * for the Microsoft popup, moving, updated, or failed with a retry. `null`
 * while nothing is being followed, so the card reads exactly as it always has.
 */
export function azureUpdateCardBody(
  progress: AzureUpdateProgress,
  update: AgentUpdateStatus,
  act: { retry: FeedActionButton["run"]; dismiss: FeedActionButton["run"] },
): CardBody | null {
  const retry = (label: string): FeedActionButton[] => [
    { key: "retry", label, tone: "primary", run: act.retry },
  ];
  switch (progress.kind) {
    case "idle":
      return null;
    case "signing_in":
      return { title: "Waiting for your Microsoft sign-in", description: AZURE_UPDATE_COPY.signingIn, actions: [] };
    case "closed":
      return { title: "Update not started", description: UPDATE_POPUP_CLOSED_NOTICE, actions: retry("Continue") };
    case "updating":
      return {
        title: AZURE_UPDATE_COPY.updating,
        description: progress.confirming ? AZURE_UPDATE_COPY.confirming : AZURE_UPDATE_COPY.running,
        updateProgress: update,
        actions: [],
      };
    case "updated":
      return {
        title: azureUpdatedLabel(progress.version, progress.releasedAt),
        description: "Your private agent is running the new version.",
        actions: [{ key: "done", label: "Done", tone: "ghost", run: act.dismiss }],
      };
    case "failed":
      return {
        title: AZURE_UPDATE_COPY.failed,
        description: progress.message,
        actions: retry("Try again"),
      };
    case "unconfirmed":
      return {
        title: "Update not confirmed yet",
        description: AZURE_UPDATE_COPY.unconfirmed,
        href: ROUTES.PROFILE_SOFTWARE_UPDATES,
        actions: [],
      };
  }
}

/** The card as it reads with nothing followed: an offer, or the hub's activity. */
function offerCardBody(
  update: AgentUpdateStatus,
  activity: string | null,
  act: { approve: FeedActionButton["run"]; defer: FeedActionButton["run"] },
): CardBody {
  if (!activity) {
    return {
      title: "An update is ready",
      description: update.summary || "Keeps your private agent current.",
      actions: [
        { key: "approve", label: "Update now", tone: "primary", run: act.approve },
        { key: "defer", label: "Later", tone: "ghost", run: act.defer },
      ],
    };
  }
  return {
    title: activity,
    description:
      update.failed || update.presentationState === "blocked"
        ? update.error || "Open Software updates to check recovery."
        : "Keep using Settings to follow this update. Completion will be verified.",
    updateProgress: update,
    href: ROUTES.PROFILE_SOFTWARE_UPDATES,
    actions: [],
  };
}

/**
 * Software updates are owner-approved mutations. Keep one calm card in the
 * existing Feed queue; the API binds approval to this pod incarnation and
 * exact release, so a stale tab cannot choose an arbitrary image. An Azure
 * approval signs in to Microsoft in a popup and is followed on this card, so
 * the person stays in the Feed.
 */
export function useAgentUpdateFeedCard(input: {
  userId: string | null;
  update: AgentUpdateStatus;
  deploymentTarget: string | null;
  availableVersion: string | null;
  onResolved: () => void;
}): AgentUpdateFeedCard | null {
  const { userId, update, deploymentTarget, availableVersion, onResolved } = input;
  const busy = useRef(false);
  const azure = useAzureUpdateProgress({ onSettled: onResolved });
  const { approve: approveHere, retry, dismiss } = azure;
  const activity = updateActivityLabel(update);
  const { releaseId, offerable } = update;

  const approve = useCallback(async () => {
    if (busy.current || !releaseId || activity || !offerable) return;
    busy.current = true;
    try {
      const approval = await approveHere({
        agent: { deploymentTarget, availableRelease: availableVersion ? { version: availableVersion } : null },
        releaseId,
        idempotencyKey:
          typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${userId}:${releaseId}`,
      });
      if (approval === "scheduled") onResolved();
    } finally {
      busy.current = false;
    }
  }, [activity, approveHere, availableVersion, deploymentTarget, offerable, onResolved, releaseId, userId]);

  const defer = useCallback(async () => {
    if (busy.current || !releaseId || activity || !offerable) return;
    busy.current = true;
    try {
      await ApiService.deferPersonalAgentUpdate({ releaseId });
      onResolved();
    } finally {
      busy.current = false;
    }
  }, [activity, offerable, onResolved, releaseId]);

  return useMemo(() => {
    const followed = azureUpdateCardBody(azure.progress, update, { retry, dismiss });
    if (!followed && !activity && !(update.available === true && offerable && releaseId)) return null;
    const body = followed ?? offerCardBody(update, activity, { approve, defer });
    const description = followed && azure.signInError ? azure.signInError : body.description;
    return {
      id: `personal-agent-update:${releaseId ?? "recovery"}`,
      icon: Download,
      iconTone: "blue",
      ...body,
      description,
      displayTimestamp: null,
    };
  }, [activity, approve, azure.progress, azure.signInError, defer, dismiss, offerable, releaseId, retry, update]);
}
