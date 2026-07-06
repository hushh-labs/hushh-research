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
 * Per-capability scope: this screen records the signal for the capability the
 * user opened (and, for explore-only capabilities, the explore mark). It does
 * NOT resolve the account-wide MASTER setup gate (`setupCompleted`). Entering
 * ONE capability is not the same as FINISHING setup — the master gate is
 * resolved only by a genuine finish (the hub's Skip/Continue =
 * `OneSetupHub.handleMasterAck`, or true onboarding completion).
 *
 * When the Continue CTA forwards into a hard-gated product surface
 * (`/one/<capability>`, e.g. `/one/gmail`, `/one/location`,
 * `/one/connected-systems`), we tag the URL with `?from=/one/setup` (the hub
 * path) so (1) `OneOnboardingGuard` allows the setup-originated entry through
 * without the master gate (see `isCapabilityHandoffTarget`), and (2) the top-bar
 * back button retraces to the hub (the breadcrumb reads `from` as a real path;
 * a bare `setup` marker was rejected by `normalizeInternalRouteHref` and fell
 * back to Profile — the QA back-button bug). An even earlier version wrote
 * `setupCompleted = true` here to dodge the guard bounce — but that account-wide
 * side effect cleared the dashboard's "Finish setup" bar prematurely. The
 * `?from=/one/setup` handoff fixes the redirect loop WITHOUT that side effect.
 *
 * Forwards that STAY on the setup surface (finance → the `/one/setup/kai`
 * wizard) or that leave `/one/*` entirely (consent → `/consents`) need no
 * marker: the wizard owns its own completion, and routes outside `/one/*` are
 * not behind `OneOnboardingGuard`.
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
  const handoffTarget = resolveCapabilityHandoffTarget(capabilityId);
  // Forward target for this capability, tagged with the setup-hub ORIGIN so:
  //  (1) the top-bar back retraces to the hub — "jaise aaya waise wapas" — for
  //      EVERY capability (gmail/email/location/pkm/connected-systems + consent),
  //      instead of falling back to Profile/dashboard; and
  //  (2) `OneOnboardingGuard` lets a setup-originated entry into a hard-gated
  //      `/one/*` surface through WITHOUT resolving the account-wide master gate
  //      (see `isCapabilityHandoffTarget` — this replaced an earlier premature
  //      `setupCompleted = true` write that cleared the "Finish setup" bar).
  // Finance opens the investor-preferences WIZARD and carries the specific
  // capability route as its `from` (the wizard reads it for re-entry + its own
  // back affordance); every other capability carries the hub path `/one/setup`.
  const target =
    handoffTarget === ROUTES.ONE_SETUP_KAI
      ? `${handoffTarget}?from=${encodeURIComponent(
          buildOneSetupCapabilityRoute(capabilityId),
        )}`
      : `${handoffTarget}${handoffTarget.includes("?") ? "&" : "?"}from=${ROUTES.ONE_SETUP}`;

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

        // NOTE: we intentionally do NOT resolve the account-wide master setup
        // gate here. Forwarding into a hard-gated `/one/*` surface is handled by
        // the `?from=setup` marker on `target` (which `OneOnboardingGuard`
        // allows through) — see the component doc comment. Marking
        // `setupCompleted = true` on capability entry was the cause of the
        // dashboard "Finish setup" bar clearing prematurely.
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
