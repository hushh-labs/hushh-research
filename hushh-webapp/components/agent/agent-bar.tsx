"use client";

import { RetainedAgentBar } from "./agent-bar-surface";
import { useAgentDockSurface } from "./agent-dock";
import { CommandAgentBar } from "@/components/agent/command-agent-bar";
import { OneVoiceControl } from "@/components/one-voice/one-voice-control";
import { useOneVoiceLiveEnabled, useOneVoiceReadiness, useOneVoiceCommandsEnabled } from "@/lib/one-voice/readiness";

/**
 * The persistent agent launcher. One stable entry point, two owners: the
 * bounded command bar while Live is off, the One Live Voice control when the
 * server says Live is on. The bottom shell always renders `<AgentBar layout="slot" />`.
 */
export function AgentBar({ layout = "fixed" }: { layout?: "fixed" | "slot" }) {
  const live = useOneVoiceLiveEnabled();
  const readiness = useOneVoiceReadiness();
  const commands = useOneVoiceCommandsEnabled();
  const dock = useAgentDockSurface();
  const unavailableLabel = commands ? undefined : readiness.status === "unknown" && readiness.microphoneOwner !== "none"
    ? "Checking voice connection…" : "Voice unavailable — check Hosting settings";
  const control = live ? <OneVoiceControl layout={layout} /> : <CommandAgentBar layout={layout} unavailableLabel={unavailableLabel} />;
  return layout === "slot" && dock ? <RetainedAgentBar>{control}</RetainedAgentBar> : control;
}
