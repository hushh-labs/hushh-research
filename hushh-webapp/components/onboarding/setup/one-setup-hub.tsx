"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { PlugZap } from "@/components/icons";
import { toast } from "sonner";

import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { SetupNavigationTile } from "@/components/onboarding/setup/capability-setup-tile";
import { SetupCompletionFooter } from "@/components/onboarding/setup/setup-completion-footer";
import { SettingsGroup } from "@/components/app-ui/settings-ui";
import { VaultUnlockDialog } from "@/components/vault/vault-unlock-dialog";
import { Button } from "@/lib/morphy-ux/button";
import styles from "./one-setup-hub.module.css";
import { useAuth } from "@/lib/firebase/auth-context";
import { useVault } from "@/lib/vault/vault-context";
import {
  isOneSetupSurfaceRoute,
  normalizeInternalRouteHref,
  ROUTES,
} from "@/lib/navigation/routes";
import { acknowledgeOneSetupExit } from "@/lib/services/one-setup-exit-service";
import { lucideCapabilityIcon } from "@/lib/onboarding/one-capabilities";
import { usePublishVoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";
import { useLocalOnboardingActionHandler } from "@/lib/agent/local-onboarding-actions";
import { PreVaultUserStateService } from "@/lib/services/pre-vault-user-state-service";
import { PreVaultSensitiveDraftService } from "@/lib/services/pre-vault-sensitive-draft-service";
import { FinanceSetupDraftService } from "@/lib/services/finance-setup-draft-service";
import { PostUnlockSyncService } from "@/lib/services/post-unlock-sync-service";
import { notifyGeminiRuntimeConfigurationChanged } from "@/lib/connections/gemini-runtime-configuration";
import { useOneConversationSession } from "@/lib/agent/one-conversation-session";

/**
 * OneSetupHub: the `/one/setup` hub screen.
 *
 * The only mandatory step is choosing an AI (managed vs. bring-your-own) and
 * setting a vault lock. Capability setup (Gmail, Calendar, Location, etc.) is
 * no longer listed here — each capability's own connect/setup screen shows up
 * the first time someone actually reaches for it, from its real page or from
 * chat. That keeps this hub a single screen instead of an upfront checklist.
 *
 * LAYOUT (Card Depth Model + recompose-by-breakpoint)
 * - Lives inside the normal app shell (`standard` chrome) so a person who has
 *   finished onboarding can still browse here without being trapped in a flow.
 *   The shell itself owns the scroll; the header region stays put.
 * - One owns the voice: "Set up One", plain language, no system nouns.
 */
export function OneSetupHub() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user } = useAuth();
  const { vaultKey, vaultOwnerToken, isVaultUnlocked } = useVault();
  const queueEntryWelcome = useOneConversationSession(
    (state) => state.queueEntryWelcome,
  );
  const [dismissing, setDismissing] = useState(false);
  const [finalizationError, setFinalizationError] = useState<string | null>(null);
  const [vaultInvitationOpen, setVaultInvitationOpen] = useState(false);
  const [vaultDialogOpen, setVaultDialogOpen] = useState(false);
  const finalizationInFlightRef = useRef<Promise<void> | null>(null);
  const [runtimeChoiceSnapshot, setRuntimeChoiceSnapshot] = useState<{
    userId: string | null;
    state: "loading" | "required" | "complete";
  }>({ userId: null, state: "loading" });
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
      setRuntimeChoiceSnapshot({ userId: null, state: "required" });
      return;
    }
    let active = true;
    const cached = PreVaultUserStateService.getCachedBootstrapState(user.uid);
    if (cached) {
      setRuntimeChoiceSnapshot({
        userId: user.uid,
        state: PreVaultUserStateService.hasOneRuntimeChoice(cached)
          ? "complete"
          : "required",
      });
      return;
    }
    setRuntimeChoiceSnapshot({ userId: user.uid, state: "loading" });
    void PreVaultUserStateService.bootstrapState(user.uid)
      .then((state) => {
        if (!active) return;
        setRuntimeChoiceSnapshot({
          userId: user.uid,
          state: PreVaultUserStateService.hasOneRuntimeChoice(state)
            ? "complete"
            : "required",
        });
      })
      .catch(() => {
        if (active) {
          setRuntimeChoiceSnapshot({ userId: user.uid, state: "required" });
        }
      });
    return () => {
      active = false;
    };
  }, [user?.uid]);

  const runtimeChoiceComplete = runtimeChoiceState === "complete";
  // The only mandatory step left in the hub is the AI-access choice, so the
  // progress projection is just that one step.
  const progressSteps = [{ id: "connections", complete: runtimeChoiceComplete }];
  const total = progressSteps.length;
  const done = progressSteps.filter((step) => step.complete).length;
  const remaining = total - done;
  const allReady = total > 0 && remaining === 0;
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
      "This is your setup home. Choose your AI and set a lock. You can connect Gmail, Calendar, and other capabilities any time from their own screens.",
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
      // Queue only a typed, owner-scoped marker after the encrypted setup
      // boundary. The Chat surface derives its summary from the unlocked
      // in-memory context and consumes this marker once; no private values
      // enter the route or conversation history.
      queueEntryWelcome(user.uid);
      setVaultDialogOpen(false);
      setVaultInvitationOpen(false);
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
    queueEntryWelcome,
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
      // AI access gate: a runtime choice is mandatory before leaving the hub.
      // When the client already knows the choice is made (the footer stays
      // disabled until runtimeChoiceComplete) trust it and skip the network
      // round-trip. Only re-verify against fresh server state when the client
      // is unsure — and even then a failed probe must not trap the person, so
      // fall back to the resolved client gate rather than stranding them.
      let runtimeChoiceConfirmed = runtimeChoiceComplete;
      if (!runtimeChoiceConfirmed) {
        try {
          const currentState = await PreVaultUserStateService.bootstrapState(
            user.uid,
            { force: true },
          );
          runtimeChoiceConfirmed =
            PreVaultUserStateService.hasOneRuntimeChoice(currentState);
          setRuntimeChoiceSnapshot({
            userId: user.uid,
            state: runtimeChoiceConfirmed ? "complete" : "required",
          });
        } catch (error) {
          console.warn(
            "[OneSetupHub] Could not verify the AI access choice:",
            error,
          );
        }
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
        toast.info("Choose your AI first.", {
          action: {
            label: "Choose",
            onClick: () => router.push(ROUTES.ONE_SETUP_CONNECTIONS),
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
      : !runtimeChoiceComplete
        ? "Choose your AI first."
        : `${remaining} left.`;

  return (
    <AppPageShell
      as="main"
      width="reading"
      fitContent
      className="relative isolate max-w-[600px]"
      nativeTest={{
        routeId: "/one/setup",
        marker: "native-route-one-setup",
        authState: "authenticated",
        dataState: hubStateLoading ? "loading" : "loaded",
      }}
    >
      <AppPageHeaderRegion>
          <PageHeader
            title={
              !hubStateLoading && allReady ? "You're all set" : "Set up One"
            }
            description={summary}
            accent="neutral"
            className={styles.setupHeader}
          />
      </AppPageHeaderRegion>

      <AppPageContentRegion>
        {hubStateLoading ? (
          <SetupHubLoadingState />
        ) : (
          <>
            {total > 0 ? (
              <div
                className={styles.setupProgress}
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={total}
                aria-valuenow={done}
                aria-label={`${done} of ${total} set up`}
              >
                <div className={styles.setupProgressLabel}>
                  {done} of {total} complete
                </div>
                <div className={styles.setupProgressTrack} aria-hidden>
                  <span
                    className={styles.setupProgressFill}
                    style={{
                      width:
                        total > 0 ? `${Math.round((done / total) * 100)}%` : "0%",
                    }}
                  />
                </div>
              </div>
            ) : null}
            <div className={styles.flatChecklist}>
              <SettingsGroup
                title="Remaining"
                testId="one-setup-capabilities-remaining"
                separatorInset
              >
                {!runtimeChoiceComplete ? (
                  <SetupNavigationTile
                    id="connections"
                    title="Choose your AI"
                    description="Use ours, or bring your own."
                    href={ROUTES.ONE_SETUP_CONNECTIONS}
                    voiceControlId="one_setup_tile_connections"
                    icon={lucideCapabilityIcon(PlugZap)}
                    tone="connected"
                    statusLabel="Required"
                    // The one row that blocks the exit. A muted grey "Required"
                    // reads like every other trailing label, so it gets the
                    // accent pill and the current-step role instead.
                    statusTone="required"
                    isCurrent
                  />
                ) : null}
              </SettingsGroup>
              {runtimeChoiceComplete ? (
                <SettingsGroup
                  title="Complete"
                  testId="one-setup-capabilities-complete"
                  separatorInset
                >
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
                </SettingsGroup>
              ) : null}
            </div>
            <div>
              <SetupCompletionFooter
                // The signed-in app scroll root already reserves the iOS safe
                // area and persistent Talk to One bar. Reserving it again here
                // creates an oversized empty tail beneath Finish setup.
                insetBottom={false}
                label={masterActionLabel}
                onComplete={() => void handleMasterAck()}
                busy={dismissing}
                blocked={!runtimeChoiceComplete}
                controlId="one-setup-master-ack"
                actionId="setup.hub_master_ack"
                testId="one-setup-master-ack"
                purpose={
                  "Finish setup and protect what you save."
                }
                // The blocker is no longer named here. It was permanent copy
                // that had to be read before the tap to be any use, and the
                // tap is exactly when people want the answer -- so it moved
                // into the toast the blocked tap now raises.
                supportingText="Set up the rest later."
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
