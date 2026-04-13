"use client";

import { ApiService } from "@/lib/services/api-service";
import { createVoiceTurnId } from "@/lib/voice/voice-telemetry";
import {
  VoiceRealtimeClient,
  type VoiceRealtimeSessionInfo,
  type VoiceRealtimeTranscriptEvent,
} from "@/lib/voice/voice-realtime-client";

export type VoiceSessionConnectionState = "idle" | "connecting" | "connected" | "error";

export type VoiceSessionSnapshot = {
  state: VoiceSessionConnectionState;
  muted: boolean;
  sessionId: string | null;
  model: string | null;
  voice: string | null;
  reconnectLatencyMs: number | null;
  lastError: string | null;
};

export type VoiceSessionEvent =
  | {
      type: "connection";
      snapshot: VoiceSessionSnapshot;
      reason: string;
    }
  | {
      type: "transcript";
      transcript: VoiceRealtimeTranscriptEvent;
    }
  | {
      type: "debug";
      event: string;
      payload?: Record<string, unknown>;
    };

export type VoiceSessionListener = (event: VoiceSessionEvent) => void;

export type VoiceSessionAcquireInput = {
  scopeId: string;
  userId: string;
  vaultOwnerToken: string;
  getVaultOwnerToken?: () => string | null;
  voice?: string;
  activate?: boolean;
};

// Keep the live session around across brief tab switches so voice does not
// repeatedly pay the full realtime handshake cost.
const BACKGROUND_DISCONNECT_DELAY_MS = 5000;
const REALTIME_SERVER_VAD_SILENCE_MS = 1000;
const REALTIME_SERVER_BARGE_IN_ENABLED = false;

function isVoiceSessionConnectCancellationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || "");
  return (
    message === "VOICE_SESSION_CONNECT_ABORTED" ||
    message === "VOICE_SESSION_CONNECT_STALE"
  );
}

function parseRealtimeSessionPayload(raw: unknown): {
  clientSecret: string;
  model: string;
  voice: string;
  sessionId?: string | null;
} | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const clientSecret = typeof value.client_secret === "string" ? value.client_secret.trim() : "";
  const model = typeof value.model === "string" ? value.model.trim() : "";
  const voice = typeof value.voice === "string" ? value.voice.trim() : "";
  const sessionId = typeof value.session_id === "string" ? value.session_id.trim() : null;
  if (!clientSecret || !model || !voice) return null;
  return { clientSecret, model, voice, sessionId: sessionId || null };
}

function stopMediaStream(stream: MediaStream | null | undefined): void {
  if (!stream) return;
  stream.getTracks().forEach((track) => {
    try {
      track.stop();
    } catch {
      // ignore
    }
  });
}

function asLowerTrimmed(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isNonFatalRealtimeStreamError(payload?: Record<string, unknown>): boolean {
  const message = asLowerTrimmed(payload?.message);
  const code = asLowerTrimmed(payload?.code);
  const errorType = asLowerTrimmed(payload?.error_type);
  const haystack = `${message} ${code} ${errorType}`.trim();
  if (!haystack) return false;
  return (
    haystack.includes("response is not in progress") ||
    haystack.includes("response not in progress") ||
    haystack.includes("no active response") ||
    haystack.includes("already cancelled") ||
    haystack.includes("already canceled") ||
    haystack.includes("nothing to cancel") ||
    haystack.includes("unknown parameter") ||
    haystack.includes("invalid parameter") ||
    haystack.includes("unrecognized parameter") ||
    haystack.includes("invalid event")
  );
}

function isHardFatalRealtimeStreamError(payload?: Record<string, unknown>): boolean {
  const message = asLowerTrimmed(payload?.message);
  const code = asLowerTrimmed(payload?.code);
  const errorType = asLowerTrimmed(payload?.error_type);
  const haystack = `${message} ${code} ${errorType}`.trim();
  if (!haystack) return false;
  return (
    haystack.includes("authentication") ||
    haystack.includes("not authorized") ||
    haystack.includes("invalid api key") ||
    haystack.includes("session expired") ||
    haystack.includes("token expired")
  );
}

class VoiceSessionManager {
  private static singleton: VoiceSessionManager | null = null;

  static getInstance(): VoiceSessionManager {
    if (!VoiceSessionManager.singleton) {
      VoiceSessionManager.singleton = new VoiceSessionManager();
    }
    return VoiceSessionManager.singleton;
  }

  private listeners = new Set<VoiceSessionListener>();
  private scopeIds = new Set<string>();
  private activeScopeIds = new Set<string>();

  private realtimeClient: VoiceRealtimeClient | null = null;
  private localStream: MediaStream | null = null;

  private userId: string | null = null;
  private vaultOwnerToken: string | null = null;
  private vaultOwnerTokenProvider: (() => string | null) | null = null;
  private configuredVoice: string = "alloy";

  private muted = true;
  private state: VoiceSessionConnectionState = "idle";
  private lastError: string | null = null;
  private sessionId: string | null = null;
  private model: string | null = null;
  private voice: string | null = null;
  private reconnectLatencyMs: number | null = null;

  private connectPromise: Promise<void> | null = null;
  private connectGeneration = 0;
  private connectAbortController: AbortController | null = null;
  private transportRecoveryInFlight = false;
  private foregroundResumeEligible = false;
  private hiddenDisconnectTimer: number | null = null;

  private visibilityHandlerRegistered = false;

  private emit(event: VoiceSessionEvent): void {
    this.listeners.forEach((listener) => {
      try {
        listener(event);
      } catch {
        // ignore listener exceptions
      }
    });
  }

  private emitDebug(event: string, payload?: Record<string, unknown>): void {
    this.emit({
      type: "debug",
      event,
      payload,
    });
  }

  private snapshot(): VoiceSessionSnapshot {
    return {
      state: this.state,
      muted: this.muted,
      sessionId: this.sessionId,
      model: this.model,
      voice: this.voice,
      reconnectLatencyMs: this.reconnectLatencyMs,
      lastError: this.lastError,
    };
  }

  private setState(state: VoiceSessionConnectionState, reason: string, errorMessage?: string): void {
    this.state = state;
    this.lastError = errorMessage || null;
    this.emit({
      type: "connection",
      snapshot: this.snapshot(),
      reason,
    });
  }

  subscribe(listener: VoiceSessionListener): () => void {
    this.listeners.add(listener);
    listener({
      type: "connection",
      snapshot: this.snapshot(),
      reason: "subscribe",
    });
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot(): VoiceSessionSnapshot {
    return this.snapshot();
  }

  getStream(): MediaStream | null {
    return this.localStream;
  }

  connected(): boolean {
    return Boolean(this.realtimeClient?.connected());
  }

  isMuted(): boolean {
    return this.muted;
  }

  private clearHiddenDisconnectTimer(reason?: string): void {
    if (this.hiddenDisconnectTimer === null) return;
    window.clearTimeout(this.hiddenDisconnectTimer);
    this.hiddenDisconnectTimer = null;
    if (reason) {
      this.emitDebug("background_disconnect_cancelled", {
        reason,
      });
    }
  }

  private resolveVaultOwnerToken(): string | null {
    if (!this.vaultOwnerTokenProvider) {
      return this.vaultOwnerToken;
    }
    const nextToken = this.vaultOwnerTokenProvider();
    this.vaultOwnerToken = typeof nextToken === "string" && nextToken.trim() ? nextToken.trim() : null;
    return this.vaultOwnerToken;
  }

  async acquire(input: VoiceSessionAcquireInput): Promise<void> {
    this.scopeIds.add(input.scopeId);
    if (input.activate) {
      this.activeScopeIds.add(input.scopeId);
    }
    const nextVaultOwnerToken = input.getVaultOwnerToken
      ? input.getVaultOwnerToken()
      : input.vaultOwnerToken;
    const credentialsChanged =
      this.userId !== input.userId || this.vaultOwnerToken !== nextVaultOwnerToken;

    this.userId = input.userId;
    this.vaultOwnerTokenProvider = input.getVaultOwnerToken || null;
    this.vaultOwnerToken =
      typeof nextVaultOwnerToken === "string" && nextVaultOwnerToken.trim()
        ? nextVaultOwnerToken.trim()
        : null;
    this.configuredVoice = String(input.voice || this.configuredVoice || "alloy").trim() || "alloy";

    if (!this.visibilityHandlerRegistered) {
      this.registerVisibilityHandlers();
    }

    if (
      credentialsChanged &&
      (this.connected() || this.connectPromise !== null || this.state === "connecting")
    ) {
      await this.disconnect("credentials_changed", { stopLocalStream: true });
    }

    await this.ensureConnected("acquire");
  }

  async release(scopeId: string): Promise<void> {
    this.scopeIds.delete(scopeId);
    this.activeScopeIds.delete(scopeId);
    if (this.scopeIds.size > 0) return;
    await this.disconnect("all_scopes_released", { stopLocalStream: true });
  }

  hasActiveScope(scopeId: string): boolean {
    return this.activeScopeIds.has(scopeId);
  }

  setMuted(nextMuted: boolean): void {
    const normalized = Boolean(nextMuted);
    if (this.muted === normalized) return;
    this.muted = normalized;
    this.applyMuteToLocalStream();
    this.emit({
      type: "connection",
      snapshot: this.snapshot(),
      reason: "mute_state_changed",
    });
  }

  toggleMuted(): boolean {
    this.setMuted(!this.muted);
    return this.muted;
  }

  private applyMuteToLocalStream(): void {
    if (!this.localStream) return;
    this.localStream.getAudioTracks().forEach((track) => {
      track.enabled = !this.muted;
    });
  }

  private async recoverFromTransportFailure(
    reason: string,
    errorMessage: string,
    payload: Record<string, unknown> = {}
  ): Promise<void> {
    if (this.transportRecoveryInFlight) {
      this.emitDebug("transport_recovery_skipped_in_flight", {
        reason,
        error_message: errorMessage,
      });
      return;
    }

    this.transportRecoveryInFlight = true;
    this.setState("error", reason, errorMessage);
    this.emitDebug("transport_recovery_started", {
      reason,
      error_message: errorMessage,
      ...payload,
    });

    try {
      await this.disconnect("transport_error_cleanup", { stopLocalStream: true });
      if (this.activeScopeIds.size === 0 || !this.userId || !this.resolveVaultOwnerToken()) {
        this.emitDebug("transport_recovery_skipped_no_scope", { reason });
        return;
      }
      await this.ensureConnected("transport_recovery");
      this.emitDebug("transport_recovery_succeeded", { reason });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "VOICE_REALTIME_TRANSPORT_RECOVERY_FAILED";
      this.setState("error", "transport_recovery_failed", message);
      this.emitDebug("transport_recovery_failed", {
        reason,
        error_message: message,
      });
    } finally {
      this.transportRecoveryInFlight = false;
    }
  }

  async ensureConnected(reason: string = "manual"): Promise<void> {
    const vaultOwnerToken = this.resolveVaultOwnerToken();
    if (!this.userId || !vaultOwnerToken) {
      throw new Error("VOICE_SESSION_AUTH_REQUIRED");
    }
    if (this.connected()) {
      this.applyMuteToLocalStream();
      return;
    }
    const inFlightConnect = this.connectPromise;
    if (inFlightConnect && this.state === "connecting") {
      await inFlightConnect;
      this.applyMuteToLocalStream();
      return;
    }

    const generation = ++this.connectGeneration;
    const connectStartedAt = performance.now();
    const connectAbortController = new AbortController();
    this.connectAbortController = connectAbortController;
    this.clearHiddenDisconnectTimer("ensure_connected");
    this.setState("connecting", reason);

    let connectOperation: Promise<void> | null = null;
    connectOperation = (async () => {
      try {
        const sessionTurnId = createVoiceTurnId();
        const sessionRequestStartedAt = performance.now();

        this.emitDebug("permission_request_started", {});
        const localStreamPromise = navigator.mediaDevices
          .getUserMedia({ audio: true })
          .then((stream) => {
            this.emitDebug("permission_request_succeeded", {});
            return stream;
          })
          .catch((error) => {
            this.emitDebug("permission_request_failed", {
              message: error instanceof Error ? error.message : String(error || "unknown"),
            });
            throw error;
          });

        this.emitDebug("realtime_session_request_started", {
          turn_id: sessionTurnId,
        });
        const sessionResponsePromise = ApiService.createKaiRealtimeSession({
          userId: this.userId!,
          vaultOwnerToken,
          voice: this.configuredVoice,
          voiceTurnId: sessionTurnId,
          signal: connectAbortController.signal,
        });

        const [localStream, sessionResponse] = await Promise.all([
          localStreamPromise,
          sessionResponsePromise,
        ]);
        if (generation !== this.connectGeneration) {
          stopMediaStream(localStream);
          throw new Error("VOICE_SESSION_CONNECT_STALE");
        }
        this.localStream = localStream;
        const sessionPayloadRaw = (await sessionResponse.json().catch(() => ({}))) as unknown;
        if (!sessionResponse.ok) {
          const detail =
            sessionPayloadRaw &&
            typeof sessionPayloadRaw === "object" &&
            typeof (sessionPayloadRaw as Record<string, unknown>).detail === "string"
              ? String((sessionPayloadRaw as Record<string, unknown>).detail)
              : `VOICE_SESSION_HTTP_${sessionResponse.status}`;
          throw new Error(detail);
        }
        this.emitDebug("realtime_session_request_succeeded", {
          turn_id: sessionTurnId,
          latency_ms: Math.max(0, Math.round(performance.now() - sessionRequestStartedAt)),
        });

        const sessionPayload = parseRealtimeSessionPayload(sessionPayloadRaw);
        if (!sessionPayload) {
          throw new Error("VOICE_SESSION_INVALID_PAYLOAD");
        }

        if (generation !== this.connectGeneration) {
          throw new Error("VOICE_SESSION_CONNECT_STALE");
        }

        const realtimeClient = new VoiceRealtimeClient();
        this.realtimeClient = realtimeClient;
        this.emitDebug("realtime_handshake_started", {
          turn_id: sessionTurnId,
          model: sessionPayload.model,
          voice: sessionPayload.voice,
        });
        await realtimeClient.connect({
          session: sessionPayload as VoiceRealtimeSessionInfo,
          localStream,
          turnId: sessionTurnId,
          signal: connectAbortController.signal,
          serverVadSilenceMs: REALTIME_SERVER_VAD_SILENCE_MS,
          enableBargeIn: REALTIME_SERVER_BARGE_IN_ENABLED,
          onTranscript: (transcriptEvent) => {
            this.emit({
              type: "transcript",
              transcript: transcriptEvent,
            });
          },
          onDebug: (event, payload) => {
            if (this.realtimeClient !== realtimeClient) {
              return;
            }
            this.emitDebug(event, payload || {});
            if (event === "stream_error" && isNonFatalRealtimeStreamError(payload || {})) {
              this.emitDebug("stream_error_ignored_non_fatal", payload || {});
              return;
            }
            if (event === "stream_error" && !isHardFatalRealtimeStreamError(payload || {})) {
              this.emitDebug("stream_error_ignored_soft", payload || {});
              return;
            }

            const peerConnectionFailed =
              event === "peer_connection_state_changed" &&
              typeof payload?.connection_state === "string" &&
              ["closed", "disconnected", "failed"].includes(payload.connection_state);
            const transportFailed =
              event === "data_channel_closed" ||
              event === "data_channel_error" ||
              (event === "stream_error" && isHardFatalRealtimeStreamError(payload || {})) ||
              peerConnectionFailed;

            if (!transportFailed) return;

            const message =
              (typeof payload?.message === "string" && payload.message.trim()) ||
              (typeof payload?.connection_state === "string" &&
              ["closed", "disconnected", "failed"].includes(payload.connection_state)
                ? `VOICE_REALTIME_CONNECTION_${payload.connection_state.toUpperCase()}`
                : "VOICE_REALTIME_TRANSPORT_ERROR");
            void this.recoverFromTransportFailure("realtime_transport_error", message, payload || {});
          },
        });
        this.emitDebug("realtime_handshake_succeeded", {
          turn_id: sessionTurnId,
          session_id: sessionPayload.sessionId || null,
        });

        if (generation !== this.connectGeneration) {
          await realtimeClient.close();
          throw new Error("VOICE_SESSION_CONNECT_STALE");
        }

        this.sessionId = sessionPayload.sessionId || null;
        this.model = sessionPayload.model;
        this.voice = sessionPayload.voice;
        this.reconnectLatencyMs = Math.max(0, Math.round(performance.now() - connectStartedAt));
        this.foregroundResumeEligible = this.activeScopeIds.size > 0;
        this.applyMuteToLocalStream();
        this.setState("connected", reason);
      } catch (error) {
        if (
          generation !== this.connectGeneration ||
          connectAbortController.signal.aborted ||
          isVoiceSessionConnectCancellationError(error)
        ) {
          const preserveForegroundResume = this.foregroundResumeEligible && this.activeScopeIds.size > 0;
          this.foregroundResumeEligible = preserveForegroundResume;
          await this.disconnect("connect_cancelled_cleanup", {
            stopLocalStream: true,
            preserveForegroundResume,
          });
          throw new Error("VOICE_SESSION_CONNECT_ABORTED");
        }
        const message = error instanceof Error ? error.message : "VOICE_SESSION_CONNECT_FAILED";
        this.foregroundResumeEligible = false;
        this.setState("error", "connect_failed", message);
        await this.disconnect("connect_failed_cleanup", { stopLocalStream: true });
        throw error;
      } finally {
        if (this.connectPromise === connectOperation) {
          this.connectPromise = null;
        }
        if (this.connectAbortController === connectAbortController) {
          this.connectAbortController = null;
        }
      }
    })();

    this.connectPromise = connectOperation;

    await this.connectPromise;
  }

  async disconnect(
    reason: string,
    options: {
      stopLocalStream?: boolean;
      preserveForegroundResume?: boolean;
    } = {}
  ): Promise<void> {
    this.clearHiddenDisconnectTimer();
    this.connectGeneration += 1;
    this.foregroundResumeEligible = Boolean(
      options.preserveForegroundResume && this.activeScopeIds.size > 0
    );

    if (this.connectAbortController) {
      this.connectAbortController.abort(reason);
      this.connectAbortController = null;
    }

    const client = this.realtimeClient;
    this.realtimeClient = null;
    if (client) {
      try {
        await client.close({ stopLocalStream: false });
      } catch {
        // ignore close errors
      }
    }

    if (this.localStream && options.stopLocalStream !== false) {
      stopMediaStream(this.localStream);
      this.localStream = null;
    }

    this.sessionId = null;
    this.model = null;
    this.voice = null;
    this.reconnectLatencyMs = null;

    this.setState("idle", reason);
  }

  commitInputAudio(): void {
    this.realtimeClient?.commitInputAudio();
  }

  async requestSpeech(input: {
    text: string;
    voice?: string;
    turnId: string;
    responseId: string;
    segmentType: "ack" | "final";
    timeoutMs?: number;
    onFirstAudio?: () => void;
    onPlaybackStarted?: () => void;
    onPlaybackEnded?: () => void;
  }): Promise<void> {
    if (!this.realtimeClient || !this.realtimeClient.connected()) {
      throw new Error("VOICE_SESSION_NOT_CONNECTED");
    }
    await this.realtimeClient.requestSpeech({
      text: input.text,
      voice: input.voice,
      turnId: input.turnId,
      responseId: input.responseId,
      segmentType: input.segmentType,
      timeoutMs: input.timeoutMs,
      onFirstAudio: input.onFirstAudio,
      onPlaybackStarted: input.onPlaybackStarted,
      onPlaybackEnded: input.onPlaybackEnded,
    });
  }

  cancelSpeech(reason: string): void {
    this.realtimeClient?.cancelSpeech(reason);
  }

  private registerVisibilityHandlers(): void {
    if (this.visibilityHandlerRegistered || typeof document === "undefined") return;

    const onVisibility = () => {
      if (document.hidden) {
        if (this.hiddenDisconnectTimer !== null) {
          return;
        }
        const preserveForegroundResume =
          this.activeScopeIds.size > 0 &&
          (this.foregroundResumeEligible || this.state === "connecting" || this.connectPromise !== null);
        this.emitDebug("background_disconnect_scheduled", {
          delay_ms: BACKGROUND_DISCONNECT_DELAY_MS,
          preserve_foreground_resume: preserveForegroundResume,
          state: this.state,
        });
        this.hiddenDisconnectTimer = window.setTimeout(() => {
          this.hiddenDisconnectTimer = null;
          this.emitDebug("background_disconnect_fired", {
            preserve_foreground_resume: preserveForegroundResume,
            state: this.state,
          });
          void this.disconnect("app_background", {
            stopLocalStream: true,
            preserveForegroundResume,
          });
        }, BACKGROUND_DISCONNECT_DELAY_MS);
        return;
      }
      this.clearHiddenDisconnectTimer("visibility_restored");
      if (this.activeScopeIds.size > 0 && this.foregroundResumeEligible) {
        void this.ensureConnected("foreground_resume").catch((error) => {
          if (isVoiceSessionConnectCancellationError(error)) {
            return;
          }
          const message = error instanceof Error ? error.message : "VOICE_SESSION_RESUME_FAILED";
          this.setState("error", "foreground_resume_failed", message);
        });
      }
    };

    document.addEventListener("visibilitychange", onVisibility);
    this.visibilityHandlerRegistered = true;
    this.emitDebug("visibility_handler_registered", {});
  }
}

export const voiceSessionManager = VoiceSessionManager.getInstance();
