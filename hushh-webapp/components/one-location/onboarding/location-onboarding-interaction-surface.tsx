"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from "react";
import { Loader2, MapPin, X } from "lucide-react";
import { Capacitor } from "@capacitor/core";

import { LocationCircleNameInputCard } from "@/components/agent/location-circle-name-input-card";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useAuth } from "@/hooks/use-auth";
import { useAgentVoiceState } from "@/lib/agent/agent-voice-state";
import { requestInternalAppNavigation } from "@/lib/utils/browser-navigation";
import {
  ONE_LOCATION_ONBOARDING_WORKFLOW_ID,
  ONE_LOCATION_SERVER_DIRECTIVE_CATALOG,
  OneLocationOnboardingRunClient,
  createLocalLocationInteractionDirective,
  createServerLocationInteractionDirective,
  type LocationInteractionDirectiveV1,
  type LocationInteractionState,
  type LocationOnboardingRunResultV1,
  type LocationPositionObservationV1,
  type LocationPreVaultDraftMetadataV1,
  type LocationRunProjectionV1,
} from "@/lib/services/one-location-onboarding-run-client";
import {
  fetchActiveLocationCircleNameDirective,
  parseLocationCircleNameDirective,
  type LocationCircleNameDirectiveV1,
  type LocationCircleNameSubmitResultV1,
} from "@/lib/services/location-circle-name-interaction-client";
import { OneLocationPreVaultDraftService } from "@/lib/services/one-location-pre-vault-draft-service";
import { AuthService } from "@/lib/services/auth-service";
import { locationWorkflowCardCopy } from "@/lib/one-location/location-workflow-card-copy";
import { publishLocationCommandStatusCard } from "@/lib/one-location/location-command-status-card";
import {
  clearLocationPerformanceEvidence,
  markLocationCardTap,
  recordLocationInteractionRendered,
} from "@/lib/one-location/one-location-runtime-telemetry";
import { useVault } from "@/lib/vault/vault-context";

type SurfaceAction = () => unknown | Promise<unknown>;

type PublishOptions = {
  run?: LocationRunProjectionV1 | null;
  dismissible?: boolean;
  onPrimary?: SurfaceAction;
  onSecondary?: SurfaceAction;
  onResult?: Readonly<Record<string, SurfaceAction>>;
};

type SurfaceActions = {
  primary?: SurfaceAction;
  secondary?: SurfaceAction;
  byResult?: Readonly<Record<string, SurfaceAction>>;
};

type OwnerSnapshot = {
  userId: string;
  generation: number;
};

type RequestSnapshot = OwnerSnapshot & {
  admissionSequence: number;
};

type RememberOutcome = {
  accepted: boolean;
  preservedActions: boolean;
};

export type LocationInteractionSurfaceContextValue = {
  currentRun: LocationRunProjectionV1 | null;
  directive: LocationInteractionDirectiveV1 | null;
  startOrResume: (
    contextRevision?: string | null,
  ) => Promise<LocationOnboardingRunResultV1>;
  settle: (input: {
    run?: LocationRunProjectionV1;
    result: string;
    draftMetadata?: LocationPreVaultDraftMetadataV1 | null;
    positionObservation?: LocationPositionObservationV1 | null;
  }) => Promise<LocationOnboardingRunResultV1>;
  presentServerResult: (
    result: LocationOnboardingRunResultV1,
    options?: Omit<PublishOptions, "run">,
  ) => void;
  /**
   * Present the one compiled, relay-issued Circle-name form. The provider
   * revalidates the projection before it reaches React state, so an AgentBar
   * route change cannot turn an arbitrary transport payload into a form.
   */
  presentCircleNameDirective: (
    directive: LocationCircleNameDirectiveV1,
  ) => boolean;
  /**
   * Retain a verified server projection while moving to the compiled Location
   * route.  Unlike `presentServerResult`, this deliberately does not render
   * the card at app root: the route-mounted device orchestrator is the only
   * owner allowed to attach native-permission and device callbacks.
   */
  stageServerResultForRoute: (result: LocationOnboardingRunResultV1) => boolean;
  publishLocal: (
    state: LocationInteractionState,
    options?: PublishOptions,
  ) => void;
  dismiss: () => void;
  clear: (options?: { clearDraft?: boolean }) => Promise<void>;
};

type LocationDeviceGateCleanupState =
  "idle" | "running" | "complete" | "failed";

const LocationInteractionSurfaceContext =
  createContext<LocationInteractionSurfaceContextValue | null>(null);

function routeToLocationSetup(): void {
  requestInternalAppNavigation({
    href: "/one/setup/location",
    source: "programmatic",
    transitionMode: "contextual",
    scroll: false,
  });
}

class SupersededLocationSurfaceResponseError extends Error {
  constructor() {
    super("A newer Location task state is already active.");
    this.name = "SupersededLocationSurfaceResponseError";
  }
}

function projectionsMatchExactly(
  current: LocationRunProjectionV1,
  next: LocationRunProjectionV1,
): boolean {
  return JSON.stringify(current) === JSON.stringify(next);
}

function mayAdmitProjection(
  current: LocationRunProjectionV1 | null,
  next: LocationRunProjectionV1,
  currentAdmissionSequence: number,
  nextAdmissionSequence: number,
): boolean {
  if (!current) return true;
  if (current.runId !== next.runId) {
    // Revisions are meaningful only inside one run. A different run may
    // replace the visible task solely when it comes from a newer admitted
    // request/presentation generation.
    return nextAdmissionSequence > currentAdmissionSequence;
  }
  if (next.revision > current.revision) return true;
  if (next.revision < current.revision) return false;
  // A revision is immutable. A changed lease, cursor, graph, evidence, or
  // status at the same revision is an incompatible response, not a refresh.
  return projectionsMatchExactly(current, next);
}

function strongestProjectionBaseline(
  current: LocationRunProjectionV1 | null,
  cached: LocationRunProjectionV1 | null,
  candidate: LocationRunProjectionV1,
): LocationRunProjectionV1 | null {
  if (!current) return cached;
  if (
    cached?.runId === candidate.runId &&
    (current.runId !== candidate.runId || cached.revision > current.revision)
  ) {
    return cached;
  }
  return current;
}

function serverPresentationMatchesExactly(
  current: LocationInteractionDirectiveV1 | null,
  next: LocationInteractionDirectiveV1 | null,
): boolean {
  return Boolean(
    current?.authority === "server" &&
    next?.authority === "server" &&
    projectionsMatchExactly(current.run, next.run) &&
    JSON.stringify(current.serverDirective) ===
      JSON.stringify(next.serverDirective),
  );
}

async function clearMatchingLateProjection(
  userId: string,
  projection: LocationRunProjectionV1,
): Promise<void> {
  const cached = await OneLocationOnboardingRunClient.readProjection(userId);
  if (cached && projectionsMatchExactly(cached, projection)) {
    await OneLocationOnboardingRunClient.clearProjection(userId);
  }
}

async function clearExactDraftForRun(
  userId: string,
  runId: string,
): Promise<void> {
  const binding =
    await OneLocationPreVaultDraftService.readRecoveryBindingForRun(
      userId,
      runId,
    );
  if (!binding) return;
  await OneLocationPreVaultDraftService.clearExact(
    userId,
    binding.runId,
    binding.revision,
    binding.digest,
  );
}

function setLocationDeviceGateCleanupState(
  state: LocationDeviceGateCleanupState,
): boolean {
  if (typeof window === "undefined") return false;
  const bridge = window.__HUSHH_NATIVE_TEST__;
  if (bridge?.enabled !== true || bridge.locationDeviceGate !== true) {
    return false;
  }
  bridge.locationExactRunCleanupState = state;
  return true;
}

export function OneLocationInteractionSurfaceProvider({
  children,
}: {
  children: ReactNode;
}) {
  const { userId } = useAuth();
  const { vaultOwnerToken, isVaultUnlocked } = useVault();
  const [currentRun, setCurrentRun] = useState<LocationRunProjectionV1 | null>(
    null,
  );
  const [directive, setDirective] =
    useState<LocationInteractionDirectiveV1 | null>(null);
  const [circleNameDirective, setCircleNameDirective] =
    useState<LocationCircleNameDirectiveV1 | null>(null);
  const directiveRef = useRef<LocationInteractionDirectiveV1 | null>(null);
  const circleNameDirectiveRef = useRef<LocationCircleNameDirectiveV1 | null>(
    null,
  );
  const circleNamePresentationRevisionRef = useRef(0);
  const actionsRef = useRef<SurfaceActions>({});
  const previousUserRef = useRef<string | null>(userId ?? null);
  const activeUserRef = useRef<string | null>(userId ?? null);
  const ownerGenerationRef = useRef(0);
  const admissionSequenceRef = useRef(0);
  const committedAdmissionSequenceRef = useRef(0);
  const currentRunAdmissionSequenceRef = useRef(0);
  const currentRunRef = useRef<LocationRunProjectionV1 | null>(null);
  const rememberTailRef = useRef<Promise<void>>(Promise.resolve());
  const foregroundRefreshRef = useRef<Promise<void> | null>(null);
  const lastForegroundSignalAtRef = useRef(0);
  const renderedUserId = userId ?? null;
  if (activeUserRef.current !== renderedUserId) {
    activeUserRef.current = renderedUserId;
    ownerGenerationRef.current += 1;
  }
  const renderedOwnerGeneration = ownerGenerationRef.current;

  const ownerIsCurrent = useCallback((owner: OwnerSnapshot): boolean => {
    return (
      activeUserRef.current === owner.userId &&
      ownerGenerationRef.current === owner.generation
    );
  }, []);

  const requestMayCommit = useCallback(
    (request: RequestSnapshot): boolean => {
      return (
        ownerIsCurrent(request) &&
        request.admissionSequence >= committedAdmissionSequenceRef.current
      );
    },
    [ownerIsCurrent],
  );

  const commitLocalResume = useCallback(
    (run: LocationRunProjectionV1, admissionSequence: number): boolean => {
      if (
        admissionSequence < committedAdmissionSequenceRef.current ||
        !mayAdmitProjection(
          currentRunRef.current,
          run,
          currentRunAdmissionSequenceRef.current,
          admissionSequence,
        )
      ) {
        return false;
      }
      const nextDirective = createLocalLocationInteractionDirective(
        "resume_required",
        { run },
      );
      committedAdmissionSequenceRef.current = admissionSequence;
      currentRunAdmissionSequenceRef.current = admissionSequence;
      currentRunRef.current = run;
      directiveRef.current = nextDirective;
      actionsRef.current = { primary: routeToLocationSetup };
      setCurrentRun(run);
      setDirective(nextDirective);
      return true;
    },
    [],
  );

  const commitServerResult = useCallback(
    (
      result: LocationOnboardingRunResultV1,
      options: {
        actions?: SurfaceActions;
        admissionSequence: number;
        preserveMatchingServerActions?: boolean;
        resumeWhenActionsCannotBePreserved?: boolean;
        /** Keep only the durable projection until the device-owning route mounts. */
        stageForRoute?: boolean;
      },
    ): RememberOutcome => {
      if (
        options.admissionSequence < committedAdmissionSequenceRef.current ||
        !mayAdmitProjection(
          currentRunRef.current,
          result.run,
          currentRunAdmissionSequenceRef.current,
          options.admissionSequence,
        )
      ) {
        return { accepted: false, preservedActions: false };
      }
      const nextDirective = options.stageForRoute
        ? null
        : createServerLocationInteractionDirective(result);
      const preservedActions = Boolean(
        !options.stageForRoute &&
        options.preserveMatchingServerActions &&
        serverPresentationMatchesExactly(directiveRef.current, nextDirective) &&
        actionsRef.current.byResult &&
        Object.keys(actionsRef.current.byResult).length > 0,
      );
      if (
        options.resumeWhenActionsCannotBePreserved &&
        !preservedActions &&
        OneLocationOnboardingRunClient.shouldOfferResume(result.run)
      ) {
        return {
          accepted: commitLocalResume(result.run, options.admissionSequence),
          preservedActions: false,
        };
      }
      committedAdmissionSequenceRef.current = options.admissionSequence;
      currentRunAdmissionSequenceRef.current = options.admissionSequence;
      currentRunRef.current = result.run;
      directiveRef.current = nextDirective;
      actionsRef.current = options.stageForRoute
        ? {}
        : preservedActions
          ? actionsRef.current
          : (options.actions ?? {});
      setCurrentRun(result.run);
      setDirective(nextDirective);
      return { accepted: true, preservedActions };
    },
    [commitLocalResume],
  );

  const remember = useCallback(
    (
      result: LocationOnboardingRunResultV1,
      request: RequestSnapshot,
      options: {
        preserveMatchingServerActions?: boolean;
        resumeWhenActionsCannotBePreserved?: boolean;
      } = {},
    ): Promise<RememberOutcome> => {
      const work = rememberTailRef.current
        .catch(() => undefined)
        .then(async (): Promise<RememberOutcome> => {
          if (!requestMayCommit(request)) {
            if (!ownerIsCurrent(request)) {
              await clearMatchingLateProjection(request.userId, result.run);
            }
            return { accepted: false, preservedActions: false };
          }

          // Check both the mounted projection and its route-surviving cache
          // before writing. This closes the equal-revision overwrite hole in
          // presentation storage without granting the cache any authority.
          const cached = await OneLocationOnboardingRunClient.readProjection(
            request.userId,
          );
          if (!requestMayCommit(request)) {
            if (!ownerIsCurrent(request)) {
              await clearMatchingLateProjection(request.userId, result.run);
            }
            return { accepted: false, preservedActions: false };
          }
          const baseline = strongestProjectionBaseline(
            currentRunRef.current,
            cached,
            result.run,
          );
          if (
            baseline &&
            !mayAdmitProjection(
              baseline,
              result.run,
              baseline === currentRunRef.current
                ? currentRunAdmissionSequenceRef.current
                : 0,
              request.admissionSequence,
            )
          ) {
            return { accepted: false, preservedActions: false };
          }

          const remembered =
            await OneLocationOnboardingRunClient.rememberProjection(
              request.userId,
              result.run,
            );
          if (!requestMayCommit(request)) {
            await clearMatchingLateProjection(request.userId, result.run);
            return { accepted: false, preservedActions: false };
          }
          if (!remembered) {
            throw new Error("Agent One returned an invalid Location task.");
          }
          if (!projectionsMatchExactly(remembered, result.run)) {
            return { accepted: false, preservedActions: false };
          }

          const outcome = commitServerResult(result, {
            ...options,
            admissionSequence: request.admissionSequence,
          });
          if (!outcome.accepted) {
            // A synchronous, newer presentation may have landed while secure
            // storage was resolving. Remove only this exact late projection.
            await clearMatchingLateProjection(request.userId, result.run);
            return outcome;
          }
          if (
            result.run.status === "cancelled" ||
            result.run.status === "expired" ||
            result.run.status === "verified_succeeded"
          ) {
            // Terminal server authority ends the local secret lifetime. Paused
            // is intentionally excluded because it remains resumable. Both
            // removals are exact so a late terminal response from run A cannot
            // erase a newer same-owner run B.
            await Promise.allSettled([
              clearMatchingLateProjection(request.userId, result.run),
              clearExactDraftForRun(request.userId, result.run.runId),
            ]);
          }
          return outcome;
        });
      rememberTailRef.current = work.then(
        () => undefined,
        () => undefined,
      );
      return work;
    },
    [commitServerResult, ownerIsCurrent, requestMayCommit],
  );

  const captureRenderedOwner = useCallback((): OwnerSnapshot => {
    if (!renderedUserId) {
      throw new Error("Sign in again to continue Location setup.");
    }
    const owner = {
      userId: renderedUserId,
      generation: renderedOwnerGeneration,
    };
    if (!ownerIsCurrent(owner)) {
      throw new SupersededLocationSurfaceResponseError();
    }
    return owner;
  }, [ownerIsCurrent, renderedOwnerGeneration, renderedUserId]);

  const captureRenderedRequest = useCallback((): RequestSnapshot => {
    return {
      ...captureRenderedOwner(),
      admissionSequence: ++admissionSequenceRef.current,
    };
  }, [captureRenderedOwner]);

  const captureRequestBearer = useCallback(
    async (request: RequestSnapshot): Promise<string> => {
      const bearerToken = await AuthService.getIdTokenWithRetry({
        retries: 1,
        delayMs: 250,
        expectedUserId: request.userId,
      });
      if (!requestMayCommit(request)) {
        throw new SupersededLocationSurfaceResponseError();
      }
      if (!bearerToken) {
        throw new Error("Sign in again to continue Location setup.");
      }
      return bearerToken;
    },
    [requestMayCommit],
  );

  const publishLocal = useCallback(
    (state: LocationInteractionState, options: PublishOptions = {}) => {
      if (
        !renderedUserId ||
        activeUserRef.current !== renderedUserId ||
        ownerGenerationRef.current !== renderedOwnerGeneration
      ) {
        return;
      }
      const activeRun = currentRunRef.current;
      // Only server authority may replace one run with another. This rejects a
      // late local recovery callback still holding run A after run B landed.
      if (options.run && activeRun && options.run.runId !== activeRun.runId) {
        return;
      }
      const admissionSequence = ++admissionSequenceRef.current;
      if (
        options.run &&
        !mayAdmitProjection(
          activeRun,
          options.run,
          currentRunAdmissionSequenceRef.current,
          admissionSequence,
        )
      ) {
        return;
      }
      // Local actions may only refresh server authority or retry bounded
      // device/presentation work. They never carry a result into settle().
      const mayRefreshOrRetryDeviceWork =
        state === "resume_required" ||
        state === "secure_task_unavailable" ||
        state === "permission_required" ||
        state === "capture_retry" ||
        state === "place_required";
      actionsRef.current = {
        primary: mayRefreshOrRetryDeviceWork ? options.onPrimary : undefined,
        secondary: options.onSecondary,
        byResult: undefined,
      };
      const run = options.run === undefined ? activeRun : options.run;
      if (run && (!activeRun || !projectionsMatchExactly(activeRun, run))) {
        currentRunRef.current = run;
        setCurrentRun(run);
      }
      committedAdmissionSequenceRef.current = admissionSequence;
      if (currentRunRef.current) {
        currentRunAdmissionSequenceRef.current = admissionSequence;
      }
      const nextDirective = createLocalLocationInteractionDirective(state, {
        run,
        dismissible: options.dismissible,
      });
      directiveRef.current = nextDirective;
      setDirective(nextDirective);
    },
    [renderedOwnerGeneration, renderedUserId],
  );

  const presentServerResult = useCallback(
    (
      result: LocationOnboardingRunResultV1,
      options: Omit<PublishOptions, "run"> = {},
    ) => {
      if (
        !renderedUserId ||
        activeUserRef.current !== renderedUserId ||
        ownerGenerationRef.current !== renderedOwnerGeneration
      ) {
        return;
      }
      const admissionSequence = ++admissionSequenceRef.current;
      commitServerResult(result, {
        actions: { byResult: options.onResult },
        admissionSequence,
      });
    },
    [commitServerResult, renderedOwnerGeneration, renderedUserId],
  );

  const dismissCircleNameDirective = useCallback(() => {
    circleNamePresentationRevisionRef.current += 1;
    circleNameDirectiveRef.current = null;
    setCircleNameDirective(null);
  }, []);

  const presentCircleNameDirective = useCallback(
    (candidate: LocationCircleNameDirectiveV1): boolean => {
      if (
        !renderedUserId ||
        activeUserRef.current !== renderedUserId ||
        ownerGenerationRef.current !== renderedOwnerGeneration
      ) {
        return false;
      }
      // The transport has already parsed this result, but its data crossed a
      // socket boundary. Rebuild the one approved form projection again at the
      // app-root owner before putting it into durable presentation state.
      const next = parseLocationCircleNameDirective(candidate);
      if (!next) return false;
      const current = circleNameDirectiveRef.current;
      if (current?.run.runId === next.run.runId) {
        if (next.run.revision < current.run.revision) return false;
        // Equal revisions are immutable. A different lease or directive at
        // that revision is a conflicting replay, never a form replacement.
        if (
          next.run.revision === current.run.revision &&
          (next.directiveId !== current.directiveId ||
            next.lease.leaseId !== current.lease.leaseId)
        ) {
          return false;
        }
      }
      circleNamePresentationRevisionRef.current += 1;
      circleNameDirectiveRef.current = next;
      setCircleNameDirective(next);
      return true;
    },
    [renderedOwnerGeneration, renderedUserId],
  );

  const settleCircleNameDirective = useCallback(
    (result: LocationCircleNameSubmitResultV1) => {
      const active = circleNameDirectiveRef.current;
      // A late result must never dismiss a newer Circle form. The submit
      // client returns no private value, but it remains bound to exactly one
      // opaque run id.
      if (!active || active.run.runId !== result.runId) return;
      dismissCircleNameDirective();
      if (result.statusCard) {
        publishLocationCommandStatusCard(result.statusCard);
        useAgentVoiceState.getState().setStatus("idle", "Circle ready");
      } else if (result.status === "working") {
        useAgentVoiceState.getState().setStatus("thinking", "Creating Circle");
      } else {
        useAgentVoiceState
          .getState()
          .setStatus("error", "Circle could not be created");
      }
    },
    [dismissCircleNameDirective],
  );

  const stageServerResultForRoute = useCallback(
    (result: LocationOnboardingRunResultV1): boolean => {
      if (
        !renderedUserId ||
        activeUserRef.current !== renderedUserId ||
        ownerGenerationRef.current !== renderedOwnerGeneration
      ) {
        return false;
      }
      // This boundary accepts only the same parsed, lease-bound directive
      // carried by the durable run. A caller cannot stage a run while swapping
      // in a different card or an old lease for the eventual device route.
      if (
        result.run.workflowId !== ONE_LOCATION_ONBOARDING_WORKFLOW_ID ||
        !result.directive ||
        !result.run.pendingDirective ||
        JSON.stringify(result.directive) !==
          JSON.stringify(result.run.pendingDirective) ||
        result.directive.lease.runRevision !== result.run.revision ||
        result.run.pendingDirective.lease.runRevision !== result.run.revision
      ) {
        return false;
      }
      const admissionSequence = ++admissionSequenceRef.current;
      return commitServerResult(result, {
        admissionSequence,
        stageForRoute: true,
      }).accepted;
    },
    [commitServerResult, renderedOwnerGeneration, renderedUserId],
  );

  const dismiss = useCallback(() => {
    if (
      activeUserRef.current !== renderedUserId ||
      ownerGenerationRef.current !== renderedOwnerGeneration
    ) {
      return;
    }
    const activeDirective = directiveRef.current;
    if (!activeDirective?.dismissible) return;
    committedAdmissionSequenceRef.current = ++admissionSequenceRef.current;
    actionsRef.current = {};
    directiveRef.current = null;
    setDirective(null);
  }, [renderedOwnerGeneration, renderedUserId]);

  const startOrResume = useCallback(
    async (contextRevision?: string | null) => {
      const request = captureRenderedRequest();
      const requestedRun = currentRunRef.current;
      try {
        const bearerToken = await captureRequestBearer(request);
        const result = await OneLocationOnboardingRunClient.startOrResume({
          runId: requestedRun?.runId ?? null,
          contextRevision,
          bearerToken,
        });
        const outcome = await remember(result, request);
        if (!outcome.accepted) {
          throw new SupersededLocationSurfaceResponseError();
        }
        return result;
      } catch (error) {
        if (
          !(error instanceof SupersededLocationSurfaceResponseError) &&
          ownerIsCurrent(request)
        ) {
          publishLocal("secure_task_unavailable", {
            run: currentRunRef.current,
            onPrimary: async () => {
              const retryRequest = captureRenderedRequest();
              const retryRun = currentRunRef.current;
              const bearerToken = await captureRequestBearer(retryRequest);
              const retry = await OneLocationOnboardingRunClient.startOrResume({
                runId: retryRun?.runId ?? null,
                contextRevision,
                bearerToken,
              });
              const retryOutcome = await remember(retry, retryRequest);
              if (!retryOutcome.accepted) {
                throw new SupersededLocationSurfaceResponseError();
              }
            },
          });
        }
        throw error;
      }
    },
    [
      captureRenderedRequest,
      captureRequestBearer,
      ownerIsCurrent,
      publishLocal,
      remember,
    ],
  );

  const settle = useCallback(
    async (input: {
      run?: LocationRunProjectionV1;
      result: string;
      draftMetadata?: LocationPreVaultDraftMetadataV1 | null;
      positionObservation?: LocationPositionObservationV1 | null;
    }) => {
      const request = captureRenderedRequest();
      const run = input.run ?? currentRunRef.current;
      if (!run) {
        throw new Error("Resume Location setup before continuing.");
      }
      const bearerToken = await captureRequestBearer(request);
      const result = await OneLocationOnboardingRunClient.settle({
        run,
        result: input.result,
        draftMetadata: input.draftMetadata,
        positionObservation: input.positionObservation,
        bearerToken,
      });
      const outcome = await remember(result, request);
      if (!outcome.accepted) {
        throw new SupersededLocationSurfaceResponseError();
      }
      return result;
    },
    [captureRenderedRequest, captureRequestBearer, remember],
  );

  const cancelExactRunForLocationDeviceGate = useCallback(async () => {
    // This authority is deliberately unavailable to normal product UI. The
    // DEBUG native bridge itself requires both -UITestMode and the dedicated
    // physical Location gate launch argument.
    if (!setLocationDeviceGateCleanupState("running")) return;
    let request: RequestSnapshot;
    try {
      request = captureRenderedRequest();
      const run = currentRunRef.current;
      if (!run || !OneLocationOnboardingRunClient.shouldOfferResume(run)) {
        throw new Error("No active Location test run is available.");
      }
      const bearerToken = await captureRequestBearer(request);
      const result = await OneLocationOnboardingRunClient.cancel({
        run,
        bearerToken,
        expectedUserId: request.userId,
      });
      const outcome = await remember(result, request);
      if (!outcome.accepted || result.run.status !== "cancelled") {
        throw new Error("Location test run cancellation was not verified.");
      }
      setLocationDeviceGateCleanupState("complete");
    } catch (error) {
      setLocationDeviceGateCleanupState("failed");
      throw error;
    }
  }, [captureRenderedRequest, captureRequestBearer, remember]);

  const refreshOnForeground = useCallback(() => {
    let request: RequestSnapshot;
    try {
      request = captureRenderedRequest();
    } catch {
      return;
    }
    const run = currentRunRef.current;
    if (
      !run ||
      !OneLocationOnboardingRunClient.shouldOfferResume(run) ||
      foregroundRefreshRef.current
    ) {
      return;
    }
    const nowMs = Date.now();
    // Capacitor and WebKit can emit app-active + visibility-visible together.
    // One owner-scoped refresh is sufficient and route rerenders do not
    // register additional work.
    if (nowMs - lastForegroundSignalAtRef.current < 500) return;
    lastForegroundSignalAtRef.current = nowMs;
    const refresh = captureRequestBearer(request)
      .then((bearerToken) =>
        OneLocationOnboardingRunClient.startOrResume({
          runId: run.runId,
          bearerToken,
        }),
      )
      .then(async (result) => {
        if (!ownerIsCurrent(request)) {
          await clearMatchingLateProjection(request.userId, result.run);
          return;
        }
        await remember(result, request, {
          preserveMatchingServerActions: true,
          // A renewed lease cannot inherit callbacks from the previous
          // directive. Commit an actionable route-only card in the same
          // update instead of exposing disabled server buttons off-route.
          resumeWhenActionsCannotBePreserved: true,
        });
      })
      .catch(() => undefined)
      .finally(() => {
        if (foregroundRefreshRef.current === refresh) {
          foregroundRefreshRef.current = null;
        }
      });
    foregroundRefreshRef.current = refresh;
  }, [captureRenderedRequest, captureRequestBearer, ownerIsCurrent, remember]);

  useEffect(() => {
    if (!renderedUserId || typeof document === "undefined") return;
    let cancelled = false;
    let removeNativeListener: (() => void) | null = null;
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refreshOnForeground();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    if (Capacitor.isNativePlatform()) {
      void import("@capacitor/app")
        .then(({ App }) =>
          App.addListener("appStateChange", ({ isActive }) => {
            if (isActive) refreshOnForeground();
          }),
        )
        .then((handle) => {
          if (cancelled) {
            void handle.remove();
            return;
          }
          removeNativeListener = () => void handle.remove();
        })
        .catch(() => {
          // Browser visibility remains the bounded fallback in a web view.
        });
    }
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      removeNativeListener?.();
    };
  }, [refreshOnForeground, renderedUserId]);

  const clear = useCallback(
    async (options: { clearDraft?: boolean } = {}) => {
      if (
        activeUserRef.current !== renderedUserId ||
        ownerGenerationRef.current !== renderedOwnerGeneration
      ) {
        return;
      }
      const admissionSequence = ++admissionSequenceRef.current;
      committedAdmissionSequenceRef.current = admissionSequence;
      currentRunAdmissionSequenceRef.current = admissionSequence;
      actionsRef.current = {};
      directiveRef.current = null;
      setDirective(null);
      dismissCircleNameDirective();
      currentRunRef.current = null;
      setCurrentRun(null);
      if (!renderedUserId) return;
      await Promise.allSettled([
        OneLocationOnboardingRunClient.clearProjection(renderedUserId),
        ...(options.clearDraft
          ? [OneLocationPreVaultDraftService.clear(renderedUserId)]
          : []),
      ]);
    },
    [dismissCircleNameDirective, renderedOwnerGeneration, renderedUserId],
  );

  useEffect(() => {
    let cancelled = false;
    const previousUserId = previousUserRef.current;
    const owner = renderedUserId
      ? {
          userId: renderedUserId,
          generation: renderedOwnerGeneration,
        }
      : null;
    previousUserRef.current = renderedUserId;
    currentRunRef.current = null;
    foregroundRefreshRef.current = null;
    lastForegroundSignalAtRef.current = 0;
    actionsRef.current = {};
    directiveRef.current = null;
    setDirective(null);
    dismissCircleNameDirective();
    setCurrentRun(null);

    if (previousUserId && previousUserId !== renderedUserId) {
      // Exact latency evidence is RAM-only and scoped to one owner session.
      clearLocationPerformanceEvidence();
      void Promise.allSettled([
        OneLocationOnboardingRunClient.clearProjection(previousUserId),
        OneLocationPreVaultDraftService.clear(previousUserId),
      ]);
    }
    if (!owner) return () => undefined;

    void (async () => {
      // Reserve hydration's sequence before its first suspension. An explicit
      // tap issued while cache I/O is pending must always be the newer request
      // and therefore cannot be superseded by a late 204/read response.
      const request: RequestSnapshot = {
        ...owner,
        admissionSequence: ++admissionSequenceRef.current,
      };
      const cached = await OneLocationOnboardingRunClient.readProjection(
        owner.userId,
      );
      if (cancelled || !ownerIsCurrent(owner) || currentRunRef.current) return;
      // sessionStorage is only a presentation cache and does not survive an
      // iOS process kill. Always reconcile it against the owner-scoped server
      // read: a 204 proves the cached run is orphaned, whereas a transport or
      // authentication failure must retain the local recovery affordance.
      try {
        const bearerToken = await captureRequestBearer(request);
        const active = await OneLocationOnboardingRunClient.findActive({
          bearerToken,
        });
        if (
          cancelled ||
          !requestMayCommit(request) ||
          request.admissionSequence !== admissionSequenceRef.current ||
          currentRunRef.current
        ) {
          return;
        }
        if (!active) {
          committedAdmissionSequenceRef.current = request.admissionSequence;
          if (cached) {
            await Promise.allSettled([
              clearMatchingLateProjection(owner.userId, cached),
              clearExactDraftForRun(owner.userId, cached.runId),
            ]);
          }
          return;
        }
        await remember(active, request, {
          resumeWhenActionsCannotBePreserved: true,
        });
      } catch {
        if (
          cancelled ||
          !requestMayCommit(request) ||
          request.admissionSequence !== admissionSequenceRef.current ||
          currentRunRef.current ||
          !cached ||
          !OneLocationOnboardingRunClient.shouldOfferResume(cached)
        ) {
          return;
        }
        commitLocalResume(cached, request.admissionSequence);
      }
    })().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [
    commitLocalResume,
    captureRequestBearer,
    dismissCircleNameDirective,
    ownerIsCurrent,
    remember,
    renderedOwnerGeneration,
    renderedUserId,
    requestMayCommit,
  ]);

  useEffect(() => {
    let cancelled = false;
    if (!renderedUserId || !isVaultUnlocked || !vaultOwnerToken) {
      dismissCircleNameDirective();
      return () => undefined;
    }
    // A relaunch recovers only an existing, server-leased form. This read does
    // not create a task or reconstruct client copy. If a relay result lands
    // while the read is in flight, its newer presentation revision wins.
    const presentationRevision = circleNamePresentationRevisionRef.current;
    void fetchActiveLocationCircleNameDirective(vaultOwnerToken)
      .then((candidate) => {
        if (
          cancelled ||
          circleNamePresentationRevisionRef.current !== presentationRevision ||
          !candidate
        ) {
          return;
        }
        presentCircleNameDirective(candidate);
      })
      .catch(() => {
        // A valid mounted lease remains usable until its own expiry. A failed
        // recovery read must not turn it into a generic error card.
      });
    return () => {
      cancelled = true;
    };
  }, [
    dismissCircleNameDirective,
    isVaultUnlocked,
    presentCircleNameDirective,
    renderedUserId,
    vaultOwnerToken,
  ]);

  const value = useMemo<LocationInteractionSurfaceContextValue>(
    () => ({
      currentRun,
      directive,
      startOrResume,
      settle,
      presentServerResult,
      presentCircleNameDirective,
      stageServerResultForRoute,
      publishLocal,
      dismiss,
      clear,
    }),
    [
      clear,
      currentRun,
      directive,
      dismiss,
      presentCircleNameDirective,
      presentServerResult,
      stageServerResultForRoute,
      publishLocal,
      settle,
      startOrResume,
    ],
  );

  return (
    <LocationInteractionSurfaceContext.Provider value={value}>
      {children}
      <OneLocationInteractionSurfaceHost
        // A Circle-name form is a separate, leased command run. It takes the
        // foreground while active; the durable onboarding directive remains
        // intact and returns after the form is dismissed or settles.
        directive={circleNameDirective ? null : directive}
        onDismiss={dismiss}
        onCancelExactRunForLocationDeviceGate={
          cancelExactRunForLocationDeviceGate
        }
        actionsRef={actionsRef}
      />
      <OneLocationCircleNameInteractionHost
        directive={circleNameDirective}
        vaultOwnerToken={vaultOwnerToken}
        onDismiss={dismissCircleNameDirective}
        onSettled={settleCircleNameDirective}
      />
    </LocationInteractionSurfaceContext.Provider>
  );
}

export function useOneLocationInteractionSurface(): LocationInteractionSurfaceContextValue {
  const value = useContext(LocationInteractionSurfaceContext);
  if (!value) {
    throw new Error(
      "useOneLocationInteractionSurface must be used inside OneLocationInteractionSurfaceProvider.",
    );
  }
  return value;
}

/** Test/embedded surfaces may intentionally render without the app root. */
export function useOptionalOneLocationInteractionSurface(): LocationInteractionSurfaceContextValue | null {
  return useContext(LocationInteractionSurfaceContext);
}

type CardCopy = {
  title: string;
  body: string;
  primary: string | null;
  secondary: string | null;
};

const LOCAL_CARD_COPY: Record<LocationInteractionState, CardCopy> = {
  permission_required: {
    title: "Allow Location access",
    body: "I’m waiting for you. Tap Continue, then choose Allow While Using App in the system prompt.",
    primary: "Continue",
    secondary: "Not now",
  },
  permission_waiting: {
    title: "Waiting for permission",
    body: "Finish the system prompt to continue Location setup.",
    primary: null,
    secondary: null,
  },
  permission_settings_required: {
    title: "Location permission is off",
    body: "Open Settings, allow Location for One, then return here.",
    primary: "Open Settings",
    secondary: "Not now",
  },
  location_services_required: {
    title: "Location Services are off",
    body: "Turn on Location Services in Settings, then return to continue.",
    primary: "Open Settings",
    secondary: "Not now",
  },
  capturing: {
    title: "Finding your location",
    body: "One is waiting for a real GPS fix from this device.",
    primary: null,
    secondary: null,
  },
  capture_retry: {
    title: "Location wasn’t ready",
    body: "No result was confirmed within 30 seconds. Check signal and permission, then try again.",
    primary: "Try again",
    secondary: "Not now",
  },
  place_required: {
    title: "Choose how to save this place",
    body: "Select Home, Work, another label, or Skip in the Location setup form.",
    primary: "Open Location setup",
    secondary: "Not now",
  },
  resume_required: {
    title: "Continue Location setup",
    body: "Your task is still active. One will resume from the next verified step.",
    primary: "Continue",
    secondary: "Not now",
  },
  verified_complete: {
    title: "Location ready",
    body: "Location setup is verified and ready to use.",
    primary: null,
    secondary: null,
  },
  secure_task_unavailable: {
    title: "Location setup isn’t ready",
    body: "One could not secure a resumable task. Nothing was saved or marked complete.",
    primary: "Try again",
    secondary: "Not now",
  },
};

function OneLocationCircleNameInteractionHost({
  directive,
  vaultOwnerToken,
  onDismiss,
  onSettled,
}: {
  directive: LocationCircleNameDirectiveV1 | null;
  vaultOwnerToken: string | null | undefined;
  onDismiss: () => void;
  onSettled: (result: LocationCircleNameSubmitResultV1) => void;
}) {
  if (!directive) return null;
  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-[calc(var(--bottom-inset,0px)+16px)] z-[10021] mx-auto flex w-full max-w-lg justify-center px-4"
      data-testid="one-location-circle-name-interaction-surface"
      aria-live="polite"
    >
      <LocationCircleNameInputCard
        directive={directive}
        vaultOwnerToken={vaultOwnerToken}
        onDismiss={onDismiss}
        onSettled={onSettled}
      />
    </div>
  );
}

function OneLocationInteractionSurfaceHost({
  directive,
  onDismiss,
  onCancelExactRunForLocationDeviceGate,
  actionsRef,
}: {
  directive: LocationInteractionDirectiveV1 | null;
  onDismiss: () => void;
  onCancelExactRunForLocationDeviceGate: SurfaceAction;
  actionsRef: MutableRefObject<{
    primary?: SurfaceAction;
    secondary?: SurfaceAction;
    byResult?: Readonly<Record<string, SurfaceAction>>;
  }>;
}) {
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const actionEpochRef = useRef(0);

  useEffect(() => {
    actionEpochRef.current += 1;
    setBusyAction(null);
    // Effects run after the approved global card commits. The telemetry
    // boundary consumes only validated opaque ids and a monotonic timestamp.
    recordLocationInteractionRendered(directive);
  }, [directive]);

  const runAction = useCallback(
    async (
      actionId: string,
      action: SurfaceAction | undefined,
      fallback?: SurfaceAction,
    ) => {
      if (busyAction) return;
      const selected = action ?? fallback;
      if (!selected) return;
      markLocationCardTap(directive, actionId);
      const epoch = actionEpochRef.current + 1;
      actionEpochRef.current = epoch;
      setBusyAction(actionId);
      try {
        await OneLocationOnboardingRunClient.settleWithin(
          Promise.resolve(selected()),
        );
      } catch {
        // The owning page publishes the corresponding recovery card. Keep the
        // approved surface mounted and never leak a native/backend error here.
      } finally {
        if (actionEpochRef.current === epoch) setBusyAction(null);
      }
    },
    [busyAction, directive],
  );

  if (!directive) return null;
  const serverContractId =
    directive.authority === "server"
      ? directive.serverDirective.contractId
      : null;
  const localState = directive.authority === "local" ? directive.state : null;
  const serverContract = serverContractId
    ? ONE_LOCATION_SERVER_DIRECTIVE_CATALOG[serverContractId]
    : null;
  const copy: Pick<CardCopy, "title" | "body"> = serverContract
    ? {
        title: locationWorkflowCardCopy(serverContract.titleKey),
        body: locationWorkflowCardCopy(serverContract.bodyKey),
      }
    : LOCAL_CARD_COPY[localState!];
  const localCopy = localState ? LOCAL_CARD_COPY[localState] : null;
  const waiting = serverContractId
    ? serverContractId === "one.location.position_pending.v2"
    : localState === "permission_waiting" || localState === "capturing";
  const fallbackPrimary =
    directive.authority === "local" &&
    (localState === "place_required" || localState === "resume_required")
      ? routeToLocationSetup
      : undefined;
  const fallbackSecondary =
    directive.authority === "local" ? onDismiss : undefined;
  const interactionId = serverContractId ?? localState ?? "unknown";
  const buttons: Array<{
    id: string;
    label: string;
    variant: "default" | "outline";
    action?: SurfaceAction;
    fallback?: SurfaceAction;
  }> = serverContract
    ? serverContract.results
        .filter((result) => result.presentation === "button")
        .map((result) => ({
          id: result.result,
          label: locationWorkflowCardCopy(result.labelKey),
          variant: result.buttonRole === "primary" ? "default" : "outline",
          action: actionsRef.current.byResult?.[result.result],
        }))
    : [
        ...(localCopy?.secondary
          ? [
              {
                id: "local_secondary",
                label: localCopy.secondary,
                variant: "outline" as const,
                action: actionsRef.current.secondary,
                fallback: fallbackSecondary,
              },
            ]
          : []),
        ...(localCopy?.primary
          ? [
              {
                id: "local_primary",
                label: localCopy.primary,
                variant: "default" as const,
                action: actionsRef.current.primary,
                fallback: fallbackPrimary,
              },
            ]
          : []),
      ];
  const exposeExactRunCleanup = Boolean(
    directive.run &&
    OneLocationOnboardingRunClient.shouldOfferResume(directive.run) &&
    typeof window !== "undefined" &&
    window.__HUSHH_NATIVE_TEST__?.enabled === true &&
    window.__HUSHH_NATIVE_TEST__?.locationDeviceGate === true,
  );

  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-[calc(var(--bottom-inset,0px)+16px)] z-[10020] mx-auto flex w-full max-w-lg justify-center px-4"
      data-testid="one-location-interaction-surface"
      data-location-interaction-state={interactionId}
      data-location-interaction-authority={directive.authority}
      data-one-approved-render-surface={directive.surface}
      aria-live="polite"
    >
      <Card
        className="pointer-events-auto w-full gap-4 border-[color:var(--app-separator)] bg-[color:var(--app-card-surface-default-solid)] py-5 shadow-[0_18px_56px_rgba(15,23,42,0.24)]"
        role="dialog"
        aria-modal="false"
        aria-labelledby="one-location-interaction-title"
        aria-describedby="one-location-interaction-description"
      >
        <CardHeader className="grid-cols-[44px_minmax(0,1fr)_36px] items-start gap-x-3 px-5">
          <span className="flex size-11 items-center justify-center rounded-full bg-[color:var(--app-accent-tint)] text-[color:var(--app-accent)]">
            {waiting ? (
              <Loader2 className="size-5 animate-spin" aria-hidden="true" />
            ) : (
              <MapPin className="size-5" aria-hidden="true" />
            )}
          </span>
          <div className="min-w-0 space-y-1">
            <CardTitle
              id="one-location-interaction-title"
              className="text-[17px]"
            >
              {copy.title}
            </CardTitle>
            <CardDescription
              id="one-location-interaction-description"
              className="leading-5"
            >
              {copy.body}
            </CardDescription>
          </div>
          {directive.dismissible ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Dismiss Location setup card"
              onClick={onDismiss}
            >
              <X aria-hidden="true" />
            </Button>
          ) : (
            <span aria-hidden />
          )}
        </CardHeader>
        {directive.run ? (
          <CardContent
            className="sr-only"
            data-location-run-id={directive.run.runId}
          >
            Location task revision {directive.run.revision}
          </CardContent>
        ) : null}
        {buttons.length ? (
          <CardFooter className="flex-wrap gap-3 px-5">
            {buttons.map((button) => (
              <Button
                key={button.id}
                type="button"
                aria-label={`Location setup: ${button.label}`}
                variant={button.variant}
                className="min-w-[8rem] flex-1"
                isLoading={busyAction === button.id}
                disabled={
                  Boolean(busyAction) || (!button.action && !button.fallback)
                }
                onClick={() =>
                  void runAction(button.id, button.action, button.fallback)
                }
              >
                {button.label}
              </Button>
            ))}
          </CardFooter>
        ) : null}
        {exposeExactRunCleanup ? (
          <CardFooter className="px-5 pt-0">
            <Button
              type="button"
              aria-label="Location device gate: Cancel exact run"
              variant="ghost"
              className="w-full"
              isLoading={busyAction === "device_gate_cancel_exact_run"}
              disabled={Boolean(busyAction)}
              onClick={() =>
                void runAction(
                  "device_gate_cancel_exact_run",
                  onCancelExactRunForLocationDeviceGate,
                )
              }
            >
              End test run
            </Button>
          </CardFooter>
        ) : null}
      </Card>
    </div>
  );
}
