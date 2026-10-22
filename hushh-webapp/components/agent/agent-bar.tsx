"use client";

import { CommandAgentBar } from "@/components/agent/command-agent-bar";
import { OneVoiceControl } from "@/components/one-voice/one-voice-control";
import { useOneVoiceLiveEnabled } from "@/lib/one-voice/readiness";
import { RetainedAgentBar } from "./agent-bar-surface";
import { useAgentDockSurface } from "./agent-dock";

/**
 * The persistent agent launcher. One stable entry point, two owners: the
 * bounded command bar while Live is off, the One Live Voice control when the
 * server says Live is on. The bottom shell always renders `<AgentBar layout="slot" />`.
 */
export function AgentBar({ layout = "fixed" }: { layout?: "fixed" | "slot" }) {
  const live = useOneVoiceLiveEnabled();
  const dock = useAgentDockSurface();
  const control = live ? <OneVoiceControl layout={layout} /> : <CommandAgentBar layout={layout} />;
  return layout === "slot" && dock ? <RetainedAgentBar>{control}</RetainedAgentBar> : control;
}
