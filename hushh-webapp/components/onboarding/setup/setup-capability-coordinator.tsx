"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { RouteLoadingState } from "@/components/app-ui/route-loading-state";
import { SetupCompletionFooter } from "@/components/onboarding/setup/setup-completion-footer";
import { useLocalOnboardingActionHandler } from "@/lib/agent/local-onboarding-actions";
import { useAuth } from "@/lib/firebase/auth-context";
import {
  buildOneSetupCapabilityRoute,
  resolveCapabilityHandoffTarget,
  ROUTES,
} from "@/lib/navigation/routes";
import { type OneSetupCapabilityId } from "@/lib/onboarding/setup-capability-ids";
import { CapabilityTourService } from "@/lib/services/capability-tour-service";
import { PreVaultUserStateService } from "@/lib/services/pre-vault-user-state-service";
import { usePublishVoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";

type Settlement = {
  status: "started" | "succeeded" | "blocked" | "failed";
  summary: string;
  routeAfter?: string;
  screenAfter?: string;
};

export type SetupCapabilityCoordinator = {
  isReady: boolean;
  /** A verified feature result, optionally recovered from a typed callback. */
  operationallyReady: boolean;
  isSettling: boolean;
  finish: () => Promise<Settlement>;
  skip: () => Promise<Settlement>;
};

export function setupCapabilityTerminalActionId(
  kind: "finish" | "skip",
  capabilityId: OneSetupCapabilityId,
): `setup.${"finish" | "skip"}_${string}` {
  return `setup.${kind}_${capabilityId.replaceAll("-", "_")}`;
}

type UseSetupCapabilityCoordinatorParams = {
  capabilityId: OneSetupCapabilityId;
  /** A real feature result. A route visit or callback hint is never sufficient. */
  isOperationallyReady: boolean;
  finishActionId: `setup.finish_${string}`;
  skipActionId: `setup.skip_${string}`;
  /**
   * Finance source settlement is durable journey state, so an interrupted
   * import can resume its Finish action after a refresh. Other capabilities
   * re-check their own real connector/permission/profile state instead.
   */
  resumeReadinessFromCallback?: boolean;
  /** Legacy compatibility surfaces keep their own route policy. */
  enabled?: boolean;
  /** A capability may have more than one physical setup workspace. */
  screenId?: string;
  /** Allow a resolved root setup to re-enter this capability's own workspace. */
  allowResolvedRootReentry?: boolean;
  /** Feature-owned terminals may use a stable authored control id. */
  terminalControlId?: (ready: boolean) => string;
};

const SETUP_CAPABILITY_SCREEN: Record<OneSetupCapabilityId, string> = {
  gmail: "one_setup_gmail",
  location: "one_setup_location",
  email: "one_setup_email",
  finance: "one_setup_finance_import",
  ria: "one_setup_ria",
  "connected-systems": "one_setup_connected_systems",
};

function setupCapabilityLabel(capabilityId: OneSetupCapabilityId): string {
  if (capabilityId === "email") return "KYC";
  if (capabilityId === "connected-systems") return "Connected Systems";
  return `${capabilityId.charAt(0).toUpperCase()}${capabilityId.slice(1)}`;
}

/**
 * One small journey authority for every physical setup workspace.
 *
 * Feature bodies own their connector, consent, vault, and native operations.
 * This hook owns only the redacted setup record and the hub return. Keeping
 * that boundary here prevents each feature route from inventing completion
 * URLs, browser-history back behavior, or a second onboarding router.
 */
export function useSetupCapabilityCoordinator({
  capabilityId,
  isOperationallyReady,
  finishActionId,
  skipActionId,
  resumeReadinessFromCallback = false,
  enabled = true,
  screenId,
  allowResolvedRootReentry = false,
  terminalControlId,
}: UseSetupCapabilityCoordinatorParams): SetupCapabilityCoordinator {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const [isReady, setIsReady] = useState(false);
  const [isSettling, setIsSettling] = useState(false);
  const [callbackReadiness, setCallbackReadiness] = useState(false);

  const operationallyReady = isOperationallyReady || callbackReadiness;
  // Same-session setup transitions reuse the redacted bootstrap record already
  // hydrated by the app runtime. Cold entry waits once; explicit settlement
  // retains the force-refresh + version checks for durable correctness.
  const cachedJourney = user?.uid
    ? PreVaultUserStateService.getCachedBootstrapState?.(user.uid) ?? null
    : null;
  const hasUsableCachedJourney = Boolean(
    enabled &&
      cachedJourney &&
      !PreVaultUserStateService.isSetupResolved(cachedJourney),
  );
  const routeReady = isReady || hasUsableCachedJourney;

  const canonicalRoute = useMemo(
    () => buildOneSetupCapabilityRoute(capabilityId),
    [capabilityId],
  );

  useEffect(() => {
    if (!enabled) return;
    if (authLoading) return;
    if (!user?.uid) {
      router.replace(`${ROUTES.LOGIN}?redirect=${encodeURIComponent(canonicalRoute)}`);
      return;
    }

    let cancelled = false;
    setCallbackReadiness(false);
    void (async () => {
      try {
        const journey =
          cachedJourney ??
          (await PreVaultUserStateService.bootstrapState(user.uid));
        if (cancelled) return;

        const canResumeCallbackReadiness =
          resumeReadinessFromCallback &&
          journey.onboardingActiveCapability === capabilityId &&
          journey.onboardingCallbackState === "succeeded";

        if (PreVaultUserStateService.isSetupResolved(journey)) {
          if (!allowResolvedRootReentry) {
            router.replace(resolveCapabilityHandoffTarget(capabilityId));
            return;
          }
          // A root-level skip never resolves an active capability. Preserve a
          // completed external source on a refresh so its terminal Finish is
          // still available instead of silently sending the person to Kai.
          if (canResumeCallbackReadiness && !cancelled) {
            setCallbackReadiness(true);
          }
          if (!cancelled) setIsReady(true);
          return;
        }

        if (canResumeCallbackReadiness) {
          if (!cancelled) {
            setCallbackReadiness(true);
            setIsReady(true);
          }
          return;
        }

        // A person may deliberately switch tasks from the hub. This replaces
        // the active goal; it never fabricates completion for the old task.
        // Avoid a redundant write on a same-route refresh.
        const alreadyActive =
          journey.onboardingPhase === "capability_setup" &&
          journey.onboardingActiveCapability === capabilityId &&
          journey.onboardingCallbackState === "none";
        if (!alreadyActive) {
          await PreVaultUserStateService.syncOnboardingJourney({
            userId: user.uid,
            phase: "capability_setup",
            activeCapability: capabilityId,
            callbackState: "none",
            expectedJourneyUpdatedAt: journey.onboardingJourneyUpdatedAt,
          });
        }
        if (!cancelled) setIsReady(true);
      } catch (error) {
        console.warn("[SetupCapabilityCoordinator] Failed to prepare setup:", error);
        if (!cancelled) {
          toast.error("This setup could not be prepared. Please try again.");
          router.replace(ROUTES.ONE_SETUP);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    authLoading,
    cachedJourney,
    canonicalRoute,
    capabilityId,
    enabled,
    allowResolvedRootReentry,
    resumeReadinessFromCallback,
    router,
    user?.uid,
  ]);

  const settle = useCallback(
    async (kind: "finish" | "skip"): Promise<Settlement> => {
      if (!user?.uid) {
        return { status: "blocked", summary: "Sign in to continue setup." };
      }
      if (isSettling) {
        return { status: "blocked", summary: "This setup is already being settled." };
      }
      if (kind === "finish" && !operationallyReady) {
        return {
          status: "blocked",
          summary: `Complete the required ${capabilityId} step before finishing setup.`,
        };
      }

      setIsSettling(true);
      try {
        const journey = await PreVaultUserStateService.bootstrapState(user.uid, {
          force: true,
        });
        if (journey.onboardingActiveCapability !== capabilityId) {
          router.replace(ROUTES.ONE_SETUP);
          return {
            status: "blocked",
            summary: "A different setup is active. Returning to setup.",
            routeAfter: ROUTES.ONE_SETUP,
          };
        }

        if (kind === "finish") {
          const completed = Array.from(
            new Set([...journey.setupCapabilityIds, capabilityId]),
          ).sort();
          await PreVaultUserStateService.settleOnboardingCapability({
            userId: user.uid,
            capabilityId,
            completedCapabilityIds: completed,
            expectedJourneyUpdatedAt: journey.onboardingJourneyUpdatedAt,
            callbackState: "succeeded",
          });
          await CapabilityTourService.markExplored(user.uid, capabilityId);
        } else {
          await PreVaultUserStateService.settleOnboardingCapability({
            userId: user.uid,
            capabilityId,
            expectedJourneyUpdatedAt: journey.onboardingJourneyUpdatedAt,
            callbackState: "none",
          });
        }

        router.replace(ROUTES.ONE_SETUP);
        return {
          status: "succeeded",
          summary:
            kind === "finish"
              ? "Setup is complete. Returning to setup."
              : "Skipped for now. Returning to setup.",
          routeAfter: ROUTES.ONE_SETUP,
          screenAfter: "one_setup_hub",
        };
      } catch (error) {
        console.warn("[SetupCapabilityCoordinator] Failed to settle setup:", error);
        const stale = error instanceof Error && /stale onboarding journey/i.test(error.message);
        return {
          status: stale ? "blocked" : "failed",
          summary: stale
            ? "This setup changed in another session. Returning to setup."
            : "Setup could not be saved. Please try again.",
          ...(stale ? { routeAfter: ROUTES.ONE_SETUP } : {}),
        };
      } finally {
        setIsSettling(false);
      }
    },
    [capabilityId, isSettling, operationallyReady, router, user?.uid],
  );

  const finish = useCallback(() => settle("finish"), [settle]);
  const skip = useCallback(() => settle("skip"), [settle]);
  useLocalOnboardingActionHandler(finishActionId, finish, { enabled });
  useLocalOnboardingActionHandler(skipActionId, skip, { enabled });

  const visibleActionId = operationallyReady ? finishActionId : skipActionId;
  const visibleLabel = operationallyReady
    ? `Finish ${setupCapabilityLabel(capabilityId)} setup`
    : `Skip ${setupCapabilityLabel(capabilityId)} setup`;
  const routeSurfaceMetadata = useMemo(
    () =>
      !enabled || !routeReady
        ? null
        : {
            screenId: screenId || SETUP_CAPABILITY_SCREEN[capabilityId],
            title: `${setupCapabilityLabel(capabilityId)} setup`,
            purpose: "Complete this bounded setup or return safely to setup.",
            actions: [
              {
                id: visibleActionId,
                actionId: visibleActionId,
                label: visibleLabel,
                purpose: operationallyReady
                  ? "Record verified capability completion and return to setup."
                  : "Leave this capability pending and return to setup.",
              },
            ],
            controls: [
              {
                id:
                  terminalControlId?.(operationallyReady) ||
                  `one-setup-${capabilityId}-terminal`,
                label: visibleLabel,
                type: "button",
                actionId: visibleActionId,
                purpose: operationallyReady
                  ? "Finish verified setup."
                  : "Skip setup for now.",
              },
            ],
            availableActions: [visibleLabel],
          },
    [
      capabilityId,
      enabled,
      routeReady,
      operationallyReady,
      screenId,
      terminalControlId,
      visibleActionId,
      visibleLabel,
    ],
  );
  usePublishVoiceSurfaceMetadata(
    routeSurfaceMetadata,
  );

  return { isReady: routeReady, operationallyReady, isSettling, finish, skip };
}

type SetupCapabilityTerminalFooterProps = {
  capabilityId: OneSetupCapabilityId;
  isOperationallyReady: boolean;
  coordinator: SetupCapabilityCoordinator;
};

/** Shared explicit Finish/Skip boundary, not a route query or header back button. */
export function SetupCapabilityTerminalFooter({
  capabilityId,
  isOperationallyReady,
  coordinator,
}: SetupCapabilityTerminalFooterProps) {
  const operationallyReady =
    isOperationallyReady || coordinator.operationallyReady;
  const label = operationallyReady
    ? `Finish ${setupCapabilityLabel(capabilityId)} setup`
    : `Skip ${setupCapabilityLabel(capabilityId)} setup`;
  const actionId = setupCapabilityTerminalActionId(
    operationallyReady ? "finish" : "skip",
    capabilityId,
  );

  return (
    <SetupCompletionFooter
      label={label}
      onComplete={() => {
        void (operationallyReady ? coordinator.finish() : coordinator.skip());
      }}
      busy={coordinator.isSettling}
      controlId={`one-setup-${capabilityId}-terminal`}
      actionId={actionId}
      purpose={
        operationallyReady
          ? `Finish ${capabilityId} setup and return to setup.`
          : `Skip ${capabilityId} setup for now and return to setup.`
      }
      supportingText={
        operationallyReady
          ? "This capability is ready. You can return to setup."
          : "You can return to this setup any time."
      }
      variant={operationallyReady ? "blue-gradient" : "none"}
      effect={operationallyReady ? "fill" : "fade"}
    />
  );
}

export function SetupCapabilityLoading({ label }: { label: string }) {
  return <RouteLoadingState label={label} surface="onboarding" />;
}
