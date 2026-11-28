"use client";

import { useAgentDeploymentFollow } from "@/lib/feed/use-agent-deployment-follow";
import { isAgentAsleep } from "@/lib/feed/agent-presence-policy";
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
  isWarmingUp: boolean;
  wakeNow: (reason: string) => void;
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
      isWarmingUp: false,
      wakeNow: () => undefined,
      livePresence: "awake",
      state: (deployment.state as string | null) ?? null,
      health: "healthy",
    };
  }
  const state = (deployment.state as string | null) ?? null;
  const isWarmingUp =
    deployment.update.presentationState !== "blocked" &&
    (state === "reserved" ||
      state === "provisioning" ||
      state === "connecting" ||
      wake.isWaking ||
      wake.livePresence === "waking" ||
      (state === "active" &&
        isAgentAsleep(deployment.health) &&
        wake.livePresence !== "awake"));
  return {
    isWaking: wake.isWaking,
    isWarmingUp,
    wakeNow: wake.wakeNow,
    livePresence: wake.livePresence,
    state,
    health: deployment.health,
  };
}
