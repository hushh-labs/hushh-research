"use client";

import { AgentChatTurnNotifier } from "@/components/agent/agent-chat-turn-notifier";
import { AgentConsentContinuationNotifier } from "@/components/agent/agent-consent-continuation-notifier";
import { AgentFeedAttentionNotifier } from "@/components/agent/agent-feed-attention-notifier";
import { AgentReleaseNotifier } from "@/components/agent/agent-release-notifier";

/** Shared app-shell composition; each notifier retains its own authority. */
export function AgentAppNotifiers() {
  return <>
    <AgentChatTurnNotifier />
    <AgentConsentContinuationNotifier />
    <AgentFeedAttentionNotifier />
    <AgentReleaseNotifier />
  </>;
}
