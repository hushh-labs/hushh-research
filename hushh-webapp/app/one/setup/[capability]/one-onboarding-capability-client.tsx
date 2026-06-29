"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { OnboardingCapabilityStep } from "@/components/onboarding/setup/onboarding-capability-step";
import { useAuth } from "@/lib/firebase/auth-context";
import { useVault } from "@/lib/vault/vault-context";
import { getOneCapability } from "@/lib/onboarding/one-capabilities";
import { CapabilityTourService } from "@/lib/services/capability-tour-service";
import { OneSetupGateService } from "@/lib/services/one-setup-gate-service";
import { PreVaultUserStateService } from "@/lib/services/pre-vault-user-state-service";
import {
  buildOneSetupCapabilityRoute,
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
 * Per-capability scope: this screen records ONLY the signal for the capability
 * the user opened (and, for explore-only capabilities, the explore mark). It
 * MUST NOT touch the master setup gate (`setupCompleted` / `setupSkipped`) —
 * that master acknowledgement belongs exclusively to the hub's Skip (0 done) /
 * Continue (1..n done) controls.
 */
export function OneOnboardingCapabilityClient({
  capabilityId,
}: {
  capabilityId: string;
}) {
  const router = useRouter();
  const { user } = useAuth();
  const { isVaultUnlocked } = useVault();
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
        // Per-capability scope ONLY: never touch the master setup gate here.
        // Mark this visit as "seen" so the hub no longer treats it as a fresh,
        // never-opened tile, and record the explore signal for explore-only
        // capabilities. The master Skip/Continue acknowledgement is the hub's.
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
