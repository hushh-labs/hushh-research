"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { GeminiRuntimeSettingsCard } from "@/components/connections/gemini-runtime-settings-card";
import { SetupCompletionFooter } from "@/components/onboarding/setup/setup-completion-footer";
import { VaultUnlockDialog } from "@/components/vault/vault-unlock-dialog";
import { useAuth } from "@/hooks/use-auth";
import { useLocalOnboardingActionHandler } from "@/lib/agent/local-onboarding-actions";
import { ROUTES } from "@/lib/navigation/routes";
import { requestInternalAppNavigation } from "@/lib/utils/browser-navigation";
import { VaultService } from "@/lib/services/vault-service";
import { PreVaultUserStateService } from "@/lib/services/pre-vault-user-state-service";
import { useVault } from "@/lib/vault/vault-context";
import { usePublishVoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";

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
  const [finishing, setFinishing] = useState(false);

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
  const finishConnections = useCallback(async () => {
    if (!hasRuntimeChoice) {
      return {
        status: "blocked" as const,
        summary: "Choose how One runs before finishing Connections setup.",
      };
    }
    if (finishing) {
      return {
        status: "blocked" as const,
        summary: "Connections setup is already being finished.",
      };
    }
    setFinishing(true);
    const requested = requestInternalAppNavigation({
      href: ROUTES.ONE_SETUP,
      replace: true,
      scroll: false,
      source: "programmatic",
      transitionMode: "full",
    });
    if (!requested) router.replace(ROUTES.ONE_SETUP);
    return {
      status: "started" as const,
      summary: "Connections setup is complete. Returning to setup.",
      routeAfter: ROUTES.ONE_SETUP,
      screenAfter: "one_setup",
    };
  }, [finishing, hasRuntimeChoice, router]);

  useLocalOnboardingActionHandler(
    "setup.finish_connections",
    finishConnections,
    { enabled: setupMode },
  );

  usePublishVoiceSurfaceMetadata({
    screenId: setupMode ? "one_setup_connections" : "one_connections_settings",
    title: setupMode ? "Connections setup" : "Gemini settings",
    purpose: "Choose the Gemini runtime used for private-agent turns.",
    actions:
      setupMode && hasRuntimeChoice && !finishing
        ? [
            {
              id: "finish_connections",
              actionId: "setup.finish_connections",
              label: "Finish Connections setup",
              purpose: "Keep the selected runtime and return to setup.",
            },
          ]
        : [],
  });

  return (
    <AppPageShell
      as="main"
      width="standard"
      className="relative isolate pb-[calc(var(--app-bottom-fixed-ui,96px)+1.25rem)] sm:pb-10 md:pb-8"
      nativeTest={{
        routeId: setupMode ? "/one/setup/connections" : "/one/connect/settings",
        marker: setupMode ? "native-route-one-setup-connections" : "native-route-connect-settings",
        authState: user ? "authenticated" : "pending",
        dataState:
          authLoading || hasVault === null || (setupMode && hasRuntimeChoice === null)
            ? "loading"
            : "loaded",
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
          onSelectionReadyChange={
            setupMode && user?.uid
              ? async (ready) => {
                  if (!ready) return;
                  await PreVaultUserStateService.markOneRuntimeChoice(
                    user.uid,
                  );
                  setHasRuntimeChoice(true);
                }
              : undefined
          }
        />
      </AppPageContentRegion>
      {setupMode ? (
        <SetupCompletionFooter
          label="Finish Connections setup"
          onComplete={() => void finishConnections()}
          busy={finishing}
          disabled={!hasRuntimeChoice || finishing}
          controlId="one-setup-connections-terminal"
          actionId="setup.finish_connections"
          purpose="Record the selected Gemini runtime and return to setup."
          supportingText="Choose one runtime before continuing."
        />
      ) : null}
      {user ? (
        <VaultUnlockDialog
          user={user}
          open={unlockOpen}
          onOpenChange={setUnlockOpen}
          title={needsVaultCreation ? "Set up your private vault" : "Open your private vault"}
          description="Your Gemini key is encrypted in your vault and is never stored by Connections."
          onSuccess={() => setUnlockOpen(false)}
        />
      ) : null}
    </AppPageShell>
  );
}
