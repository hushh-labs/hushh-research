"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  createContext,
  useContext,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import { useAgentRuntimeStateOptional } from "@/lib/agent/agent-runtime-context";
import { executeAgentGatewayAction } from "@/lib/agent/agent-action-runtime";
import { settleAgentGatewayAction } from "@/lib/agent/agent-gateway-action-settlement";
import { registerOneSystemActionExecutor } from "@/lib/agent/one-system-action-executor";

import {
  LocationCommandRuntime,
  type CommandPresentation,
} from "@/lib/agent/location-command-runtime";
import { useAgentVoiceState } from "@/lib/agent/agent-voice-state";
import {
  AGENT_CONVERSATION_REQUEST_EVENT,
  AGENT_CONVERSATION_STOP_EVENT,
  AGENT_CONVERSATION_CANCEL_EVENT,
  acknowledgeAgentConversation,
  markAgentConversationOwnerReady,
  type AgentConversationRequest,
  type AgentConversationCancellation,
} from "@/lib/agent/agent-voice-settings";
import {
  appInteractionCoordinator,
  type VoiceSessionLease,
} from "@/lib/interaction/interaction-intent-coordinator";
import { useKaiSession } from "@/lib/stores/kai-session-store";
import { usePersonaState } from "@/lib/persona/persona-context";
import { getVoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { OneLocationStateResource } from "@/lib/one-location/one-location-state-resource";
import { OneLocationService } from "@/lib/one-location/service";
import { CommandCapture } from "@/lib/voice/command-capture";
import { snapKaiBottomChromeVisible } from "@/lib/navigation/kai-bottom-chrome-visibility";
import { readVoicePreferences } from "@/lib/agent/voice-preferences";
import { VaultUnlockDialog } from "@/components/vault/vault-unlock-dialog";

import { appRouteMatches } from "@/lib/navigation/route-settlement";
import { requestInternalAppNavigation } from "@/lib/utils/browser-navigation";
import { connectReviewRedirectMatches } from "@/lib/navigation/connect-routes";
import { hasMountedLocalOnboardingHandler } from "@/lib/agent/local-onboarding-actions";
import { useOptionalOneLocationInteractionSurface } from "@/components/one-location/onboarding/location-onboarding-interaction-surface";
import type { LocationOnboardingRunResultV1 } from "@/lib/services/one-location-onboarding-run-client";

const LocationCommandContext = createContext<
  ReturnType<typeof useCommandController>["controller"] | null
>(null);

/**
 * The two fields that change at microphone cadence (up to ~12 times a
 * second while recording). They live in their own context so the bottom
 * shell, the command card and the device bridge, which never show them, do
 * not re-render on every audio frame. Only the agent bar's meter reads them.
 */
type LocationCommandLive = { level: number; elapsedMs: number };
const LOCATION_COMMAND_LIVE_IDLE: LocationCommandLive = { level: 0, elapsedMs: 0 };
const LocationCommandLiveContext = createContext<LocationCommandLive>(
  LOCATION_COMMAND_LIVE_IDLE,
);

export function useLocationCommandLive(): LocationCommandLive {
  return useContext(LocationCommandLiveContext);
}

export function useLocationCommand() {
  const value = useContext(LocationCommandContext);
  if (!value) throw new Error("LocationCommandProvider is required.");
  return value;
}

export function useOptionalLocationCommand() {
  return useContext(LocationCommandContext);
}

/** Sole command and microphone owner; presentation may mount and collapse independently.
 *
 * `enabled=false` keeps the context mounted (consumers stay stable) but hands
 * conversation ownership to the One Live Voice owner: this hook then neither
 * subscribes to conversation requests nor announces itself owner-ready. Typed
 * Siri actions keep their validated executor in both modes.
 */
function useCommandController(enabled = true) {
  const router = useRouter();
  const runtime = useAgentRuntimeStateOptional();
  const { user } = useAuth();
  const { vaultOwnerToken, vaultKey, isVaultUnlocked } = useVault();
  const { switchPersona } = usePersonaState();
  const busyOperations = useKaiSession((state) => state.busyOperations);
  const setAnalysisParams = useKaiSession((state) => state.setAnalysisParams);
  const locationSurface = useOptionalOneLocationInteractionSurface();
  const locationSurfaceRef = useRef(locationSurface);
  locationSurfaceRef.current = locationSurface;
  const [workflowResult, setWorkflowResult] =
    useState<LocationOnboardingRunResultV1 | null>(null);
  const [view, setView] = useState<CommandPresentation>({
    phase: "idle",
    message: "",
  });
  const [recording, setRecording] = useState<"starting" | "recording" | null>(
    null,
  );
  const [level, setLevel] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [capture] = useState(() => new CommandCapture());
  const lease = useRef<VoiceSessionLease | null>(null);
  const captureGeneration = useRef(0);
  const recordingRef = useRef(recording);
  const processingRef = useRef(false);
  const pendingExternalRequest = useRef<AgentConversationRequest | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const latestRuntimeRef = useRef(runtime);
  latestRuntimeRef.current = runtime;
  const latest = useRef({
    user,
    vaultOwnerToken,
    vaultKey,
    isVaultUnlocked,
    busyOperations,
    setAnalysisParams,
    switchPersona,
  });
  latest.current = {
    user,
    vaultOwnerToken,
    vaultKey,
    isVaultUnlocked,
    busyOperations,
    setAnalysisParams,
    switchPersona,
  };
  const [command] = useState(
    () =>
      new LocationCommandRuntime({
        authority: () => {
          const value = latest.current;
          return value.user?.uid &&
            value.isVaultUnlocked &&
            value.vaultKey &&
            value.vaultOwnerToken
            ? {
                userId: value.user.uid,
                token: value.vaultOwnerToken,
                vaultKey: value.vaultKey,
              }
            : null;
        },
        context: () => ({
          one_voice_context: latestRuntimeRef.current?.oneVoiceContextSnapshot,
        }),
        present: (value) => {
          setView(value);
          if (value.phase === "gate" || value.phase === "recovery")
            setCollapsed(false);
          if (value.phase === "gate" || value.phase === "recovery")
            snapKaiBottomChromeVisible();
        },
        presentWorkflow: (result) => {
          if (!locationSurfaceRef.current)
            throw new Error("Location setup is still loading.");
          locationSurfaceRef.current.claimCommandPresentation(result.run.runId);
          setWorkflowResult(result);
        },
        pauseWorkflow: () => {
          setWorkflowResult(null);
          locationSurfaceRef.current?.claimCommandPresentation(null);
        },
        reconcile: async () => {
          const current = latest.current;
          if (
            !current.user ||
            !current.vaultOwnerToken ||
            !current.isVaultUnlocked
          )
            throw new Error("Unlock to refresh Location.");
          CacheSyncService.onConnectionGraphMutated(current.user.uid);
          await OneLocationStateResource.load(current.user.uid, () =>
            OneLocationService.getState(current.vaultOwnerToken!),
          );
          // Let the subscribed owner render the refreshed information before preparation.
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          );
        },
        navigate: async (route, requiredActionId) => {
          if (
            !route.startsWith("/one/") ||
            route.includes(":") ||
            route.includes("\\")
          )
            return false;
          requestInternalAppNavigation({
            href: route,
            source: "voice",
            transitionMode: "contextual",
          });
          const until = Date.now() + 8_000;
          const matches = (current: string) =>
            appRouteMatches(current, route, true) ||
            (!requiredActionId && connectReviewRedirectMatches(current, route));
          while (Date.now() < until) {
            const currentRoute =
              latestRuntimeRef.current?.appRuntimeState.route.pathname;
            if (
              matches(window.location.pathname + window.location.search) &&
              currentRoute &&
              matches(currentRoute) &&
              (!requiredActionId ||
                hasMountedLocalOnboardingHandler(requiredActionId))
            ) {
              await new Promise<void>((resolve) =>
                requestAnimationFrame(() =>
                  requestAnimationFrame(() => resolve()),
                ),
              );
              return true;
            }
            await new Promise((resolve) => setTimeout(resolve, 40));
          }
          return false;
        },
        execute: async (actionId, slots, authority, signal) => {
          const current = latestRuntimeRef.current;
          const value = latest.current;
          if (!current?.appRuntimeState)
            throw new Error("The action runtime is still loading.");
          const result = await executeAgentGatewayAction({
            actionId,
            slots,
            executionContext: authority,
            signal,
            userId: value.user?.uid || "",
            router,
            appRuntimeState: current.appRuntimeState,
            surfaceMetadata: getVoiceSurfaceMetadata(),
            allowedActionIds:
              current.oneVoiceContextSnapshot.executable_action_ids,
            hasPortfolioData:
              current.appRuntimeState.portfolio.has_portfolio_data,
            busyOperations: value.busyOperations,
            setAnalysisParams: value.setAnalysisParams,
            switchPersona: value.switchPersona,
          });
          return settleAgentGatewayAction(result, {
            getCurrentRoute: () =>
              latestRuntimeRef.current?.appRuntimeState.route,
            getCurrentSurfaceMetadata: getVoiceSurfaceMetadata,
          });
        },
      }),
  );
  const report = useCallback(
    (error: unknown) =>
      setView({
        phase: "gate",
        message:
          error instanceof Error
            ? error.message
            : "The command could not continue.",
        gate: {
          kind: "unavailable",
          message: "Review or cancel this command.",
        },
      }),
    [],
  );
  const run = useCallback(
    (work: Promise<unknown>) => {
      const generation = captureGeneration.current;
      void work.catch((error) => {
        if (generation === captureGeneration.current) report(error);
      });
    },
    [report],
  );
  const cancelCapture = useCallback(() => {
    captureGeneration.current++;
    recordingRef.current = null;
    processingRef.current = false;
    setRecording(null);
    setLevel(0);
    setElapsedMs(0);
    void capture.cancel();
    lease.current?.release("command_capture_cancelled");
    lease.current = null;
    useAgentVoiceState.getState().reset();
  }, [capture]);
  const finishCapture = useCallback(async () => {
    if (!recordingRef.current) return;
    if (recordingRef.current === "starting") {
      cancelCapture();
      return;
    }
    const generation = captureGeneration.current;
    recordingRef.current = null;
    processingRef.current = true;
    setRecording(null);
    setView({ phase: "working", message: "Finishing recording…" });
    useAgentVoiceState.getState().setStatus("transcribing");
    try {
      const audio = await capture.finish();
      if (generation !== captureGeneration.current) return;
      lease.current?.release("command_capture_finished");
      lease.current = null;
      setView({ phase: "working", message: "Transcribing…" });
      const transcript = await command.transcribe(audio.audioBase64);
      if (generation === captureGeneration.current)
        await command.submit(transcript);
    } catch (error) {
      if (generation === captureGeneration.current) report(error);
    } finally {
      if (generation === captureGeneration.current) {
        processingRef.current = false;
        lease.current?.release("command_capture_finished");
        lease.current = null;
        setLevel(0);
        useAgentVoiceState.getState().reset();
      }
    }
  }, [cancelCapture, capture, command, report]);
  const finishRef = useRef(finishCapture);
  finishRef.current = finishCapture;
  const startCapture = useCallback(async () => {
    if (
      recordingRef.current ||
      processingRef.current ||
      ["working", "gate", "recovery"].includes(viewRef.current.phase)
    )
      return;
    if (!latest.current.isVaultUnlocked || !latest.current.vaultOwnerToken) {
      setUnlockOpen(true);
      return;
    }
    if (!readVoicePreferences(latest.current.user?.uid || null).voiceEnabled)
      throw new Error("Enable commands in your settings first.");
    const generation = ++captureGeneration.current;
    // Invalidate any passive recovery read before a new capture can start.
    command.pause();
    setLevel(0);
    setElapsedMs(0);
    setView({ phase: "idle", message: "" });
    recordingRef.current = "starting";
    setRecording("starting");
    lease.current = appInteractionCoordinator.acquireVoiceLease({
      owner: "agent-bar-command",
      onRevoked: cancelCapture,
    });
    useAgentVoiceState.getState().setStatus("connecting");
    try {
      await capture.start(
        crypto.randomUUID(),
        () => {
          if (generation === captureGeneration.current)
            run(finishRef.current());
        },
        (event) => {
          if (generation !== captureGeneration.current) return;
          setLevel(event.level);
          setElapsedMs(event.elapsedMs);
        },
      );
      if (generation !== captureGeneration.current) return;
      recordingRef.current = "recording";
      setRecording("recording");
      capture.haptic("ready");
      setView({ phase: "idle", message: "" });
      useAgentVoiceState.getState().setStatus("listening");
    } catch (error) {
      if (generation !== captureGeneration.current) return;
      cancelCapture();
      // A capture failure has no command to resume. Keep the fresh microphone
      // gesture reachable, including after the first OS permission grant.
      setView({
        phase: "result",
        message:
          error instanceof Error
            ? error.message
            : "The microphone could not start. Try recording again.",
      });
    }
  }, [cancelCapture, capture, command, run]);
  const startRef = useRef(startCapture);
  startRef.current = startCapture;
  useEffect(() => {
    if (!enabled) return;
    const request = (event: Event) => {
      const value =
        (event as CustomEvent<AgentConversationRequest>).detail || {};
      const accepted = () => {
        if (value.requestId && pendingExternalRequest.current !== value) return;
        pendingExternalRequest.current = null;
        if (value.requestId)
          acknowledgeAgentConversation({
            source: value.source || "agent_chat",
            requestId: value.requestId,
            outcome: "accepted",
          });
      };
      const generation = captureGeneration.current;
      if (
        pendingExternalRequest.current ||
        (value.initialRequestText &&
          (recordingRef.current || processingRef.current))
      ) {
        if (value.requestId)
          acknowledgeAgentConversation({
            source: value.source || "agent_chat",
            requestId: value.requestId,
            outcome: "failed",
          });
        return; // One microphone/task owner; keep the current capture visible.
      }
      if (value.requestId) pendingExternalRequest.current = value;
      const work = value.initialRequestText
        ? command.submit(value.initialRequestText, value.requestId, accepted)
        : recordingRef.current
          ? finishRef.current()
          : startRef.current().then(accepted);
      void work.catch((error) => {
        if (value.requestId && pendingExternalRequest.current !== value) return;
        pendingExternalRequest.current = null;
        if (value.requestId)
          acknowledgeAgentConversation({
            source: value.source || "agent_chat",
            requestId: value.requestId,
            outcome: "failed",
          });
        if (generation === captureGeneration.current) report(error);
      });
    };
    const stop = () => {
      pendingExternalRequest.current = null;
      cancelCapture();
      command.pause();
    };
    const cancelPendingRequest = (event: Event) => {
      const cancellation = (event as CustomEvent<AgentConversationCancellation>)
        .detail;
      const pending = pendingExternalRequest.current;
      if (
        !pending ||
        !cancellation?.requestId ||
        pending.requestId !== cancellation.requestId ||
        pending.source !== cancellation.source
      )
        return;
      stop();
    };
    window.addEventListener(AGENT_CONVERSATION_REQUEST_EVENT, request);
    window.addEventListener(AGENT_CONVERSATION_STOP_EVENT, stop);
    window.addEventListener(
      AGENT_CONVERSATION_CANCEL_EVENT,
      cancelPendingRequest,
    );
    const release = markAgentConversationOwnerReady();
    return () => {
      release();
      window.removeEventListener(AGENT_CONVERSATION_REQUEST_EVENT, request);
      window.removeEventListener(AGENT_CONVERSATION_STOP_EVENT, stop);
      window.removeEventListener(
        AGENT_CONVERSATION_CANCEL_EVENT,
        cancelPendingRequest,
      );
    };
  }, [cancelCapture, command, enabled, report]);
  useEffect(() => {
    command.clearReferences();
    return () => command.clearReferences();
  }, [command, user?.uid, isVaultUnlocked, vaultKey]);
  useEffect(() => {
    cancelCapture();
    command.pause();
    if (user?.uid && isVaultUnlocked && vaultOwnerToken && vaultKey)
      run(command.recover());
    return () => {
      cancelCapture();
      command.pause();
    };
  }, [
    user?.uid,
    isVaultUnlocked,
    vaultOwnerToken,
    vaultKey,
    cancelCapture,
    command,
    run,
  ]);
  useEffect(() => {
    const background = () => {
      if (document.hidden) cancelCapture();
    };
    document.addEventListener("visibilitychange", background);
    const handle = Capacitor.isNativePlatform()
      ? App.addListener("appStateChange", ({ isActive }) => {
          if (!isActive) cancelCapture();
        })
      : null;
    return () => {
      document.removeEventListener("visibilitychange", background);
      void handle?.then((listener) => listener.remove());
    };
  }, [cancelCapture]);

  // Native typed requests enter the same checkpoint, preparation and receipt
  // lifecycle. Native completion only acknowledges this durable handoff.
  useEffect(
    () =>
      registerOneSystemActionExecutor(async (invocation) => {
        if (
          invocation.expectedOwner &&
          invocation.expectedOwner !== latest.current.user?.uid
        )
          return {
            status: "blocked",
            actionId: invocation.actionId,
            label: null,
            routeBefore: null,
            resultSummary:
              "Your account changed. Unlock to start this command again.",
          };
        if (recordingRef.current || processingRef.current) {
          return {
            status: "blocked",
            actionId: invocation.actionId,
            label: null,
            routeBefore:
              latestRuntimeRef.current?.appRuntimeState.route.pathname ?? null,
            resultSummary:
              "Finish or cancel your current recording before starting another command.",
          };
        }
        const generation = captureGeneration.current;
        const owner = latest.current.user?.uid;
        try {
          await command.submitAction(
            invocation.actionId,
            invocation.slots,
            invocation.id,
          );
          return {
            status: "started",
            actionId: invocation.actionId,
            label: null,
            routeBefore:
              latestRuntimeRef.current?.appRuntimeState.route.pathname ?? null,
            resultSummary:
              "Your Location command is ready in HUSSH. Review its result or required action there.",
          };
        } catch (error) {
          if (
            generation === captureGeneration.current &&
            owner === latest.current.user?.uid
          )
            report(error);
          return {
            status: "blocked",
            actionId: invocation.actionId,
            label: null,
            routeBefore:
              latestRuntimeRef.current?.appRuntimeState.route.pathname ?? null,
            resultSummary:
              "Open HUSSH to unlock or continue your Location command.",
          };
        }
      }),
    [command, report],
  );

  // Test-only dispatch entry point (restored; it lived in the Agent Bar until
  // that surface was rebuilt). Automation supplies the actionId/slots a voice
  // turn would have produced and gets the dispatcher's truthful result --
  // proving the action itself, without simulating audio or a relay. Installed
  // only when the native test bridge is enabled by an init script. The
  // operation id makes location local handlers take the same direct path the
  // Live device step takes instead of the bounded command runtime's handoff.
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const bridge = window.__HUSHH_NATIVE_TEST__;
    if (!bridge?.enabled) return undefined;

    const dispatch = async (
      actionId: string,
      slots?: Record<string, unknown>,
    ) => {
      bridge.dispatchAgentActionStatus = `running:${actionId}`;
      bridge.dispatchAgentActionError = "";
      const current = latestRuntimeRef.current;
      const value = latest.current;
      if (!current?.appRuntimeState) {
        const message = "App runtime state is not ready.";
        bridge.dispatchAgentActionStatus = `error:${actionId}`;
        bridge.dispatchAgentActionError = message;
        throw new Error(message);
      }
      try {
        const result = await executeAgentGatewayAction({
          actionId,
          slots: slots ?? {},
          userId: value.user?.uid ?? "",
          router,
          appRuntimeState: current.appRuntimeState,
          surfaceMetadata: getVoiceSurfaceMetadata(),
          allowedActionIds:
            current.oneVoiceContextSnapshot.executable_action_ids ?? null,
          hasPortfolioData: current.appRuntimeState.portfolio.has_portfolio_data,
          busyOperations: value.busyOperations,
          setAnalysisParams: value.setAnalysisParams,
          switchPersona: value.switchPersona,
          executionContext: {
            operationId: `native-test:${crypto.randomUUID()}`,
          },
        });
        bridge.dispatchAgentActionStatus = `ok:${actionId}`;
        return result;
      } catch (error) {
        bridge.dispatchAgentActionStatus = `error:${actionId}`;
        bridge.dispatchAgentActionError =
          error instanceof Error ? error.message : "native action dispatch failed";
        throw error;
      }
    };

    bridge.dispatchAgentAction = dispatch;
    return () => {
      const currentBridge = window.__HUSHH_NATIVE_TEST__;
      if (currentBridge && currentBridge.dispatchAgentAction === dispatch) {
        currentBridge.dispatchAgentAction = null;
      }
    };
  }, [router]);

  const cancelTask = useCallback(() => {
    cancelCapture();
    run(command.cancel());
  }, [cancelCapture, command, run]);
  const dismissResult = useCallback(() => {
    setView((current) =>
      current.phase === "result" ? { phase: "idle", message: "" } : current,
    );
  }, []);
  const workflowDirective = locationSurface?.directive;
  const progress =
    workflowResult &&
    workflowDirective?.authority === "server" &&
    workflowDirective.run.runId === workflowResult.run.runId
      ? (
          {
            "one.location.position_pending.v2": "Finding your location…",
            "one.location.place_choice.v2":
              "Preparing your private saved place…",
            "one.location.place_persisting.v2":
              "Preparing your private saved place…",
            "one.location.awaiting_vault_finalize.v2":
              "Saving your location privately…",
          } as Record<string, string>
        )[workflowDirective.serverDirective.contractId]
      : undefined;
  const visibleView = useMemo<CommandPresentation>(
    () =>
      progress
        ? { ...view, phase: "working", message: progress, gate: undefined }
        : view,
    [progress, view],
  );
  const hapticCancel = useCallback(() => capture.haptic("cancel"), [capture]);
  const active = Boolean(
    recording ||
      view.phase === "working" ||
      view.phase === "gate" ||
      view.phase === "recovery",
  );
  // Memoised: this value reaches the bottom shell and the agent bar on every
  // persistent-chrome route. Without the memo a new object per render (and
  // there was one per microphone level event) re-rendered both of them.
  const controller = useMemo(
    () => ({
      command,
      workflowResult,
      view: visibleView,
      recording,
      collapsed,
      setCollapsed,
      startCapture,
      finishCapture,
      cancelCapture,
      cancelTask,
      dismissResult,
      run,
      hapticCancel,
      active,
      user,
      unlockOpen,
      setUnlockOpen,
    }),
    [
      command,
      workflowResult,
      visibleView,
      recording,
      collapsed,
      startCapture,
      finishCapture,
      cancelCapture,
      cancelTask,
      dismissResult,
      run,
      hapticCancel,
      active,
      user,
      unlockOpen,
    ],
  );
  const live = useMemo<LocationCommandLive>(
    () => ({ level, elapsedMs }),
    [level, elapsedMs],
  );
  return { controller, live };
}

export function LocationCommandProvider({
  children,
  enabled = true,
}: {
  children: ReactNode;
  enabled?: boolean;
}) {
  const { controller, live } = useCommandController(enabled);
  return (
    <LocationCommandContext.Provider value={controller}>
      <LocationCommandLiveContext.Provider value={live}>
        {children}
      </LocationCommandLiveContext.Provider>
      {controller.user ? (
        <VaultUnlockDialog
          user={controller.user}
          open={controller.unlockOpen}
          onOpenChange={controller.setUnlockOpen}
          onSuccess={() => controller.setUnlockOpen(false)}
          title="Unlock for Location commands"
          description="Unlock your vault, then tap Talk to One to record or resume a command."
        />
      ) : null}
    </LocationCommandContext.Provider>
  );
}
