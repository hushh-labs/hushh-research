"use client";

import { AGENT_ICON_MAP, type AgentIconProps } from "./agent-icons";
import { MessageSquareIcon } from "@/components/icons/ui";

/** Shared outline capability geometry for launchers and onboarding. */
export function OneRosterAgentIcon({
  agentId,
  weight = "regular",
  ...props
}: AgentIconProps & { agentId: string }) {
  const Icon = AGENT_ICON_MAP[agentId as keyof typeof AGENT_ICON_MAP];
  return Icon ? (
    <Icon
      {...props}
      weight={weight}
      color={agentId === "location" ? "var(--agent-location-blue)" : undefined}
    />
  ) : (
    <MessageSquareIcon {...props} weight={weight} color="var(--app-accent)" />
  );
}
