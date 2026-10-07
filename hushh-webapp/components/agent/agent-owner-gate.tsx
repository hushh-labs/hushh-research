"use client";

import { useEffect, type ReactNode } from "react";
import { usePathname } from "next/navigation";

import { LocationCommandProvider } from "@/components/agent/location-command-provider";
import { LocationCommandDeviceBridge } from "@/components/one-location/onboarding/location-command-device-bridge";
import { LocationPublisherBridge } from "@/components/location/location-publisher-bridge";
import { LocationUpdatesStepBridge } from "@/components/location/location-updates-step-bridge";
import { RequestReviewStepBridge } from "@/components/connections/request-review-step-bridge";
import { VoiceSessionProvider } from "@/components/one-voice/voice-session-provider";
import { OneVoiceMailDraftBridge } from "@/components/one-voice/one-voice-mail-draft-bridge";
import { useOneVoiceLiveEnabled, useOneVoiceCommandsEnabled } from "@/lib/one-voice/readiness";
import { dispatchAgentConversationAfterRoute } from "@/lib/agent/agent-voice-settings";

/**
 * Exactly one microphone owner at a time.
 *
 * Both providers stay mounted so the tree never remounts when readiness
 * resolves; ownership is switched with `enabled`. While the server says Live
 * is off, the bounded command runtime owns the mic and the conversation
 * events; when it says on, the One Live Voice session does.
 */
export function AgentOwnerGate({ children }: { children: ReactNode }) {
  const live = useOneVoiceLiveEnabled();
  const commands = useOneVoiceCommandsEnabled();
  const pathname = usePathname();

  // A source surface can hand Talk to One off to canonical Chat, but never
  // starts recording under that source surface's route context.
  useEffect(() => {
    dispatchAgentConversationAfterRoute(pathname);
  }, [pathname]);

  return (
    <LocationCommandProvider enabled={commands}>
      {commands ? <LocationCommandDeviceBridge /> : null}
      <VoiceSessionProvider enabled={live}>
        <OneVoiceMailDraftBridge />
        {live ? (
          <>
            <LocationPublisherBridge />
            <LocationUpdatesStepBridge />
            <RequestReviewStepBridge />
          </>
        ) : null}
        {children}
      </VoiceSessionProvider>
    </LocationCommandProvider>
  );
}
