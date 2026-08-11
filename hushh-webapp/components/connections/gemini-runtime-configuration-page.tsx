"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { PrivateAgentCard } from "@/components/connections/private-agent-card";
import { GeminiRuntimeSettingsCard } from "@/components/connections/gemini-runtime-settings-card";
import { CapabilityCinematicIntroGate } from "@/components/onboarding/setup/capability-cinematic-intro";
import { SetupCompletionFooter } from "@/components/onboarding/setup/setup-completion-footer";
import { VaultUnlockDialog } from "@/components/vault/vault-unlock-dialog";
import { useAuth } from "@/hooks/use-auth";
import { useLocalOnboardingActionHandler } from "@/lib/agent/local-onboarding-actions";
import { ROUTES } from "@/lib/navigation/routes";
import { requestInternalAppNavigation } from "@/lib/utils/browser-navigation";
import { VaultService } from "@/lib/services/vault-service";
import { PreVaultUserStateService } from "@/lib/services/pre-vault-user-state-service";
import type { OneRuntimeSetupChoice } from "@/lib/services/pre-vault-user-state-service";
import { PreVaultSensitiveDraftService } from "@/lib/services/pre-vault-sensitive-draft-service";
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
  const [hasVault, setHasVault] = useState<boolean | null>(
    setupMode ? true : null,
  );
  const [hasRuntimeChoice, setHasRuntimeChoice] = useState<boolean | null>(
    setupMode ? null : true,
  );
  const [setupChoice, setSetupChoice] = useState<OneRuntimeSetupChoice | null>(
    null,
  );
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [finishing, setFinishing] = useState(false);

  useEffect(() => {
    if (setupMode) {
      setHasVault(true);
      return;
    }
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
  }, [authLoading, isVaultUnlocked, setupMode, user?.uid]);

  useEffect(() => {
    if (!setupMode) {
      setHasRuntimeChoice(true);
      return;
    }
    if (authLoading || !user?.uid) return;
    let active = true;
    const cached = PreVaultUserStateService.getCachedBootstrapState(user.uid);
    if (cached) {
      setHasRuntimeChoice(PreVaultUserStateService.hasOneRuntimeChoice(cached));
      setSetupChoice(cached.oneRuntimeSetupChoice);
      return;
    }
    void PreVaultUserStateService.bootstrapState(user.uid)
      .then((state) => {
        if (active) {
          setHasRuntimeChoice(
            PreVaultUserStateService.hasOneRuntimeChoice(state),
          );
          setSetupChoice(state.oneRuntimeSetupChoice);
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
      router.replace(
        `/login?redirect=${encodeURIComponent(setupMode ? ROUTES.ONE_SETUP_CONNECTIONS : ROUTES.CONNECT_SETTINGS)}`,
      );
    }
  }, [authLoading, router, setupMode, user]);

  const needsVaultCreation = !setupMode && Boolean(
    user && !isVaultUnlocked && hasVault === false,
  );
  const needsUnlock = !setupMode && Boolean(
    user && !isVaultUnlocked && hasVault === true,
  );
  const finishConnections = useCallback(async () => {
    if (!hasRuntimeChoice) {
      return {
        status: "blocked" as const,
        summary: "Choose AI access before finishing setup.",
      };
    }
    if (finishing) {
      return {
        status: "blocked" as const,
        summary: "AI access setup is already being finished.",
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
      summary: "AI access setup is complete. Returning to setup.",
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
    title: setupMode ? "AI access setup" : "Gemini settings",
    purpose: "Choose how the private agent reaches Gemini.",
    actions:
      setupMode && hasRuntimeChoice && !finishing
        ? [
            {
              id: "finish_connections",
              actionId: "setup.finish_connections",
              label: "Finish AI access setup",
              purpose: "Keep the selected runtime and return to setup.",
            },
          ]
        : [],
  });

  const content = (
    <AppPageShell
      as="main"
      width={setupMode ? "reading" : "standard"}
      className="relative isolate pb-[calc(var(--app-bottom-fixed-ui,96px)+1.25rem)] sm:pb-10 md:pb-8"
      nativeTest={{
        routeId: setupMode ? "/one/setup/connections" : "/one/connect/settings",
        marker: setupMode
          ? "native-route-one-setup-connections"
          : "native-route-connect-settings",
        authState: user ? "authenticated" : "pending",
        dataState:
          authLoading ||
          hasVault === null ||
          (setupMode && hasRuntimeChoice === null)
            ? "loading"
            : "loaded",
      }}
    >
      <AppPageHeaderRegion>
        <PageHeader
          title={setupMode ? "AI access" : "Gemini settings"}
          description={
            setupMode
              ? "Choose Hussh managed Gemini or set up your own Gemini access. Your credential stays in this session until you finish setup."
              : "Choose how your private agent reaches Gemini."
          }
          accent="neutral"
        />
      </AppPageHeaderRegion>
      {/* space-y-6 gives the Gemini and "Coming soon" groups the standard
          surface rhythm; without it the two SettingsGroups render flush and the
          "Coming soon" heading looks cramped against the Gemini card (#1940). */}
      <AppPageContentRegion className="space-y-6">
        {/* Below the AI-connection card, deliberately: a pod runs on the person's
            own model key, so it is offered only after there is a key to run it on. */}
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
          initialSetupChoice={setupChoice}
          onSelectionReadyChange={
            setupMode && user?.uid
              ? async (choice) => {
                  const state = await PreVaultUserStateService.markOneRuntimeChoice(
                    user.uid,
                    choice,
                  );
                  setSetupChoice(state.oneRuntimeSetupChoice);
                  setHasRuntimeChoice(true);
                }
              : undefined
          }
          onPreVaultDraftStaged={
            setupMode && user?.uid
              ? (draft) => PreVaultSensitiveDraftService.stageGeminiRuntime(user.uid, draft)
              : undefined
          }
          onPreVaultDraftCleared={
            setupMode && user?.uid
              ? () => PreVaultSensitiveDraftService.clearGeminiRuntime(user.uid)
              : undefined
          }
        />
        {/* Not shown during first-run setup: the person is still connecting the key
            the pod would run on, and offering to build one mid-flow would interrupt
            the journey they are already in. */}
        {setupMode ? null : (
          <PrivateAgentCard
            vaultOwnerToken={vaultOwnerToken}
            needsUnlock={needsUnlock}
            onRequestVaultUnlock={() => setUnlockOpen(true)}
          />
        )}
      </AppPageContentRegion>
      {setupMode ? (
        <SetupCompletionFooter
          label="Finish AI access setup"
          onComplete={() => void finishConnections()}
          busy={finishing}
          disabled={!hasRuntimeChoice || finishing}
          controlId="one-setup-connections-terminal"
          actionId="setup.finish_connections"
          purpose="Record the selected Gemini runtime and return to setup."
          supportingText="Choose one Gemini option before continuing."
        />
      ) : null}
      {!setupMode && user ? (
        <VaultUnlockDialog
          user={user}
          open={unlockOpen}
          onOpenChange={setUnlockOpen}
          title={
            needsVaultCreation
              ? "Set up your private vault"
              : "Open your private vault"
          }
          description="Your Gemini access is encrypted in your private vault and is never stored by Hussh."
          onSuccess={() => setUnlockOpen(false)}
        />
      ) : null}
    </AppPageShell>
  );

  // AI access is a root prerequisite rather than an agent capability. Its
  // shared intro stays presentational-only and never enters the capability
  // catalog or generated action registry.
  return setupMode ? (
    <CapabilityCinematicIntroGate capabilityId="connections">
      {content}
    </CapabilityCinematicIntroGate>
  ) : (
    content
  );
}
