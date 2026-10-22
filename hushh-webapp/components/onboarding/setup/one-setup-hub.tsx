"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";

import { NativeTestBeacon } from "@/components/app-ui/native-test-beacon";
import { MarketingPreferencePanel } from "@/components/account/marketing-preference-panel";
import { useMarketingPreference } from "@/components/account/use-marketing-preference";
import { PwmResearchDisclosure } from "@/components/onboarding/setup/pwm-research-disclosure";
import { SetupV10Icon, SetupV10Surface } from "@/components/onboarding/setup/setup-v10-surface";
import { useInitialContacts } from "@/components/onboarding/initial-contacts-bridge";
import { InitialContactsOnboardingService as InitialContacts } from "@/lib/services/initial-contacts-onboarding-service";
import { VaultUnlockDialog } from "@/components/vault/vault-unlock-dialog";
import styles from "./one-setup-hub.module.css";
import { useAuth } from "@/lib/firebase/auth-context";
import { useVault } from "@/lib/vault/vault-context";
import {
  isOneSetupSurfaceRoute,
  buildOneSetupConnectionsRoute,
  resolveOneSetupCompletionTarget,
  normalizeInternalRouteHref,
  ROUTES,
  buildInitialContactsWelcomeRoute,
} from "@/lib/navigation/routes";
import { acknowledgeOneSetupExit } from "@/lib/services/one-setup-exit-service";
import { usePublishVoiceSurfaceMetadata } from "@/lib/kai/actions/voice-surface-metadata";
import { useLocalOnboardingActionHandler } from "@/lib/agent/local-onboarding-actions";
import { CacheService, CACHE_KEYS } from "@/lib/services/cache-service";
import {
  PreVaultUserStateService,
  type OneRuntimeSetupChoice,
  type PreVaultUserState,
} from "@/lib/services/pre-vault-user-state-service";
import { PreVaultSensitiveDraftService } from "@/lib/services/pre-vault-sensitive-draft-service";
import {
  GEMINI_RUNTIME_CREDENTIAL_REF,
  PersonalKnowledgeModelService,
} from "@/lib/services/personal-knowledge-model-service";
import { FinanceSetupDraftService } from "@/lib/services/finance-setup-draft-service";
import { PostUnlockSyncService } from "@/lib/services/post-unlock-sync-service";
import { notifyGeminiRuntimeConfigurationChanged } from "@/lib/connections/gemini-runtime-configuration";
import { useOneConversationSession } from "@/lib/agent/one-conversation-session";

function immediateRuntimeChoiceReadiness(
  userId: string,
  state: PreVaultUserState | null | undefined,
  canReadVault: boolean,
): boolean | null {
  if (!PreVaultUserStateService.hasOneRuntimeChoice(state)) return false;
  // The BYOK marker is durable, but its credential is deliberately only in
  // process memory until vault finalization. A reload can leave the marker
  // behind without a key. An unlocked vault may also hold a saved key.
  if (state?.oneRuntimeSetupChoice !== "byok_pending_vault") return true;
  if (PreVaultSensitiveDraftService.hasGeminiRuntime(userId)) return true;
  return canReadVault ? null : false;
}

async function hasReadyRuntimeChoice(params: {
  userId: string;
  state: PreVaultUserState | null | undefined;
  vaultKey: string | null;
  vaultOwnerToken: string | null;
}): Promise<boolean> {
  const immediate = immediateRuntimeChoiceReadiness(
    params.userId,
    params.state,
    Boolean(params.vaultKey && params.vaultOwnerToken),
  );
  if (immediate !== null) return immediate;
  return hasStoredGeminiKey(params.userId, params.vaultKey, params.vaultOwnerToken);
}

async function hasStoredGeminiKey(
  userId: string,
  vaultKey: string | null,
  vaultOwnerToken: string | null,
): Promise<boolean> {
  if (!vaultKey || !vaultOwnerToken) return false;
  try {
    const credential = await PersonalKnowledgeModelService.loadRuntimeSecret({
      userId,
      vaultKey,
      vaultOwnerToken,
      credentialRef: GEMINI_RUNTIME_CREDENTIAL_REF,
    });
    return Boolean(credential);
  } catch {
    return false;
  }
}

/**
 * OneSetupHub: the `/one/setup` hub screen.
 *
 * The only mandatory step is choosing an AI (managed vs. bring-your-own) and
 * setting a vault lock. Capability setup (Gmail, Calendar, Location, etc.) is
 * no longer listed here — each capability's own connect/setup screen shows up
 * the first time someone actually reaches for it, from its real page or from
 * chat. That keeps this hub a single screen instead of an upfront checklist.
 *
 * The setup surface owns its own full-viewport scroll and visual composition;
 * setup state and completion still use the existing authoritative services.
 */
export function OneSetupHub() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, signOut } = useAuth();
  const emailPreference = useMarketingPreference(user?.uid ?? null, "setup");
  const initialContacts = useInitialContacts();
  const { vaultKey, vaultOwnerToken, isVaultUnlocked } = useVault();
  const queueEntryWelcome = useOneConversationSession(
    (state) => state.queueEntryWelcome,
  );
  const [dismissing, setDismissing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [finalizationError, setFinalizationError] = useState<string | null>(
    null,
  );
  const [vaultInvitationOpen, setVaultInvitationOpen] = useState(false);
  const [vaultDialogOpen, setVaultDialogOpen] = useState(false);
  const finalizationInFlightRef = useRef<Promise<string> | null>(null);
  const [runtimeChoiceSnapshot, setRuntimeChoiceSnapshot] = useState<{
    userId: string | null;
    state: "loading" | "required" | "complete";
    choice: OneRuntimeSetupChoice | null;
  }>({ userId: null, state: "loading", choice: null });
  const runtimeChoiceState =
    runtimeChoiceSnapshot.userId === (user?.uid ?? null)
      ? runtimeChoiceSnapshot.state
      : "loading";
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
    if (!user?.uid) {
      setRuntimeChoiceSnapshot({ userId: null, state: "required", choice: null });
      return;
    }
    let active = true;
    let verification = 0;
    const applySavedChoice = (saved: PreVaultUserState) => {
      const current = ++verification;
      const immediate = immediateRuntimeChoiceReadiness(
        user.uid,
        saved,
        Boolean(isVaultUnlocked && vaultKey && vaultOwnerToken),
      );
      const choice = saved.oneRuntimeSetupChoice;
      if (immediate !== null) {
        setRuntimeChoiceSnapshot({
          userId: user.uid,
          state: immediate ? "complete" : "required",
          choice,
        });
        return;
      }
      setRuntimeChoiceSnapshot({ userId: user.uid, state: "loading", choice });
      void hasReadyRuntimeChoice({
        userId: user.uid,
        state: saved,
        vaultKey,
        vaultOwnerToken,
      }).then((ready) => {
        if (!active || current !== verification) return;
        setRuntimeChoiceSnapshot({
          userId: user.uid,
          state: ready ? "complete" : "required",
          choice,
        });
      });
    };
    const reconcileSavedChoice = () => {
      const saved = PreVaultUserStateService.getCachedBootstrapState(user.uid);
      if (!active || !saved) return;
      applySavedChoice(saved);
    };
    const unsubscribe = CacheService.getInstance().subscribe((event) => {
      if (
        event.type === "set" &&
        event.key === CACHE_KEYS.PRE_VAULT_BOOTSTRAP(user.uid)
      ) {
        reconcileSavedChoice();
      }
    });
    const cleanup = () => {
      active = false;
      verification++;
      unsubscribe();
    };
    const cached = PreVaultUserStateService.getCachedBootstrapState(user.uid);
    if (cached) {
      applySavedChoice(cached);
      return cleanup;
    }
    setRuntimeChoiceSnapshot({ userId: user.uid, state: "loading", choice: null });
    void PreVaultUserStateService.bootstrapState(user.uid)
      .then((state) => {
        if (!active) return;
        applySavedChoice(state);
      })
      .catch(() => {
        if (active) {
          setRuntimeChoiceSnapshot({ userId: user.uid, state: "required", choice: null });
        }
      });
    return cleanup;
  }, [isVaultUnlocked, user?.uid, vaultKey, vaultOwnerToken]);

  const runtimeChoiceComplete = runtimeChoiceState === "complete";
  // Capability setup is optional, but the root vault is not. Finish setup is
  // therefore the only exit from the hub and always leads to vault setup when
  // the vault is not already unlocked.
  const masterActionLabel = "Finish setup";
  const hubStateLoading = runtimeChoiceState === "loading";

  // Publish screen context so the onboarding guide can describe the hub and
  // navigate the person to any capability they ask for.
  usePublishVoiceSurfaceMetadata({
    screenId: "one_setup_hub",
    title: "Set up One",
    purpose:
      "This is your setup home. Choose your AI and set a lock. You can connect Mail, Calendar, and other capabilities any time from their own screens.",
    actions:
      hubStateLoading || dismissing || !runtimeChoiceComplete
        ? []
        : [
            {
              id: "master_ack",
              actionId: "setup.hub_master_ack",
              label: masterActionLabel,
              purpose: "Finish setup and protect what you save.",
            },
          ],
  });

  const completeSetupAfterVault = useCallback(async (): Promise<string> => {
    if (!user?.uid) {
      router.replace(completionTarget);
      return completionTarget;
    }
    if (!vaultKey || !vaultOwnerToken) {
      throw new Error("Not ready yet. Try again.");
    }
    if (finalizationInFlightRef.current) {
      return finalizationInFlightRef.current;
    }
    const target = resolveOneSetupCompletionTarget(
      returnTo,
      PreVaultSensitiveDraftService.hasFinanceIntent(user.uid),
    );

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
      const bootstrap = PreVaultUserStateService.getCachedBootstrapState(user.uid);
      if (
        (bootstrap?.oneRuntimeSetupChoice ?? runtimeChoiceSnapshot.choice) ===
          "byok_pending_vault" &&
        !(await hasStoredGeminiKey(user.uid, vaultKey, vaultOwnerToken))
      ) {
        throw new Error("Your Gemini key was not saved. Choose your AI again.");
      }
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

      const showContactsWelcome =
        bootstrap?.initialContactsWelcomeAcknowledged === false ||
        InitialContacts.getSnapshot().ownerId === user.uid;
      const completion = acknowledgeOneSetupExit({
        userId: user.uid,
        skipped: false,
        isVaultUnlocked: true,
        vaultKey,
        vaultOwnerToken,
      });
      // Queue only a typed, owner-scoped marker after the encrypted setup
      // boundary. The Chat surface derives its summary from the unlocked
      // in-memory context and consumes this marker once. Queue before the
      // completion latch can make the route guard unmount this screen.
      if (!showContactsWelcome) queueEntryWelcome(user.uid);
      await completion;
      setVaultDialogOpen(false);
      setVaultInvitationOpen(false);
      // Finance source intents intentionally remain process-memory-only until
      // this encryption boundary completes. Resume the canonical source flow
      // once, now that it has a valid vault session.
      const next = showContactsWelcome ? buildInitialContactsWelcomeRoute(target) : target;
      router.replace(next);
      return next;
    })();
    finalizationInFlightRef.current = finalize;
    try {
      return await finalize;
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
    returnTo,
    queueEntryWelcome,
    router,
    runtimeChoiceSnapshot.choice,
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
      // Recheck the credential on the action path: a staged key can disappear
      // without a cache event, and a saved vault key can change on this device.
      let runtimeChoiceConfirmed = runtimeChoiceComplete;
      if (runtimeChoiceConfirmed && runtimeChoiceSnapshot.choice === "byok_pending_vault") {
        runtimeChoiceConfirmed = await hasReadyRuntimeChoice({
          userId: user.uid,
          state: PreVaultUserStateService.getCachedBootstrapState(user.uid),
          vaultKey: isVaultUnlocked ? vaultKey : null,
          vaultOwnerToken: isVaultUnlocked ? vaultOwnerToken : null,
        });
      }
      if (!runtimeChoiceConfirmed) {
        try {
          const currentState = await PreVaultUserStateService.bootstrapState(
            user.uid,
            { force: true },
          );
          runtimeChoiceConfirmed = await hasReadyRuntimeChoice({
            userId: user.uid,
            state: currentState,
            vaultKey: isVaultUnlocked ? vaultKey : null,
            vaultOwnerToken: isVaultUnlocked ? vaultOwnerToken : null,
          });
          setRuntimeChoiceSnapshot({
            userId: user.uid,
            state: runtimeChoiceConfirmed ? "complete" : "required",
            choice: currentState.oneRuntimeSetupChoice,
          });
        } catch (error) {
          console.warn(
            "[OneSetupHub] Could not verify the AI access choice:",
            error,
          );
        }
      }
      if (!runtimeChoiceConfirmed) {
        // Keep the prerequisite guard for voice/programmatic entry as well.
        toast.info("Choose your AI first.", {
          action: {
            label: "Choose",
            onClick: () => router.push(buildOneSetupConnectionsRoute(returnTo)),
          },
        });
        return {
          status: "blocked" as const,
          summary: "Choose your AI first.",
        };
      }

      if (!isVaultUnlocked) {
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
      const routeAfter = await completeSetupAfterVault();
      return {
        status: "succeeded" as const,
        summary: "Setup complete.",
        routeAfter,
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

  return (
    <SetupV10Surface
      stage="hub"
      onMenu={() => {
        if (!dismissing) setMenuOpen((open) => !open);
      }}
      menuDisabled={dismissing}
      menuOpen={menuOpen}
      menuContent={
        <button
          type="button"
          onClick={() => {
            if (dismissing) return;
            setMenuOpen(false);
            void signOut({ redirectTo: ROUTES.LOGIN, expectedUserId: user?.uid });
          }}
        >
          Sign out
        </button>
      }
    >
      <NativeTestBeacon
        routeId="/one/setup"
        marker="native-route-one-setup"
        authState="authenticated"
        dataState={hubStateLoading ? "loading" : "loaded"}
      />
      <div className={styles.hub}>
        <h1>Set up One</h1>
        <p className={styles.subtitle}>Choose the AI that works for you.</p>
        {hubStateLoading ? <SetupHubLoadingState /> : (
          <>
            <div data-testid="one-setup-ai-choice">
              <button
                type="button"
                className={styles.aiOption}
                disabled={dismissing}
                onClick={() => router.push(buildOneSetupConnectionsRoute(returnTo))}
                data-voice-control-id="one_setup_tile_connections"
              >
                <span className={styles.optionIcon}><SetupV10Icon name="plug" size={22} /></span>
                <span className={styles.optionCopy}>
                  <strong>Choose your AI</strong>
                  <small>{runtimeChoiceComplete ? "You can change this later." : "Use ours, or bring your own key."}</small>
                </span>
                <span className={`${styles.status} ${runtimeChoiceComplete ? styles.selected : ""}`}>
                  {runtimeChoiceComplete ? "Selected" : "Required"}
                </span>
                <SetupV10Icon name="chevron-right" size={17} className={styles.chevron} />
              </button>
            </div>
            {initialContacts.ownerId === user?.uid ? (
              <button
                type="button"
                className={styles.contactsAction}
                disabled={["reading", "matching", "ready"].includes(initialContacts.status)}
                onClick={() => InitialContacts.startSource()}
              >
                {initialContacts.status === "ready"
                  ? `${initialContacts.result?.autoConnectedCount ?? 0} people found`
                  : ["reading", "matching"].includes(initialContacts.status)
                    ? "Finding people…"
                    : "Find people I know"}
              </button>
            ) : null}
            {runtimeChoiceComplete ? <PwmResearchDisclosure compact className={styles.disclosure} /> : null}
            <MarketingPreferencePanel model={emailPreference} />
            <button
              type="button"
              className={styles.primary}
              disabled={!runtimeChoiceComplete || dismissing}
              onClick={() => void handleMasterAck()}
              data-testid="one-setup-master-ack"
              data-voice-control-id="one-setup-master-ack"
              data-voice-action-id="setup.hub_master_ack"
              data-voice-label={masterActionLabel}
              data-voice-purpose="Finish setup and protect what you save."
            >
              {dismissing ? "Finishing…" : masterActionLabel}
              <SetupV10Icon name="arrow-right" size={18} />
            </button>
            {!runtimeChoiceComplete ? <p className={styles.underAction}>Choose an AI to continue.</p> : null}
          </>
        )}
        {finalizationError ? (
          <div role="alert" className={styles.error}>
            <span>{finalizationError}</span>
            <button type="button" onClick={() => void handleMasterAck()}>Try again</button>
          </div>
        ) : null}
      </div>
      {user ? (
        <VaultUnlockDialog
          user={user}
          open={vaultDialogOpen}
          onOpenChange={setVaultDialogOpen}
          dismissible={false}
          enableGeneratedDefault
          setupPresentation
          title="Set a lock"
          description="Only you can open what you save. Not even we can read it."
          onSuccess={() => undefined}
        />
      ) : null}
    </SetupV10Surface>
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
