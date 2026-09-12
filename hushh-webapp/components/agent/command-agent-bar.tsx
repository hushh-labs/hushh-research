"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { usePathname, useRouter } from "next/navigation";
import { AudioLines, MessageCircle, Sun, X } from "lucide-react";
import { useTheme } from "next-themes";
import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { useOptionalAgentPopover } from "@/components/agent/agent-popover-provider";
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
import { getKaiChromeState } from "@/lib/navigation/kai-chrome-state";
import { isFoundationPublicRoute } from "@/lib/navigation/routes";
import { snapKaiBottomChromeVisible } from "@/lib/navigation/kai-bottom-chrome-visibility";
import { readVoicePreferences } from "@/lib/agent/voice-preferences";
import { cn } from "@/lib/utils";
import { VaultUnlockDialog } from "@/components/vault/vault-unlock-dialog";

/** Sole microphone owner. All command entries share execution authority. */
export function CommandAgentBar({
  layout = "fixed",
}: {
  layout?: "fixed" | "slot";
}) {
  const pathname = usePathname();
  const router = useRouter();
  const runtime = useAgentRuntimeStateOptional();
  const { user } = useAuth();
  const { vaultOwnerToken, vaultKey, isVaultUnlocked } = useVault();
  const { switchPersona } = usePersonaState();
  const busyOperations = useKaiSession((state) => state.busyOperations);
  const setAnalysisParams = useKaiSession((state) => state.setAnalysisParams);
  const popover = useOptionalAgentPopover();
  const { theme, setTheme } = useTheme();
  const [view, setView] = useState<CommandPresentation>({
    phase: "idle",
    message: "",
  });
  const [recording, setRecording] = useState<"starting" | "recording" | null>(
    null,
  );
  const [input, setInput] = useState("");
  const [unlockOpen, setUnlockOpen] = useState(false);
  const capture = useRef(new CommandCapture());
  const lease = useRef<VoiceSessionLease | null>(null);
  const captureGeneration = useRef(0);
  const recordingRef = useRef(recording);
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
            snapKaiBottomChromeVisible();
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
        navigate: async (route) => {
          if (
            !route.startsWith("/one/") ||
            route.includes(":") ||
            route.includes("\\")
          )
            return false;
          router.push(route);
          const expected = new URL(route, window.location.origin);
          const until = Date.now() + 8_000;
          while (Date.now() < until) {
            if (
              window.location.pathname === expected.pathname &&
              window.location.search === expected.search &&
              latestRuntimeRef.current?.appRuntimeState.route.pathname ===
                expected.pathname
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
      void work.catch(report);
    },
    [report],
  );
  const cancelCapture = useCallback(() => {
    captureGeneration.current++;
    recordingRef.current = null;
    setRecording(null);
    void capture.current.cancel();
    lease.current?.release("command_capture_cancelled");
    lease.current = null;
    useAgentVoiceState.getState().reset();
  }, []);
  const finishCapture = useCallback(async () => {
    if (!recordingRef.current) return;
    if (recordingRef.current === "starting") {
      cancelCapture();
      return;
    }
    const generation = captureGeneration.current;
    recordingRef.current = null;
    setRecording(null);
    useAgentVoiceState.getState().setStatus("transcribing");
    try {
      const audio = await capture.current.finish();
      lease.current?.release("command_capture_finished");
      lease.current = null;
      if (generation !== captureGeneration.current) return;
      setView({ phase: "working", message: "Transcribing…" });
      const transcript = await command.transcribe(audio.audioBase64);
      if (generation === captureGeneration.current)
        await command.submit(transcript);
    } finally {
      useAgentVoiceState.getState().reset();
    }
  }, [cancelCapture, command]);
  const finishRef = useRef(finishCapture);
  finishRef.current = finishCapture;
  const startCapture = useCallback(async () => {
    if (recordingRef.current) return;
    if (!latest.current.isVaultUnlocked || !latest.current.vaultOwnerToken) {
      setUnlockOpen(true);
      return;
    }
    if (!readVoicePreferences(latest.current.user?.uid || null).voiceEnabled)
      throw new Error("Enable commands in your settings first.");
    const generation = ++captureGeneration.current;
    recordingRef.current = "starting";
    setRecording("starting");
    popover?.minimizeAgent();
    lease.current = appInteractionCoordinator.acquireVoiceLease({
      owner: "agent-bar-command",
      onRevoked: cancelCapture,
    });
    useAgentVoiceState.getState().setStatus("connecting");
    try {
      await capture.current.start(crypto.randomUUID(), () =>
        run(finishRef.current()),
      );
      if (generation !== captureGeneration.current) return;
      recordingRef.current = "recording";
      setRecording("recording");
      setView({ phase: "idle", message: "" });
      useAgentVoiceState.getState().setStatus("listening");
    } catch (error) {
      if (generation !== captureGeneration.current) return;
      cancelCapture();
      throw error;
    }
  }, [cancelCapture, popover, run]);
  const startRef = useRef(startCapture);
  startRef.current = startCapture;
  useEffect(() => {
    const request = (event: Event) => {
      const value =
        (event as CustomEvent<AgentConversationRequest>).detail || {};
      popover?.minimizeAgent();
      const accepted = () => {
        if (value.requestId)
          acknowledgeAgentConversation({
            source: value.source || "agent_chat",
            requestId: value.requestId,
            outcome: "accepted",
          });
      };
      const work = value.initialRequestText
        ? command.submit(value.initialRequestText, value.requestId, accepted)
        : recordingRef.current
          ? finishRef.current()
          : startRef.current().then(accepted);
      void work.catch((error) => {
        if (value.requestId)
          acknowledgeAgentConversation({
            source: value.source || "agent_chat",
            requestId: value.requestId,
            outcome: "failed",
          });
        report(error);
      });
    };
    const stop = () => {
      cancelCapture();
      command.pause();
    };
    window.addEventListener(AGENT_CONVERSATION_REQUEST_EVENT, request);
    window.addEventListener(AGENT_CONVERSATION_STOP_EVENT, stop);
    window.addEventListener(AGENT_CONVERSATION_CANCEL_EVENT, stop);
    const release = markAgentConversationOwnerReady();
    return () => {
      release();
      window.removeEventListener(AGENT_CONVERSATION_REQUEST_EVENT, request);
      window.removeEventListener(AGENT_CONVERSATION_STOP_EVENT, stop);
      window.removeEventListener(AGENT_CONVERSATION_CANCEL_EVENT, stop);
    };
  }, [cancelCapture, command, popover, report]);
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

  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const held = useRef(false);
  const suppressClick = useRef(false);
  useEffect(
    () => () => {
      if (holdTimer.current) clearTimeout(holdTimer.current);
    },
    [],
  );
  const hidden = Boolean(
    popover?.expanded ||
    popover?.motionState === "opening" ||
    popover?.motionState === "closing",
  );
  const noNavbar =
    !user ||
    getKaiChromeState(pathname).useOnboardingChrome ||
    pathname === "/" ||
    isFoundationPublicRoute(pathname);
  return (
    <div
      data-agent-bar-shell
      data-ui-role="talk-to-one"
      data-agent-bar-layout={layout}
      data-ambient-chrome-ignore
      className={cn(
        "pointer-events-none flex flex-col items-center gap-3",
        layout === "slot" ? "w-full" : "fixed inset-x-0 z-[540] px-4",
      )}
      style={
        layout === "fixed"
          ? ({
              bottom: noNavbar
                ? "calc(var(--app-safe-area-bottom-effective) + 0.75rem)"
                : "var(--agent-bar-with-nav-bottom)",
            } as CSSProperties)
          : undefined
      }
    >
      {user ? (
        <VaultUnlockDialog
          user={user}
          open={unlockOpen}
          onOpenChange={setUnlockOpen}
          onSuccess={() => setUnlockOpen(false)}
          title="Unlock for Location commands"
          description="Unlock your vault, then tap Talk to One to record or resume a command."
        />
      ) : null}
      {view.phase !== "idle" && !hidden ? (
        <div
          className="agent-approval-glass pointer-events-auto max-h-[min(70dvh,36rem)] w-full max-w-[392px] overflow-y-auto rounded-3xl p-4"
          role="region"
          aria-label="Location command"
        >
          {view.gate?.choices?.map((choice) => (
            <button
              key={choice.id}
              type="button"
              className="my-1 block w-full rounded-xl border p-3 text-left"
              onClick={(event) =>
                run(
                  command.chooseResource(
                    choice.id,
                    event.nativeEvent.isTrusted,
                  ),
                )
              }
            >
              <span className="block">{choice.label}</span>
              {choice.detail ? (
                <span className="text-xs text-muted-foreground">
                  {choice.detail}
                </span>
              ) : null}
            </button>
          ))}
          {view.transcript ? (
            <p className="mb-2 text-sm text-muted-foreground">
              {view.transcript}
            </p>
          ) : null}
          {view.actionLabel ? (
            <p className="font-semibold">{view.actionLabel}</p>
          ) : null}
          <p className="text-sm" role="status" aria-live="polite">
            {view.message}
          </p>
          {view.gate?.kind === "input" ? (
            <form
              className="mt-3 flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                run(command.resolve(input));
                setInput("");
              }}
            >
              <input
                value={input}
                onChange={(event) => setInput(event.target.value)}
                aria-label="Missing Location detail"
                className="min-w-0 flex-1 rounded-xl border bg-background px-3 py-2"
                autoComplete="off"
              />
              <button
                type="submit"
                className="rounded-xl bg-primary px-3 text-primary-foreground"
              >
                Continue
              </button>
            </form>
          ) : null}
          {view.gate &&
          ["confirmation", "permission", "navigation"].includes(
            view.gate.kind,
          ) ? (
            <button
              type="button"
              className="mt-3 w-full rounded-full bg-primary py-3 text-primary-foreground"
              onClick={(event) =>
                run(command.continueGate(event.nativeEvent.isTrusted))
              }
            >
              {view.gate.kind === "confirmation" ? "Confirm" : "Continue"}
            </button>
          ) : null}
          {view.gate?.kind === "unavailable" ? (
            <button
              type="button"
              className="mt-3 w-full rounded-full bg-primary py-3 text-primary-foreground"
              onClick={() => run(command.refresh())}
            >
              Refresh / Resume
            </button>
          ) : null}
          {view.recoverable?.map((pending) => (
            <div
              key={pending.command_id}
              className="mt-3 flex items-center gap-3 text-sm"
            >
              <span className="flex-1">
                Step {pending.next_step + 1} of {pending.step_count || 1}
              </span>
              <button
                onClick={() => run(command.resume(pending))}
                className="rounded-full bg-primary px-4 py-2 text-primary-foreground"
              >
                Resume
              </button>
              <button onClick={() => run(command.cancel(pending))}>
                Cancel
              </button>
            </div>
          ))}
          {view.phase !== "recovery" ? (
            <button
              type="button"
              className="mt-3 text-sm text-muted-foreground"
              onClick={() => {
                cancelCapture();
                run(command.cancel());
              }}
            >
              {view.phase === "result" ? "Dismiss" : "Cancel"}
            </button>
          ) : null}
        </div>
      ) : null}
      <div
        data-testid="one-voice-agent-bar"
        data-agent-dock="one-agent-dock"
        role="group"
        aria-label="One assistant"
        className={cn(
          "pointer-events-auto relative z-0 flex w-full items-center gap-2 transition-opacity",
          layout === "slot"
            ? "max-w-[min(calc(100vw-1.5rem),var(--app-agent-bar-max-width))]"
            : "max-w-[min(calc(100vw-2rem),34rem)]",
          hidden && "pointer-events-none opacity-0",
        )}
        aria-hidden={hidden}
      >
        <button
          type="button"
          data-native-voice-control-id="one_voice_agent_bar_start"
          data-testid="one-voice-agent-bar-start-icon"
          data-agent-action="voice"
          className="agent-bar-voice-launcher flex h-11 min-w-0 flex-1 touch-none items-center gap-2 rounded-full px-3 text-left text-sm font-medium focus-visible:ring-2 focus-visible:ring-primary"
          disabled={!recording && view.phase === "working"}
          aria-label={
            recording
              ? "Finish recording"
              : "Talk to One. Hold to speak, or tap to start and finish."
          }
          onPointerDown={(event) => {
            if (recordingRef.current || event.button !== 0) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            held.current = false;
            suppressClick.current = false;
            holdTimer.current = setTimeout(() => {
              held.current = true;
              run(startRef.current());
            }, 250);
          }}
          onPointerUp={() => {
            if (holdTimer.current) clearTimeout(holdTimer.current);
            if (held.current) {
              held.current = false;
              suppressClick.current = true;
              run(finishRef.current());
            }
          }}
          onPointerCancel={() => {
            if (holdTimer.current) clearTimeout(holdTimer.current);
            held.current = false;
            suppressClick.current = true;
            cancelCapture();
          }}
          onClick={() => {
            if (suppressClick.current) {
              suppressClick.current = false;
              return;
            }
            run(
              recordingRef.current ? finishRef.current() : startRef.current(),
            );
          }}
        >
          <AudioLines
            className={cn(
              "h-5 w-5",
              recording === "recording" && "animate-pulse text-primary",
            )}
          />
          <span>
            {recording === "starting"
              ? "Preparing microphone…"
              : recording
                ? "Listening · finish"
                : "Talk to One"}
          </span>
        </button>
        {recording ? (
          <button
            type="button"
            onClick={cancelCapture}
            aria-label="Cancel recording"
            className="rounded-full p-3"
          >
            <X className="h-5 w-5" />
          </button>
        ) : null}
        <button
          type="button"
          data-testid="one-agent-chat-open"
          data-agent-action="chat"
          onClick={() => popover?.openAgent()}
          aria-label="Chat with One"
          className="flex h-11 items-center gap-1.5 rounded-full border-l px-3 text-sm"
        >
          <MessageCircle className="h-4 w-4" />
          <span data-testid="one-agent-chat-label">Chat</span>
        </button>
        <button
          type="button"
          aria-label="Switch appearance"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          className="rounded-full p-2"
        >
          <Sun className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
