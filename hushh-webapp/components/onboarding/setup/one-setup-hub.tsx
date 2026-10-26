"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Cloud } from "@/components/icons";
import { toast } from "sonner";

import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { MarketingPreferencePanel } from "@/components/account/marketing-preference-panel";
import { useMarketingPreference } from "@/components/account/use-marketing-preference";
import { PwmResearchDisclosure } from "@/components/onboarding/setup/pwm-research-disclosure";
import {
  CapabilitySetupTile,
  SetupNavigationTile,
} from "@/components/onboarding/setup/capability-setup-tile";
import {
  BufferHandoffScreen,
  GuidedConnectionScreen,
  VaultExplainerScreens,
} from "@/components/onboarding/setup/local-first-vault-sequence";
import { CacheService, CACHE_KEYS } from "@/lib/services/cache-service";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { AccountIdentityService } from "@/lib/services/account-identity-service";
import { useInitialContacts } from "@/components/onboarding/initial-contacts-bridge";
import { InitialContactsOnboardingService as InitialContacts } from "@/lib/services/initial-contacts-onboarding-service";
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
  buildOneSetupCloudRoute,
  buildOneSetupFinanceImportRoute,
  buildPhoneMandateRoute,
  buildInitialContactsWelcomeRoute,
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
import { usePublishVoiceSurfaceMetadata } from "@/lib/kai/actions/voice-surface-metadata";
import { useLocalOnboardingActionHandler } from "@/lib/agent/local-onboarding-actions";
import { useOneConversationSession } from "@/lib/agent/one-conversation-session";
import { useCapabilitySetupStates } from "@/lib/onboarding/use-capability-setup-states";
import { groupSetupCapabilities } from "@/lib/onboarding/setup-capability-order";
import {
  isCapabilitySetupComplete,
  type CapabilityStatus,
} from "@/lib/services/capability-setup-state-service";
import { getCapabilityStatusDisplay } from "@/lib/onboarding/capability-status-display";
import { isLocalFirstOnboardingEnabled } from "@/lib/onboarding/local-first-flags";
import { migrateOnboardingBuffer } from "@/lib/services/onboarding-buffer-migration-service";
import { OneAgentPresence } from "@/components/dashboard/one-agent-presence";
import { PublicProfileDiscoveryCard } from "@/components/profile/public-profile-discovery-card";
import { ApiService } from "@/lib/services/api-service";
import { PreVaultUserStateService } from "@/lib/services/pre-vault-user-state-service";
import { immediateRuntimeChoiceReadiness, hasReadyRuntimeChoice, hasStoredAiKey } from "@/lib/one/setup-runtime-readiness";
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
  const { user, userId: ownerId } = useAuth();
  const emailPreference = useMarketingPreference(ownerId ?? null, "setup");
  const initialContacts = useInitialContacts();
  const queueEntryWelcome = useOneConversationSession((state) => state.queueEntryWelcome);
  const { vaultKey, vaultOwnerToken, isVaultUnlocked } = useVault();
  const { byId, isLoading, isEnriching } = useCapabilitySetupStates({
    enrichVault: true,
    enrichOauth: true,
    enrichRia: true,
  });
  const [dismissing, setDismissing] = useState(false);
  const [finalizationError, setFinalizationError] = useState<string | null>(
    null,
  );
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
  const prereqMatchesUser = prereqSnapshot.userId === (ownerId ?? null);
  const cloudState = prereqMatchesUser ? prereqSnapshot.cloud : "loading";
  const runtimeChoiceState = prereqMatchesUser
    ? prereqSnapshot.runtime
    : "loading";
  // The third root prerequisite. The agent's record (its HusshID) is minted from
  // a VERIFIED phone, so without one no pod can exist: a person could finish the
  // wizard with a cloud and an AI and still have no agent (founder-hit,
  // 2026-09-02). It is read from the identity shadow, not from a client claim.
  const [phoneState, setPhoneState] = useState<{
    userId: string | null;
    phone: "loading" | "required" | "complete";
  }>({ userId: null, phone: "loading" });
  const phoneVerified =
    phoneState.userId === (ownerId ?? null) &&
    phoneState.phone === "complete";
  const resolvePhoneVerification = useCallback(async (): Promise<boolean> => {
    if (!ownerId) throw new Error("Account identity is unavailable.");
    // Reset preserves identity. Use the shared bootstrap's verified claim after
    // local cleanup; an empty best-effort refresh must not downgrade that proof.
    const cached = AccountIdentityService.peekCachedIdentity(ownerId);
    if (cached && !cached.isStale && typeof cached.data.phone_verified === "boolean") {
      return AccountIdentityService.hasVerifiedPhone(cached.data);
    }
    // A stale identity must be revalidated; an older bootstrap hint cannot
    // override a phone transfer or revocation recorded by the identity owner.
    if (!cached) {
      const bootstrap = await PreVaultUserStateService.bootstrapState(ownerId).catch(() => null);
      if (bootstrap?.phoneVerified === true) return true;
    }
    const identity = await AccountIdentityService.refreshCurrentUserIdentity(user, {
      force: true,
      requireSuccess: true,
    });
    if (!identity || typeof identity.phone_verified !== "boolean") {
      throw new Error("Unable to check phone verification. Please try again.");
    }
    return AccountIdentityService.hasVerifiedPhone(identity);
  }, [user, ownerId]);
  useEffect(() => {
    if (!ownerId) {
      setPhoneState({ userId: null, phone: "required" });
      return;
    }
    let active = true;
    setPhoneState({ userId: ownerId, phone: "loading" });
    void resolvePhoneVerification()
      .then((verified) => {
        if (!active) return;
        setPhoneState({ userId: ownerId, phone: verified ? "complete" : "required" });
      })
      .catch(() => {
        if (active) setFinalizationError("Unable to check phone verification. Please try again.");
      });
    return () => { active = false; };
  }, [ownerId, resolvePhoneVerification]);
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
  const completionTarget = returnTo || ROUTES.HOME;

  useEffect(() => {
    if (!ownerId) {
      setPrereqSnapshot({
        userId: null,
        cloud: "required",
        runtime: "required",
      });
      return;
    }
    let active = true;
    let verification = 0;
    const project = (
      state: Parameters<typeof PreVaultUserStateService.hasOneCloudProject>[0],
      ready = immediateRuntimeChoiceReadiness(ownerId, state, Boolean(vaultKey && vaultOwnerToken)),
    ) => ({
      userId: ownerId,
      cloud: PreVaultUserStateService.hasOneCloudProject(state)
        ? ("complete" as const)
        : ("required" as const),
      runtime: ready === null ? ("loading" as const) : ready
        ? ("complete" as const)
        : ("required" as const),
    });
    const publish = (state: Parameters<typeof project>[0]) => {
      const revision = ++verification;
      const snapshot = project(state);
      setPrereqSnapshot(snapshot);
      if (snapshot.runtime !== "loading") return;
      void hasReadyRuntimeChoice({ userId: ownerId, state, vaultKey, vaultOwnerToken })
        .then(ready => {
          if (active && revision === verification) setPrereqSnapshot(project(state, ready));
        });
    };
    const unsubscribe = CacheService.getInstance().subscribe((event) => {
      if (!active || event.type !== "set" || event.key !== CACHE_KEYS.PRE_VAULT_BOOTSTRAP(ownerId)) return;
      const saved = PreVaultUserStateService.getCachedBootstrapState(ownerId);
      if (saved) publish(saved);
    });
    const cleanup = () => {
      active = false;
      unsubscribe();
    };
    const cached = PreVaultUserStateService.getCachedBootstrapState(ownerId);
    if (cached) {
      publish(cached);
      // Stale-while-revalidate: the cached record can predate a prerequisite
      // completed on another surface. The founder-hit case (2026-08-21): the
      // one-click BYOC flow finished and this checklist kept demanding an
      // agent-home choice from a cache written before the save.
      // Render the cache instantly, confirm it in the background, and update
      // only when the truth differs.
      void PreVaultUserStateService.bootstrapState(ownerId, { force: true })
        .then((state) => {
          if (active) publish(state);
        })
        .catch(() => undefined);
      return cleanup;
    }
    setPrereqSnapshot({
      userId: ownerId,
      cloud: "loading",
      runtime: "loading",
    });
    void PreVaultUserStateService.bootstrapState(ownerId)
      .then((state) => {
        if (!active) return;
        publish(state);
      })
      .catch(() => {
        if (active) {
          setPrereqSnapshot({
            userId: ownerId,
            cloud: "required",
            runtime: "required",
          });
        }
      });
    return cleanup;
  }, [isVaultUnlocked, ownerId, vaultKey, vaultOwnerToken]);

  // The cloud setup runs as a background job; while it does, the row says so
  // ("step N of 6") instead of "Required", and the person keeps onboarding.
  // Slow poll: the cloud page owns the live checklist, this row only needs the
  // headline. When the job records, the marker flips and stale-while-revalidate
  // above turns the row Connected.
  const [cloudSetupJob, setCloudSetupJob] = useState<{
    stage: string;
    stagesReached: number;
  } | null>(null);
  const cloudComplete_forJob =
    prereqMatchesUser && prereqSnapshot.cloud === "complete";
  useEffect(() => {
    if (!ownerId || cloudComplete_forJob) {
      setCloudSetupJob(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const status = await ApiService.getByocSetupStatus();
        if (cancelled) return;
        if (status.status === "running" && !status.stale) {
          setCloudSetupJob({
            stage: status.stage,
            stagesReached: status.stages.length,
          });
          timer = setTimeout(() => void poll(), 10_000);
          return;
        }
        setCloudSetupJob(null);
        if (status.status === "recorded") {
          void PreVaultUserStateService.bootstrapState(ownerId, {
            force: true,
          })
            .then(async (state) => {
              const ready = await hasReadyRuntimeChoice({ userId: ownerId, state, vaultKey, vaultOwnerToken });
              if (!cancelled) {
                setPrereqSnapshot({
                  userId: ownerId,
                  cloud: PreVaultUserStateService.hasOneCloudProject(state)
                    ? "complete"
                    : "required",
                  runtime: ready
                    ? "complete"
                    : "required",
                });
              }
            })
            .catch(() => undefined);
        }
      } catch {
        if (!cancelled) setCloudSetupJob(null);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [ownerId, cloudComplete_forJob, vaultKey, vaultOwnerToken]);
  const cloudSetupRunning = cloudSetupJob !== null;
  const cloudSetupStageLabel = cloudSetupJob
    ? `Setting up (step ${Math.min(Math.max(cloudSetupJob.stagesReached, 1), 6)} of 6)`
    : "Required";

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
  const setupPrerequisitesComplete =
    cloudComplete && phoneVerified && runtimeChoiceComplete;
  // Hosting and AI access remain separate durable prerequisites, presented
  // together by the existing agent setup wizard.

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

  const shouldShowContactsWelcome = useCallback(() => {
    if (!ownerId) return false;
    const bootstrap = PreVaultUserStateService.getCachedBootstrapState(ownerId);
    return bootstrap?.initialContactsWelcomeAcknowledged === false ||
      InitialContacts.getSnapshot().ownerId === ownerId;
  }, [ownerId]);

  const resolveFinalizedSetupTarget = useCallback(() => {
    const target = ownerId && PreVaultSensitiveDraftService.hasFinanceIntent(ownerId)
      ? buildOneSetupFinanceImportRoute(returnTo)
      : completionTarget;
    return shouldShowContactsWelcome() ? buildInitialContactsWelcomeRoute(target) : target;
  }, [completionTarget, returnTo, shouldShowContactsWelcome, ownerId]);

  const completeSetupAfterVault = useCallback(async (): Promise<void> => {
    if (!ownerId) {
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
        userId: ownerId,
        vaultKey,
        vaultOwnerToken,
      });
      const bootstrap = PreVaultUserStateService.getCachedBootstrapState(ownerId)
        ?? await PreVaultUserStateService.bootstrapState(ownerId, { force: true });
      if (bootstrap.oneRuntimeSetupChoice === "byok_pending_vault" &&
          !(await hasStoredAiKey(ownerId, vaultKey, vaultOwnerToken))) {
        throw new Error("Your selected AI key was not saved. Choose your AI again.");
      }
      await PostUnlockSyncService.run({
        userId: ownerId,
        vaultKey,
        vaultOwnerToken,
      });
      await FinanceSetupDraftService.finalizeForVault({
        userId: ownerId,
        vaultKey,
        vaultOwnerToken,
      });
      notifyGeminiRuntimeConfigurationChanged(ownerId);

      const completion = acknowledgeOneSetupExit({
        userId: ownerId,
        skipped: false,
        isVaultUnlocked: true,
        vaultKey,
        vaultOwnerToken,
      });
      // Queue only a typed, owner-scoped marker after the encrypted setup
      // boundary. The Chat surface derives its summary from the unlocked
      // in-memory context and consumes this marker once; no private values
      // enter the route or conversation history.
      if (!shouldShowContactsWelcome()) queueEntryWelcome(ownerId);
      await completion;
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
      router.replace(resolveFinalizedSetupTarget());
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
    queueEntryWelcome,
    resolveFinalizedSetupTarget,
    shouldShowContactsWelcome,
    localFirstEnabled,
    router,
    ownerId,
    vaultKey,
    vaultOwnerToken,
  ]);

  useEffect(() => {
    if (
      !vaultInvitationOpen ||
      !isVaultUnlocked ||
      !vaultKey ||
      !vaultOwnerToken ||
      !ownerId ||
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
    ownerId,
  ]);

  // Final drain, after the vault exists. Idempotent: anything already
  // acknowledged is skipped, anything still buffered is retried on the next
  // signed-in pass. A stalled vault key must not strand the person on this
  // screen, so the watchdog routes home regardless.
  useEffect(() => {
    if (!localFirstEnabled || localFirstStage !== "draining") return;

    let active = true;
    const watchdog = setTimeout(() => {
      if (active) router.replace(resolveFinalizedSetupTarget());
    }, 8000);

    if (!ownerId || !vaultKey || !vaultOwnerToken) {
      // Wait for the render that carries the freshly unlocked key.
      return () => {
        active = false;
        clearTimeout(watchdog);
      };
    }

    void migrateOnboardingBuffer({
      userId: ownerId,
      vaultKey,
      vaultOwnerToken,
    })
      .catch((error) => {
        console.warn(
          "[OneSetupHub] Could not finish moving buffered details into the private agent:",
          error instanceof Error ? error.name : "UnknownError",
        );
      })
      .finally(() => {
        if (active) router.replace(resolveFinalizedSetupTarget());
      });

    return () => {
      active = false;
      clearTimeout(watchdog);
    };
  }, [
    resolveFinalizedSetupTarget,
    localFirstEnabled,
    localFirstStage,
    router,
    ownerId,
    vaultKey,
    vaultOwnerToken,
  ]);

  // The pre-vault pass. It writes nothing (there is no vault key yet) and
  // reports what is still waiting — but it runs BEFORE any vault surface opens,
  // so the vault is genuinely the last thing the person is asked for.
  const runGuidedConnection = async () => {
    setLocalFirstStage("migrating");
    if (ownerId) {
      await migrateOnboardingBuffer({
        userId: ownerId,
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
    if (!ownerId) {
      router.replace(completionTarget);
      return { status: "started" as const, summary: "Opening home." };
    }
    setDismissing(true);
    try {
      // Root-setup prerequisites remain mandatory before leaving the hub.
      // Only re-verify against
      // fresh server state when the client is unsure — and even then a failed probe
      // must not trap the person, so fall back to the resolved client gate rather
      // than stranding them.
      let cloudConfirmed = cloudComplete;
      const cachedRuntimeState = PreVaultUserStateService.getCachedBootstrapState(ownerId);
      let runtimeChoiceConfirmed = cachedRuntimeState
        ? await hasReadyRuntimeChoice({ userId: ownerId, state: cachedRuntimeState, vaultKey, vaultOwnerToken })
        : runtimeChoiceComplete;
      let phoneConfirmed = phoneVerified;
      if (!phoneConfirmed) {
        phoneConfirmed = await resolvePhoneVerification();
        setFinalizationError(null);
        setPhoneState({
          userId: ownerId,
          phone: phoneConfirmed ? "complete" : "required",
        });
      }
      if (!cloudConfirmed || !runtimeChoiceConfirmed) {
        try {
          const currentState = await PreVaultUserStateService.bootstrapState(
            ownerId,
            { force: true },
          );
          cloudConfirmed =
            PreVaultUserStateService.hasOneCloudProject(currentState);
          runtimeChoiceConfirmed = await hasReadyRuntimeChoice({
            userId: ownerId, state: currentState, vaultKey, vaultOwnerToken,
          });
          setPrereqSnapshot({
            userId: ownerId,
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
      // Distinct messages per missing step, deliberately. "Choose an agent home" and
      // "Choose AI access" are different next actions, and one string covering both
      // is how a gate stops telling a person what to do and becomes noise.
      if (!cloudConfirmed) {
        toast.info("Choose where your agent lives.", {
          action: {
            label: "Choose",
            onClick: () => router.push(buildOneSetupCloudRoute(returnTo)),
          },
        });
        return {
          status: "blocked" as const,
          summary: "Choose where your agent lives before continuing.",
        };
      }
      if (!phoneConfirmed) {
        toast.info("Verify your phone first.", {
          action: {
            label: "Verify",
            onClick: () =>
              router.push(buildPhoneMandateRoute(ROUTES.ONE_SETUP)),
          },
        });
        return {
          status: "blocked" as const,
          summary: "Verify your phone first.",
        };
      }
      if (!runtimeChoiceConfirmed) {
        // The action stays tappable precisely so this can fire. A permanent
        // line under the button was the only thing naming the blocker before,
        // and it sat there unread until someone had already tapped and got
        // nothing back; the phone action had a `title` tooltip, which a touch
        // device never shows at all. A toast answers the tap that asked, and
        // carries the way out with it.
        //
        // One block, no description: the toast ceiling is two lines.
        toast.info("Finish your agent setup.", {
          action: {
            label: "Choose",
            onClick: () => router.push(buildOneSetupCloudRoute(returnTo)),
          },
        });
        return {
          status: "blocked" as const,
          summary: "Finish your agent setup.",
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
        summary: "Setup complete. Continuing.",
        routeAfter: resolveFinalizedSetupTarget(),
      };
    } catch {
      if (!phoneVerified) setFinalizationError("Unable to check phone verification. Please try again.");
      // The finalizer retains its visible failure state. Return a terminal
      // action result so button and voice callers do not leak a rejected promise.
      return {
        status: "failed" as const,
        summary: "Could not save your setup. Try again.",
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

  // Name the first mandatory prerequisite in the shared header.
  const summary = hubStateLoading
    ? "One moment…"
    : setupPrerequisitesComplete
      ? "Add more any time."
      : !cloudComplete
        ? "Choose where your agent lives first."
        : !runtimeChoiceComplete
          ? "Finish your agent setup."
          : "Finish setting up One.";
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
      fitContent
      className={`relative isolate max-w-[600px] ${styles.hubPage}`}
      nativeTest={{
        routeId: "/one/setup",
        marker: "native-route-one-setup",
        authState: "authenticated",
        dataState: hubStateLoading ? "loading" : "loaded",
      }}
    >
      {/* Suppressed during the local-first story takeover: that centered screen
          owns the one title, so the hub must not render a second one above it
          (Restraint Charter: one title per screen). The master Skip/Finish
          action now lives solely in the in-flow footer below, shown on every
          viewport, so the header carries only the title -- the old top-right
          mobile action was retired (its terminal-action contract asserts it is
          gone). */}
      {!storyTakeoverActive ? (
        <AppPageHeaderRegion>
          <PageHeader
            title={
              !hubStateLoading && setupPrerequisitesComplete ? "You're all set" : "Set up One"
            }
            description={summary}
            accent="neutral"
            className={styles.setupHeader}
          />
        </AppPageHeaderRegion>
      ) : null}

      <AppPageContentRegion className={styles.setupContent}>
        {localFirstSequenceActive ? (
          localFirstStage === "guided_connection" ||
          localFirstStage === "migrating" ? (
            <GuidedConnectionScreen
              agentReady={
                ownerId ? isPersonalAgentReadyFromCachedFeed(ownerId) : false
              }
              busy={localFirstStage === "migrating"}
              onContinue={() => void runGuidedConnection()}
            />
          ) : localFirstStage === "explainer" ? (
            <VaultExplainerScreens
              // Arm the completion effect the same way the flag-off path does at
              // handleMasterAck: it is gated on vaultInvitationOpen, so without this
              // the local-first (flag-on) user sets their lock and is stranded on the
              // explainer -- the buffer never drains and the hub never routes home.
              onComplete={() => {
                setVaultInvitationOpen(true);
                setVaultDialogOpen(true);
              }}
            />
          ) : (
            <BufferHandoffScreen />
          )
        ) : hubStateLoading ? (
          <SetupHubLoadingState />
        ) : (
          <>
            {phoneVerified ? <PublicProfileDiscoveryCard userId={ownerId} onboarding /> : null}
            <div className={styles.flatChecklist}>
              {/* The hosting choice comes first and stays first. It determines
                  whether the agent uses Shared or a pod. AI access is completed
                  inside that wizard, before the capability choices. */}
              <SettingsGroup
                title="Start here"
                testId="one-setup-foundation"
                separatorInset
              >
                <SetupNavigationTile
                  id="cloud"
                  title={
                    cloudComplete && runtimeChoiceComplete
                      ? "Agent home" : "Set up your private agent"
                  }
                  description={
                    cloudComplete
                      ? runtimeChoiceComplete
                        ? "Your hosting and AI choices are saved."
                        : "Finish choosing AI access in your agent setup."
                      : cloudSetupRunning
                        ? "Being set up in the background. Keep going; this finishes on its own."
                        : "Choose Hussh Shared, your own cloud, or Hussh Pods when available."
                  }
                  href={buildOneSetupCloudRoute(returnTo)}
                  voiceControlId="one_setup_tile_cloud"
                  icon={lucideCapabilityIcon(Cloud)}
                  tone="connected"
                  statusLabel={
                    cloudComplete
                      ? runtimeChoiceComplete ? "Connected" : "Continue"
                      : cloudSetupRunning
                        ? cloudSetupStageLabel
                        : "Required"
                  }
                  statusTone={cloudComplete && runtimeChoiceComplete ? undefined : "required"}
                  isCurrent={!cloudComplete || !runtimeChoiceComplete}
                  isComplete={cloudComplete && runtimeChoiceComplete}
                />
                <SetupNavigationTile
                  id="phone"
                  title="Verify your phone"
                  description={
                    phoneVerified
                      ? "Verified. Your agent's record is minted from this number."
                      : cloudComplete
                        ? "Your agent's record is minted from your verified number."
                        : "After choosing where your agent lives."
                  }
                  href={buildPhoneMandateRoute(ROUTES.ONE_SETUP)}
                  voiceControlId="one_setup_tile_phone"
                  icon={lucideCapabilityIcon(Cloud)}
                  tone="connected"
                  statusLabel={
                    phoneVerified
                      ? "Verified"
                      : cloudComplete
                        ? "Required"
                        : "After agent home"
                  }
                  statusTone={
                    phoneVerified
                      ? undefined
                      : cloudComplete
                        ? "required"
                        : "muted"
                  }
                  isCurrent={cloudComplete && !phoneVerified}
                  isComplete={phoneVerified}
                />
                {/* The agent's live build status, IN the journey where it
                    started. The honest presence surface existed only on the
                    home screen, so the person who just pressed "Use Hussh's
                    AI" had to leave setup to learn whether anything was
                    happening (audit finding, 2026-08-21). It renders nothing
                    until there is an agent state to report. */}
                {runtimeChoiceComplete ? <OneAgentPresence /> : null}
              </SettingsGroup>
              {initialContacts.ownerId === ownerId ? (
                <SettingsGroup separatorInset>
                  <SettingsRow title={initialContacts.source === "device" ? "Find people from your phone" : "Find people with Google Contacts"}
                    description={initialContacts.status === "ready"
                      ? `${initialContacts.result?.autoConnectedCount ?? 0} new connections. Your shared circle will be ready after setup.`
                      : "Optional. Match people you know and organize a shared Contacts circle."}
                    trailing={initialContacts.status === "ready" ? "Checked" : ["reading", "matching"].includes(initialContacts.status) ? "Checking…" : "Find people"}
                    disabled={["reading", "matching", "ready"].includes(initialContacts.status)}
                    onClick={() => InitialContacts.startSource()} />
                </SettingsGroup>
              ) : null}
              {cloudComplete && remainingItems.length > 0 ? (
                <SettingsGroup
                  title="Remaining"
                  testId="one-setup-capabilities-remaining"
                  separatorInset
                >
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
              ) : null}
              {cloudComplete && completeItems.length > 0 ? (
                <SettingsGroup
                  title="Complete"
                  testId="one-setup-capabilities-complete"
                  separatorInset
                >
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
            <div className="mt-6 space-y-4">
              <PwmResearchDisclosure className="mb-4" />
              <MarketingPreferencePanel model={emailPreference} />
            </div>
            <div className={`mx-auto w-full sm:w-80 ${styles.hubFooter}`}>
              <Button
                type="button"
                variant="blue"
                effect="fill"
                size="prominent"
                fullWidth
                disabled={!setupPrerequisitesComplete}
                loading={dismissing}
                onClick={() => void handleMasterAck()}
                data-testid="one-setup-master-ack"
                data-voice-control-id="one-setup-master-ack"
                data-voice-action-id="setup.hub_master_ack"
                data-voice-label={masterActionLabel}
                data-voice-purpose="Finish setup and protect what you save."
              >
                {masterActionLabel}
              </Button>
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
