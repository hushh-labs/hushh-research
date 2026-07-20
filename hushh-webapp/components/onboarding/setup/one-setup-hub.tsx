"use client";

import { useEffect, useMemo, useState } from "react";
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
import { Skeleton } from "@/components/ui/skeleton";
import styles from "./one-setup-hub.module.css";
import { useAuth } from "@/lib/firebase/auth-context";
import { useVault } from "@/lib/vault/vault-context";
import { normalizeInternalRouteHref, ROUTES } from "@/lib/navigation/routes";
import { acknowledgeOneSetupExit } from "@/lib/services/one-setup-exit-service";
import {
  CAPABILITY_SETUP_COPY,
  type CapabilitySetupCopy,
} from "@/lib/onboarding/capability-setup-copy";
import {
  getOneSetupCapability,
  lucideCapabilityIcon,
  ONE_SETUP_CAPABILITIES,
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
  const [runtimeChoiceSnapshot, setRuntimeChoiceSnapshot] = useState<{
    userId: string | null;
    state: "loading" | "required" | "complete";
  }>({ userId: null, state: "loading" });
  const runtimeChoiceState =
    runtimeChoiceSnapshot.userId === (user?.uid ?? null)
      ? runtimeChoiceSnapshot.state
      : "loading";
  const returnTo = useMemo(
    () => normalizeInternalRouteHref(searchParams.get("return_to")),
    [searchParams],
  );
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
  // count it as done. Connections is also a real, mandatory setup step and is
  // rendered alongside these capability rows, so it must participate in the
  // same progress projection instead of being omitted from the denominator.
  const completedCapabilityCount = items.filter((item) =>
    isCapabilitySetupComplete(item.status),
  ).length;
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
  // The MASTER setup acknowledgement is owned by this single hub control:
  //   - 0 capabilities done  -> "Skip setup"   (master skip-resolved)
  //   - 1..n capabilities done -> "Finish setup" (master completed, not skipped)
  // Computed here (ahead of the voice metadata publish below, which needs the
  // label) rather than only near `handleMasterAck`.
  // Connections is required before leaving the hub, but choosing a runtime is
  // not the same as completing an optional capability. Preserve the explicit
  // Skip outcome until at least one capability itself has been completed.
  const masterSkipped = completedCapabilityCount === 0;
  const masterActionLabel = masterSkipped ? "Skip setup" : "Finish setup";
  const hubStateLoading =
    isLoading || isEnriching || runtimeChoiceState === "loading";

  // Publish screen context so the onboarding guide can describe the hub and
  // navigate the person to any capability they ask for.
  usePublishVoiceSurfaceMetadata({
    screenId: "one_setup_hub",
    title: "Set up One",
    purpose:
      "This is your setup home. Each tile is one thing One can do for you. Set up the ones you want and skip the rest.",
    actions: hubStateLoading ? [] : [
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
              purpose: masterSkipped
                ? "Skip setup for now and go home."
                : "Finish setup for now and go home.",
            },
          ]),
    ],
  });

  // Either way, resolving the master ack SATISFIES the root setup gate so the
  // hard gate on /one/* does not bounce the user back here. Per-capability
  // tiles never touch this gate; they only record their own signal. We mark
  // the server pre-vault gate (authoritative for the gate and
  // PostAuthRouteService); when the vault is unlocked we also flip the vault
  // profile so the unlocked path agrees. Both are awaited before navigating
  // so the gate is consistent on the very next route resolve. Failures remain
  // on the hub and preserve the unresolved journey.
  const handleMasterAck = async () => {
    if (dismissing) {
      return {
        status: "blocked" as const,
        summary: "Setup is already being finished.",
      };
    }
    if (!user?.uid) {
      router.push(completionTarget);
      return { status: "started" as const, summary: "Opening home." };
    }
    setDismissing(true);
    try {
      const currentState = await PreVaultUserStateService.bootstrapState(
        user.uid,
        { force: true },
      );
      if (!PreVaultUserStateService.hasOneRuntimeChoice(currentState)) {
        setRuntimeChoiceSnapshot({ userId: user.uid, state: "required" });
        return {
          status: "blocked" as const,
          summary: "Choose how One runs in Connections before continuing.",
        };
      }
      await acknowledgeOneSetupExit({
        userId: user.uid,
        skipped: masterSkipped,
        isVaultUnlocked,
        vaultKey,
        vaultOwnerToken,
      });
      router.push(completionTarget);
      return {
        status: "succeeded" as const,
        summary: masterSkipped
          ? "Skipped setup for now."
          : "Finished setup for now. Opening home.",
        routeAfter: completionTarget,
      };
    } catch (error) {
      console.warn("[OneSetupHub] Failed to resolve master setup gate:", error);
      return {
        status: "failed" as const,
        summary:
          "Setup could not be finished yet. You are still on the setup hub.",
      };
    } finally {
      setDismissing(false);
    }
  };

  // Voice parity: "skip setup" / "finish setup" drive the same master
  // acknowledgement as the visible shared terminal action.
  useLocalOnboardingActionHandler("setup.hub_master_ack", async () => {
    return handleMasterAck();
  });

  const summary = hubStateLoading
    ? "Checking what's set up…"
    : allReady
      ? "Everything's set up. You're good to go."
      : `${done} of ${total} ready, ${remaining} left to set up.`;

  return (
    <AppPageShell
      as="main"
      width="standard"
      className="relative isolate"
      nativeTest={{
        routeId: "/one/setup",
        marker: "native-route-one-setup",
        authState: "authenticated",
        dataState: hubStateLoading ? "loading" : "loaded",
      }}
    >
      <AppPageHeaderRegion>
        <PageHeader
          title={!hubStateLoading && allReady ? "You're all set" : "Finish setting up One"}
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
                title="Connections"
                description="Use Hushh managed Gemini or your own Google AI Studio key."
                href={ROUTES.ONE_SETUP_CONNECTIONS}
                voiceControlId="one_setup_tile_connections"
                icon={lucideCapabilityIcon(PlugZap)}
                tone="connected"
                statusLabel="Required"
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
                  title="Connections"
                  description="Change how One runs."
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
        <SetupCompletionFooter
          label={masterActionLabel}
          onComplete={() => void handleMasterAck()}
          busy={dismissing}
          disabled={!runtimeChoiceComplete}
          controlId="one-setup-master-ack"
          actionId="setup.hub_master_ack"
          testId="one-setup-master-ack"
          purpose={
            masterSkipped
              ? "Skip the remaining setup for now and go home."
              : "Finish setup for now and go home."
          }
          supportingText={
            !runtimeChoiceComplete
              ? "Choose a Connections option before continuing."
              : masterSkipped
              ? "You can set up these capabilities any time."
              : "Your completed setup stays in place. You can add more any time."
          }
          variant={masterSkipped ? "none" : "blue-gradient"}
          effect={masterSkipped ? "fade" : "fill"}
        />
          </>
        )}
      </AppPageContentRegion>
    </AppPageShell>
  );
}

function SetupHubLoadingState() {
  const setupStepCount = ONE_SETUP_CAPABILITIES.length + 1;
  return (
    <div
      data-testid="one-setup-loading-state"
      className="space-y-5"
      aria-busy="true"
      aria-label="Checking setup progress"
    >
      <div
        className="grid gap-1.5"
        style={{ gridTemplateColumns: `repeat(${setupStepCount}, minmax(0, 1fr))` }}
        aria-hidden="true"
      >
        {Array.from({ length: setupStepCount }).map((_, index) => (
          <Skeleton key={index} className="h-1 rounded-full" />
        ))}
      </div>
      <div className="space-y-3" aria-hidden="true">
        <Skeleton className="h-3 w-24" />
        <div className="overflow-hidden rounded-[var(--app-card-radius-compact)] border border-border/45 bg-background/45">
          {Array.from({ length: setupStepCount }).map((_, index) => (
            <div
              key={index}
              className="flex min-h-[72px] items-center gap-3 border-b border-border/45 px-4 last:border-b-0"
            >
              <Skeleton className="h-10 w-10 shrink-0 rounded-2xl" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-3.5 w-2/5" />
                <Skeleton className="h-3 w-4/5" />
              </div>
            </div>
          ))}
        </div>
      </div>
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
