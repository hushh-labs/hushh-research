"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { OnboardingCapabilityStep } from "@/components/onboarding/setup/onboarding-capability-step";
import { useAuth } from "@/lib/firebase/auth-context";
import { useVault } from "@/lib/vault/vault-context";
import { getOneCapability } from "@/lib/onboarding/one-capabilities";
import { CapabilityTourService } from "@/lib/services/capability-tour-service";
import { KaiProfileService } from "@/lib/services/kai-profile-service";
import { OneSetupGateService } from "@/lib/services/one-setup-gate-service";
import { PreVaultUserStateService } from "@/lib/services/pre-vault-user-state-service";
import {
  buildOneSetupCapabilityRoute,
  isOneSetupSurfaceRoute,
  resolveCapabilityHandoffTarget,
  ROUTES,
} from "@/lib/navigation/routes";


/**
 * Per-capability setup step client: `/one/setup/<capability>`.
 *
 * This route lives UNDER `/one/setup/*`, which `OneOnboardingGuard` allows
 * through while the root setup gate is unresolved (see
 * `isOneSetupCapabilityRoute`). That is what fixes the first-time trap:
 * tapping a setup-hub tile lands HERE (allowed) instead of a hard-gated
 * canonical route (which bounced the user back to `/one/setup`).
 *
 * Per-capability scope: this screen records the signal for the capability the
 * user opened (and, for explore-only capabilities, the explore mark). It also
 * resolves the MASTER setup gate (`setupCompleted`) WHEN — and only when — the
 * Continue CTA forwards the user into a hard-gated product surface
 * (`/one/<capability>`, e.g. `/one/location`, `/one/gmail`,
 * `/one/connected-systems`). Without this, `OneOnboardingGuard` saw the master
 * gate still unresolved on the destination and bounced the user straight back
 * to `/one/setup` — the exact redirect loop reported on UAT. Pressing Continue
 * here is an explicit "proceed into the product" intent, equivalent to the
 * hub's Continue (1..n done) control, so it satisfies the same gate the hub
 * does (and mirrors `OneSetupHub.handleMasterAck`).
 *
 * Forwards that STAY on the setup surface (finance → the `/one/setup/kai`
 * wizard) or that leave `/one/*` entirely (consent → `/consents`) do NOT
 * resolve the master gate here: the wizard owns its own completion, and routes
 * outside `/one/*` are not behind `OneOnboardingGuard`.
 */
export function OneOnboardingCapabilityClient({
  capabilityId,
}: {
  capabilityId: string;
}) {
  const router = useRouter();
  const { user } = useAuth();
  const { vaultKey, vaultOwnerToken, isVaultUnlocked } = useVault();
  const [busy, setBusy] = useState(false);

  const capability = getOneCapability(capabilityId);

  // The step collects nothing and renders pre-vault, but if this capability's
  // workspace reads vault-backed data and the vault is currently locked, set the
  // honest "you'll unlock next" expectation. The destination guard owns the
  // actual unlock prompt.
  const needsVaultUnlock =
    capability?.requiresVault === true && !isVaultUnlocked;
  // Forward target for this capability. When the destination is the
  // investor-preferences WIZARD (`/one/setup/kai`, used by finance), append a
  // `from` marker so `OneOnboardingGuard` treats the visit as an intentional
  // re-entry and does NOT bounce a user who has already resolved the gate. The
  // wizard reads `from` for its own back affordance too.
  const handoffTarget = resolveCapabilityHandoffTarget(capabilityId);
  const target =
    handoffTarget === ROUTES.ONE_SETUP_KAI
      ? `${handoffTarget}?from=${encodeURIComponent(
          buildOneSetupCapabilityRoute(capabilityId),
        )}`
      : handoffTarget;
  // Does Continue forward into a hard-gated `/one/*` product surface? Those
  // (and only those) are guarded by `OneOnboardingGuard`, which bounces back to
  // `/one/setup` while the master gate is unresolved. Setup-surface forwards
  // (finance → `/one/setup/kai`) and off-`/one` forwards (consent → `/consents`)
  // are not gated, so they keep the per-capability-only scope.
  const forwardsToGatedSurface =
    handoffTarget.startsWith(`${ROUTES.ONE_HOME}/`) &&
    !isOneSetupSurfaceRoute(handoffTarget);

  // Unknown capability: contain to the hub, never a hard 404.
  useEffect(() => {
    if (!capability) {

      router.replace(ROUTES.ONE_SETUP);
    }
  }, [capability, router]);

  if (!capability) {
    return <HushhLoader label="Opening…" />;
  }

  const handleBack = () => {
    router.replace(ROUTES.ONE_SETUP);
  };

  const handlePrimary = () => {
    if (busy) return;
    const userId = user?.uid ?? null;

    // Auth/lock guards own the unauthenticated path; if we somehow have no user,
    // just forward so the user is never stranded on this screen.
    if (!userId) {
      router.replace(target);
      return;
    }

    setBusy(true);

    void (async () => {
      try {
        // Mark this visit as "seen" so the hub no longer treats it as a fresh,
        // never-opened tile, and record the explore signal for explore-only
        // capabilities.
        OneSetupGateService.markSeen(userId);

        if (capability?.isExploreOnly === true) {
          await CapabilityTourService.markExplored(userId, capabilityId).catch(
            () => undefined,
          );
          const explored = await CapabilityTourService.loadExploredIds(userId);
          void PreVaultUserStateService.syncSetupCapabilities(userId, [
            ...explored,
          ]).catch(() => undefined);
        }

        // Resolve the MASTER setup gate before forwarding into a hard-gated
        // `/one/*` surface, otherwise `OneOnboardingGuard` bounces the user back
        // to `/one/setup` (the reported redirect loop). This mirrors the hub's
        // Continue path: mark the server pre-vault gate (authoritative for the
        // gate + PostAuthRouteService) as completed, and — when the vault is
        // unlocked — flip the vault profile too so the unlocked path agrees.
        // Both are awaited so the gate is consistent on the very next resolve.
        // Setup-surface forwards (finance wizard) and off-`/one` forwards
        // (consent) skip this: they are not behind the hard gate.
        if (forwardsToGatedSurface) {
          await PreVaultUserStateService.syncKaiSetupState({
            userId,
            completed: true,
            // Continue with a capability opened is an active completion, not a
            // skip. The hub's Skip control still owns the 0-done skip path.
            skipped: false,
          });
          if (isVaultUnlocked && vaultKey && vaultOwnerToken) {
            await KaiProfileService.setOnboardingCompleted({
              userId,
              vaultKey,
              vaultOwnerToken,
              skippedPreferences: false,
            }).catch((error) => {
              console.warn(
                "[OneOnboardingCapabilityClient] Failed to mark vault profile setup completed:",
                error,
              );
            });
          }
        }
      } catch (resolveError) {
        console.warn(
          "[OneOnboardingCapabilityClient] Failed to record capability signal:",
          resolveError,
        );
        // Fail-open: still forward so the user is never stranded.
      } finally {
        router.replace(target);

      }
    })();
  };

  return (
    <OnboardingCapabilityStep
      capabilityId={capabilityId}
      onPrimary={handlePrimary}
      onBack={handleBack}
      busy={busy}
      needsVaultUnlock={needsVaultUnlock}
    />
  );
}
