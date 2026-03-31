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
  voice?: string;
};

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

  private realtimeClient: VoiceRealtimeClient | null = null;
  private localStream: MediaStream | null = null;

  private userId: string | null = null;
  private vaultOwnerToken: string | null = null;
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

  async acquire(input: VoiceSessionAcquireInput): Promise<void> {
    this.scopeIds.add(input.scopeId);
    const credentialsChanged =
      this.userId !== input.userId || this.vaultOwnerToken !== input.vaultOwnerToken;

    this.userId = input.userId;
    this.vaultOwnerToken = input.vaultOwnerToken;
    this.configuredVoice = String(input.voice || this.configuredVoice || "alloy").trim() || "alloy";

    if (!this.visibilityHandlerRegistered) {
      this.registerVisibilityHandlers();
    }

    if (credentialsChanged && this.connected()) {
      await this.disconnect("credentials_changed", { stopLocalStream: true });
    }

    await this.ensureConnected("acquire");
  }

  async release(scopeId: string): Promise<void> {
    this.scopeIds.delete(scopeId);
    if (this.scopeIds.size > 0) return;
    await this.disconnect("all_scopes_released", { stopLocalStream: true });
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
      if (this.scopeIds.size === 0 || !this.userId || !this.vaultOwnerToken) {
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
    if (!this.userId || !this.vaultOwnerToken) {
      throw new Error("VOICE_SESSION_AUTH_REQUIRED");
    }
    if (this.connected()) {
      this.applyMuteToLocalStream();
      return;
    }
    if (this.connectPromise) {
      await this.connectPromise;
      this.applyMuteToLocalStream();
      return;
    }

    const generation = ++this.connectGeneration;
    const connectStartedAt = performance.now();
    this.connectAbortController = new AbortController();
    this.setState("connecting", reason);

    this.connectPromise = (async () => {
      try {
        const localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (generation !== this.connectGeneration) {
          stopMediaStream(localStream);
          throw new Error("VOICE_SESSION_CONNECT_STALE");
        }
        this.localStream = localStream;

        const sessionTurnId = createVoiceTurnId();
        const sessionResponse = await ApiService.createKaiRealtimeSession({
          userId: this.userId!,
          vaultOwnerToken: this.vaultOwnerToken!,
          voice: this.configuredVoice,
          voiceTurnId: sessionTurnId,
          signal: this.connectAbortController?.signal,
        });
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

        const sessionPayload = parseRealtimeSessionPayload(sessionPayloadRaw);
        if (!sessionPayload) {
          throw new Error("VOICE_SESSION_INVALID_PAYLOAD");
        }

        if (generation !== this.connectGeneration) {
          throw new Error("VOICE_SESSION_CONNECT_STALE");
        }

        const realtimeClient = new VoiceRealtimeClient();
        await realtimeClient.connect({
          session: sessionPayload as VoiceRealtimeSessionInfo,
          localStream,
          turnId: sessionTurnId,
          onTranscript: (transcriptEvent) => {
            this.emit({
              type: "transcript",
              transcript: transcriptEvent,
            });
          },
          onDebug: (event, payload) => {
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
              ["closed", "failed"].includes(payload.connection_state);
            const transportFailed =
              event === "data_channel_closed" ||
              event === "data_channel_error" ||
              (event === "stream_error" && isHardFatalRealtimeStreamError(payload || {})) ||
              peerConnectionFailed;

            if (!transportFailed) return;

            const message =
              (typeof payload?.message === "string" && payload.message.trim()) ||
              (typeof payload?.connection_state === "string" &&
              ["closed", "failed"].includes(payload.connection_state)
                ? `VOICE_REALTIME_CONNECTION_${payload.connection_state.toUpperCase()}`
                : "VOICE_REALTIME_TRANSPORT_ERROR");
            void this.recoverFromTransportFailure("realtime_transport_error", message, payload || {});
          },
        });

        if (generation !== this.connectGeneration) {
          await realtimeClient.close();
          throw new Error("VOICE_SESSION_CONNECT_STALE");
        }

        this.realtimeClient = realtimeClient;
        this.sessionId = sessionPayload.sessionId || null;
        this.model = sessionPayload.model;
        this.voice = sessionPayload.voice;
        this.reconnectLatencyMs = Math.max(0, Math.round(performance.now() - connectStartedAt));
        this.applyMuteToLocalStream();
        this.setState("connected", reason);
      } catch (error) {
        const message = error instanceof Error ? error.message : "VOICE_SESSION_CONNECT_FAILED";
        this.setState("error", "connect_failed", message);
        await this.disconnect("connect_failed_cleanup", { stopLocalStream: true });
        throw error;
      } finally {
        if (this.connectPromise) {
          this.connectPromise = null;
        }
        this.connectAbortController = null;
      }
    })();

    await this.connectPromise;
  }

  async disconnect(
    reason: string,
    options: {
      stopLocalStream?: boolean;
    } = {}
  ): Promise<void> {
    this.connectGeneration += 1;

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
        void this.disconnect("app_background", { stopLocalStream: true });
        return;
      }
      if (this.scopeIds.size > 0) {
        void this.ensureConnected("foreground_resume").catch((error) => {
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
