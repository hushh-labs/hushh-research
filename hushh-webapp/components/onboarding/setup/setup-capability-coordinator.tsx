"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { RouteLoadingState } from "@/components/app-ui/route-loading-state";
import { SetupCompletionFooter } from "@/components/onboarding/setup/setup-completion-footer";
import { useLocalOnboardingActionHandler } from "@/lib/agent/local-onboarding-actions";
import { useAuth } from "@/lib/firebase/auth-context";
import { requestInternalAppNavigation } from "@/lib/utils/browser-navigation";
import {
  buildOneSetupCapabilityRoute,
  resolveCapabilityHandoffTarget,
  resolveCompletedSetupCapabilityEntry,
  ROUTES,
} from "@/lib/navigation/routes";
import { type OneSetupCapabilityId } from "@/lib/onboarding/setup-capability-ids";
import { CapabilityTourService } from "@/lib/services/capability-tour-service";
import { ApiError, apiErrorCode } from "@/lib/services/api-client";
import {
  PreVaultUserStateService,
  type PreVaultUserState,
} from "@/lib/services/pre-vault-user-state-service";
import { deriveVoiceRouteScreen } from "@/lib/voice/route-screen-derivation";
import { usePublishVoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";

type Settlement = {
  status: "started" | "succeeded" | "blocked" | "failed";
  summary: string;
  routeAfter?: string;
  screenAfter?: string;
};

type SetupSettlementOptions = {
  /**
   * A physical setup surface may own one promise toast for the whole durable
   * settlement. Keep the coordinator's default recovery toast for every
   * other caller, including local action and voice pathways.
   */
  suppressErrorToast?: boolean;
};

export type SetupCapabilityCoordinator = {
  isReady: boolean;
  /** Durable completion detected before the feature-owned setup body mounts. */
  isAlreadyComplete: boolean;
  /** A verified feature result, optionally recovered from a typed callback. */
  operationallyReady: boolean;
  isSettling: boolean;
  finish: (options?: SetupSettlementOptions) => Promise<Settlement>;
  skip: (options?: SetupSettlementOptions) => Promise<Settlement>;
  /** Idempotent return used by a completed-entry acknowledgement. */
  returnToSetup: () => void;
};

export type SetupCapabilityJourneyMode = "auto" | "root" | "individual";

export function resolveSetupCapabilityJourneyMode(
  requestedMode: SetupCapabilityJourneyMode,
  setupResolved: boolean,
): Exclude<SetupCapabilityJourneyMode, "auto"> {
  if (requestedMode !== "auto") return requestedMode;
  return setupResolved ? "individual" : "root";
}

export function hasUnresolvedRootSetup(
  journey: PreVaultUserState | null | undefined,
): boolean {
  return !PreVaultUserStateService.isSetupResolved(journey);
}

export function resolveSetupCapabilityReturnTarget({
  capabilityId,
  journeyMode,
  hasExplicitIncompleteSetup,
}: {
  capabilityId: OneSetupCapabilityId;
  journeyMode: Exclude<SetupCapabilityJourneyMode, "auto">;
  hasExplicitIncompleteSetup: boolean;
}): string {
  if (journeyMode === "individual") return ROUTES.ONE_HOME;
  if (hasExplicitIncompleteSetup) return ROUTES.ONE_SETUP;
  return resolveCapabilityHandoffTarget(capabilityId);
}

const LAND_ON_WORKSPACE_AFTER_FINISH: ReadonlySet<OneSetupCapabilityId> =
  new Set<OneSetupCapabilityId>(["location"]);

export function resolveSetupCapabilityTerminalTarget({
  capabilityId,
  journeyMode,
  hasExplicitIncompleteSetup,
  kind,
}: {
  capabilityId: OneSetupCapabilityId;
  journeyMode: Exclude<SetupCapabilityJourneyMode, "auto">;
  hasExplicitIncompleteSetup: boolean;
  kind: "finish" | "skip";
}): string {
  // A capability may prefer to hand off straight to its own workspace after a
  // Finish (e.g. Location). That shortcut is only safe once the overall
  // first-run setup is actually resolved. If setup is still explicitly
  // incomplete — the master "Finish setup" (which requires Connections) has
  // not been completed yet — finishing an individual capability like Location
  // must return the user to the /one/setup hub, never jump into the workspace.
  if (
    kind === "finish" &&
    journeyMode !== "individual" &&
    !hasExplicitIncompleteSetup &&
    LAND_ON_WORKSPACE_AFTER_FINISH.has(capabilityId)
  ) {
    return resolveCapabilityHandoffTarget(capabilityId);
  }

  return resolveSetupCapabilityReturnTarget({
    capabilityId,
    journeyMode,
    hasExplicitIncompleteSetup,
  });
}

export function resolveSetupCapabilityTerminalScreen(targetRoute: string) {
  const screen = deriveVoiceRouteScreen(targetRoute).screen;
  return screen === "unknown" ? undefined : screen;
}

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
  /** Blocks tap and voice settlement while feature-owned state is mutating. */
  settlementBlocked?: boolean;
  /** A capability may have more than one physical setup workspace. */
  screenId?: string;
  /**
   * Root setup returns to the setup hub. Individual setup is an intentional
   * post-onboarding re-entry and returns to One. Auto derives the mode from
   * the freshly revalidated account setup state.
   */
  journeyMode?: SetupCapabilityJourneyMode;
  /** Feature-owned terminals may use a stable authored control id. */
  terminalControlId?: (ready: boolean) => string;
  /** Auto-settling experiences publish the action without inventing a button. */
  terminalPresentation?: "explicit" | "automatic";
};

const SETUP_CAPABILITY_SCREEN: Record<OneSetupCapabilityId, string> = {
  gmail: "one_setup_gmail",
  calendar: "one_setup_calendar",
  location: "one_setup_location",
  email: "one_setup_email",
  finance: "one_setup_finance_import",
  ria: "one_setup_ria",
  "connected-systems": "one_setup_connected_systems",
};

function setupCapabilityLabel(capabilityId: OneSetupCapabilityId): string {
  if (capabilityId === "email") return "KYC";
  if (capabilityId === "connected-systems") return "CRM";
  return `${capabilityId.charAt(0).toUpperCase()}${capabilityId.slice(1)}`;
}

function isOnboardingJourneyConflict(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 409 &&
    apiErrorCode(error) === "STALE_ONBOARDING_JOURNEY"
  );
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
  settlementBlocked = false,
  screenId,
  journeyMode = "auto",
  terminalControlId,
  terminalPresentation = "explicit",
}: UseSetupCapabilityCoordinatorParams): SetupCapabilityCoordinator {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const userId = user?.uid;
  const [isReady, setIsReady] = useState(false);
  const [isSettling, setIsSettling] = useState(false);
  const [callbackReadiness, setCallbackReadiness] = useState(false);
  const [confirmedCompletionKey, setConfirmedCompletionKey] = useState<
    string | null
  >(null);

  const operationallyReady = isOperationallyReady || callbackReadiness;
  // Same-session setup transitions reuse the redacted bootstrap record already
  // hydrated by the app runtime. Cold entry waits once; explicit settlement
  // retains the force-refresh + version checks for durable correctness.
  const cachedJourney = userId
    ? PreVaultUserStateService.getCachedBootstrapState?.(userId) ?? null
    : null;
  const cachedCompletedEntry = resolveCompletedSetupCapabilityEntry({
    capabilityId,
    completedCapabilityIds: cachedJourney?.setupCapabilityIds ?? [],
    rootSetupResolved:
      PreVaultUserStateService.isSetupResolved(cachedJourney),
  });
  const cachedCompletedTarget =
    cachedCompletedEntry.kind === "redirect"
      ? cachedCompletedEntry.target
      : null;
  const completionKey = userId ? `${userId}:${capabilityId}` : null;
  const isAlreadyComplete =
    cachedCompletedEntry.kind === "acknowledge" ||
    (cachedCompletedEntry.kind === "continue" &&
      completionKey !== null &&
      confirmedCompletionKey === completionKey);
  const hasUsableCachedJourney = Boolean(
    enabled &&
      cachedJourney &&
      !cachedCompletedTarget &&
      !PreVaultUserStateService.isSetupResolved(cachedJourney),
  );
  const routeReady = isReady || hasUsableCachedJourney || isAlreadyComplete;

  const canonicalRoute = useMemo(
    () => buildOneSetupCapabilityRoute(capabilityId),
    [capabilityId],
  );

  const replaceRoute = useCallback(
    (href: string) => {
      const requested = requestInternalAppNavigation({
        href,
        replace: true,
        scroll: false,
        source: "programmatic",
        transitionMode: "full",
      });
      if (!requested) router.replace(href);
    },
    [router],
  );
  const returnToSetup = useCallback(() => {
    replaceRoute(ROUTES.ONE_SETUP);
  }, [replaceRoute]);

  useEffect(() => {
    if (!enabled) return;
    if (authLoading) return;
    if (!userId) {
      replaceRoute(`${ROUTES.LOGIN}?redirect=${encodeURIComponent(canonicalRoute)}`);
      return;
    }

    let cancelled = false;
    setCallbackReadiness(false);
    void (async () => {
      try {
        const initialJourney =
          cachedJourney ??
          (await PreVaultUserStateService.bootstrapState(userId));
        if (cancelled) return;
        const completedEntry = resolveCompletedSetupCapabilityEntry({
          capabilityId,
          completedCapabilityIds: initialJourney.setupCapabilityIds,
          rootSetupResolved:
            PreVaultUserStateService.isSetupResolved(initialJourney),
        });
        if (completedEntry.kind === "redirect") {
          replaceRoute(completedEntry.target);
          return;
        }
        if (completedEntry.kind === "acknowledge") {
          setConfirmedCompletionKey(`${userId}:${capabilityId}`);
          setIsReady(true);
          return;
        }
        setConfirmedCompletionKey(null);
        const prepare = async (
          journey: typeof initialJourney,
          retryConflict: boolean,
        ): Promise<void> => {
          if (cancelled) return;
          const canResumeCallbackReadiness =
            resumeReadinessFromCallback &&
            journey.onboardingActiveCapability === capabilityId &&
            journey.onboardingCallbackState === "succeeded";

          if (PreVaultUserStateService.isSetupResolved(journey)) {
            if (canResumeCallbackReadiness) setCallbackReadiness(true);
            setIsReady(true);
            return;
          }

          if (canResumeCallbackReadiness) {
            setCallbackReadiness(true);
            setIsReady(true);
            return;
          }

          const alreadyActive =
            journey.onboardingPhase === "capability_setup" &&
            journey.onboardingActiveCapability === capabilityId &&
            journey.onboardingCallbackState === "none";
          if (alreadyActive) {
            setIsReady(true);
            return;
          }

          try {
            await PreVaultUserStateService.syncOnboardingJourney({
              userId,
              phase: "capability_setup",
              activeCapability: capabilityId,
              callbackState: "none",
              expectedJourneyUpdatedAt: journey.onboardingJourneyUpdatedAt,
            });
            if (!cancelled) setIsReady(true);
          } catch (error) {
            if (!retryConflict || !isOnboardingJourneyConflict(error)) throw error;
            const fresh = await PreVaultUserStateService.bootstrapState(userId, {
              force: true,
            });
            await prepare(fresh, false);
          }
        };

        await prepare(initialJourney, true);
      } catch (error) {
        console.warn("[SetupCapabilityCoordinator] Failed to prepare setup:", error);
        if (!cancelled) {
          toast.error("This setup could not be prepared. Please try again.");
          replaceRoute(ROUTES.ONE_SETUP);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    authLoading,
    cachedJourney,
    cachedCompletedTarget,
    canonicalRoute,
    capabilityId,
    enabled,
    journeyMode,
    resumeReadinessFromCallback,
    replaceRoute,
    userId,
  ]);

  const settle = useCallback(
    async (
      kind: "finish" | "skip",
      options: SetupSettlementOptions = {},
    ): Promise<Settlement> => {
      if (!userId) {
        return { status: "blocked", summary: "Sign in to continue setup." };
      }
      if (isSettling) {
        return { status: "blocked", summary: "This setup is already being settled." };
      }
      if (settlementBlocked) {
        return {
          status: "blocked",
          summary: "This setup is still saving. Wait for it to finish.",
        };
      }
      if (kind === "finish" && !operationallyReady) {
        return {
          status: "blocked",
          summary: `Complete the required ${capabilityId} step before finishing setup.`,
        };
      }

      setIsSettling(true);
      try {
        const journey = await PreVaultUserStateService.bootstrapState(userId, {
          force: true,
        });
        const resolvedJourneyMode = resolveSetupCapabilityJourneyMode(
          journeyMode,
          PreVaultUserStateService.isSetupResolved(journey),
        );

        if (
          resolvedJourneyMode === "root" &&
          journey.onboardingActiveCapability !== capabilityId
        ) {
          replaceRoute(ROUTES.ONE_SETUP);
          return {
            status: "blocked",
            summary: "A different setup is active. Returning to setup.",
            routeAfter: ROUTES.ONE_SETUP,
          };
        }

        if (resolvedJourneyMode === "individual") {
          if (kind === "finish") {
            const completed = Array.from(
              new Set([...journey.setupCapabilityIds, capabilityId]),
            ).sort();
            await PreVaultUserStateService.syncSetupCapabilities(
              userId,
              completed,
            );
            await CapabilityTourService.markExplored(userId, capabilityId);
          }
        } else if (kind === "finish") {
          const completed = Array.from(
            new Set([...journey.setupCapabilityIds, capabilityId]),
          ).sort();
          await PreVaultUserStateService.settleOnboardingCapability({
            userId,
            capabilityId,
            completedCapabilityIds: completed,
            expectedJourneyUpdatedAt: journey.onboardingJourneyUpdatedAt,
            callbackState: "succeeded",
          });
          await CapabilityTourService.markExplored(userId, capabilityId);
        } else {
          await PreVaultUserStateService.settleOnboardingCapability({
            userId,
            capabilityId,
            expectedJourneyUpdatedAt: journey.onboardingJourneyUpdatedAt,
            callbackState: "none",
          });
        }

        const hasExplicitIncompleteSetup = hasUnresolvedRootSetup(journey);

        // If the user already completed onboarding, always send them to their landing target instead of the setup hub.
        const targetRoute = resolveSetupCapabilityTerminalTarget({
          capabilityId,
          journeyMode: resolvedJourneyMode,
          hasExplicitIncompleteSetup,
          kind,
        });

        replaceRoute(targetRoute);
        return {
          status: "succeeded",
          summary:
            kind === "finish" && targetRoute === ROUTES.ONE_LOCATION
              ? "Setup is complete. Opening Location."
              : kind === "finish"
              ? resolvedJourneyMode === "individual"
                ? "Setup is complete. Returning to One."
                : "Setup is complete. Returning to setup."
              : resolvedJourneyMode === "individual"
                ? "Skipped for now. Returning to One."
                : "Skipped for now. Returning to setup.",
          routeAfter: targetRoute,
          screenAfter: resolveSetupCapabilityTerminalScreen(targetRoute),
        };
      } catch (error) {
        console.warn("[SetupCapabilityCoordinator] Failed to settle setup:", error);
        const stale = isOnboardingJourneyConflict(error);
        if (!options.suppressErrorToast) {
          toast.error(
            stale
              ? "Setup changed in another session. Please try again."
              : "Setup could not be saved. Please try again.",
          );
        }
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
    [
      capabilityId,
      isSettling,
      operationallyReady,
      replaceRoute,
      settlementBlocked,
      journeyMode,
      userId,
    ],
  );

  const finish = useCallback(
    (options?: SetupSettlementOptions) => settle("finish", options),
    [settle],
  );
  const skip = useCallback(
    (options?: SetupSettlementOptions) => settle("skip", options),
    [settle],
  );
  useLocalOnboardingActionHandler(finishActionId, finish, {
    enabled:
      enabled && routeReady && !settlementBlocked && !isAlreadyComplete,
  });
  useLocalOnboardingActionHandler(skipActionId, skip, {
    enabled:
      enabled && routeReady && !settlementBlocked && !isAlreadyComplete,
  });

  const visibleActionId = operationallyReady ? finishActionId : skipActionId;
  const visibleLabel = operationallyReady
    ? `Finish ${setupCapabilityLabel(capabilityId)} setup`
    : `Skip ${setupCapabilityLabel(capabilityId)} setup`;
  const routeSurfaceMetadata = useMemo(
    () =>
      !enabled || !routeReady || isAlreadyComplete
        ? null
        : {
            screenId: screenId || SETUP_CAPABILITY_SCREEN[capabilityId],
            title: `${setupCapabilityLabel(capabilityId)} setup`,
            purpose: "Complete this bounded setup or return safely to setup.",
            actions: settlementBlocked ? [] : [
              {
                id: visibleActionId,
                actionId: visibleActionId,
                label: visibleLabel,
                purpose: operationallyReady
                  ? "Record verified capability completion and return to setup."
                  : "Leave this capability pending and return to setup.",
              },
            ],
            controls: settlementBlocked || terminalPresentation === "automatic" ? [] : [
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
            availableActions: settlementBlocked ? [] : [visibleLabel],
          },
    [
      capabilityId,
      enabled,
      isAlreadyComplete,
      routeReady,
      operationallyReady,
      settlementBlocked,
      screenId,
      terminalControlId,
      terminalPresentation,
      visibleActionId,
      visibleLabel,
    ],
  );
  usePublishVoiceSurfaceMetadata(
    routeSurfaceMetadata,
  );

  return {
    isReady: routeReady,
    isAlreadyComplete,
    operationallyReady,
    isSettling,
    finish,
    skip,
    returnToSetup,
  };
}

type SetupCapabilityTerminalFooterProps = {
  capabilityId: OneSetupCapabilityId;
  isOperationallyReady: boolean;
  coordinator: SetupCapabilityCoordinator;
  pending?: boolean;
  skipLabel?: string;
  finishLabel?: string;
};

/** Shared explicit Finish/Skip boundary, not a route query or header back button. */
export function SetupCapabilityTerminalFooter({
  capabilityId,
  isOperationallyReady,
  coordinator,
  pending = false,
  skipLabel,
  finishLabel,
}: SetupCapabilityTerminalFooterProps) {
  const operationallyReady =
    isOperationallyReady || coordinator.operationallyReady;
  const label = operationallyReady
    ? finishLabel ?? `Finish ${setupCapabilityLabel(capabilityId)} setup`
    : skipLabel ?? `Skip ${setupCapabilityLabel(capabilityId)} setup`;
  const actionId = setupCapabilityTerminalActionId(
    operationallyReady ? "finish" : "skip",
    capabilityId,
  );

  return (
    <SetupCompletionFooter
      label={label}
      onComplete={() => {
        if (pending) return;
        void (operationallyReady ? coordinator.finish() : coordinator.skip());
      }}
      busy={coordinator.isSettling || pending}
      disabled={pending}
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
