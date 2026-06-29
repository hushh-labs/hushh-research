"use client";

import { Suspense } from "react";

import { AppPageContentRegion, AppPageShell } from "@/components/app-ui/app-page-shell";
import { NativeRouteMarker } from "@/components/app-ui/native-route-marker";
import { AgentChatWorkspace } from "@/components/agent/agent-chat-workspace";
import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";

export function AgentScreen() {
  const { user, loading } = useAuth();
  const { isVaultUnlocked, vaultOwnerToken } = useVault();
  const nativeAuthState = loading ? "pending" : user?.uid ? "authenticated" : "anonymous";
  const nativeDataState = loading
    ? "loading"
    : user?.uid && isVaultUnlocked && vaultOwnerToken
      ? "loaded"
      : "unavailable-valid";

  return (
    <AppPageShell
      width="wide"
      className="!max-w-none !px-0 !py-0"
      nativeTest={{
        routeId: "/agent",
        marker: "native-route-agent",
        authState: nativeAuthState,
        dataState: nativeDataState,
      }}
    >
      <NativeRouteMarker
        routeId="/agent"
        marker="native-route-agent"
        authState={nativeAuthState}
        dataState={nativeDataState}
      />
      <AppPageContentRegion className="min-h-0">
        <Suspense fallback={<HushhLoader label="Loading..." variant="fullscreen" />}>
          <AgentChatWorkspace variant="page" />
        </Suspense>
      </AppPageContentRegion>
    </AppPageShell>
  );
}
