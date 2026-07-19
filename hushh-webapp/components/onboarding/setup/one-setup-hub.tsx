"use client";

import { useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { CapabilitySetupTile } from "@/components/onboarding/setup/capability-setup-tile";
import { SetupCompletionFooter } from "@/components/onboarding/setup/setup-completion-footer";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
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
  const { byId, isLoading } = useCapabilitySetupStates({
    enrichVault: true,
    enrichOauth: true,
    enrichRia: true,
  });
  const [dismissing, setDismissing] = useState(false);
  const returnTo = useMemo(
    () => normalizeInternalRouteHref(searchParams.get("return_to")),
    [searchParams],
  );
  const completionTarget = returnTo || ROUTES.ONE_HOME;

  const items = useMemo(() => buildSetupItems(byId), [byId]);
  const groupedItems = groupSetupCapabilities(items, (item) =>
    isCapabilitySetupComplete(item.status),
  );
  const remainingItems = groupedItems.remaining;
  const completeItems = groupedItems.complete;
  const visibleItems = groupedItems.visible;

  const total = items.length;
  // "Ready" counts only GENUINELY set-up capabilities (completed/skipped). A
  // tile that still needs a connection or an unlock (blocked/unknown) is NOT
  // ready, even though it is not directly tappable-into-setup — so we never
  // count it as done. Everything that is not complete is "left to set up".
  const done = items.filter((item) =>
    isCapabilitySetupComplete(item.status),
  ).length;
  const remaining = total - done;
  const allReady = total > 0 && remaining === 0;
  // The MASTER setup acknowledgement is owned by this single hub control:
  //   - 0 capabilities done  -> "Skip setup"   (master skip-resolved)
  //   - 1..n capabilities done -> "Finish setup" (master completed, not skipped)
  // Computed here (ahead of the voice metadata publish below, which needs the
  // label) rather than only near `handleMasterAck`.
  const masterSkipped = done === 0;
  const masterActionLabel = masterSkipped ? "Skip setup" : "Finish setup";

  // Publish screen context so the onboarding guide can describe the hub and
  // navigate the person to any capability they ask for.
  usePublishVoiceSurfaceMetadata({
    screenId: "one_setup_hub",
    title: "Set up One",
    purpose:
      "This is your setup home. Each tile is one thing One can do for you. Set up the ones you want and skip the rest.",
    actions: [
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
      ...(dismissing
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

  const summary = isLoading
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
        dataState: isLoading ? "loading" : "loaded",
      }}
    >
      <AppPageHeaderRegion>
        <PageHeader
          title={allReady ? "You're all set" : "Finish setting up One"}
          description={summary}
          accent="neutral"
          className={styles.setupHeader}
        />
      </AppPageHeaderRegion>

      <AppPageContentRegion>
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
            title="Private configuration"
            description="Choose how One runs before setting up individual features."
            testId="one-setup-connections"
            separatorInset
          >
            <SettingsRow
              title="Connections"
              description="Use Hushh managed Gemini or your own Google AI Studio key."
              density="compact"
              chevron
              onClick={() => router.push(ROUTES.ONE_SETUP_CONNECTIONS)}
            />
          </SettingsGroup>
          {remainingItems.length > 0 ? (
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
          {completeItems.length > 0 ? (
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
        <SetupCompletionFooter
          label={masterActionLabel}
          onComplete={() => void handleMasterAck()}
          busy={dismissing}
          controlId="one-setup-master-ack"
          actionId="setup.hub_master_ack"
          testId="one-setup-master-ack"
          purpose={
            masterSkipped
              ? "Skip the remaining setup for now and go home."
              : "Finish setup for now and go home."
          }
          supportingText={
            masterSkipped
              ? "You can set up these capabilities any time."
              : "Your completed setup stays in place. You can add more any time."
          }
          variant={masterSkipped ? "none" : "blue-gradient"}
          effect={masterSkipped ? "fade" : "fill"}
        />
      </AppPageContentRegion>
    </AppPageShell>
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
