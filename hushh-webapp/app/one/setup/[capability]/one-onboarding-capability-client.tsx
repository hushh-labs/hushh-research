"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { RouteLoadingState } from "@/components/app-ui/route-loading-state";
import { OnboardingCapabilityStep } from "@/components/onboarding/setup/onboarding-capability-step";
import { useLocalOnboardingActionHandler } from "@/lib/agent/local-onboarding-actions";
import { useAuth } from "@/lib/firebase/auth-context";
import { useVault } from "@/lib/vault/vault-context";
import { getOneSetupCapability } from "@/lib/onboarding/one-capabilities";
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
 * When the setup CTA forwards into a product surface
 * (`/one/<capability>`, e.g. `/one/gmail`, `/one/location`,
 * `/one/connected-systems`), we tag the URL with `?from=/one/setup` (the hub
 * path) as navigation history only. Durable active-capability state supplies
 * admission authority; the top-bar uses the marker to return through this
 * capability's explicit terminal acknowledgement.
 *
 * Finance stays on the setup surface through `/one/setup/kai`. RIA leaves the
 * `/one/*` family, but admission is still bounded by the durable active
 * capability record rather than by query-string history.
 */
export function OneOnboardingCapabilityClient({
  capabilityId,
}: {
  capabilityId: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user } = useAuth();
  const { isVaultUnlocked } = useVault();
  const [busy, setBusy] = useState(false);

  const capability = getOneSetupCapability(capabilityId);
  const completion = searchParams.get("finish") === "1";

  // The step collects nothing and renders pre-vault, but if this capability's
  // workspace reads vault-backed data and the vault is currently locked, set the
  // honest "private setup comes next" expectation. The destination guard owns
  // the actual vault access prompt.
  const needsVaultUnlock =
    capability?.requiresVault === true && !isVaultUnlocked;
  const handoffTarget = resolveCapabilityHandoffTarget(capabilityId);
  // Forward target for this capability, tagged with the setup-hub ORIGIN so:
  //  (1) the top-bar back retraces to the hub — "jaise aaya waise wapas" — for
  //      EVERY capability (Gmail, drafting, Location, RIA, and tools),
  //      instead of falling back to Profile/dashboard; and
  //  (2) the durable active-capability record lets `OneOnboardingGuard` admit
  //      only this capability's bounded route family without resolving the
  //      account-wide master gate.
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

  const runPrimary = async () => {
    const userId = user?.uid ?? null;

    // Auth/lock guards own the unauthenticated path; if we somehow have no user,
    // just forward so the user is never stranded on this screen.
    if (!userId) {
      router.replace(target);
      return { status: "started" as const, summary: "Opening the capability." };
    }

    setBusy(true);

    try {
      if (completion) {
        const durableState = await PreVaultUserStateService.bootstrapState(
          userId,
          { force: true },
        );
        if (durableState.onboardingActiveCapability !== capabilityId) {
          router.replace(ROUTES.ONE_SETUP);
          return {
            status: "blocked" as const,
            summary:
              "This finish step no longer matches the active setup. Returning to setup.",
            routeAfter: ROUTES.ONE_SETUP,
          };
        }
        await CapabilityTourService.markExplored(userId, capabilityId);
        const localIds = await CapabilityTourService.loadExploredIds(userId);
        const completedIds = Array.from(
          new Set([
            ...durableState.setupCapabilityIds,
            ...localIds,
            capabilityId,
          ]),
        ).sort();
        await PreVaultUserStateService.syncSetupCapabilities(
          userId,
          completedIds,
        );
        await PreVaultUserStateService.syncOnboardingJourney({
          userId,
          phase: "setup_hub",
          activeCapability: null,
        });
        router.replace(ROUTES.ONE_SETUP);
        return {
          status: "started" as const,
          summary: `${capability?.title || capabilityId} setup is finished. Returning to setup.`,
          routeAfter: ROUTES.ONE_SETUP,
          screenAfter: "one_setup_hub",
        };
      }

      // Mark this visit as seen, but do not mark the capability complete.
      // Every capability writes setupCapabilityIds only from its terminal
      // "Finish <capability> setup" acknowledgement.
      OneSetupGateService.markSeen(userId);
      await PreVaultUserStateService.syncOnboardingJourney({
        userId,
        phase: "capability_setup",
        activeCapability: capabilityId,
      });

      // NOTE: we intentionally do NOT resolve the account-wide master setup
      // gate here. The durable active-capability record authorizes only this
      // bounded route family; the query marker is navigation history. Marking
      // `setupCompleted=true` here previously cleared the root gate too early.
      router.replace(target);
      return {
        status: "started" as const,
        summary: `Opening ${capability?.title || capabilityId}.`,
        routeAfter: target,
      };
    } catch (resolveError) {
      console.warn(
        "[OneOnboardingCapabilityClient] Failed to record capability signal:",
        resolveError,
      );
      return {
        status: "failed" as const,
        summary:
          "This setup step could not save its progress. Please try again.",
      };
    } finally {
      setBusy(false);
    }
  };

  // Voice parity: "continue" / "got it" on this step drives the exact same
  // forwarding logic as tapping the Set up or Finish setup button. Registered
  // before the `!capability` early return below to satisfy Rules of Hooks
  // (this hook must run unconditionally on every render of this component).
  useLocalOnboardingActionHandler("setup.capability_continue", async () => {
    if (!capability) {
      return { status: "blocked", summary: "This setup step isn't open yet." };
    }
    if (busy) {
      return { status: "blocked", summary: "Already continuing, one moment." };
    }
    return runPrimary();
  });

  if (!capability) {
    return <RouteLoadingState label="Preparing setup…" />;
  }

  const handleBack = () => {
    if (!completion || !user?.uid) {
      router.replace(ROUTES.ONE_SETUP);
      return;
    }
    // Leaving the terminal screen is a cancellation, not completion. Clear the
    // active capability so the hub is reachable without falsely adding it to
    // setupCapabilityIds.
    setBusy(true);
    void PreVaultUserStateService.syncOnboardingJourney({
      userId: user.uid,
      phase: "setup_hub",
      activeCapability: null,
    })
      .then(() => router.replace(ROUTES.ONE_SETUP))
      .catch((error) => {
        console.warn(
          "[OneOnboardingCapabilityClient] Failed to cancel capability finish:",
          error,
        );
        setBusy(false);
      });
  };

  const handlePrimary = () => {
    if (busy) return;
    void runPrimary();
  };

  return (
    <OnboardingCapabilityStep
      capabilityId={capabilityId}
      onPrimary={handlePrimary}
      onBack={handleBack}
      busy={busy}
      needsVaultUnlock={needsVaultUnlock}
      completion={completion}
    />
  );
}
