"use client";

import type { ReactNode } from "react";

import { LocationCommandProvider } from "@/components/agent/location-command-provider";
import { LocationCommandDeviceBridge } from "@/components/one-location/onboarding/location-command-device-bridge";
import { LocationPublisherBridge } from "@/components/location/location-publisher-bridge";
import { LocationUpdatesStepBridge } from "@/components/location/location-updates-step-bridge";
import { VoiceSessionProvider } from "@/components/one-voice/voice-session-provider";
import { useOneVoiceLiveEnabled } from "@/lib/one-voice/readiness";

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
  return (
    <LocationCommandProvider enabled={!live}>
      {!live ? <LocationCommandDeviceBridge /> : null}
      <VoiceSessionProvider enabled={live}>
        {live ? (
          <>
            <LocationPublisherBridge />
            <LocationUpdatesStepBridge />
          </>
        ) : null}
        {children}
      </VoiceSessionProvider>
    </LocationCommandProvider>
  );
}
