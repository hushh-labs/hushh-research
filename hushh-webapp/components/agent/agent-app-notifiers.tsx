"use client";

import { useEffect, useRef } from "react";
import { useAuth } from "@/hooks/use-auth";
import { ApiService } from "@/lib/services/api-service";
import { useVault } from "@/lib/vault/vault-context";
import { AgentChatTurnNotifier } from "@/components/agent/agent-chat-turn-notifier";
import { AgentConsentContinuationNotifier } from "@/components/agent/agent-consent-continuation-notifier";
import { AgentFeedAttentionNotifier } from "@/components/agent/agent-feed-attention-notifier";
import { AgentReleaseNotifier } from "@/components/agent/agent-release-notifier";

/** Shared app-shell composition; each notifier retains its own authority. */
export function AgentAppNotifiers() {
  const { userId } = useAuth();
  const { isVaultUnlocked } = useVault();
  const warmedUserRef = useRef<string | null>(null);
  const warmedUnlockedUserRef = useRef<string | null>(null);

  useEffect(() => {
    if (!userId) return;
    const shouldWarmAuth = warmedUserRef.current !== userId;
    const shouldWarmUnlock = isVaultUnlocked && warmedUnlockedUserRef.current !== userId;
    if (!shouldWarmAuth && !shouldWarmUnlock) return;
    if (shouldWarmAuth) warmedUserRef.current = userId;
    if (shouldWarmUnlock) warmedUnlockedUserRef.current = userId;
    const runPrewarm = () => {
      void ApiService.prewarmOwnerPodChatAccess().catch(() => undefined);
    };
    const w = typeof window !== "undefined"
      ? (window as Window & {
          requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
          cancelIdleCallback?: (handle: number) => void;
        })
      : null;
    if (w?.requestIdleCallback) {
      const handle = w.requestIdleCallback(runPrewarm, { timeout: 1000 });
      return () => {
        w.cancelIdleCallback?.(handle);
      };
    }
    const timer = setTimeout(runPrewarm, 150);
    return () => clearTimeout(timer);
  }, [userId, isVaultUnlocked]);

  return <>
    <AgentChatTurnNotifier />
    <AgentConsentContinuationNotifier />
    <AgentFeedAttentionNotifier />
    <AgentReleaseNotifier />
  </>;
}
