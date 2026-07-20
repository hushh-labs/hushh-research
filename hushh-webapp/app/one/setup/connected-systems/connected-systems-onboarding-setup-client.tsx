"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";

import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { VaultStatusInline } from "@/components/app-ui/vault-status-inline";
import {
  SetupCapabilityLoading,
  SetupCapabilityTerminalFooter,
  useSetupCapabilityCoordinator,
} from "@/components/onboarding/setup/setup-capability-coordinator";
import { ConnectedSystemsPanel } from "@/components/profile/connected-systems-panel";
import { VaultUnlockDialog } from "@/components/vault/vault-unlock-dialog";
import { useAuth } from "@/hooks/use-auth";
import { ROUTES } from "@/lib/navigation/routes";
import { useVault } from "@/lib/vault/vault-context";

export function ConnectedSystemsOnboardingSetupClient() {
  const params = useSearchParams();
  const { user } = useAuth();
  const { vaultOwnerToken } = useVault();
  const [showUnlock, setShowUnlock] = useState(false);
  const [ready, setReady] = useState(false);
  const coordinator = useSetupCapabilityCoordinator({
    capabilityId: "connected-systems",
    isOperationallyReady: ready,
    finishActionId: "setup.finish_connected_systems",
    skipActionId: "setup.skip_connected_systems",
  });
  const systemId = params.get("system")?.trim() || null;

  if (!coordinator.isReady) return <SetupCapabilityLoading label="Preparing external systems…" />;

  return (
    <AppPageShell as="main" width="standard" className="space-y-4 pb-[calc(var(--app-bottom-inset)+1rem)]">
      <AppPageHeaderRegion>
        <PageHeader
          title="CRM"
          description="Find your existing CRM record or approve creating one from your verified identity."
          accent="neutral"
        />
      </AppPageHeaderRegion>
      <AppPageContentRegion>
        <VaultStatusInline className="mb-3 px-1" />
        <ConnectedSystemsPanel
          cacheUserId={user?.uid}
          vaultOwnerToken={vaultOwnerToken}
          onRequestUnlock={() => setShowUnlock(true)}
          mode={systemId ? "detail" : "list"}
          systemId={systemId}
          setupRouteBase={ROUTES.ONE_SETUP_CONNECTED_SYSTEMS}
          onSetupReadinessChange={setReady}
          presentation="setup"
        />
      </AppPageContentRegion>
      {!systemId ? (
        <SetupCapabilityTerminalFooter
          capabilityId="connected-systems"
          isOperationallyReady={ready}
          coordinator={coordinator}
        />
      ) : null}
      {user ? (
        <VaultUnlockDialog
          user={user}
          open={showUnlock}
          onOpenChange={setShowUnlock}
          title="Set up your private vault"
          description="Set up or open your private vault to inspect CRM records and approve CRM actions."
          onSuccess={() => setShowUnlock(false)}
        />
      ) : null}
    </AppPageShell>
  );
}
