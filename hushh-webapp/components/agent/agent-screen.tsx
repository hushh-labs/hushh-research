"use client";

import { AppPageShell } from "@/components/app-ui/app-page-shell";
import { NativeRouteMarker } from "@/components/app-ui/native-route-marker";
import { AgentChatWorkspace } from "@/components/agent/agent-chat-workspace";

export function AgentScreen() {
  return (
    <AppPageShell
      width="expanded"
      className="px-[var(--page-inline-gutter-standard)] py-[var(--page-block-padding)]"
      nativeTest={{
        routeId: "/agent",
        marker: "native-route-agent",
        authState: "authenticated",
        dataState: "loaded",
      }}
    >
      <NativeRouteMarker
        routeId="/agent"
        marker="native-route-agent"
        authState="authenticated"
        dataState="loaded"
      />
      <AgentChatWorkspace variant="page" />
    </AppPageShell>
  );
}
