"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import { Bug, Loader2, Mic, Search } from "lucide-react";

import { KaiCommandPalette } from "@/components/kai/kai-command-palette";
import { VoiceCompactStatus } from "@/components/kai/voice/voice-compact-status";
import { VoiceConsoleSheet } from "@/components/kai/voice/voice-console-sheet";
import { VoiceDebugDrawer } from "@/components/kai/voice/voice-debug-drawer";
import type { KaiCommandAction } from "@/lib/kai/kai-command-types";
import { Button } from "@/lib/morphy-ux/button";
import { morphyToast as toast } from "@/lib/morphy-ux/morphy";
import { Icon } from "@/lib/morphy-ux/ui";
import { useKaiBottomChromeVisibility } from "@/lib/navigation/kai-bottom-chrome-visibility";
import { KAI_COMMAND_BAR_OPEN_EVENT } from "@/lib/navigation/kai-command-bar-events";
import { cn } from "@/lib/utils";
import { useVault } from "@/lib/vault/vault-context";
import { useAmplitudeMeter } from "@/lib/voice/use-amplitude-meter";
import { composeVoiceSpeechAfterExecution } from "@/lib/voice/voice-response-composer";
import { useVoiceSession } from "@/lib/voice/voice-session-store";
import { createVoiceTurnId } from "@/lib/voice/voice-telemetry";
import {
  canTransitionVoiceUiState,
  getAllowedVoiceUiTransitions,
  type VoiceUiState,
} from "@/lib/voice/voice-ui-state-machine";
import { VoiceTtsPlaybackManager } from "@/lib/voice/voice-tts-playback";
import { voiceSessionManager } from "@/lib/voice/voice-session-manager";
import { getVoiceV2Flags } from "@/lib/voice/voice-feature-flags";
import type { GroundedVoicePlan } from "@/lib/voice/voice-grounding";
import {
  VoiceTurnOrchestrator,
  type VoiceOrchestratorSource,
  type VoiceTurnOrchestratorConfig,
  type VoiceSpeakSegmentType,
} from "@/lib/voice/voice-turn-orchestrator";
import type {
  AppRuntimeState,
  VoiceActionResult,
  VoiceMemoryHint,
  VoicePlanPayload,
  VoiceResponse,
} from "@/lib/voice/voice-types";

type VoiceVisibilityMode = "enabled" | "disabled" | "hidden";

const DEFAULT_TTS_VOICE =
  String(process.env.NEXT_PUBLIC_KAI_VOICE_TTS_VOICE || "alloy").trim() || "alloy";

const DEV_VOICE_DEBUG_ENABLED =
  process.env.NODE_ENV !== "production" || process.env.NEXT_PUBLIC_KAI_VOICE_DEBUG === "1";

const VOICE_V2_FLAGS = getVoiceV2Flags();

interface KaiSearchBarProps {
  onCommand: (command: KaiCommandAction, params?: Record<string, unknown>) => void;
  onVoiceResponse?: (payload: {
    turnId: string;
    responseId: string;
    transcript: string;
    response: VoiceResponse;
    plan: VoicePlanPayload;
    groundedPlan?: GroundedVoicePlan;
    memory?: VoiceMemoryHint;
    executionAllowed?: boolean;
    needsConfirmation?: boolean;
  }) => Promise<unknown> | unknown;
  disabled?: boolean;
  hasPortfolioData?: boolean;
  userId?: string;
  vaultOwnerToken?: string;
  voiceAvailable?: boolean;
  voiceVisibilityMode?: VoiceVisibilityMode;
  voiceUnavailableReason?: string;
  appRuntimeState?: AppRuntimeState;
  onTtsPlayingChange?: (playing: boolean) => void;
  voiceContext?: Record<string, unknown>;
  portfolioTickers?: Array<{
    symbol: string;
    name?: string;
    sector?: string;
    asset_type?: string;
    is_investable?: boolean;
    analyze_eligible?: boolean;
  }>;
}

function isPermissionDeniedError(error: unknown): boolean {
  const name =
    error && typeof error === "object" && "name" in error ? String(error.name || "") : "";
  return name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError";
}

function isVoiceSessionConnectAbortedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || "");
  return message === "VOICE_SESSION_CONNECT_ABORTED";
}

function createResponseId(turnId: string): string {
  return `vrsp_${turnId.replace(/^vturn_/, "")}`;
}

function deriveMicDisabledReason(input: {
  disabled: boolean;
  voiceAvailable: boolean;
  voiceVisibilityMode: VoiceVisibilityMode;
  voiceUnavailableReason?: string;
  micPermissionStatus: string;
}): string | null {
  if (input.voiceVisibilityMode === "hidden") return null;
  if (input.micPermissionStatus === "denied") {
    return "Microphone permission denied";
  }
  if (input.disabled) {
    return "Kai is unavailable on this screen right now.";
  }
  if (input.voiceVisibilityMode === "disabled" || !input.voiceAvailable) {
    return input.voiceUnavailableReason || "Voice is unavailable right now.";
  }
  return null;
}

function describeVoiceConnectStage(permissionStatus: string): string {
  if (permissionStatus === "prompt") {
    return "Waiting for microphone access...";
  }
  return "Connecting realtime voice session...";
}

const VOICE_STATUS_PREVIEW_MESSAGES = new Set([
  "",
  "Listening...",
  "Audio detected...",
  "Connecting realtime voice session...",
  "Waiting for microphone access...",
  "Creating realtime session...",
  "Opening realtime voice connection...",
]);

const VOICE_BARGE_IN_SHORT_COMMANDS = new Set([
  "back",
  "cancel",
  "dashboard",
  "market",
  "mute",
  "no",
  "open",
  "portfolio",
  "profile",
  "repeat",
  "resume",
  "show",
  "stop",
  "wait",
  "yes",
]);

function normalizeVoicePreviewText(value: string): string {
  return String(value || "").trim();
}

export function shouldShowAmbientListeningStatus(preview: string): boolean {
  const normalized = normalizeVoicePreviewText(preview);
  return VOICE_STATUS_PREVIEW_MESSAGES.has(normalized);
}

export function shouldTriggerVoiceBargeIn(partialTranscript: string): boolean {
  const normalized = String(partialTranscript || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return false;
  if (VOICE_BARGE_IN_SHORT_COMMANDS.has(normalized)) return true;

  const compact = normalized.replace(/\s+/g, "");
  if (compact.length >= 8) return true;

  const words = normalized.split(" ").filter(Boolean);
  if (words.length >= 2) {
    const meaningfulChars = words.reduce((sum, word) => sum + word.length, 0);
    return meaningfulChars >= 6;
  }
  return false;
}

type TimerRefLike = {
  current: number | null;
};

type VoiceUiStateRefLike = {
  current: VoiceUiState;
};

export function clearClientVadFallbackTimer(timerRef: TimerRefLike): void {
  if (timerRef.current === null) return;
  window.clearTimeout(timerRef.current);
  timerRef.current = null;
}

export function scheduleClientVadFallbackCommit(input: {
  timerRef: TimerRefLike;
  sessionMutedRef: { current: boolean };
  voiceUiStateRef: VoiceUiStateRefLike;
  commitInputAudio: () => void;
  emitDebug: (
    stage: "turn" | "mic" | "stt" | "planner" | "dispatch" | "tts" | "ui_fsm",
    event: string,
    payload?: Record<string, unknown>,
    turnId?: string | null
  ) => void;
  getCurrentTurnId: () => string | null;
}): void {
  clearClientVadFallbackTimer(input.timerRef);
  input.timerRef.current = window.setTimeout(() => {
    input.timerRef.current = null;
    if (
      input.sessionMutedRef.current ||
      input.voiceUiStateRef.current !== "sheet_listening"
    ) {
      return;
    }
    input.commitInputAudio();
    input.emitDebug("stt", "client_vad_fallback_commit", {}, input.getCurrentTurnId());
  }, 1200);
}

export function runAutoTurnDispatchSafely(input: {
  dispatch: () => Promise<void>;
  onError: (error: Error) => void;
}): void {
  void Promise.resolve()
    .then(() => input.dispatch())
    .catch((error) => {
      input.onError(error instanceof Error ? error : new Error("VOICE_AUTOTURN_FAILED"));
    });
}

export function KaiSearchBar({
  onCommand,
  onVoiceResponse,
  disabled = false,
  hasPortfolioData = true,
  userId,
  vaultOwnerToken,
  voiceAvailable = true,
  voiceVisibilityMode = "enabled",
  voiceUnavailableReason,
  appRuntimeState,
  onTtsPlayingChange,
  voiceContext,
  portfolioTickers = [],
}: KaiSearchBarProps) {
  const { getVaultOwnerToken } = useVault();
  const [open, setOpen] = useState(false);
  const [voiceUiState, setVoiceUiState] = useState<VoiceUiState>("idle");
  const [voiceErrorMessage, setVoiceErrorMessage] = useState<string | null>(null);
  const [ttsPlaybackState, setTtsPlaybackState] = useState<"idle" | "loading" | "playing">("idle");
  const [processingStageText, setProcessingStageText] = useState<string | null>(null);
  const [transcriptPreview, setTranscriptPreview] = useState<string>("");
  const [finalTranscript, setFinalTranscript] = useState<string>("");
  const [lastReplyText, setLastReplyText] = useState<string>("");
  const [micPermissionStatus, setMicPermissionStatus] = useState<string>("unknown");
  const [stableMicDisabledReason, setStableMicDisabledReason] = useState<string | null>(null);
  const [realtimeSessionReady, setRealtimeSessionReady] = useState<boolean>(false);
  const [sessionMuted, setSessionMuted] = useState<boolean>(true);
  const [sessionStateText, setSessionStateText] = useState<string>("idle");
  const [voiceSessionId] = useState<string>(
    () => `vsession_${createVoiceTurnId().replace("vturn_", "")}`
  );
  const [sessionScopeId] = useState<string>(
    () => `voice_scope_${createVoiceTurnId().replace("vturn_", "")}`
  );

  const { hidden: hideBottomChrome, progress: hideBottomChromeProgress } =
    useKaiBottomChromeVisibility(true);

  const appendDebugEvent = useVoiceSession((s) => s.appendDebugEvent);
  const setLastAssistantReply = useVoiceSession((s) => s.setLastAssistantReply);
  const pendingConfirmation = useVoiceSession((s) => s.pendingConfirmation);
  const setPendingConfirmation = useVoiceSession((s) => s.setPendingConfirmation);

  const barRef = useRef<HTMLDivElement | null>(null);
  const ttsPlaybackManagerRef = useRef<VoiceTtsPlaybackManager | null>(null);
  const orchestratorRef = useRef<VoiceTurnOrchestrator | null>(null);
  const currentVoiceTurnIdRef = useRef<string | null>(null);
  const voiceUiStateRef = useRef<VoiceUiState>("idle");
  const partialFallbackTimerRef = useRef<number | null>(null);
  const lastFinalTranscriptRef = useRef<{ text: string; atMs: number } | null>(null);
  const transcriptPreviewRef = useRef<string>("");
  const sessionMutedRef = useRef<boolean>(true);
  const ttsPlaybackStateRef = useRef<"idle" | "loading" | "playing">("idle");
  const onVoiceResponseRef = useRef<KaiSearchBarProps["onVoiceResponse"]>(onVoiceResponse);
  const appRuntimeStateRef = useRef<AppRuntimeState | undefined>(appRuntimeState);
  const voiceContextRef = useRef<Record<string, unknown> | undefined>(voiceContext);
  const setLastAssistantReplyRef = useRef(setLastAssistantReply);
  const transitionVoiceStateRef = useRef<
    (next: VoiceUiState, reason: string, payload?: Record<string, unknown>) => void
  >(() => {});
  const speakAssistantMessageRef = useRef<
    (input: {
      text: string;
      turnId: string;
      responseId: string;
      segmentType: VoiceSpeakSegmentType;
    }) => Promise<void>
  >(async () => {});
  const processTranscriptTurnRef = useRef<
    (transcript: string, source: VoiceOrchestratorSource) => Promise<void>
  >(async () => {});
  const moveToListeningOrIdleRef = useRef<() => void>(() => {});
  const emitDebugRef = useRef<
    (
      stage: "turn" | "mic" | "stt" | "planner" | "dispatch" | "tts" | "ui_fsm",
      event: string,
      payload?: Record<string, unknown>,
      turnId?: string | null
    ) => void
  >(() => {});
  const startMeterRef = useRef<(stream: MediaStream) => Promise<void>>(async () => {});
  const stopMeterRef = useRef<() => void>(() => {});

  const { rawRms, normalizedLevel, smoothedLevel, start, stop } = useAmplitudeMeter({
    sensitivity: 11,
    smoothingFactor: 0.2,
    logIntervalMs: 500,
  });

  const micHidden = voiceVisibilityMode === "hidden";
  const micDisabledReason = useMemo(
    () =>
      deriveMicDisabledReason({
        disabled,
        voiceAvailable,
        voiceVisibilityMode,
        voiceUnavailableReason,
        micPermissionStatus,
      }),
    [disabled, micPermissionStatus, voiceAvailable, voiceUnavailableReason, voiceVisibilityMode]
  );
  const micDisabled = Boolean(micDisabledReason);

  const emitDebug = useCallback(
    (
      stage: "turn" | "mic" | "stt" | "planner" | "dispatch" | "tts" | "ui_fsm",
      event: string,
      payload: Record<string, unknown> = {},
      turnId?: string | null
    ) => {
      appendDebugEvent({
        turnId: turnId || currentVoiceTurnIdRef.current || "no_turn",
        sessionId: voiceSessionId,
        stage,
        event,
        payload,
      });
    },
    [appendDebugEvent, voiceSessionId]
  );

  const transitionVoiceState = useCallback(
    (next: VoiceUiState, reason: string, payload: Record<string, unknown> = {}) => {
      const prev = voiceUiStateRef.current;
      if (prev === next) return;
      if (!canTransitionVoiceUiState(prev, next)) {
        emitDebug("ui_fsm", "state_invalid_transition", {
          from: prev,
          to: next,
          reason,
          allowed: getAllowedVoiceUiTransitions(prev),
          ...payload,
        });
        return;
      }
      voiceUiStateRef.current = next;
      setVoiceUiState(next);
      emitDebug("ui_fsm", "state_transition", {
        from: prev,
        to: next,
        reason,
        ...payload,
      });
    },
    [emitDebug]
  );

  const moveToListeningOrIdle = useCallback(() => {
    if (pendingConfirmation) {
      clearClientVadFallbackTimer(partialFallbackTimerRef);
      transitionVoiceState("retry_ready", "pending_confirmation_ready");
      setTranscriptPreview(pendingConfirmation.prompt);
      setProcessingStageText("Confirm or cancel this voice action.");
      return;
    }
    if (sessionMuted) {
      clearClientVadFallbackTimer(partialFallbackTimerRef);
      transitionVoiceState("sheet_muted", "session_muted");
      setTranscriptPreview("Microphone muted. Tap mic to continue.");
      setProcessingStageText(null);
      return;
    }
    const sessionReady = realtimeSessionReady && voiceSessionManager.connected();
    if (!sessionReady) {
      clearClientVadFallbackTimer(partialFallbackTimerRef);
      transitionVoiceState("retry_ready", "session_not_connected");
      setProcessingStageText("Realtime session reconnecting. Tap retry if it does not recover.");
      setTranscriptPreview("Realtime session reconnecting...");
      return;
    }
    transitionVoiceState("sheet_listening", "session_live");
    setProcessingStageText(null);
    setTranscriptPreview("Listening...");
  }, [pendingConfirmation, realtimeSessionReady, sessionMuted, transitionVoiceState]);

  const setVoiceError = useCallback(
    (message: string, userMessage?: string) => {
      setVoiceErrorMessage(message);
      transitionVoiceState("error_terminal", "error", { message });
      emitDebug("turn", "error", { message });
      toast.error(userMessage || message);
    },
    [emitDebug, transitionVoiceState]
  );

  const setRetryReadyError = useCallback(
    (message: string, userMessage?: string) => {
      setVoiceErrorMessage(message);
      setProcessingStageText(message);
      setTranscriptPreview(message);
      transitionVoiceState("retry_ready", "recoverable_error", { message });
      emitDebug("turn", "retry_ready", { message });
      toast.error(userMessage || message);
    },
    [emitDebug, transitionVoiceState]
  );

  const speakAssistantMessage = useCallback(
    async (input: {
      text: string;
      turnId: string;
      responseId: string;
      segmentType: VoiceSpeakSegmentType;
    }) => {
      const manager = ttsPlaybackManagerRef.current;
      if (!manager) return;
      if (!userId || !vaultOwnerToken) {
        throw new Error("VOICE_TTS_AUTH_REQUIRED");
      }
      const speakInput = {
        userId,
        vaultOwnerToken,
        text: input.text,
        voice: DEFAULT_TTS_VOICE,
        voiceTurnId: input.turnId,
        responseId: input.responseId,
        segmentType: input.segmentType,
      } as const;

      try {
        await manager.speak({
          ...speakInput,
          adapter: "realtime_stream_tts",
          realtimeAdapter: {
            speak: ({
              text,
              voice,
              voiceTurnId,
              responseId,
              segmentType,
              timeoutMs,
              onFirstAudio,
              onPlaybackStarted,
              onPlaybackEnded,
            }) =>
              voiceSessionManager.requestSpeech({
                text,
                voice,
                turnId: voiceTurnId || input.turnId,
                responseId: responseId || input.responseId,
                segmentType: segmentType || input.segmentType,
                timeoutMs,
                onFirstAudio,
                onPlaybackStarted,
                onPlaybackEnded,
              }),
            cancel: () => voiceSessionManager.cancelSpeech("VOICE_STREAM_TTS_CANCELLED"),
          },
        });
      } catch (error) {
        if (!VOICE_V2_FLAGS.ttsBackendFallbackEnabled) {
          throw error;
        }
        emitDebug(
          "tts",
          "realtime_tts_failed_backend_fallback",
          {
            reason: error instanceof Error ? error.message : "unknown_error",
          },
          input.turnId
        );
        await manager.speak({ ...speakInput, adapter: "backend_batch_tts" });
      }
    },
    [emitDebug, userId, vaultOwnerToken]
  );

  const processTranscriptTurn = useCallback(
    async (transcript: string, source: VoiceOrchestratorSource) => {
      if (!orchestratorRef.current || !onVoiceResponse) {
        setVoiceError("Voice response callback is not configured", "Voice command failed.");
        return;
      }
      if (!userId || !vaultOwnerToken || !voiceAvailable) {
        toast.info(voiceUnavailableReason || "Unlock your vault to use voice");
        moveToListeningOrIdle();
        return;
      }

      const normalized = String(transcript || "").trim();
      if (!normalized) return;
      setPendingConfirmation(null);

      const previous = lastFinalTranscriptRef.current;
      const now = performance.now();
      if (previous && previous.text.toLowerCase() === normalized.toLowerCase() && now - previous.atMs < 1400) {
        emitDebug("stt", "final_transcript_deduped", { transcript: normalized });
        return;
      }
      lastFinalTranscriptRef.current = { text: normalized, atMs: now };

      setFinalTranscript(normalized);
      setTranscriptPreview(normalized);

      try {
        const result = await orchestratorRef.current.processTranscript({
          transcript: normalized,
          source,
        });
        if (!result) return;
        currentVoiceTurnIdRef.current = result.turnId;
        if (result.response.kind === "clarify" && result.response.reason === "stt_unusable") {
          setProcessingStageText("Tap retry and speak again.");
          transitionVoiceState("retry_ready", "clarify_retry_ready", {
            response_kind: result.response.kind,
            reason: result.response.reason,
          });
        }
      } catch (error) {
        const message =
          error instanceof Error && error.message.trim()
            ? error.message.trim()
            : "Voice command failed. Please try again.";
        setRetryReadyError(message, "Voice command failed. Please try again.");
      }
    },
    [
      emitDebug,
      moveToListeningOrIdle,
      onVoiceResponse,
      setVoiceError,
      setRetryReadyError,
      userId,
      vaultOwnerToken,
      voiceAvailable,
      voiceUnavailableReason,
      setPendingConfirmation,
      transitionVoiceState,
    ]
  );

  const submitDebugTurn = useCallback(() => {
    if (!VOICE_V2_FLAGS.submitDebugVisible) return;
    if (!realtimeSessionReady) {
      toast.info("Realtime session still connecting.");
      return;
    }
    voiceSessionManager.commitInputAudio();
    emitDebug("stt", "debug_submit_commit_sent", {}, currentVoiceTurnIdRef.current);
  }, [emitDebug, realtimeSessionReady]);

  const toggleMuteListening = useCallback(() => {
    const nextMuted = voiceSessionManager.toggleMuted();
    setSessionMuted(nextMuted);
    if (nextMuted) {
      clearClientVadFallbackTimer(partialFallbackTimerRef);
      transitionVoiceState("sheet_muted", "mic_muted");
      setTranscriptPreview("Microphone muted. Tap mic to continue.");
      return;
    }
    transitionVoiceState("sheet_listening", "mic_unmuted");
    setTranscriptPreview(realtimeSessionReady ? "Listening..." : "Connecting realtime voice session...");
  }, [realtimeSessionReady, transitionVoiceState]);

  const cancelListening = useCallback(() => {
    clearClientVadFallbackTimer(partialFallbackTimerRef);
    setPendingConfirmation(null);
    ttsPlaybackManagerRef.current?.stop();
    voiceSessionManager.cancelSpeech("VOICE_CANCELLED");
    orchestratorRef.current?.cancelActiveTurn("voice_cancel_clicked");
    voiceSessionManager.setMuted(true);
    void voiceSessionManager.release(sessionScopeId);
    setSessionMuted(true);
    setRealtimeSessionReady(false);
    setSessionStateText("idle");
    setVoiceErrorMessage(null);
    transitionVoiceState("idle", "cancel_clicked");
    setProcessingStageText(null);
    setTranscriptPreview("");
    setFinalTranscript("");
  }, [sessionScopeId, setPendingConfirmation, transitionVoiceState]);

  const handleExamplePrompt = useCallback(
    async (prompt: string) => {
      const trimmed = String(prompt || "").trim();
      if (!trimmed) return;
      transitionVoiceState("processing_compact", "example_prompt_selected");
      await processTranscriptTurn(trimmed, "example_chip");
    },
    [processTranscriptTurn, transitionVoiceState]
  );

  const handleReplay = useCallback(async () => {
    const replayText = String(lastReplyText || "").trim();
    if (!replayText) return;
    const turnId = createVoiceTurnId();
    currentVoiceTurnIdRef.current = turnId;
    transitionVoiceState("speaking_compact", "replay_clicked", { turn_id: turnId });
    try {
      await speakAssistantMessage({
        text: replayText,
        turnId,
        responseId: createResponseId(turnId),
        segmentType: "final",
      });
      moveToListeningOrIdle();
    } catch (error) {
      setRetryReadyError(
        error instanceof Error ? error.message : "Could not replay response",
        "Could not replay the last response."
      );
    }
  }, [
    lastReplyText,
    moveToListeningOrIdle,
    setRetryReadyError,
    speakAssistantMessage,
    transitionVoiceState,
  ]);

  const handleStopSpeaking = useCallback(
    (event?: MouseEvent<HTMLButtonElement>) => {
      event?.preventDefault();
      event?.stopPropagation();
      ttsPlaybackManagerRef.current?.stop();
      voiceSessionManager.cancelSpeech("VOICE_BARGE_IN_STOP");
      moveToListeningOrIdle();
    },
    [moveToListeningOrIdle]
  );

  const connectVoiceSession = useCallback(async (): Promise<"connected" | "cancelled" | "failed"> => {
    if (!VOICE_V2_FLAGS.enabled) return "failed";
    if (!userId || !vaultOwnerToken || !voiceAvailable) return "failed";
    try {
      await voiceSessionManager.acquire({
        scopeId: sessionScopeId,
        userId,
        vaultOwnerToken,
        getVaultOwnerToken,
        voice: DEFAULT_TTS_VOICE,
        activate: true,
      });
      const connected = voiceSessionManager.connected();
      setRealtimeSessionReady(connected);
      const snapshot = voiceSessionManager.getSnapshot();
      setSessionMuted(snapshot.muted);
      if (connected) {
        return "connected";
      }
      return snapshot.state === "idle" && !snapshot.lastError ? "cancelled" : "failed";
    } catch (error) {
      const message = error instanceof Error ? error.message : "Realtime voice session failed";
      if (isVoiceSessionConnectAbortedError(error)) {
        setVoiceErrorMessage(null);
        setProcessingStageText(null);
        setTranscriptPreview("");
        setRealtimeSessionReady(false);
        setSessionMuted(true);
        return "cancelled";
      }
      if (isPermissionDeniedError(error)) {
        setMicPermissionStatus("denied");
        setVoiceError(message, "Microphone permission denied");
        return "failed";
      }
      setVoiceErrorMessage(message);
      return "failed";
    }
  }, [getVaultOwnerToken, sessionScopeId, setVoiceError, userId, vaultOwnerToken, voiceAvailable]);

  const startListening = useCallback(async () => {
    if (micDisabled) {
      if (stableMicDisabledReason) toast.info(stableMicDisabledReason);
      return;
    }
    if (sessionStateText === "connecting") {
      return;
    }
    let permissionStatus = "unknown";
    if (navigator.permissions?.query) {
      try {
        const result = await navigator.permissions.query({ name: "microphone" as PermissionName });
        permissionStatus = result.state;
        setMicPermissionStatus(result.state);
        if (result.state === "denied") {
          setVoiceError("Microphone permission denied", "Microphone permission denied");
          return;
        }
      } catch {
        setMicPermissionStatus("unknown");
      }
    }

    setVoiceErrorMessage(null);
    setProcessingStageText(null);
    setPendingConfirmation(null);
    transitionVoiceState("sheet_listening", "mic_connect_started");
    setTranscriptPreview(describeVoiceConnectStage(permissionStatus));

    const connectionState = await connectVoiceSession();
    if (connectionState !== "connected") {
      if (connectionState === "cancelled") {
        transitionVoiceState("idle", "session_connect_cancelled");
        setTranscriptPreview("");
        return;
      }
      setProcessingStageText("Connection failed. Tap retry to try again.");
      transitionVoiceState("retry_ready", "session_connect_failed");
      setTranscriptPreview("Could not connect to realtime voice.");
      return;
    }
    setMicPermissionStatus("granted");
    voiceSessionManager.setMuted(false);
    setSessionMuted(false);
    setVoiceErrorMessage(null);
    setProcessingStageText(null);
    setTranscriptPreview("Listening...");
  }, [
    connectVoiceSession,
    micDisabled,
    sessionStateText,
    setPendingConfirmation,
    stableMicDisabledReason,
    setVoiceError,
    transitionVoiceState,
  ]);

  const handleRetry = useCallback(async () => {
    setPendingConfirmation(null);
    transitionVoiceState("idle", "retry_button_clicked");
    await startListening();
  }, [setPendingConfirmation, startListening, transitionVoiceState]);

  const handleConfirmPending = useCallback(async () => {
    if (!pendingConfirmation || !onVoiceResponseRef.current) {
      return;
    }
    const turnId = pendingConfirmation.turnId || createVoiceTurnId();
    const responseId = pendingConfirmation.responseId || createResponseId(turnId);
    const response =
      pendingConfirmation.kind === "cancel_active_analysis" &&
      pendingConfirmation.toolCall.tool_name === "cancel_active_analysis"
        ? {
            kind: "execute" as const,
            message: pendingConfirmation.prompt,
            speak: true as const,
            tool_call: {
              ...pendingConfirmation.toolCall,
              args: {
                confirm: true,
              },
            },
          }
        : {
            kind: "execute" as const,
            message: pendingConfirmation.prompt,
            speak: true as const,
            tool_call: pendingConfirmation.toolCall,
          };
    const plan: VoicePlanPayload = {
      mode: "execute_and_wait",
      action_id: null,
      reply_strategy: "template",
      response,
      execution_allowed: true,
      needs_confirmation: false,
    };

    setPendingConfirmation(null);
    setProcessingStageText("Executing action...");
    transitionVoiceState("processing_compact", "confirmation_accepted");
    try {
      const outcome = await Promise.resolve(
        onVoiceResponseRef.current({
          turnId,
          responseId,
          transcript: pendingConfirmation.transcript,
          response,
          plan,
          executionAllowed: true,
          needsConfirmation: false,
        })
      );
      const actionResult =
        outcome &&
        typeof outcome === "object" &&
        "actionResult" in outcome &&
        outcome.actionResult &&
        typeof outcome.actionResult === "object"
          ? (outcome.actionResult as VoiceActionResult)
          : null;
      const speech = composeVoiceSpeechAfterExecution({
        response,
        plan,
        actionResult,
        plannerFinalText: response.message,
      });
      if (speech?.text) {
        currentVoiceTurnIdRef.current = turnId;
        setLastReplyText(speech.text);
        if (speech.segmentType !== "ack") {
          setFinalTranscript(speech.text);
        }
        setLastAssistantReplyRef.current({
          message: speech.text,
          kind: speech.segmentType === "ack" ? "speak_only" : response.kind,
          turnId,
        });
        emitDebug("tts", "assistant_text_scheduled", {
          response_id: responseId,
          segment_type: speech.segmentType,
          kind: speech.segmentType === "ack" ? "ack" : response.kind,
          text_chars: speech.text.length,
        }, turnId);
        setProcessingStageText("Kai is speaking...");
        transitionVoiceState("speaking_compact", "confirmation_speech_scheduled");
        await speakAssistantMessageRef.current({
          text: speech.text,
          turnId,
          responseId,
          segmentType: speech.segmentType,
        });
      }
      moveToListeningOrIdle();
    } catch (error) {
      setRetryReadyError(
        error instanceof Error ? error.message : "Voice confirmation failed",
        "Could not complete that voice action."
      );
    }
  }, [
    emitDebug,
    moveToListeningOrIdle,
    pendingConfirmation,
    setPendingConfirmation,
    setRetryReadyError,
    transitionVoiceState,
  ]);

  const handleCancelPending = useCallback(() => {
    if (!pendingConfirmation) return;
    setPendingConfirmation(null);
    setProcessingStageText("Voice action canceled.");
    if (sessionMuted) {
      setTranscriptPreview("Voice action canceled.");
      transitionVoiceState("idle", "confirmation_cancelled");
      return;
    }
    transitionVoiceState("sheet_listening", "confirmation_cancelled");
    setTranscriptPreview(realtimeSessionReady ? "Listening..." : "Connecting realtime voice session...");
  }, [
    pendingConfirmation,
    realtimeSessionReady,
    sessionMuted,
    setPendingConfirmation,
    transitionVoiceState,
  ]);

  const handleMicTap = useCallback(
    async (event: MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      if (micHidden) return;
      if (sessionMuted && realtimeSessionReady) {
        voiceSessionManager.setMuted(false);
        setSessionMuted(false);
        setVoiceErrorMessage(null);
        setProcessingStageText(null);
        transitionVoiceState("sheet_listening", "mic_unmuted");
        setTranscriptPreview("Listening...");
        return;
      }
      if (sessionMuted || voiceUiState === "idle" || voiceUiState === "retry_ready") {
        await startListening();
        return;
      }
      voiceSessionManager.setMuted(true);
      clearClientVadFallbackTimer(partialFallbackTimerRef);
      setSessionMuted(true);
      transitionVoiceState("sheet_muted", "mic_muted_from_button");
      setTranscriptPreview("Microphone muted. Tap mic to continue.");
    },
    [
      micHidden,
      realtimeSessionReady,
      sessionMuted,
      startListening,
      transitionVoiceState,
      voiceUiState,
    ]
  );

  useEffect(() => {
    sessionMutedRef.current = sessionMuted;
  }, [sessionMuted]);

  useEffect(() => {
    transcriptPreviewRef.current = transcriptPreview;
  }, [transcriptPreview]);

  useEffect(() => {
    ttsPlaybackStateRef.current = ttsPlaybackState;
  }, [ttsPlaybackState]);

  useEffect(() => {
    voiceUiStateRef.current = voiceUiState;
  }, [voiceUiState]);

  useEffect(() => {
    onVoiceResponseRef.current = onVoiceResponse;
  }, [onVoiceResponse]);

  useEffect(() => {
    appRuntimeStateRef.current = appRuntimeState;
  }, [appRuntimeState]);

  useEffect(() => {
    voiceContextRef.current = voiceContext;
  }, [voiceContext]);

  useEffect(() => {
    setStableMicDisabledReason(micDisabledReason);
  }, [micDisabledReason]);

  useEffect(() => {
    setLastAssistantReplyRef.current = setLastAssistantReply;
  }, [setLastAssistantReply]);

  useEffect(() => {
    transitionVoiceStateRef.current = transitionVoiceState;
  }, [transitionVoiceState]);

  useEffect(() => {
    speakAssistantMessageRef.current = speakAssistantMessage;
  }, [speakAssistantMessage]);

  useEffect(() => {
    processTranscriptTurnRef.current = processTranscriptTurn;
  }, [processTranscriptTurn]);

  useEffect(() => {
    moveToListeningOrIdleRef.current = moveToListeningOrIdle;
  }, [moveToListeningOrIdle]);

  useEffect(() => {
    emitDebugRef.current = emitDebug;
  }, [emitDebug]);

  useEffect(() => {
    startMeterRef.current = start;
  }, [start]);

  useEffect(() => {
    stopMeterRef.current = stop;
  }, [stop]);

  useLayoutEffect(() => {
    const root = document.documentElement;
    const update = () => {
      const barHeight = barRef.current?.getBoundingClientRect().height ?? 48;
      const cssGap = Number.parseFloat(getComputedStyle(root).getPropertyValue("--kai-command-bottom-gap"));
      const gap = Number.isFinite(cssGap) ? cssGap : 12;
      const total = Math.round(barHeight + gap);
      root.style.setProperty("--kai-command-fixed-ui", `${total}px`);
    };

    update();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => update()) : null;
    if (barRef.current && ro) ro.observe(barRef.current);

    window.addEventListener("resize", update, { passive: true });
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", update);
    };
  }, []);

  useEffect(() => {
    const handleOpen = () => setOpen(true);
    window.addEventListener(KAI_COMMAND_BAR_OPEN_EVENT, handleOpen as EventListener);
    return () => {
      window.removeEventListener(KAI_COMMAND_BAR_OPEN_EVENT, handleOpen as EventListener);
    };
  }, []);

  useEffect(() => {
    if (ttsPlaybackManagerRef.current) return;
    ttsPlaybackManagerRef.current = new VoiceTtsPlaybackManager(
      (state) => {
        setTtsPlaybackState(state);
        onTtsPlayingChange?.(state === "playing");
      },
      {
        onPlaybackStarted: ({ voiceTurnId, source }) => {
          emitDebug("tts", "playback_started", { source }, voiceTurnId || null);
        },
        onPlaybackEnded: ({ voiceTurnId, source }) => {
          emitDebug("tts", "playback_ended", { source }, voiceTurnId || null);
        },
        onPlaybackFailed: ({ voiceTurnId, reason, source }) => {
          emitDebug("tts", "playback_failed", { reason, source: source || null }, voiceTurnId || null);
        },
        onStopped: ({ voiceTurnId, source }) => {
          emitDebug("tts", "playback_stopped", { source: source || null }, voiceTurnId || null);
        },
      }
    );
  }, [emitDebug, onTtsPlayingChange]);

  useEffect(() => {
    const voiceResponseHandler = onVoiceResponseRef.current;
    if (!voiceResponseHandler || !userId || !vaultOwnerToken) {
      orchestratorRef.current?.cancelActiveTurn("orchestrator_disabled");
      orchestratorRef.current = null;
      return;
    }
    const orchestratorConfig: VoiceTurnOrchestratorConfig = {
      userId,
      vaultOwnerToken,
      getAppRuntimeState: () => appRuntimeStateRef.current,
      getVoiceContext: () => voiceContextRef.current,
      onVoiceResponse: (payload) => {
        const handler = onVoiceResponseRef.current;
        if (!handler) {
          throw new Error("VOICE_RESPONSE_HANDLER_UNAVAILABLE");
        }
        if (
          payload.needsConfirmation &&
          payload.response.kind === "execute" &&
          (payload.response.tool_call.tool_name === "cancel_active_analysis" ||
            payload.response.tool_call.tool_name === "execute_kai_command" ||
            payload.response.tool_call.tool_name === "resume_active_analysis")
        ) {
          setPendingConfirmation({
            kind: payload.response.tool_call.tool_name,
            toolCall: payload.response.tool_call,
            prompt: payload.response.message,
            transcript: payload.transcript,
            turnId: payload.turnId,
            responseId: payload.responseId,
          });
          return {
            shortTermMemoryWrite: false,
          };
        }
        return handler(payload);
      },
      speak: (input) => speakAssistantMessageRef.current(input),
      onStageChange: (stage) => {
        if (stage === "planning") {
          setProcessingStageText("Planning response...");
          transitionVoiceStateRef.current("processing_compact", "planner_started");
          return;
        }
        if (stage === "dispatch") {
          setProcessingStageText("Executing action...");
          transitionVoiceStateRef.current("processing_compact", "dispatch_started");
          return;
        }
        if (stage === "speaking_ack") {
          setProcessingStageText("Kai is speaking...");
          transitionVoiceStateRef.current("speaking_compact", "ack_started");
          return;
        }
        if (stage === "speaking_final") {
          setProcessingStageText("Kai is speaking...");
          transitionVoiceStateRef.current("speaking_compact", "final_started");
          return;
        }
        if (stage === "idle") {
          moveToListeningOrIdleRef.current();
        }
      },
      onDebug: (event, payload) => {
        emitDebugRef.current("planner", event, payload || {}, currentVoiceTurnIdRef.current);
      },
      onAssistantText: ({ text, kind, turnId, responseId, segmentType }) => {
        currentVoiceTurnIdRef.current = turnId;
        setLastReplyText(text);
        if (kind !== "ack") {
          setFinalTranscript(text);
        }
        setLastAssistantReplyRef.current({
          message: text,
          kind: kind === "ack" ? "speak_only" : kind,
          turnId,
        });
        emitDebugRef.current(
          "tts",
          "assistant_text_scheduled",
          {
            response_id: responseId,
            segment_type: segmentType,
            kind,
            text_chars: text.length,
          },
          turnId
        );
      },
    };

    if (orchestratorRef.current) {
      orchestratorRef.current.updateConfig(orchestratorConfig);
      return;
    }
    orchestratorRef.current = new VoiceTurnOrchestrator(orchestratorConfig);
  }, [onVoiceResponse, setPendingConfirmation, userId, vaultOwnerToken]);

  useEffect(() => {
    const unsubscribe = voiceSessionManager.subscribe((event) => {
      if (event.type === "connection") {
        const snapshot = event.snapshot;
        setRealtimeSessionReady(snapshot.state === "connected");
        setSessionMuted(snapshot.muted);
        setSessionStateText(snapshot.state);
        if (snapshot.muted || snapshot.state === "idle" || snapshot.state === "error") {
          clearClientVadFallbackTimer(partialFallbackTimerRef);
        }

        if (snapshot.state === "connected") {
          setVoiceErrorMessage(null);
          const stream = voiceSessionManager.getStream();
          if (stream) {
            void startMeterRef.current(stream);
          }
          if (
            !snapshot.muted &&
            (voiceUiStateRef.current === "sheet_listening" || voiceUiStateRef.current === "retry_ready")
          ) {
            if (voiceUiStateRef.current === "retry_ready") {
              transitionVoiceStateRef.current("sheet_listening", "session_recovered");
            }
            setTranscriptPreview("Listening...");
          }
        }
        if (snapshot.state === "idle" || snapshot.state === "error") {
          stopMeterRef.current();
        }
        if (snapshot.state === "connecting" && voiceUiStateRef.current === "sheet_listening") {
          setTranscriptPreview("Connecting realtime voice session...");
        }
        if (snapshot.state === "error") {
          orchestratorRef.current?.cancelActiveTurn("session_error");
          const detail =
            typeof snapshot.lastError === "string" && snapshot.lastError.trim()
              ? snapshot.lastError.trim()
              : "Realtime voice session failed.";
          setProcessingStageText(null);
          setVoiceErrorMessage(detail);
          setTranscriptPreview("Realtime session dropped.");
          if (voiceSessionManager.hasActiveScope(sessionScopeId)) {
            setProcessingStageText("Realtime session dropped. Tap retry to reconnect.");
            transitionVoiceStateRef.current("retry_ready", "session_error_retry_ready");
          }
        }

        emitDebugRef.current(
          "stt",
          "session_state_changed",
          {
            state: snapshot.state,
            reason: event.reason,
            muted: snapshot.muted,
            session_id: snapshot.sessionId,
            model: snapshot.model,
            voice: snapshot.voice,
            reconnect_latency_ms: snapshot.reconnectLatencyMs,
            last_error: snapshot.lastError,
          },
          currentVoiceTurnIdRef.current
        );
        return;
      }

      if (event.type === "debug") {
        const allowConnectStageUpdates =
          voiceUiStateRef.current === "sheet_listening" &&
          (!sessionMutedRef.current || voiceSessionManager.getSnapshot().state === "connecting");
        if (allowConnectStageUpdates) {
          if (event.event === "permission_request_started") {
            setTranscriptPreview("Waiting for microphone access...");
          } else if (event.event === "permission_request_succeeded") {
            setMicPermissionStatus("granted");
            setTranscriptPreview("Creating realtime session...");
          } else if (event.event === "realtime_session_request_started") {
            setTranscriptPreview("Creating realtime session...");
          } else if (
            event.event === "realtime_session_request_succeeded" ||
            event.event === "realtime_handshake_started"
          ) {
            setTranscriptPreview("Opening realtime voice connection...");
          }
        }
        if (
          event.event === "speech_started" &&
          !sessionMutedRef.current &&
          voiceUiStateRef.current === "retry_ready"
        ) {
          transitionVoiceStateRef.current("sheet_listening", "speech_started_after_retry");
          setProcessingStageText(null);
          setVoiceErrorMessage(null);
        }
        emitDebugRef.current("stt", event.event, event.payload || {}, currentVoiceTurnIdRef.current);
        return;
      }

      const transcriptEvent = event.transcript;
      if (transcriptEvent.kind === "partial") {
        if (
          ttsPlaybackStateRef.current === "playing" &&
          shouldTriggerVoiceBargeIn(transcriptEvent.text)
        ) {
          ttsPlaybackManagerRef.current?.stop();
          voiceSessionManager.cancelSpeech("VOICE_BARGE_IN");
          orchestratorRef.current?.cancelActiveTurn("barge_in");
          moveToListeningOrIdleRef.current();
        }
        if (!sessionMutedRef.current) {
          setTranscriptPreview(transcriptEvent.text);
        }
        if (VOICE_V2_FLAGS.clientVadFallbackEnabled && !sessionMutedRef.current) {
          scheduleClientVadFallbackCommit({
            timerRef: partialFallbackTimerRef,
            sessionMutedRef,
            voiceUiStateRef,
            commitInputAudio: () => voiceSessionManager.commitInputAudio(),
            emitDebug: emitDebugRef.current,
            getCurrentTurnId: () => currentVoiceTurnIdRef.current,
          });
        }
        return;
      }

      clearClientVadFallbackTimer(partialFallbackTimerRef);

      setFinalTranscript(transcriptEvent.text);
      setTranscriptPreview(transcriptEvent.text);
      if (!sessionMutedRef.current && voiceUiStateRef.current === "retry_ready") {
        transitionVoiceStateRef.current("sheet_listening", "speech_captured_after_retry");
        setProcessingStageText(null);
        setVoiceErrorMessage(null);
      }
      if (VOICE_V2_FLAGS.autoturnEnabled && !sessionMutedRef.current) {
        runAutoTurnDispatchSafely({
          dispatch: () => processTranscriptTurnRef.current(transcriptEvent.text, "microphone"),
          onError: (error) => {
            emitDebugRef.current(
              "turn",
              "autoturn_dispatch_failed",
              {
                error: error.message,
              },
              currentVoiceTurnIdRef.current
            );
            setRetryReadyError(error.message, "Voice command failed.");
          },
        });
      }
    });

    return () => {
      unsubscribe();
      clearClientVadFallbackTimer(partialFallbackTimerRef);
    };
  }, [sessionScopeId, setRetryReadyError]);

  useEffect(() => {
    if (VOICE_V2_FLAGS.enabled && voiceAvailable && userId && vaultOwnerToken) {
      return;
    }
    clearClientVadFallbackTimer(partialFallbackTimerRef);
    void voiceSessionManager.release(sessionScopeId);
    setRealtimeSessionReady(false);
    setSessionMuted(true);
    setSessionStateText("idle");
    if (voiceUiStateRef.current !== "idle") {
      transitionVoiceState("idle", "voice_unavailable");
    }
  }, [sessionScopeId, transitionVoiceState, userId, vaultOwnerToken, voiceAvailable]);

  useEffect(() => {
    return () => {
      stop();
      ttsPlaybackManagerRef.current?.stop();
      orchestratorRef.current?.cancelActiveTurn("component_unmount");
      void voiceSessionManager.release(sessionScopeId);
    };
  }, [sessionScopeId, stop]);

  useEffect(() => {
    if (voiceUiState !== "error_terminal") return;
    const timer = window.setTimeout(() => {
      setVoiceErrorMessage(null);
      transitionVoiceState("idle", "error_recovered");
    }, 1600);
    return () => window.clearTimeout(timer);
  }, [transitionVoiceState, voiceUiState]);

  useEffect(() => {
    if (voiceUiState !== "sheet_listening") return;
    if (!realtimeSessionReady) return;
    const timer = window.setInterval(() => {
      if (!shouldShowAmbientListeningStatus(transcriptPreviewRef.current)) {
        return;
      }
      const activity = smoothedLevel > 0.06 ? "Audio detected..." : "Listening...";
      setTranscriptPreview(activity);
    }, 280);
    return () => {
      window.clearInterval(timer);
    };
  }, [realtimeSessionReady, smoothedLevel, voiceUiState]);

  const showVoiceSheet =
    voiceUiState === "sheet_listening" || voiceUiState === "sheet_muted";
  const showProcessingCompact = voiceUiState === "processing_compact";
  const showSpeakingCompact = voiceUiState === "speaking_compact";
  const showRetryCompact = voiceUiState === "retry_ready";
  const showBaseCommandSurface =
    !showVoiceSheet && !showProcessingCompact && !showSpeakingCompact && !showRetryCompact;
  const isElevatedVoiceSurface =
    showVoiceSheet || showProcessingCompact || showSpeakingCompact || showRetryCompact;

  const compactLabel = useMemo(() => {
    if (showProcessingCompact) return "Processing your voice command...";
    if (showSpeakingCompact) return "Kai is responding...";
    if (pendingConfirmation) return "Confirm this voice action";
    if (showRetryCompact) return "I couldn't understand that. Please try again.";
    return "";
  }, [pendingConfirmation, showProcessingCompact, showRetryCompact, showSpeakingCompact]);

  const commandBarBottomOffset = isElevatedVoiceSurface
    ? "calc(var(--app-bottom-inset) + 58px)"
    : "calc(var(--app-bottom-inset) + var(--kai-command-bottom-gap, 18px))";
  const realtimeConnecting = sessionStateText === "connecting" && !realtimeSessionReady;

      return (
    <>
      <div
        className={cn(
          "fixed inset-x-0 z-[136] flex justify-center px-4",
          hideBottomChrome ? "pointer-events-none opacity-0" : "pointer-events-none opacity-100"
        )}
        style={{
          bottom: commandBarBottomOffset,
          transform: `translate3d(0, calc(${100 * hideBottomChromeProgress}% + ${12 * hideBottomChromeProgress}px), 0)`,
          opacity: Math.max(0, 1 - hideBottomChromeProgress),
        }}
      >
        <div ref={barRef} className="pointer-events-auto w-full max-w-[460px]">
          {showVoiceSheet ? (
            <VoiceConsoleSheet
              open={showVoiceSheet}
              muted={sessionMuted && realtimeSessionReady}
              submitting={false}
              submitEnabled={VOICE_V2_FLAGS.submitDebugVisible && realtimeSessionReady}
              showSubmit={VOICE_V2_FLAGS.submitDebugVisible}
              transcriptPreview={transcriptPreview}
              smoothedLevel={smoothedLevel}
              onMuteToggle={toggleMuteListening}
              onSubmit={submitDebugTurn}
              onCancel={cancelListening}
              onExamplePrompt={handleExamplePrompt}
            />
          ) : showProcessingCompact || showSpeakingCompact || showRetryCompact ? (
            <VoiceCompactStatus
              mode={showProcessingCompact ? "processing" : showSpeakingCompact ? "speaking" : "retry_ready"}
              label={compactLabel}
              stageText={processingStageText}
              replyText={showSpeakingCompact || showRetryCompact ? lastReplyText || finalTranscript : finalTranscript}
              smoothedLevel={smoothedLevel}
              onStopSpeaking={
                showSpeakingCompact && ttsPlaybackState === "playing"
                  ? () => handleStopSpeaking()
                  : undefined
              }
              onReplay={
                showSpeakingCompact || showRetryCompact
                  ? handleReplay
                  : undefined
              }
              onRetry={showRetryCompact && !pendingConfirmation ? handleRetry : undefined}
              onConfirm={showRetryCompact && pendingConfirmation ? handleConfirmPending : undefined}
              onCancel={showRetryCompact && pendingConfirmation ? handleCancelPending : undefined}
              confirmLabel="Confirm"
              cancelLabel="Not now"
            />
          ) : showBaseCommandSurface ? (
            <div className="relative h-12">
              <Button
                variant="none"
                effect="fade"
                fullWidth
                size="default"
                data-tour-id="kai-command-bar"
                className={cn(
                  "h-12 justify-start rounded-full px-4 pr-12 text-sm text-muted-foreground",
                  disabled && "pointer-events-none opacity-50"
                )}
                onClick={() => setOpen(true)}
              >
                <Icon icon={Search} size="sm" className="mr-2 text-muted-foreground" />
                Analyze, dashboard, consent with Kai
              </Button>
              {!micHidden ? (
                <button
                  type="button"
                  aria-label="Toggle voice microphone"
                  data-no-route-swipe
                  disabled={micDisabled}
                  title={
                    micDisabled
                      ? stableMicDisabledReason || undefined
                      : sessionMuted
                        ? "Unmute microphone"
                        : "Mute microphone"
                  }
                  className={cn(
                    "absolute right-2 top-1/2 z-10 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground",
                    micDisabled && "cursor-not-allowed opacity-60"
                  )}
                  onClick={handleMicTap}
                >
                  {realtimeConnecting ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Icon icon={Mic} size="sm" />
                  )}
                </button>
              ) : null}
            </div>
          ) : null}

          {showBaseCommandSurface && stableMicDisabledReason ? (
            <p className="mt-1 text-center text-[10px] text-muted-foreground">{stableMicDisabledReason}</p>
          ) : null}
          {voiceErrorMessage ? (
            <p className="mt-1 text-center text-[10px] text-destructive">{voiceErrorMessage}</p>
          ) : null}
        </div>
      </div>

      <KaiCommandPalette
        open={open}
        onOpenChange={setOpen}
        onCommand={onCommand}
        hasPortfolioData={hasPortfolioData}
        portfolioTickers={portfolioTickers}
      />

      <VoiceDebugDrawer
        enabled={DEV_VOICE_DEBUG_ENABLED}
        currentState={voiceUiState}
        sessionId={voiceSessionId}
        route={appRuntimeState?.route.pathname || ""}
        screen={appRuntimeState?.route.screen || ""}
        authStatus={appRuntimeState?.auth.signed_in ? "signed_in" : "signed_out"}
        vaultStatus={
          appRuntimeState?.vault.unlocked && appRuntimeState?.vault.token_valid
            ? "unlocked_valid"
            : "locked_or_invalid"
        }
        voiceAvailabilityReason={voiceAvailable ? "available" : voiceUnavailableReason || "unavailable"}
      />

      {DEV_VOICE_DEBUG_ENABLED ? (
        <div className="pointer-events-none fixed bottom-[108px] right-4 z-[150] rounded-full border border-border/60 bg-background/90 px-2 py-1 text-[10px] text-muted-foreground shadow">
          <span className="pointer-events-none inline-flex items-center gap-1">
            <Bug className="h-3 w-3" />
            {voiceUiState} | {ttsPlaybackState} | mic:{micPermissionStatus} | session:{sessionStateText}
          </span>
        </div>
      ) : null}

      {DEV_VOICE_DEBUG_ENABLED && (rawRms > 0 || normalizedLevel > 0) ? (
        <div className="pointer-events-none fixed bottom-[90px] left-1/2 z-[150] -translate-x-1/2 rounded-full bg-background/85 px-3 py-1 text-[10px] text-muted-foreground shadow">
          raw={rawRms.toFixed(4)} level={normalizedLevel.toFixed(3)} smoothed={smoothedLevel.toFixed(3)}
        </div>
      ) : null}
    </>
  );
}
