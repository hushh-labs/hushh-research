"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { PrivateAgentCard } from "@/components/connections/private-agent-card";
import { GeminiRuntimeSettingsCard } from "@/components/connections/gemini-runtime-settings-card";
import { RuntimeProviderMark } from "@/components/brand/runtime-provider-mark";
import { RUNTIME_PROVIDER_CATALOG } from "@/lib/connections/runtime-provider-catalog";
import { SetupCompletionFooter } from "@/components/onboarding/setup/setup-completion-footer";
import { VaultUnlockDialog } from "@/components/vault/vault-unlock-dialog";
import { useAuth } from "@/hooks/use-auth";
import {
  isValidatedAuthSessionOwnerCurrent,
  snapshotValidatedAuthSessionOwner,
} from "@/lib/auth/session-owner";
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

export function GeminiRuntimeConfigurationPage(props: GeminiRuntimeConfigurationPageProps) {
  const auth = useAuth();
  const owner = snapshotValidatedAuthSessionOwner();
  return (
    <OwnerRuntimeConfigurationPage
      key={`${auth.user?.uid ?? "signed-out"}:${owner?.generation ?? "unresolved"}`}
      {...props}
      auth={auth}
    />
  );
}

function OwnerRuntimeConfigurationPage({
  setupMode = false,
  auth,
}: GeminiRuntimeConfigurationPageProps & { auth: ReturnType<typeof useAuth> }) {
  const router = useRouter();
  const { user, loading: authLoading } = auth;
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
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

  const needsVaultCreation =
    !setupMode && Boolean(user && !isVaultUnlocked && hasVault === false);
  const needsUnlock =
    !setupMode && Boolean(user && !isVaultUnlocked && hasVault === true);
  const returnToSetupHub = useCallback(() => {
    setFinishing(true);
    const requested = requestInternalAppNavigation({
      href: ROUTES.ONE_SETUP,
      replace: true,
      scroll: false,
      source: "programmatic",
      transitionMode: "full",
    });
    if (!requested) router.replace(ROUTES.ONE_SETUP);
  }, [router]);

  const finishConnections = useCallback(async () => {
    if (!hasRuntimeChoice) {
      return {
        status: "blocked" as const,
        summary: "Choose your AI first.",
      };
    }
    if (finishing) {
      return {
        status: "blocked" as const,
        summary: "AI access setup is already being finished.",
      };
    }
    returnToSetupHub();
    return {
      status: "started" as const,
      summary: "AI access setup is complete. Returning to setup.",
      routeAfter: ROUTES.ONE_SETUP,
      screenAfter: "one_setup",
    };
  }, [finishing, hasRuntimeChoice, returnToSetupHub]);

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
        {/* The provider marks used to live on a full-screen prologue with its
            own Continue button — one extra screen and one extra tap in front of
            a two-option choice. They carry the same "these are the models"
            context here, inline, at zero cost. */}
        {setupMode ? (
          <ul
            className="mb-4 flex flex-wrap items-center gap-2"
            aria-label="AI providers"
            data-runtime-provider-lane
          >
            {RUNTIME_PROVIDER_CATALOG.map((provider) => (
              <li key={provider.id} className="relative">
                <span
                  className="inline-flex h-9 w-9 items-center justify-center"
                  title={
                    provider.availability === "available"
                      ? `${provider.name} is available now`
                      : `${provider.name} is coming soon`
                  }
                >
                  {/* One size for every mark. The row gave each provider a
                      36px slot but only Gemini was sized to it — the other four
                      kept the mark's own 48px default, so they overflowed their
                      slots and overlapped each other by 4px, which is why the
                      logos looked cramped and Grok came out clipped. */}
                  <RuntimeProviderMark
                    provider={provider}
                    className="h-9 w-9"
                  />
                </span>
                <span className="sr-only">
                  {provider.availability === "available"
                    ? `${provider.name} is available now.`
                    : `${provider.name} is coming soon.`}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        <PageHeader
          title={setupMode ? "Choose your AI" : "Gemini settings"}
          description={
            setupMode
              ? "Your pod's AI, or your own key."
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
                  const owner = snapshotValidatedAuthSessionOwner();
                  if (!mountedRef.current || !owner || owner.userId !== user.uid) return;
                  const state =
                    await PreVaultUserStateService.markOneRuntimeChoice(
                      user.uid,
                      choice,
                    );
                  if (!mountedRef.current || !isValidatedAuthSessionOwnerCurrent(owner)) return;
                  setSetupChoice(state.oneRuntimeSetupChoice);
                  setHasRuntimeChoice(true);
                  // Taking the recommended option IS the whole decision —
                  // there is nothing further to enter — so it finishes this
                  // step instead of parking the person on a Continue button
                  // they have to find. Bringing your own key still continues
                  // below, because that path has a form left to fill.
                  if (choice === "hushh_managed_vertex") {
                    // Navigation can unmount the card before its callback resumes.
                    // Retire BYOK only after the managed choice was persisted.
                    PreVaultSensitiveDraftService.clearGeminiRuntime(user.uid);
                    returnToSetupHub();
                  }
                }
              : undefined
          }
          onPreVaultDraftStaged={
            setupMode && user?.uid
              ? (draft) =>
                  PreVaultSensitiveDraftService.stageGeminiRuntime(
                    user.uid,
                    draft,
                  )
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
          label="Continue"
          onComplete={() => void finishConnections()}
          busy={finishing}
          disabled={!hasRuntimeChoice || finishing}
          controlId="one-setup-connections-terminal"
          actionId="setup.finish_connections"
          purpose="Record the selected Gemini runtime and return to setup."
          supportingText="Pick one to continue."
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
          description="Gemini access stays in your vault."
          onSuccess={() => setUnlockOpen(false)}
        />
      ) : null}
    </AppPageShell>
  );

  // AI access is a root prerequisite rather than an agent capability, and it is
  // the ONE step that blocks finishing setup. It deliberately does not sit
  // behind the shared cinematic prologue: a mandatory two-option choice must be
  // one tap from the hub, not a screen, a Continue, and then the choice.
  return content;
}
