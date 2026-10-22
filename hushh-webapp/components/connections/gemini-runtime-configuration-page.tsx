"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { PrivateAgentCard } from "@/components/connections/private-agent-card";
import { GeminiRuntimeSettingsCard } from "@/components/connections/gemini-runtime-settings-card";
import { SetupCompletionFooter } from "@/components/onboarding/setup/setup-completion-footer";
import setupStyles from "@/components/onboarding/setup/one-setup-hub.module.css";
import { VaultUnlockDialog } from "@/components/vault/vault-unlock-dialog";
import { useAuth } from "@/hooks/use-auth";
import {
  isValidatedAuthSessionOwnerCurrent,
  snapshotValidatedAuthSessionOwner,
} from "@/lib/auth/session-owner";
import { useLocalOnboardingActionHandler } from "@/lib/agent/local-onboarding-actions";
import {
  buildOneSetupRoute,
  resolveOneSetupReturnTo,
  ROUTES,
} from "@/lib/navigation/routes";
import { requestInternalAppNavigation } from "@/lib/utils/browser-navigation";
import { VaultService } from "@/lib/services/vault-service";
import { PreVaultUserStateService } from "@/lib/services/pre-vault-user-state-service";
import type { OneRuntimeSetupChoice } from "@/lib/services/pre-vault-user-state-service";
import { PreVaultSensitiveDraftService } from "@/lib/services/pre-vault-sensitive-draft-service";
import { useVault } from "@/lib/vault/vault-context";
import { usePublishVoiceSurfaceMetadata } from "@/lib/kai/actions/voice-surface-metadata";

type GeminiRuntimeConfigurationPageProps = {
  setupMode?: boolean;
  embeddedInCloudSetup?: boolean;
  onSetupReadyChange?: (ready: boolean) => void;
};

export function GeminiRuntimeConfigurationPage(
  props: GeminiRuntimeConfigurationPageProps,
) {
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
  embeddedInCloudSetup = false,
  onSetupReadyChange,
  auth,
}: GeminiRuntimeConfigurationPageProps & { auth: ReturnType<typeof useAuth> }) {
  const router = useRouter();
  const searchParams = useSearchParams();
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
  const [canContinue, setCanContinue] = useState(false);
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const embedded = setupMode && embeddedInCloudSetup;

  useEffect(() => {
    onSetupReadyChange?.(canContinue && hasRuntimeChoice === true);
    return () => onSetupReadyChange?.(false);
  }, [canContinue, hasRuntimeChoice, onSetupReadyChange]);

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
    const href = buildOneSetupRoute({
      returnTo: resolveOneSetupReturnTo(searchParams.get("return_to")),
    });
    const requested = requestInternalAppNavigation({
      href,
      replace: true,
      scroll: false,
      source: "programmatic",
      transitionMode: "full",
    });
    if (!requested) router.replace(href);
  }, [router, searchParams]);

  const finishConnections = useCallback(async () => {
    if (!canContinue) {
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
  }, [finishing, canContinue, returnToSetupHub]);

  useLocalOnboardingActionHandler(
    "setup.finish_connections",
    finishConnections,
    { enabled: setupMode && !embedded },
  );

  usePublishVoiceSurfaceMetadata(
    embedded
      ? null
      : {
          screenId: setupMode
            ? "one_setup_connections"
            : "one_connections_settings",
          title: setupMode ? "AI access setup" : "AI settings",
          purpose: "Choose and verify the private agent’s AI connection.",
          actions:
            setupMode && canContinue && !finishing
              ? [
                  {
                    id: "finish_connections",
                    actionId: "setup.finish_connections",
                    label: "Finish AI access setup",
                    purpose: "Keep the selected runtime and return to setup.",
                  },
                ]
              : [],
        },
  );

  const runtimeSettings = (
    <GeminiRuntimeSettingsCard
      userId={user?.uid}
      vaultKey={vaultKey}
      vaultOwnerToken={vaultOwnerToken}
      needsVaultCreation={needsVaultCreation}
      needsUnlock={needsUnlock}
      onRequestVaultCreation={() => setUnlockOpen(true)}
      onRequestVaultUnlock={() => setUnlockOpen(true)}
      requiresExplicitSelection={setupMode}
      initiallyConfigured={
        hasRuntimeChoice === true &&
        (setupChoice !== "byok_pending_vault" ||
          Boolean(
            user?.uid &&
            PreVaultSensitiveDraftService.hasGeminiRuntime(user.uid),
          ))
      }
      onCanContinueChange={setupMode ? setCanContinue : undefined}
      initialSetupChoice={setupChoice}
      onSelectionReadyChange={
        setupMode && user?.uid
          ? async (choice) => {
              const owner = snapshotValidatedAuthSessionOwner();
              if (!mountedRef.current || !owner || owner.userId !== user.uid)
                return;
              const state = await PreVaultUserStateService.markOneRuntimeChoice(
                user.uid,
                choice,
              );
              if (
                !mountedRef.current ||
                !isValidatedAuthSessionOwnerCurrent(owner)
              )
                return;
              setSetupChoice(state.oneRuntimeSetupChoice);
              setHasRuntimeChoice(true);
              if (choice === "hushh_managed_vertex") {
                PreVaultSensitiveDraftService.clearGeminiRuntime(user.uid);
              }
            }
          : undefined
      }
      onPreVaultDraftStaged={
        setupMode && user?.uid
          ? (draft) =>
              PreVaultSensitiveDraftService.stageGeminiRuntime(user.uid, draft)
          : undefined
      }
      onPreVaultDraftCleared={
        setupMode && user?.uid
          ? () => PreVaultSensitiveDraftService.clearGeminiRuntime(user.uid)
          : undefined
      }
    />
  );

  if (embedded) {
    return (
      <section aria-label="AI access" className="space-y-4">
        <h2 className="text-base font-semibold">AI access</h2>
        {runtimeSettings}
      </section>
    );
  }

  const content = (
    <AppPageShell
      as="main"
      width={setupMode ? "reading" : "standard"}
      className={`relative isolate pb-[calc(var(--app-bottom-fixed-ui,96px)+1.25rem)] sm:pb-10 md:pb-8 ${setupMode ? setupStyles.aiSelectionPage : ""}`}
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
          title={setupMode ? "Choose your AI" : "AI settings"}
          description={
            setupMode
              ? "Your pod's AI, or your own key."
              : "Choose your AI connection."
          }
          accent="neutral"
          className={setupMode ? setupStyles.setupHeader : undefined}
        />
      </AppPageHeaderRegion>
      {/* space-y-6 gives the Gemini and "Coming soon" groups the standard
          surface rhythm; without it the two SettingsGroups render flush and the
          "Coming soon" heading looks cramped against the Gemini card (#1940). */}
      <AppPageContentRegion
        className={setupMode ? setupStyles.aiSelectionContent : "space-y-6"}
      >
        {runtimeSettings}
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
          disabled={!canContinue || finishing}
          controlId="one-setup-connections-terminal"
          actionId="setup.finish_connections"
          purpose="Record the selected AI connection and return to setup."
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
          description="Manage your AI connection securely."
          onSuccess={() => setUnlockOpen(false)}
        />
      ) : null}
    </AppPageShell>
  );

  // The standalone route remains available for existing bookmarks. New setup
  // composes the same authority-bearing choice inside the hosting wizard.
  return content;
}
