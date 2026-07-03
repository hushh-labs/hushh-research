"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { type LucideIcon } from "lucide-react";

import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { Button } from "@/components/ui/button";
import { CapabilitySetupTile } from "@/components/onboarding/setup/capability-setup-tile";
import { SettingsGroup } from "@/components/app-ui/settings-ui";
import { useAuth } from "@/lib/firebase/auth-context";
import { useVault } from "@/lib/vault/vault-context";
import { ROUTES } from "@/lib/navigation/routes";
import { KaiProfileService } from "@/lib/services/kai-profile-service";
import { OneSetupGateService } from "@/lib/services/one-setup-gate-service";
import { PreVaultUserStateService } from "@/lib/services/pre-vault-user-state-service";
import {
  CAPABILITY_SETUP_COPY,
  type CapabilitySetupCopy,
} from "@/lib/onboarding/capability-setup-copy";
import {
  getOneCapability,
  type OneCapabilityTone,
} from "@/lib/onboarding/one-capabilities";
import { usePublishVoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";
import { useCapabilitySetupStates } from "@/lib/onboarding/use-capability-setup-states";
import {
  isCapabilitySetupActionable,
  isCapabilitySetupComplete,
  type CapabilityStatus,
} from "@/lib/services/capability-setup-state-service";
import { cn } from "@/lib/utils";

/**
 * OneSetupHub: the `/one/setup` hub screen.
 *
 * It is the calm home for "what's left to set up". It opts into the expensive
 * resolver enrichment (`enrichVault` + `enrichOauth`) so every tile shows an
 * honest state (Ready, Set up, N to review) or an honest blocked reason
 * ("Unlock to set up", "Connect to set up") instead of guessing.
 *
 * LAYOUT (Card Depth Model + recompose-by-breakpoint)
 * - Lives inside the normal app shell (`standard` chrome) so a person who has
 *   finished onboarding can still browse here without being trapped in a flow.
 * - A single grouped inset list (SettingsGroup) of full-width setup rows in
 *   actionable-first order. The shell itself owns the scroll; the header region
 *   stays put.
 * - One owns the voice: "Set up One", plain language, no system nouns.
 */
export function OneSetupHub() {
  const router = useRouter();
  const { user } = useAuth();
  const { vaultKey, vaultOwnerToken, isVaultUnlocked } = useVault();
  const { byId, isLoading } = useCapabilitySetupStates({
    enrichVault: true,
    enrichOauth: true,
  });
  const [dismissing, setDismissing] = useState(false);

  const items = useMemo(() => buildSetupItems(byId), [byId]);

  const total = items.length;
  // "Ready" counts only GENUINELY set-up capabilities (completed/skipped). A
  // tile that still needs a connection or an unlock (blocked/unknown) is NOT
  // ready, even though it is not directly tappable-into-setup — so we never
  // count it as done. Everything that is not complete is "left to set up".
  const done = items.filter((item) => isCapabilitySetupComplete(item.status)).length;
  const remaining = total - done;
  const allReady = total > 0 && remaining === 0;

  // Publish screen context so the onboarding guide can describe the hub and
  // navigate the person to any capability they ask for.
  usePublishVoiceSurfaceMetadata({
    screenId: "one_setup_hub",
    title: "Set up One",
    purpose:
      "This is your setup home. Each tile is one thing One can do for you. Set up the ones you want and skip the rest.",
    actions: CAPABILITY_SETUP_COPY.map((cap) => ({
      id: cap.id,
      label: cap.title,
      purpose: cap.setupBlurb,
    })),
  });

  // The MASTER setup acknowledgement is owned by this single hub control:
  //   - 0 capabilities done  -> "Skip"     (master skip-resolved)
  //   - 1..n capabilities done -> "Continue" (master completed, not skipped)
  // Either way it SATISFIES the root setup gate so the hard gate on /one/* does
  // not bounce the user back here. Per-capability tiles never touch this gate;
  // they only record their own signal. We mark the server pre-vault gate
  // (authoritative for the gate and PostAuthRouteService); when the vault is
  // unlocked we also flip the vault profile so the unlocked path agrees. Both
  // are awaited before navigating so the gate is consistent on the very next
  // route resolve. Failures stay fail-open (we still navigate home).
  const masterSkipped = done === 0;
  const masterActionLabel = masterSkipped ? "Skip" : "Continue";

  const handleMasterAck = async () => {
    if (dismissing) return;
    if (!user?.uid) {
      router.push(ROUTES.ONE_HOME);
      return;
    }
    setDismissing(true);
    try {
      await PreVaultUserStateService.syncKaiSetupState({
        userId: user.uid,
        completed: true,
        skipped: masterSkipped,
      });
      if (isVaultUnlocked && vaultKey && vaultOwnerToken) {
        await KaiProfileService.setOnboardingCompleted({
          userId: user.uid,
          vaultKey,
          vaultOwnerToken,
          skippedPreferences: masterSkipped,
        }).catch((error) => {
          console.warn(
            "[OneSetupHub] Failed to mark vault profile setup completed:",
            error,
          );
        });
      }
      OneSetupGateService.markSeen(user.uid);
    } catch (error) {
      console.warn("[OneSetupHub] Failed to resolve master setup gate:", error);
    } finally {
      setDismissing(false);
      router.push(ROUTES.ONE_HOME);
    }
  };

  const summary = isLoading
    ? "Checking what's set up…"
    : allReady
      ? "Everything's set up. You're good to go."
      : `${done} of ${total} ready, ${remaining} left to set up.`;

  return (
    <AppPageShell
      as="main"
      width="standard"
      className="relative isolate pb-[calc(var(--app-safe-area-bottom-effective,0px)+2.5rem)]"
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
          actions={
            <Button
              type="button"
              variant={masterSkipped ? "ghost" : "default"}
              size="sm"
              disabled={dismissing}
              onClick={() => void handleMasterAck()}
              data-testid="one-setup-master-ack"
              className={cn(
                "rounded-full type-subhead font-medium",
                "transition-[background-color,transform] duration-[var(--motion-duration-sm)] ease-[var(--motion-ease-standard)]",
                "active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100",
                masterSkipped
                  ? "text-primary hover:bg-primary/10"
                  : "!bg-primary !text-primary-foreground hover:!bg-primary/90",
              )}
            >
              {masterActionLabel}
            </Button>
          }
        />
      </AppPageHeaderRegion>

      <AppPageContentRegion>
        <SettingsGroup testId="one-setup-capabilities" separatorInset>
          {items.map((item) => (
            <CapabilitySetupTile
              key={item.id}
              title={item.copy.setupTitle}
              description={item.copy.setupBlurb}
              href={item.copy.href}
              icon={item.icon}
              tone={item.tone}
              status={item.status}
              isExploreOnly={item.isExploreOnly}
              isCurrent={item.isCurrent}
            />
          ))}
        </SettingsGroup>
      </AppPageContentRegion>
    </AppPageShell>
  );
}

interface SetupItem {
  id: string;
  copy: CapabilitySetupCopy;
  status: CapabilityStatus;
  icon: LucideIcon;
  tone: OneCapabilityTone;
  isActionable: boolean;
  isExploreOnly: boolean;
  isCurrent: boolean;
}

function buildSetupItems(
  byId: Record<string, CapabilityStatus>,
): SetupItem[] {
  // Order: still-actionable capabilities first (so the next thing to do is at
  // the top), completed/ready ones after. Stable within each bucket by catalog
  // order so the list never jumps around between renders.
  const enriched = CAPABILITY_SETUP_COPY.flatMap((copy) => {
    const capability = getOneCapability(copy.id);
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
        isActionable: isCapabilitySetupActionable(status),
        isExploreOnly: capability.isExploreOnly === true,
      },
    ];
  });

  const ordered = [
    ...enriched.filter((item) => item.isActionable),
    ...enriched.filter((item) => !item.isActionable),
  ];

  const firstActionableId = ordered.find((item) => item.isActionable)?.id ?? null;

  return ordered.map((item) => ({
    ...item,
    isCurrent: item.id === firstActionableId,
  }));
}
