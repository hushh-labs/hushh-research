"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { PlugZap } from "lucide-react";

import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { GeminiRuntimeSettingsCard } from "@/components/connections/gemini-runtime-settings-card";
import { VaultUnlockDialog } from "@/components/vault/vault-unlock-dialog";
import { useAuth } from "@/hooks/use-auth";
import { ROUTES } from "@/lib/navigation/routes";
import { VaultService } from "@/lib/services/vault-service";
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
          eyebrow={setupMode ? "Set up One" : "Connect"}
          title={setupMode ? "Choose how One runs" : "Gemini settings"}
          description={
            setupMode
              ? "Use Hussh managed Gemini, Google AI Studio, or a Google Cloud Vertex API key."
              : "Manage the Gemini provider for your private-agent turns."
          }
          icon={PlugZap}
          accent="neutral"
        />
      </AppPageHeaderRegion>
      <AppPageContentRegion>
        <div className="space-y-4">
          <GeminiRuntimeSettingsCard
            userId={user?.uid}
            vaultKey={vaultKey}
            vaultOwnerToken={vaultOwnerToken}
            needsVaultCreation={needsVaultCreation}
            needsUnlock={needsUnlock}
            onRequestVaultCreation={() => setUnlockOpen(true)}
            onRequestVaultUnlock={() => setUnlockOpen(true)}
            onConfigured={
              setupMode
                ? () => router.push(ROUTES.ONE_SETUP)
                : undefined
            }
          />
          <SettingsGroup title="What stays managed by Hussh" separatorInset>
            <SettingsRow
              title="Background workflows"
              description="CRM mapping, portfolio ingestion, and consent execution continue to use Hussh-managed Vertex."
              density="compact"
              disabled
            />
            <SettingsRow
              title="Gmail"
              description="Gmail is a disabled Connections child and is not available to One or voice."
              density="compact"
              disabled
            />
          </SettingsGroup>
        </div>
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
