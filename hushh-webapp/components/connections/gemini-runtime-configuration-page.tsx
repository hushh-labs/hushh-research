"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { GeminiRuntimeSettingsCard } from "@/components/connections/gemini-runtime-settings-card";
import { VaultUnlockDialog } from "@/components/vault/vault-unlock-dialog";
import { useAuth } from "@/hooks/use-auth";
import { ROUTES } from "@/lib/navigation/routes";
import { VaultService } from "@/lib/services/vault-service";
import { PreVaultUserStateService } from "@/lib/services/pre-vault-user-state-service";
import { useVault } from "@/lib/vault/vault-context";

type GeminiRuntimeConfigurationPageProps = {
  setupMode?: boolean;
};

export function GeminiRuntimeConfigurationPage({
  setupMode = false,
}: GeminiRuntimeConfigurationPageProps) {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const { vaultKey, vaultOwnerToken, isVaultUnlocked } = useVault();
  const [hasVault, setHasVault] = useState<boolean | null>(null);
  const [hasRuntimeChoice, setHasRuntimeChoice] = useState<boolean | null>(
    setupMode ? null : true,
  );
  const [unlockOpen, setUnlockOpen] = useState(false);

  useEffect(() => {
    if (authLoading || !user?.uid) return;
    if (isVaultUnlocked) {
      setHasVault(true);
      return;
    }
    let active = true;
    void VaultService.checkVault(user.uid)
      .then((exists) => {
        if (active) setHasVault(exists);
      })
      .catch(() => {
        if (active) setHasVault(false);
      });
    return () => {
      active = false;
    };
  }, [authLoading, isVaultUnlocked, user?.uid]);

  useEffect(() => {
    if (!setupMode) {
      setHasRuntimeChoice(true);
      return;
    }
    if (authLoading || !user?.uid) return;
    let active = true;
    const cached = PreVaultUserStateService.getCachedBootstrapState(user.uid);
    if (cached) {
      setHasRuntimeChoice(
        PreVaultUserStateService.hasOneRuntimeChoice(cached),
      );
      return;
    }
    void PreVaultUserStateService.bootstrapState(user.uid)
      .then((state) => {
        if (active) {
          setHasRuntimeChoice(
            PreVaultUserStateService.hasOneRuntimeChoice(state),
          );
        }
      })
      .catch(() => {
        if (active) setHasRuntimeChoice(false);
      });
    return () => {
      active = false;
    };
  }, [authLoading, setupMode, user?.uid]);

  useEffect(() => {
    if (!authLoading && !user) {
      router.replace(`/login?redirect=${encodeURIComponent(setupMode ? ROUTES.ONE_SETUP_CONNECTIONS : ROUTES.CONNECT_SETTINGS)}`);
    }
  }, [authLoading, router, setupMode, user]);

  const needsVaultCreation = Boolean(user && !isVaultUnlocked && hasVault === false);
  const needsUnlock = Boolean(user && !isVaultUnlocked && hasVault === true);
  return (
    <AppPageShell
      as="main"
      width="standard"
      className="relative isolate pb-[calc(var(--app-bottom-fixed-ui,96px)+1.25rem)] sm:pb-10 md:pb-8"
      nativeTest={{
        routeId: setupMode ? "/one/setup/connections" : "/one/connect/settings",
        marker: setupMode ? "native-route-one-setup-connections" : "native-route-connect-settings",
        authState: user ? "authenticated" : "pending",
        dataState: authLoading || hasVault === null ? "loading" : "loaded",
      }}
    >
      <AppPageHeaderRegion>
        <PageHeader
          title={setupMode ? "Connections" : "Gemini settings"}
          description={
            setupMode
              ? "Choose one option to continue setting up One."
              : "Manage the Gemini provider for your private-agent turns."
          }
          accent="neutral"
        />
      </AppPageHeaderRegion>
      <AppPageContentRegion>
        <GeminiRuntimeSettingsCard
          userId={user?.uid}
          vaultKey={vaultKey}
          vaultOwnerToken={vaultOwnerToken}
          needsVaultCreation={needsVaultCreation}
          needsUnlock={needsUnlock}
          onRequestVaultCreation={() => setUnlockOpen(true)}
          onRequestVaultUnlock={() => setUnlockOpen(true)}
          requiresExplicitSelection={setupMode}
          initiallyConfigured={hasRuntimeChoice === true}
          onConfigured={
            setupMode && user?.uid
              ? async () => {
                  await PreVaultUserStateService.markOneRuntimeChoice(
                    user.uid,
                  );
                  setHasRuntimeChoice(true);
                  router.push(ROUTES.ONE_SETUP);
                }
              : undefined
          }
        />
      </AppPageContentRegion>
      {user ? (
        <VaultUnlockDialog
          user={user}
          open={unlockOpen}
          onOpenChange={setUnlockOpen}
          title="Unlock your vault"
          description="Your Gemini key is encrypted in your vault and is never stored by Connections."
          onSuccess={() => setUnlockOpen(false)}
        />
      ) : null}
    </AppPageShell>
  );
}
