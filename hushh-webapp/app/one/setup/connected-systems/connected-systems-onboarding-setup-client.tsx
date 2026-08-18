"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { CapabilityCinematicIntroGate } from "@/components/onboarding/setup/capability-cinematic-intro";
import { VaultStatusInline } from "@/components/app-ui/vault-status-inline";
import {
  SetupCapabilityLoading,
  SetupCapabilityTerminalFooter,
  useSetupCapabilityCoordinator,
} from "@/components/onboarding/setup/setup-capability-coordinator";
import { ConnectedSystemsPanel } from "@/components/profile/connected-systems-panel";
import { VaultUnlockDialog } from "@/components/vault/vault-unlock-dialog";
import { useAuth } from "@/hooks/use-auth";
import { buildConnectedSystemRoute, ROUTES } from "@/lib/navigation/routes";
import { PreVaultUserStateService } from "@/lib/services/pre-vault-user-state-service";
import { useVault } from "@/lib/vault/vault-context";

export function ConnectedSystemsOnboardingSetupClient() {
  const router = useRouter();
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
  const completedSetup = Boolean(
    coordinator.isReady &&
    user?.uid &&
    PreVaultUserStateService.isSetupResolved(
      PreVaultUserStateService.getCachedBootstrapState(user.uid),
    ),
  );

  useEffect(() => {
    if (!completedSetup) return;
    router.replace(buildConnectedSystemRoute(systemId));
  }, [completedSetup, router, systemId]);

  if (!coordinator.isReady || completedSetup) {
    return <SetupCapabilityLoading label="Preparing external systems…" />;
  }

  return (
    <CapabilityCinematicIntroGate capabilityId="connected-systems">
      <AppPageShell
        as="main"
        width="reading"
        className="space-y-4 pb-[calc(var(--app-bottom-inset)+1rem)]"
      >
        <AppPageHeaderRegion>
          <PageHeader
            title="CRM"
            description="Find or create your CRM record."
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
            title="Set a lock"
            description="Unlock to review CRM."
            allowVaultCreation={false}
            onSuccess={() => setShowUnlock(false)}
          />
        ) : null}
      </AppPageShell>
    </CapabilityCinematicIntroGate>
  );
}
