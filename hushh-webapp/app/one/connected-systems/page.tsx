"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  AppPageContentRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { NativeTestBeacon } from "@/components/app-ui/native-test-beacon";
import { ConnectedSystemsPanel } from "@/components/profile/connected-systems-panel";
import { VaultUnlockDialog } from "@/components/vault/vault-unlock-dialog";
import { ConnectedSystemDetailClient } from "@/app/one/connected-systems/[systemId]/connected-system-detail-client";
import { useAuth } from "@/hooks/use-auth";
import { buildConnectedSystemRoute } from "@/lib/navigation/routes";
import { useVault } from "@/lib/vault/vault-context";

export default function ConnectedSystemsPage() {
  const router = useRouter();
  const { user } = useAuth();
  const { vaultKey, vaultOwnerToken } = useVault();
  const searchParams = useSearchParams();
  const [showUnlock, setShowUnlock] = useState(false);
  const selectedSystemId = String(searchParams.get("system") || "").trim();

  useEffect(() => {
    if (!selectedSystemId) return;
    router.replace(
      buildConnectedSystemRoute(selectedSystemId, {
        agentActionId: searchParams.get("agentActionId"),
      }),
      { scroll: false },
    );
  }, [router, searchParams, selectedSystemId]);

  // One release of query-backed detail links remains readable while the client
  // replaces it with the canonical finite nested route above.
  if (selectedSystemId) {
    return (
      <ConnectedSystemDetailClient
        systemId={selectedSystemId}
        routeId="/one/connected-systems"
      />
    );
  }

  return (
    <AppPageShell
      as="main"
      width="reading"
      className="pb-[calc(var(--app-bottom-inset)+var(--kai-command-fixed-ui,82px)+1.25rem)] sm:pb-10 md:pb-8"
      nativeTest={{
        routeId: "/one/connected-systems",
        marker: "native-route-connected-systems",
        authState: user ? "authenticated" : "pending",
        dataState: "loaded",
      }}
    >
      <NativeTestBeacon
        routeId="/one/connected-systems"
        marker="native-route-connected-systems"
        authState={user ? "authenticated" : "pending"}
        dataState="loaded"
      />
      <AppPageContentRegion>
        <ConnectedSystemsPanel
          cacheUserId={user?.uid}
          vaultKey={vaultKey}
          vaultOwnerToken={vaultOwnerToken}
          onRequestUnlock={() => setShowUnlock(true)}
          mode="list"
        />
      </AppPageContentRegion>

      {user ? (
        <VaultUnlockDialog
          user={user}
          open={showUnlock}
          onOpenChange={setShowUnlock}
          title="Set up your private vault"
          description="Set up or open your private vault to inspect CRM records and approve Connected Systems actions."
          onSuccess={() => setShowUnlock(false)}
        />
      ) : null}
    </AppPageShell>
  );
}
