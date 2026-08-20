"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Cloud, PlugZap } from "lucide-react";

import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import {
  CapabilitySetupTile,
  SetupNavigationTile,
} from "@/components/onboarding/setup/capability-setup-tile";
import {
  BufferHandoffScreen,
  GuidedConnectionScreen,
  VaultExplainerScreens,
} from "@/components/onboarding/setup/local-first-vault-sequence";
import { SetupCompletionFooter } from "@/components/onboarding/setup/setup-completion-footer";
import { SettingsGroup } from "@/components/app-ui/settings-ui";
import { VaultUnlockDialog } from "@/components/vault/vault-unlock-dialog";
import { Button } from "@/lib/morphy-ux/button";
import styles from "./one-setup-hub.module.css";
import { useAuth } from "@/lib/firebase/auth-context";
import { isPersonalAgentReadyFromCachedFeed } from "@/lib/feed/personal-agent-readiness";
import { useVault } from "@/lib/vault/vault-context";
import {
  isOneSetupSurfaceRoute,
  normalizeInternalRouteHref,
  ROUTES,
} from "@/lib/navigation/routes";
import { acknowledgeOneSetupExit } from "@/lib/services/one-setup-exit-service";
import {
  CAPABILITY_SETUP_COPY,
  type CapabilitySetupCopy,
} from "@/lib/onboarding/capability-setup-copy";
import {
  getOneSetupCapability,
  lucideCapabilityIcon,
  type OneCapabilityIcon,
  type OneCapabilityTone,
} from "@/lib/onboarding/one-capabilities";
import { usePublishVoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";
import { useLocalOnboardingActionHandler } from "@/lib/agent/local-onboarding-actions";
import { useCapabilitySetupStates } from "@/lib/onboarding/use-capability-setup-states";
import { groupSetupCapabilities } from "@/lib/onboarding/setup-capability-order";
import {
  isCapabilitySetupComplete,
  type CapabilityStatus,
} from "@/lib/services/capability-setup-state-service";
import { getCapabilityStatusDisplay } from "@/lib/onboarding/capability-status-display";
import { isLocalFirstOnboardingEnabled } from "@/lib/onboarding/local-first-flags";
import { migrateOnboardingBuffer } from "@/lib/services/onboarding-buffer-migration-service";
import { PreVaultUserStateService } from "@/lib/services/pre-vault-user-state-service";
import { PreVaultSensitiveDraftService } from "@/lib/services/pre-vault-sensitive-draft-service";
import { FinanceSetupDraftService } from "@/lib/services/finance-setup-draft-service";
import { PostUnlockSyncService } from "@/lib/services/post-unlock-sync-service";
import { notifyGeminiRuntimeConfigurationChanged } from "@/lib/connections/gemini-runtime-configuration";

/**
 * OneSetupHub: the `/one/setup` hub screen.
 *
 * It is the calm home for "what's left to set up". It opts into the expensive
 * resolver enrichment (`enrichVault` + `enrichOauth`) so every tile shows an
 * honest state (Ready, Set up, N to review) or an honest blocked reason
 * ("Set up vault", "Connect to set up") instead of guessing.
 *
 * LAYOUT (Card Depth Model + recompose-by-breakpoint)
 * - Lives inside the normal app shell (`standard` chrome) so a person who has
 *   finished onboarding can still browse here without being trapped in a flow.
 * - Remaining and Complete inset lists preserve the authored product order.
 *   The shell itself owns the scroll; the header region stays put.
 * - One owns the voice: "Set up One", plain language, no system nouns.
 */
export function OneSetupHub() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user } = useAuth();
  const { vaultKey, vaultOwnerToken, isVaultUnlocked } = useVault();
  const { byId, isLoading, isEnriching } = useCapabilitySetupStates({
    enrichVault: true,
    enrichOauth: true,
    enrichRia: true,
  });
  const [dismissing, setDismissing] = useState(false);
  const [finalizationError, setFinalizationError] = useState<string | null>(null);
  const [vaultInvitationOpen, setVaultInvitationOpen] = useState(false);
  const [vaultDialogOpen, setVaultDialogOpen] = useState(false);
  /**
   * Local-first sequencing (Workstream D4), OFF by default.
   *
   * This changes only WHEN the vault flow is entered — guided connection, then
   * the buffer migration, then the explainers, then the same unmodified vault
   * dialog. With the flag off, `localFirstStage` never leaves "idle" and every
   * branch below falls through to today's behaviour.
   */
  const localFirstEnabled = isLocalFirstOnboardingEnabled();
  const [localFirstStage, setLocalFirstStage] = useState<
    "idle" | "guided_connection" | "migrating" | "explainer" | "draining"
  >("idle");
  const finalizationInFlightRef = useRef<Promise<void> | null>(null);
  // Both root prerequisites come from ONE PreVaultUserState read. They are two facts
  // on the same record, so splitting them into two snapshots would mean two fetches,
  // two caches and two chances for the hub to show a person a half-updated checklist.
  const [prereqSnapshot, setPrereqSnapshot] = useState<{
    userId: string | null;
    cloud: "loading" | "required" | "complete";
    runtime: "loading" | "required" | "complete";
  }>({ userId: null, cloud: "loading", runtime: "loading" });
  const prereqMatchesUser = prereqSnapshot.userId === (user?.uid ?? null);
  const cloudState = prereqMatchesUser ? prereqSnapshot.cloud : "loading";
  const runtimeChoiceState = prereqMatchesUser ? prereqSnapshot.runtime : "loading";
  const returnTo = useMemo(() => {
    const raw = normalizeInternalRouteHref(searchParams.get("return_to"));
    if (!raw) return null;
    // Never send the master exit back onto a setup surface. A stray
    // `?return_to=/one/setup` (e.g. from a capability/connector sub-flow that
    // returns to the hub) would make Skip/Finish replace /one/setup with
    // itself and look like a no-op. Fall through to home instead.
    const path = raw.split(/[?#]/)[0] ?? raw;
    return isOneSetupSurfaceRoute(path) ? null : raw;
  }, [searchParams]);
  const completionTarget = returnTo || ROUTES.ONE_HOME;

  useEffect(() => {
    if (!user?.uid) {
      setPrereqSnapshot({
        userId: null,
        cloud: "required",
        runtime: "required",
      });
      return;
    }
    let active = true;
    const project = (
      state: Parameters<typeof PreVaultUserStateService.hasOneCloudProject>[0],
    ) => ({
      userId: user.uid,
      cloud: PreVaultUserStateService.hasOneCloudProject(state)
        ? ("complete" as const)
        : ("required" as const),
      runtime: PreVaultUserStateService.hasOneRuntimeChoice(state)
        ? ("complete" as const)
        : ("required" as const),
    });
    const cached = PreVaultUserStateService.getCachedBootstrapState(user.uid);
    if (cached) {
      setPrereqSnapshot(project(cached));
      return;
    }
    setPrereqSnapshot({
      userId: user.uid,
      cloud: "loading",
      runtime: "loading",
    });
    void PreVaultUserStateService.bootstrapState(user.uid)
      .then((state) => {
        if (!active) return;
        setPrereqSnapshot(project(state));
      })
      .catch(() => {
        if (active) {
          setPrereqSnapshot({
            userId: user.uid,
            cloud: "required",
            runtime: "required",
          });
        }
      });
    return () => {
      active = false;
    };
  }, [user?.uid]);

  const items = useMemo(() => buildSetupItems(byId), [byId]);
  const groupedItems = groupSetupCapabilities(items, (item) =>
    isCapabilitySetupComplete(item.status),
  );
  const remainingItems = groupedItems.remaining;
  const completeItems = groupedItems.complete;
  const visibleItems = groupedItems.visible;

  const cloudComplete = cloudState === "complete";
  const runtimeChoiceComplete = runtimeChoiceState === "complete";
  // Both root prerequisites, in product order. The footer and the master exit read
  // this rather than either half, so a person cannot leave the hub having done one.
  const setupPrerequisitesComplete = cloudComplete && runtimeChoiceComplete;
  // "Ready" counts only GENUINELY set-up capabilities (completed/skipped). A
  // tile that still needs a connection or an unlock (blocked/unknown) is NOT
  // ready, even though it is not directly tappable-into-setup — so we never
  // count it as done. AI access is also a real, mandatory setup step and is
  // rendered alongside these capability rows, so it must participate in the
  // same progress projection instead of being omitted from the denominator.
  const progressSteps = [
    { id: "cloud", complete: cloudComplete },
    { id: "connections", complete: runtimeChoiceComplete },
    ...items.map((item) => ({
      id: item.id,
      complete: isCapabilitySetupComplete(item.status),
    })),
  ];
  const total = progressSteps.length;
  const done = progressSteps.filter((step) => step.complete).length;
  const remaining = total - done;
  const allReady = total > 0 && remaining === 0;
  // Capability setup is optional, but the root vault is not. Finish setup is
  // therefore the only exit from the hub and always leads to vault setup when
  // the vault is not already unlocked.
  const masterActionLabel = "Finish setup";
  const hubStateLoading =
    isLoading || isEnriching || runtimeChoiceState === "loading";

  // Publish screen context so the onboarding guide can describe the hub and
  // navigate the person to any capability they ask for.
  usePublishVoiceSurfaceMetadata({
    screenId: "one_setup_hub",
    title: "Set up One",
    purpose:
      "This is your setup home. Each tile is one thing One can do for you. Set up the ones you want and skip the rest.",
    actions: hubStateLoading
      ? []
      : [
          ...visibleItems.map((item) => ({
            id: item.id,
            actionId: getOneSetupCapability(item.id)?.setupActionId,
            label: item.copy.setupTitle,
            purpose: `${item.copy.setupBlurb} ${
              isCapabilitySetupComplete(item.status)
                ? "This setup is complete."
                : "This setup is still remaining."
            }`,
          })),
          ...(dismissing || !setupPrerequisitesComplete
            ? []
            : [
                {
                  id: "master_ack",
                  actionId: "setup.hub_master_ack",
                  label: masterActionLabel,
                  purpose: "Finish setup and protect what you save.",
                },
              ]),
        ],
  });

  const completeSetupAfterVault = useCallback(async (): Promise<void> => {
    if (!user?.uid) {
      router.replace(completionTarget);
      return;
    }
    if (!vaultKey || !vaultOwnerToken) {
      throw new Error("Not ready yet. Try again.");
    }
    if (finalizationInFlightRef.current) {
      return finalizationInFlightRef.current;
    }

    const finalize = (async () => {
      setFinalizationError(null);
      // This is the one durable boundary for sensitive setup input. Every
      // pre-vault origin remains in memory until its owning encrypted write
      // succeeds; neither a route change nor background warm-up can race it.
      await PreVaultSensitiveDraftService.finalizeForVault({
        userId: user.uid,
        vaultKey,
        vaultOwnerToken,
      });
      await PostUnlockSyncService.run({
        userId: user.uid,
        vaultKey,
        vaultOwnerToken,
      });
      await FinanceSetupDraftService.finalizeForVault({
        userId: user.uid,
        vaultKey,
        vaultOwnerToken,
      });
      notifyGeminiRuntimeConfigurationChanged(user.uid);

      await acknowledgeOneSetupExit({
        userId: user.uid,
        skipped: false,
        isVaultUnlocked: true,
        vaultKey,
        vaultOwnerToken,
      });
      setVaultDialogOpen(false);
      setVaultInvitationOpen(false);
      if (localFirstEnabled) {
        // The vault key reaches this component on the NEXT render (VaultFlow
        // calls unlockVault then onSuccess in the same tick), so the final drain
        // cannot run inside this callback. Stay mounted one more beat; the effect
        // below runs it and then routes home.
        //
        // This sits INSIDE the finalization promise rather than after it (where
        // it lived before main restructured this into an in-flight-guarded
        // IIFE), so the drain is only entered once every encrypted write above
        // has actually succeeded. Returning here skips the routing below; the
        // draining effect owns the final navigation.
        setLocalFirstStage("draining");
        return;
      }
      // Finance source intents intentionally remain process-memory-only until
      // this encryption boundary completes. Resume the canonical source flow
      // once, now that it has a valid vault session.
      router.replace(
        PreVaultSensitiveDraftService.hasFinanceIntent(user.uid)
          ? ROUTES.ONE_SETUP_FINANCE_IMPORT
          : completionTarget,
      );
    })();
    finalizationInFlightRef.current = finalize;
    try {
      await finalize;
    } catch (error) {
      setFinalizationError(
        error instanceof Error
          ? error.message
          : "Couldn't save your setup. Try again.",
      );
      throw error;
    } finally {
      if (finalizationInFlightRef.current === finalize) {
        finalizationInFlightRef.current = null;
      }
    }
  }, [
    completionTarget,
    localFirstEnabled,
    router,
    user?.uid,
    vaultKey,
    vaultOwnerToken,
  ]);

  useEffect(() => {
    if (
      !vaultInvitationOpen ||
      !isVaultUnlocked ||
      !vaultKey ||
      !vaultOwnerToken ||
      !user?.uid ||
      finalizationInFlightRef.current
    ) {
      return;
    }
    setDismissing(true);
    void completeSetupAfterVault()
      .catch(() => undefined)
      .finally(() => setDismissing(false));
  }, [
    completeSetupAfterVault,
    isVaultUnlocked,
    vaultInvitationOpen,
    vaultKey,
    vaultOwnerToken,
    user?.uid,
  ]);

  // Final drain, after the vault exists. Idempotent: anything already
  // acknowledged is skipped, anything still buffered is retried on the next
  // signed-in pass. A stalled vault key must not strand the person on this
  // screen, so the watchdog routes home regardless.
  useEffect(() => {
    if (!localFirstEnabled || localFirstStage !== "draining") return;

    let active = true;
    const watchdog = setTimeout(() => {
      if (active) router.replace(completionTarget);
    }, 8000);

    if (!user?.uid || !vaultKey || !vaultOwnerToken) {
      // Wait for the render that carries the freshly unlocked key.
      return () => {
        active = false;
        clearTimeout(watchdog);
      };
    }

    void migrateOnboardingBuffer({
      userId: user.uid,
      vaultKey,
      vaultOwnerToken,
    })
      .catch((error) => {
        console.warn(
          "[OneSetupHub] Could not finish moving buffered details into the private agent:",
          error,
        );
      })
      .finally(() => {
        if (active) router.replace(completionTarget);
      });

    return () => {
      active = false;
      clearTimeout(watchdog);
    };
  }, [
    completionTarget,
    localFirstEnabled,
    localFirstStage,
    router,
    user?.uid,
    vaultKey,
    vaultOwnerToken,
  ]);

  // The pre-vault pass. It writes nothing (there is no vault key yet) and
  // reports what is still waiting — but it runs BEFORE any vault surface opens,
  // so the vault is genuinely the last thing the person is asked for.
  const runGuidedConnection = async () => {
    setLocalFirstStage("migrating");
    if (user?.uid) {
      await migrateOnboardingBuffer({
        userId: user.uid,
        vaultKey,
        vaultOwnerToken,
      }).catch((error) => {
        console.warn(
          "[OneSetupHub] Pre-vault buffer pass failed; continuing to vault setup:",
          error,
        );
      });
    }
    setLocalFirstStage("explainer");
  };

  const handleMasterAck = async () => {
    if (dismissing) {
      return {
        status: "blocked" as const,
        summary: "Setup is already being finished.",
      };
    }
    if (!user?.uid) {
      router.replace(completionTarget);
      return { status: "started" as const, summary: "Opening home." };
    }
    setDismissing(true);
    try {
      // Root-setup gate: BOTH prerequisites are mandatory before leaving the hub.
      // When the client already knows they are satisfied (the footer stays disabled
      // until then) trust it and skip the network round-trip. Only re-verify against
      // fresh server state when the client is unsure — and even then a failed probe
      // must not trap the person, so fall back to the resolved client gate rather
      // than stranding them.
      let cloudConfirmed = cloudComplete;
      let runtimeChoiceConfirmed = runtimeChoiceComplete;
      if (!cloudConfirmed || !runtimeChoiceConfirmed) {
        try {
          const currentState = await PreVaultUserStateService.bootstrapState(
            user.uid,
            { force: true },
          );
          cloudConfirmed =
            PreVaultUserStateService.hasOneCloudProject(currentState);
          runtimeChoiceConfirmed =
            PreVaultUserStateService.hasOneRuntimeChoice(currentState);
          setPrereqSnapshot({
            userId: user.uid,
            cloud: cloudConfirmed ? "complete" : "required",
            runtime: runtimeChoiceConfirmed ? "complete" : "required",
          });
        } catch (error) {
          console.warn(
            "[OneSetupHub] Could not verify the root setup prerequisites:",
            error,
          );
        }
      }
      // Distinct messages per missing step, deliberately. "Set up your cloud" and
      // "Choose AI access" are different next actions, and one string covering both
      // is how a gate stops telling a person what to do and becomes noise.
      if (!cloudConfirmed) {
        return {
          status: "blocked" as const,
          summary: "Connect your own cloud before continuing.",
        };
      }
      if (!runtimeChoiceConfirmed) {
        return {
          status: "blocked" as const,
          summary: "Choose your AI first.",
        };
      }

      if (!isVaultUnlocked) {
        if (localFirstEnabled) {
          setLocalFirstStage("guided_connection");
          return {
            status: "succeeded" as const,
            summary: "Continue to connect your private agent.",
          };
        }
        // No screen in between. Finish setup opens the lock step itself; the
        // reassurance the old invitation screen carried ("only you can open
        // what you save") now lives on the lock step's own first screen, so
        // nothing is lost and a whole tap disappears.
        setVaultInvitationOpen(true);
        setVaultDialogOpen(true);
        return {
          status: "succeeded" as const,
          summary: "One step left: set a lock.",
        };
      }
      await completeSetupAfterVault();
      return {
        status: "succeeded" as const,
        summary: "Setup complete. Opening home.",
        routeAfter: completionTarget,
      };
    } finally {
      setDismissing(false);
    }
  };

  // Voice and the visible shared terminal action drive the same mandatory
  // root-completion boundary.
  useLocalOnboardingActionHandler("setup.hub_master_ack", async () => {
    return handleMasterAck();
  });

  // Phones get the master action as a bare header link with no supporting line
  // under it, so the one mandatory step has to be named somewhere they can read
  // it before they tap. The header description is the only copy both layouts
  // share, so the blocker rides there rather than only in the desktop footer.
  //
  // It carries ONLY that. The segmented progress bar below already renders
  // "done of total"; repeating the count in words was two facts competing for
  // the one line people actually read.
  const summary = hubStateLoading
    ? "One moment…"
    : allReady
      ? "Add more any time."
      : !cloudComplete
        ? "Connect your cloud first."
        : !runtimeChoiceComplete
          ? "Choose your AI first."
          : `${remaining} left.`;
  const localFirstSequenceActive =
    localFirstEnabled && localFirstStage !== "idle" && Boolean(user);
  // A centered story-screen takeover (the local-first sequence) is a full screen
  // with its own single title, icon, and action. The hub therefore suppresses its
  // own PageHeader while one is showing: rendering both stacked two competing
  // titles over one centered screen (Restraint Charter: one title per screen).
  const storyTakeoverActive = localFirstSequenceActive;

  return (
    <AppPageShell
      as="main"
      width="reading"
      className="relative isolate"
      nativeTest={{
        routeId: "/one/setup",
        marker: "native-route-one-setup",
        authState: "authenticated",
        dataState: hubStateLoading ? "loading" : "loaded",
      }}
    >
      {/* Suppressed during the local-first story takeover: that centered screen
          owns the one title, so the hub must not render a second one above it
          (Restraint Charter: one title per screen). */}
      {!storyTakeoverActive ? (
        <AppPageHeaderRegion>
          {/* Header title + mobile master action share one flex row. The action
              was absolutely positioned over the header before, so the large
              display title ran underneath it and the two overlapped. A flex row
              with a min-w-0 title column and a shrink-0 button keeps real
              horizontal separation; the title shrinks within its column.

              The row wraps, and the title column holds a floor before it does.
              `min-w-0` let the title shrink to nothing while a shrink-0 action
              whose label cannot wrap took what it needed first -- at 320px with
              200% text that left the title 60px to paint 180px of "Finish
              setting up One", which overflowed a visible box straight through
              the action (measured: 96px of overlap, in every hub state). The
              floor has to be min-width, not flex-basis: `flex-1` is
              `flex: 1 1 0%`, so a basis utility next to it is simply overwritten
              and the row never wraps. In rem, so it grows with the text setting
              that causes the squeeze; above that threshold nothing moves. */}
          <div className="flex flex-wrap items-start gap-3">
            <div className="min-w-[8rem] flex-1">
            <PageHeader
              title={
                !hubStateLoading && allReady ? "You're all set" : "Set up One"
              }
              description={summary}
              accent="neutral"
              className={styles.setupHeader}
            />
            </div>
            {/* Mobile surfaces the master Skip/Finish action top-right in the
                header so it is always reachable and never hides behind the fixed
                "Talk to One" agent bar. Desktop keeps the in-flow footer below. */}
            {!hubStateLoading ? (
              <button
                type="button"
                onClick={() => void handleMasterAck()}
                disabled={dismissing || !setupPrerequisitesComplete}
                title={
                  !cloudComplete
                    ? "Connect your cloud first."
                    : !runtimeChoiceComplete
                      ? "Choose your AI first."
                      : undefined
                }
                data-testid="one-setup-master-ack-mobile"
                // Same rule as the desktop footer: the accent is reserved for a
                // tap that can actually finish. A faded accent still reads blue,
                // so a blocked finish goes neutral rather than dimmed.
                className="mt-1 shrink-0 whitespace-nowrap rounded-full px-3 py-1.5 text-sm font-semibold text-[var(--app-accent)] transition hover:bg-[var(--app-accent-tint)] disabled:pointer-events-none disabled:text-muted-foreground disabled:opacity-100 sm:hidden"
              >
                {masterActionLabel}
              </button>
            ) : null}
          </div>
        </AppPageHeaderRegion>
      ) : null}

      <AppPageContentRegion>
        {localFirstSequenceActive ? (
          localFirstStage === "guided_connection" ||
          localFirstStage === "migrating" ? (
            <GuidedConnectionScreen
              agentReady={
                user?.uid
                  ? isPersonalAgentReadyFromCachedFeed(user.uid)
                  : false
              }
              busy={localFirstStage === "migrating"}
              onContinue={() => void runGuidedConnection()}
            />
          ) : localFirstStage === "explainer" ? (
            <VaultExplainerScreens
              onComplete={() => setVaultDialogOpen(true)}
            />
          ) : (
            <BufferHandoffScreen />
          )
        ) : hubStateLoading ? (
          <SetupHubLoadingState />
        ) : (
          <>
            {total > 0 ? (
              <div
                className={styles.segmentedProgress}
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={total}
                aria-valuenow={done}
                aria-label={`${done} of ${total} set up`}
              >
                {Array.from({ length: total }).map((_, index) => (
                  <span
                    key={index}
                    data-filled={index < done ? "true" : undefined}
                  />
                ))}
              </div>
            ) : null}
            <div className={styles.flatChecklist}>
              <SettingsGroup
                title="Remaining"
                testId="one-setup-capabilities-remaining"
                separatorInset
              >
                {!cloudComplete ? (
                  <SetupNavigationTile
                    id="cloud"
                    title="Your cloud"
                    description="Run your private agent in your own Google Cloud project. Your compute, your bill."
                    href={ROUTES.ONE_SETUP_CLOUD}
                    voiceControlId="one_setup_tile_cloud"
                    icon={lucideCapabilityIcon(Cloud)}
                    tone="connected"
                    statusLabel="Required"
                  />
                ) : null}
                {!runtimeChoiceComplete ? (
                  <SetupNavigationTile
                    id="connections"
                    title="Choose your AI"
                    description={
                      cloudComplete
                        ? "Use ours, or bring your own."
                        : "Connect your cloud first, then choose."
                    }
                    href={ROUTES.ONE_SETUP_CONNECTIONS}
                    voiceControlId="one_setup_tile_connections"
                    icon={lucideCapabilityIcon(PlugZap)}
                    tone="connected"
                    statusLabel={cloudComplete ? "Required" : "After your cloud"}
                    // The one row that blocks the exit. A muted grey "Required"
                    // reads like every other trailing label, so it gets the
                    // accent pill and the current-step role — but only once the
                    // cloud step ahead of it is done; before that the cloud row
                    // is the current step, not this one.
                    statusTone={cloudComplete ? "required" : "muted"}
                    isCurrent={cloudComplete}
                  />
                ) : null}
                {remainingItems.map((item) => (
                  <CapabilitySetupTile
                    key={item.id}
                    capabilityId={item.id}
                    title={item.copy.setupTitle}
                    description={item.copy.setupBlurb}
                    actionLabel={item.copy.actionLabel}
                    resumeActionLabel={item.copy.resumeActionLabel}
                    href={item.copy.href}
                    voiceControlId={item.voiceControlId}
                    icon={item.icon}
                    tone={item.tone}
                    status={item.status}
                    isExploreOnly={item.isExploreOnly}
                    isCurrent={item.isCurrent}
                  />
                ))}
              </SettingsGroup>
              {completeItems.length > 0 || runtimeChoiceComplete || cloudComplete ? (
                <SettingsGroup
                  title="Complete"
                  testId="one-setup-capabilities-complete"
                  separatorInset
                >
                  {cloudComplete ? (
                    <SetupNavigationTile
                      id="cloud"
                      title="Your cloud"
                      description="Your private agent runs in your own Google Cloud project."
                      href={ROUTES.ONE_SETUP_CLOUD}
                      voiceControlId="one_setup_tile_cloud"
                      icon={lucideCapabilityIcon(Cloud)}
                      tone="connected"
                      statusLabel="Connected"
                      isComplete
                    />
                  ) : null}
                  {runtimeChoiceComplete ? (
                    <SetupNavigationTile
                      id="connections"
                      title="Choose your AI"
                      description="Change this any time."
                      href={ROUTES.ONE_SETUP_CONNECTIONS}
                      voiceControlId="one_setup_tile_connections"
                      icon={lucideCapabilityIcon(PlugZap)}
                      tone="connected"
                      statusLabel="Selected"
                      isComplete
                    />
                  ) : null}
                  {completeItems.map((item) => (
                    <CapabilitySetupTile
                      key={item.id}
                      capabilityId={item.id}
                      title={item.copy.setupTitle}
                      description={item.copy.setupBlurb}
                      actionLabel={item.copy.actionLabel}
                      resumeActionLabel={item.copy.resumeActionLabel}
                      href={item.copy.href}
                      voiceControlId={item.voiceControlId}
                      icon={item.icon}
                      tone={item.tone}
                      status={item.status}
                      isExploreOnly={item.isExploreOnly}
                      isCurrent={false}
                    />
                  ))}
                </SettingsGroup>
              ) : null}
            </div>
            {/* Desktop keeps the calm in-flow terminal action; mobile uses the
            top-right header action instead (the fixed agent bar would cover a
            bottom footer on phones). */}
            <div className="hidden sm:block">
              <SetupCompletionFooter
                label={masterActionLabel}
                onComplete={() => void handleMasterAck()}
                busy={dismissing}
                disabled={!setupPrerequisitesComplete}
                controlId="one-setup-master-ack"
                actionId="setup.hub_master_ack"
                testId="one-setup-master-ack"
                purpose={
                  "Finish setup and protect what you save."
                }
                supportingText={
                  !cloudComplete
                    ? "Connect your cloud first."
                    : !runtimeChoiceComplete
                      ? "Choose your AI first."
                      : "Set up the rest later."
                }
                variant="blue-gradient"
                effect="fill"
              />
            </div>
          </>
        )}
        {finalizationError ? (
          <div
            role="alert"
            className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-[var(--app-card-radius-compact)] border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
          >
            <span>{finalizationError}</span>
            <Button
              type="button"
              variant="none"
              effect="fade"
              onClick={() => void handleMasterAck()}
            >
              Try again
            </Button>
          </div>
        ) : null}
      </AppPageContentRegion>
      {user ? (
        <VaultUnlockDialog
          user={user}
          open={vaultDialogOpen}
          onOpenChange={setVaultDialogOpen}
          dismissible={false}
          enableGeneratedDefault
          title="Set a lock"
          description="Only you can open what you save. Not even we can read it."
          onSuccess={() => undefined}
        />
      ) : null}
    </AppPageShell>
  );
}

function SetupHubLoadingState() {
  return (
    <div
      data-testid="one-setup-loading-state"
      className="rounded-[var(--app-card-radius-compact)] border border-border/55 bg-[color:var(--app-card-surface-compact)] px-4 py-5 text-sm text-muted-foreground"
      aria-busy="true"
      aria-label="Checking setup progress"
    >
      Checking your setup…
    </div>
  );
}

interface SetupItem {
  id: string;
  copy: CapabilitySetupCopy;
  status: CapabilityStatus;
  icon: OneCapabilityIcon;
  tone: OneCapabilityTone;
  voiceControlId: string;
  isActionable: boolean;
  isExploreOnly: boolean;
  isCurrent: boolean;
}

function buildSetupItems(byId: Record<string, CapabilityStatus>): SetupItem[] {
  // Preserve product order inside each state section. A completed item moves
  // once from Remaining to Complete, then remains stable there; this keeps the
  // visual list and the published voice-action order correlated.
  const enriched = CAPABILITY_SETUP_COPY.flatMap((copy) => {
    const capability = getOneSetupCapability(copy.id);
    if (!capability) return [];
    const status: CapabilityStatus = byId[copy.id] ?? {
      id: copy.id,
      state: "unknown",
      pendingCount: 0,
      prerequisite: null,
      requiresUnlock: false,
    };
    return [
      {
        id: copy.id,
        copy,
        status,
        icon: capability.icon,
        tone: capability.tone,
        voiceControlId: capability.setupControlId,
        isActionable: getCapabilityStatusDisplay(status, {
          actionLabel: copy.actionLabel,
          resumeActionLabel: copy.resumeActionLabel,
        }).isActionable,
        isExploreOnly: capability.isExploreOnly === true,
      },
    ];
  });

  const firstActionableId =
    enriched.find((item) => item.isActionable)?.id ?? null;

  return enriched.map((item) => ({
    ...item,
    isCurrent: item.id === firstActionableId,
  }));
}
