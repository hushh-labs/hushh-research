"use client";

import { useAgentDeploymentFollow } from "@/lib/feed/use-agent-deployment-follow";
import { useProactiveAgentWake, type WakeState } from "@/lib/feed/use-proactive-agent-wake";
import { isOwnerCloudTarget } from "@/lib/one/owner-cloud";
import { hasRecentAgentAnswer } from "@/lib/services/pod-chat-turn-transport";

function isWakeablePodTarget(target: unknown): boolean {
  return (
    isOwnerCloudTarget(target) ||
    target === "ace" ||
    target === "gcp" ||
    target === "azure"
  );
}

function hasLocalSandboxOverride(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_LOCAL_SANDBOX_EDGE_URL?.trim());
}

/** Foreground Chat shares the canonical wake authority and presence state with `/one`. */
export function useChatAgentWake(
  userId: string | null,
  enabled: boolean,
): {
  isWaking: boolean;
  livePresence: WakeState | "unknown" | null;
  state: string | null;
  health: string | null;
} {
  const localOverride = hasLocalSandboxOverride();
  const recentAnswer = hasRecentAgentAnswer();
  const deployment = useAgentDeploymentFollow({ enabled: enabled && !!userId, userId });
  const wake = useProactiveAgentWake({
    userId: userId ?? "",
    state: deployment.state,
    health: deployment.health,
    enabled:
      enabled &&
      !!userId &&
      !localOverride &&
      !recentAnswer &&
      isWakeablePodTarget(deployment.deploymentTarget) &&
      deployment.update.presentationState !== "blocked",
  });
  if (localOverride || recentAnswer) {
    return {
      isWaking: false,
      livePresence: "awake",
      state: (deployment.state as string | null) ?? null,
      health: "healthy",
    };
  }
  return {
    isWaking: wake.isWaking,
    livePresence: wake.livePresence,
    state: (deployment.state as string | null) ?? null,
    health: deployment.health,
  };
}
