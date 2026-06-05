"use client";

import { AppPageShell } from "@/components/app-ui/app-page-shell";
import { NativeRouteMarker } from "@/components/app-ui/native-route-marker";
import { AgentChatWorkspace } from "@/components/agent/agent-chat-workspace";

export function AgentScreen() {
  return (
    <AppPageShell
      width="wide"
      className="!max-w-none !px-0 !py-0"
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
