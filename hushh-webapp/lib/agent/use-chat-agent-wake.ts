"use client";

import { useAgentDeploymentFollow } from "@/lib/feed/use-agent-deployment-follow";
import { useProactiveAgentWake } from "@/lib/feed/use-proactive-agent-wake";
import { isOwnerCloudTarget } from "@/lib/one/owner-cloud";

/** Foreground Chat shares the existing wake authority and cross-surface cooldown. */
export function useChatAgentWake(userId: string | null, enabled: boolean) {
  const deployment = useAgentDeploymentFollow({ enabled: enabled && !!userId, userId });
  useProactiveAgentWake({
    userId: userId ?? "",
    state: deployment.state,
    health: deployment.health,
    enabled: enabled && !!userId && isOwnerCloudTarget(deployment.deploymentTarget) &&
      deployment.update.presentationState !== "blocked",
  });
}
