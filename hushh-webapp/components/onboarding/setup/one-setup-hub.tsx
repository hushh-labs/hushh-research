"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { PlugZap } from "lucide-react";

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
  const completionTarget = returnTo || ROUTES.ONE_HOME;

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

  const items = useMemo(() => buildSetupItems(byId), [byId]);
  const groupedItems = groupSetupCapabilities(items, (item) =>
    isCapabilitySetupComplete(item.status),
  );
  const remainingItems = groupedItems.remaining;
  const completeItems = groupedItems.complete;
  const visibleItems = groupedItems.visible;

  const runtimeChoiceComplete = runtimeChoiceState === "complete";
  // "Ready" counts only GENUINELY set-up capabilities (completed/skipped). A
  // tile that still needs a connection or an unlock (blocked/unknown) is NOT
  // ready, even though it is not directly tappable-into-setup — so we never
  // count it as done. AI access is also a real, mandatory setup step and is
  // rendered alongside these capability rows, so it must participate in the
  // same progress projection instead of being omitted from the denominator.
  const progressSteps = [
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
          ...(dismissing || !runtimeChoiceComplete
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
  }, [completionTarget, router, user?.uid, vaultKey, vaultOwnerToken]);

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
      className="relative isolate"
      nativeTest={{
        routeId: "/one/setup",
        marker: "native-route-one-setup",
        authState: "authenticated",
        dataState: hubStateLoading ? "loading" : "loaded",
      }}
    >
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
              disabled={dismissing || !runtimeChoiceComplete}
              title={
                !runtimeChoiceComplete ? "Choose your AI first." : undefined
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

      <AppPageContentRegion>
        {hubStateLoading ? (
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
              {completeItems.length > 0 || runtimeChoiceComplete ? (
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
                disabled={!runtimeChoiceComplete}
                controlId="one-setup-master-ack"
                actionId="setup.hub_master_ack"
                testId="one-setup-master-ack"
                purpose={
                  "Finish setup and protect what you save."
                }
                supportingText={
                  !runtimeChoiceComplete
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
