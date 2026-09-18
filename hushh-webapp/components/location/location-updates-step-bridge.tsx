"use client";

/**
 * App-level consumer of the `set_location_updates` client step that One Live
 * Voice issues for `resume_device_location_updates` /
 * `pause_device_location_updates`.
 *
 * Mounted ONCE next to `LocationPublisherBridge` (AgentOwnerGate) while Live
 * is on, so a request spoken on `/one` survives the navigation to
 * `/one/location` that it may trigger. It owns no UI and no publish loop: it
 * wires the real app ports into the pure `runLocationUpdatesStep` and reports
 * each step exactly once, from what actually happened on the device.
 *
 * Execution goes through `executeAgentGatewayAction` -- the same dispatcher a
 * tap, a chat action, or the bounded command runtime uses -- with the step id
 * as the operation id and the action's own authored journey as its
 * authorization. Nothing here reads the transcript, matches phrases, clicks
 * the switch, or opens a raw URL.
 */

import { useCallback, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

import { useAuth } from "@/hooks/use-auth";
import { executeAgentGatewayAction } from "@/lib/agent/agent-action-runtime";
import { useAgentRuntimeStateOptional } from "@/lib/agent/agent-runtime-context";
import {
  hasMountedLocalOnboardingHandler,
  prepareLocalOnboardingAction,
  waitForLocalOnboardingHandler,
} from "@/lib/agent/local-onboarding-actions";
import { LocationBus } from "@/lib/one-location/location-bus";
import { readOneLocationControlState } from "@/lib/one-location/location-control-state";
import { OneLocationStateResource } from "@/lib/one-location/one-location-state-resource";
import {
  runLocationUpdatesStep,
  SET_LOCATION_UPDATES_STEP,
  type LocationUpdatesExecuteInput,
  type LocationUpdatesStepPorts,
} from "@/lib/one-voice/location-updates-step";
import {
  useVoiceSessionStore,
  useVoiceToolEffects,
} from "@/lib/one-voice/session-store";
import { useKaiSession } from "@/lib/stores/kai-session-store";
import { requestInternalAppNavigation } from "@/lib/utils/browser-navigation";
import { resolveNavigationJourney } from "@/lib/voice/navigation-journey";
import { getVoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";
import { toReportedOsPermission } from "@/components/location/location-publisher-bridge";

function afterPaint(): Promise<void> {
  if (typeof requestAnimationFrame !== "function") return Promise.resolve();
  return new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function LocationUpdatesStepBridge() {
  const { userId } = useAuth();
  const router = useRouter();
  const runtime = useAgentRuntimeStateOptional();
  const busyOperations = useKaiSession((state) => state.busyOperations);
  const setAnalysisParams = useKaiSession((state) => state.setAnalysisParams);

  // Everything the step reads is read at call time, never from the render
  // that received the frame: the step may be answered on /one and executed
  // on /one/location, and the dispatcher's admission checks the CURRENT
  // route against the action's authored destination.
  const uidRef = useRef<string | null>(userId ?? null);
  const runtimeRef = useRef(runtime);
  const busyRef = useRef(busyOperations);
  const setAnalysisParamsRef = useRef(setAnalysisParams);
  useEffect(() => {
    uidRef.current = userId ?? null;
    runtimeRef.current = runtime;
    busyRef.current = busyOperations;
    setAnalysisParamsRef.current = setAnalysisParams;
  });

  const handledStepsRef = useRef(new Set<string>());
  const inFlightRef = useRef(new Map<string, AbortController>());

  const execute = useCallback(
    async (input: LocationUpdatesExecuteInput) => {
      const current = runtimeRef.current;
      if (!current?.appRuntimeState) {
        return {
          status: "blocked" as const,
          actionId: input.actionId,
          label: null,
          routeBefore: null,
          resultSummary: "The action runtime is not ready.",
          reason: "runtime_unavailable",
        };
      }
      return executeAgentGatewayAction({
        actionId: input.actionId,
        slots: {},
        userId: uidRef.current ?? "",
        router,
        appRuntimeState: current.appRuntimeState,
        surfaceMetadata: getVoiceSurfaceMetadata(),
        allowedActionIds:
          current.oneVoiceContextSnapshot?.executable_action_ids ?? null,
        goalAuthorization: {
          goalId: input.goalId,
          expectedScreen: input.expectedScreen,
        },
        hasPortfolioData: current.appRuntimeState.portfolio.has_portfolio_data,
        busyOperations: busyRef.current,
        setAnalysisParams: setAnalysisParamsRef.current,
        executionContext: {
          operationId: input.operationId,
          directiveId: input.operationId,
          preparedBinding: input.preparedBinding,
        },
        signal: input.signal,
      });
    },
    [router],
  );

  const buildPorts = useCallback(
    (): LocationUpdatesStepPorts => ({
      userId: uidRef.current,
      readControlState: () => readOneLocationControlState(uidRef.current),
      readOwnerGrants: () => {
        const uid = uidRef.current;
        if (!uid) return null;
        return OneLocationStateResource.readPresentation(uid)?.ownerGrants ?? null;
      },
      readFixStatus: () => LocationBus.getState().status,
      readOsPermission: () => toReportedOsPermission(LocationBus.getState().permission),
      readRoute: () => runtimeRef.current?.appRuntimeState.route.screen ?? null,
      isHandlerMounted: hasMountedLocalOnboardingHandler,
      resolveJourney: (actionId) => resolveNavigationJourney(actionId),
      navigate: (href) =>
        requestInternalAppNavigation({
          href,
          source: "voice",
          transitionMode: "contextual",
        }),
      waitForHandler: async (actionId, timeoutMs) =>
        Boolean(await waitForLocalOnboardingHandler(actionId, timeoutMs)),
      afterPaint,
      prepare: (actionId) => prepareLocalOnboardingAction(actionId, {}),
      execute,
      now: () => Date.now(),
      sleep,
    }),
    [execute],
  );

  // A step is cancelled only when the session itself goes away: the store's
  // single `clientStep` slot is replaced by every later request, so its
  // identity changing says nothing about this step.
  useEffect(() => {
    const unsubscribe = useVoiceSessionStore.subscribe((next, prev) => {
      const ended =
        next.state.phase === "idle" && prev.state.phase !== "idle";
      const reconnecting =
        next.state.phase === "connecting" && prev.state.phase !== "connecting";
      if (!ended && !reconnecting) return;
      for (const controller of inFlightRef.current.values()) controller.abort();
      inFlightRef.current.clear();
    });
    const inFlight = inFlightRef.current;
    return () => {
      unsubscribe();
      for (const controller of inFlight.values()) controller.abort();
      inFlight.clear();
    };
  }, []);

  useVoiceToolEffects({
    onClientStep: (step, report) => {
      if (step.kind !== SET_LOCATION_UPDATES_STEP) return;
      if (handledStepsRef.current.has(step.stepId)) return;
      handledStepsRef.current.add(step.stepId);
      const controller = new AbortController();
      inFlightRef.current.set(step.stepId, controller);
      let reported = false;
      const once = (
        status: "ok" | "failed",
        payload?: Record<string, unknown>,
      ) => {
        if (reported) return;
        reported = true;
        report(status, payload);
      };
      void runLocationUpdatesStep(
        { stepId: step.stepId, payload: step.payload, timeoutS: step.timeoutS },
        buildPorts(),
        controller.signal,
      )
        .then((result) => once(result.status, result.payload))
        .catch(() =>
          once("failed", {
            gateway_action_id: String(step.payload?.gateway_action_id ?? ""),
            desired_state: step.payload?.desired_state === "off" ? "off" : "on",
            outcome: "failed",
            observed_state: "unknown",
            reason_code: "exception",
            navigated: false,
            os_permission: "unknown",
          }),
        )
        .finally(() => {
          inFlightRef.current.delete(step.stepId);
        });
    },
  });

  return null;
}
