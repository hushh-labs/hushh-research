"use client";

import { AGENT_ICON_MAP, type AgentIconProps } from "./agent-icons";
import { MessageSquareIcon } from "@/components/icons/ui";

/** Shared outline treatment for the One roster and its welcome illustration. */
export function OneRosterAgentIcon({
  agentId,
  ...props
}: AgentIconProps & { agentId: string }) {
  const Icon = AGENT_ICON_MAP[agentId as keyof typeof AGENT_ICON_MAP];
  return Icon ? (
    <Icon
      {...props}
      weight="regular"
      color={agentId === "location" ? "var(--agent-location-blue)" : undefined}
    />
  ) : (
    <MessageSquareIcon {...props} weight="regular" color="var(--app-accent)" />
  );
}
