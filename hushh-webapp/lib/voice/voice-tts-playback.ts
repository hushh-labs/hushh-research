"use client";

import { ApiService } from "@/lib/services/api-service";

export type VoiceTtsPlaybackState = "idle" | "loading" | "playing";

export type VoiceSpeakInput = {
  userId: string;
  vaultOwnerToken: string;
  text: string;
  voice?: string;
  voiceTurnId?: string;
  responseId?: string;
  segmentType?: "ack" | "final";
  timeoutMs?: number;
  adapter?: "backend_batch_tts" | "realtime_stream_tts";
  realtimeAdapter?: {
    speak: (input: {
      text: string;
      voice?: string;
      voiceTurnId?: string;
      responseId?: string;
      segmentType?: "ack" | "final";
      timeoutMs?: number;
      onFirstAudio?: () => void;
      onPlaybackStarted?: () => void;
      onPlaybackEnded?: () => void;
    }) => Promise<void>;
    cancel?: () => void;
  };
};

export type VoicePlaybackSource =
  | "backend_openai_audio"
  | "browser_speech_synthesis"
  | "realtime_stream_tts";

function isTruthyEnvFlag(raw: string | undefined): boolean {
  return ["1", "true", "yes", "on", "enabled"].includes(String(raw || "").trim().toLowerCase());
}

function isVoiceFailFastEnabled(): boolean {
  const disableFallbacks =
    isTruthyEnvFlag(process.env.NEXT_PUBLIC_DISABLE_VOICE_FALLBACKS) ||
    isTruthyEnvFlag(process.env.DISABLE_VOICE_FALLBACKS);
  const failFast =
    isTruthyEnvFlag(process.env.NEXT_PUBLIC_FAIL_FAST_VOICE) ||
    isTruthyEnvFlag(process.env.FAIL_FAST_VOICE);
  const forceRealtime =
    isTruthyEnvFlag(process.env.NEXT_PUBLIC_FORCE_REALTIME_VOICE) ||
    isTruthyEnvFlag(process.env.FORCE_REALTIME_VOICE);
  return disableFallbacks || failFast || forceRealtime;
}

function isLegacyLocalSpeechCompatEnabled(): boolean {
  return (
    isTruthyEnvFlag(process.env.NEXT_PUBLIC_ENABLE_LEGACY_LOCAL_TTS_COMPAT) ||
    isTruthyEnvFlag(process.env.ENABLE_LEGACY_LOCAL_TTS_COMPAT)
  );
}

type VoiceTtsLifecycleHandlers = {
  onRequested?: (payload: { voiceTurnId?: string; text: string; voice?: string }) => void;
  onAudioReceived?: (payload: {
    voiceTurnId?: string;
    mimeType: string;
    audioBytesEstimate: number;
    source: VoicePlaybackSource;
    model?: string;
    voice?: string;
    format?: string;
    fallbackAttempted?: boolean;
    candidateOrder?: string[];
    attempts?: Array<{
      model?: string;
      status_code?: number;
      elapsed_ms?: number;
      result?: string;
      error?: string;
      next_model?: string | null;
    }>;
  }) => void;
  onPlaybackStarted?: (payload: { voiceTurnId?: string; source: VoicePlaybackSource }) => void;
  onPlaybackEnded?: (payload: { voiceTurnId?: string; source: VoicePlaybackSource }) => void;
  onPlaybackFailed?: (payload: {
    voiceTurnId?: string;
    reason: string;
    source?: VoicePlaybackSource;
  }) => void;
  onFallbackActivated?: (payload: {
    voiceTurnId?: string;
    source: "browser_speech_synthesis";
    reason: string;
    backendInFlight: boolean;
    backendResponseReceived: boolean;
    timeoutMs: number;
    requestedVoice?: string;
  }) => void;
  onStopped?: (payload: { voiceTurnId?: string; source?: VoicePlaybackSource }) => void;
  onTraceEvent?: (payload: {
    voiceTurnId?: string;
    event: string;
    metadata?: Record<string, unknown>;
    finalize?: boolean;
  }) => void;
};

function normalizeAudioMimeType(raw: string | null | undefined): string {
  const normalized = String(raw || "").trim().toLowerCase();
  const base = (normalized.split(";", 1)[0] || "").trim();
  return base || "audio/mpeg";
}

function parseHeaderBoolean(raw: string | null | undefined): boolean {
  return ["1", "true", "yes", "on", "enabled"].includes(String(raw || "").trim().toLowerCase());
}

function resolveTtsTimeoutMs(explicitTimeout?: number): number {
  if (typeof explicitTimeout === "number" && Number.isFinite(explicitTimeout) && explicitTimeout > 0) {
    return Math.round(explicitTimeout);
  }
  const fromEnv = Number(process.env.NEXT_PUBLIC_KAI_VOICE_TTS_TIMEOUT_MS || "");
  if (Number.isFinite(fromEnv) && fromEnv >= 4000) {
    return Math.round(fromEnv);
  }
  return 20000;
}

function isRealtimeBackendFallbackEnabled(): boolean {
  return isTruthyEnvFlag(process.env.NEXT_PUBLIC_VOICE_V2_TTS_BACKEND_FALLBACK_ENABLED);
}

function isStreamBackedAudioPlaybackSupported(mimeType: string): boolean {
  if (typeof MediaSource === "undefined") return false;
  if (typeof MediaSource.isTypeSupported === "function") {
    try {
      return MediaSource.isTypeSupported(mimeType);
    } catch {
      return false;
    }
  }
  return true;
}

export class VoiceTtsPlaybackManager {
  private audio: HTMLAudioElement | null = null;
  private audioUrl: string | null = null;
  private activeRunId = 0;
  private state: VoiceTtsPlaybackState = "idle";
  private usingSpeechSynthesis = false;
  private playbackCompletionResolver: (() => void) | null = null;
  private readonly onStateChange?: (state: VoiceTtsPlaybackState) => void;
  private readonly lifecycleHandlers?: VoiceTtsLifecycleHandlers;
  private activeVoiceTurnId: string | undefined;
  private activePlaybackSource: VoicePlaybackSource | undefined;
  private inFlightTtsAbortController: AbortController | null = null;
  private inFlightRealtimeCancel: (() => void) | null = null;
  private traceTimingByTurn = new Map<string, { turnStartMs: number; lastStageMs: number }>();

  constructor(
    onStateChange?: (state: VoiceTtsPlaybackState) => void,
    lifecycleHandlers?: VoiceTtsLifecycleHandlers
  ) {
    this.onStateChange = onStateChange;
    this.lifecycleHandlers = lifecycleHandlers;
  }

  private setState(next: VoiceTtsPlaybackState): void {
    if (this.state === next) return;
    this.state = next;
    this.onStateChange?.(next);
  }

  private isRunActive(runId: number): boolean {
    return runId === this.activeRunId;
  }

  private emitTraceEvent(
    event: string,
    metadata: Record<string, unknown> = {},
    options?: { voiceTurnId?: string; finalize?: boolean }
  ): void {
    const turnId = options?.voiceTurnId || this.activeVoiceTurnId;
    const nowMs = performance.now();
    const timestampIso = new Date().toISOString();
    let sincePrevMs = 0;
    let sinceTurnStartMs = 0;
    if (turnId) {
      const existing = this.traceTimingByTurn.get(turnId);
      if (!existing) {
        this.traceTimingByTurn.set(turnId, {
          turnStartMs: nowMs,
          lastStageMs: nowMs,
        });
      }
      const current = this.traceTimingByTurn.get(turnId)!;
      sincePrevMs = existing ? Math.max(0, Math.round(nowMs - existing.lastStageMs)) : 0;
      sinceTurnStartMs = Math.max(0, Math.round(nowMs - current.turnStartMs));
      this.traceTimingByTurn.set(turnId, {
        turnStartMs: current.turnStartMs,
        lastStageMs: nowMs,
      });
      if (options?.finalize) {
        this.traceTimingByTurn.delete(turnId);
      }
    }
    this.lifecycleHandlers?.onTraceEvent?.({
      voiceTurnId: turnId,
      event,
      metadata: {
        event,
        timestamp_iso: timestampIso,
        layer: "frontend",
        source:
          typeof metadata.source === "string" && metadata.source.trim()
            ? metadata.source
            : "voice_tts_playback",
        since_prev_ms: sincePrevMs,
        since_turn_start_ms: sinceTurnStartMs,
        ...metadata,
      },
      finalize: options?.finalize,
    });
  }

  private async playBackendAudioFromStream(
    runId: number,
    input: VoiceSpeakInput,
    responseMimeType: string,
    statusCode: number,
    responseReader: ReadableStreamDefaultReader<Uint8Array>,
    ttsBodyReadStartedAt: number,
    headerMeta: {
      model?: string;
      voice?: string;
      format?: string;
      fallbackAttempted: boolean;
      candidateOrder: string[];
      attempts: Array<{
        result?: string;
        model?: string;
        status_code?: number;
        elapsed_ms?: number;
        error?: string;
        next_model?: string | null;
      }>;
      audioBytesEstimate?: number;
    }
  ): Promise<void> {
    if (typeof MediaSource === "undefined") {
      throw new Error("VOICE_TTS_STREAM_PLAYBACK_UNSUPPORTED");
    }

    const mediaSource = new MediaSource();
    this.audioUrl = URL.createObjectURL(mediaSource);
    this.audio = new Audio(this.audioUrl);
    this.activePlaybackSource = "backend_openai_audio";
    this.emitTraceEvent(
      "tts_audio_src_assigned",
      {
        route: "/api/kai/voice/tts",
        playback_source: "backend_openai_audio",
        audio_url_created: Boolean(this.audioUrl),
        stream_mode: true,
        source: "voice_tts_playback",
      },
      { voiceTurnId: input.voiceTurnId }
    );

    let playbackReject: ((error: Error) => void) | null = null;
    const playbackPromise = new Promise<void>((resolve, reject) => {
      if (!this.audio) {
        reject(new Error("VOICE_TTS_AUDIO_INIT"));
        return;
      }
      let settled = false;
      const safeResolve = () => {
        if (settled) return;
        settled = true;
        this.playbackCompletionResolver = null;
        resolve();
      };
      const safeReject = (error: Error) => {
        if (settled) return;
        settled = true;
        this.playbackCompletionResolver = null;
        reject(error);
      };
      playbackReject = safeReject;
      this.playbackCompletionResolver = safeResolve;
      this.audio.onended = () => safeResolve();
      this.audio.onerror = () => safeReject(new Error("VOICE_TTS_AUDIO_PLAYBACK"));
      this.audio.onplay = () => {
        if (!this.isRunActive(runId)) return;
        this.emitTraceEvent(
          "tts_playback_started",
          {
            route: "/api/kai/voice/tts",
            playback_source: "backend_openai_audio",
            stream_mode: true,
            source: "voice_tts_playback",
          },
          { voiceTurnId: input.voiceTurnId }
        );
        this.setState("playing");
        this.lifecycleHandlers?.onPlaybackStarted?.({
          voiceTurnId: input.voiceTurnId,
          source: "backend_openai_audio",
        });
      };
    });

    let sourceBuffer: SourceBuffer | null = null;
    const appendQueue: Uint8Array[] = [];
    let sourceBufferEnded = false;
    let appendInFlight = false;
    let playbackRequested = false;
    let firstAudioByteMs: number | null = null;
    let audioBytesRead = 0;

    const markFirstAudioByte = () => {
      if (firstAudioByteMs !== null) return;
      firstAudioByteMs = Math.max(0, Math.round(performance.now() - ttsBodyReadStartedAt));
      this.emitTraceEvent(
        "tts_first_audio_byte_received",
        {
          route: "/api/kai/voice/tts",
          first_audio_byte_ms: firstAudioByteMs,
          stream_mode: true,
          source: "voice_tts_playback",
        },
        { voiceTurnId: input.voiceTurnId }
      );
      this.emitTraceEvent(
        "tts_first_playable_data_received",
        {
          route: "/api/kai/voice/tts",
          first_playable_data_ms: firstAudioByteMs,
          stream_mode: true,
          source: "voice_tts_playback",
        },
        { voiceTurnId: input.voiceTurnId }
      );
    };

    const requestPlayback = () => {
      if (playbackRequested || !this.audio || !this.isRunActive(runId)) return;
      playbackRequested = true;
      this.emitTraceEvent(
        "tts_play_requested",
        {
          route: "/api/kai/voice/tts",
          playback_source: "backend_openai_audio",
          stream_mode: true,
          source: "voice_tts_playback",
        },
        { voiceTurnId: input.voiceTurnId }
      );
      const playResult = this.audio.play();
      if (playResult) {
        void playResult.catch((error: unknown) => {
          if (!this.isRunActive(runId)) return;
          playbackReject?.(error instanceof Error ? error : new Error("VOICE_TTS_AUDIO_PLAYBACK"));
        });
      }
    };

    const maybeFinalizeStream = () => {
      if (!sourceBuffer || sourceBuffer.updating || appendQueue.length > 0) {
        return;
      }
      if (!sourceBufferEnded) {
        return;
      }
      try {
        if (mediaSource.readyState === "open") {
          mediaSource.endOfStream();
        }
      } catch {
        // noop
      }
    };

    const drainAppendQueue = () => {
      if (!sourceBuffer || sourceBuffer.updating || appendInFlight) return;
      const nextChunk = appendQueue.shift();
      if (!nextChunk) {
        maybeFinalizeStream();
        return;
      }
      appendInFlight = true;
      try {
        const stableChunk = new Uint8Array(nextChunk.byteLength);
        stableChunk.set(nextChunk);
        sourceBuffer.appendBuffer(stableChunk.buffer as ArrayBuffer);
      } catch (error) {
        appendInFlight = false;
        throw error;
      }
    };

    const sourceOpenPromise = new Promise<void>((resolve, reject) => {
      mediaSource.addEventListener(
        "sourceopen",
        () => {
          if (!this.isRunActive(runId)) {
            resolve();
            return;
          }
          try {
            sourceBuffer = mediaSource.addSourceBuffer(responseMimeType);
            sourceBuffer.mode = "sequence";
            sourceBuffer.addEventListener("updateend", () => {
              appendInFlight = false;
              if (!this.isRunActive(runId)) {
                return;
              }
              if (!playbackRequested) {
                requestPlayback();
              }
              drainAppendQueue();
            });
            sourceBuffer.addEventListener("error", () => {
              reject(new Error("VOICE_TTS_MEDIA_SOURCE_BUFFER_ERROR"));
            });
            resolve();
          } catch (error) {
            reject(error instanceof Error ? error : new Error("VOICE_TTS_MEDIA_SOURCE_INIT"));
          }
        },
        { once: true }
      );
      mediaSource.addEventListener(
        "error",
        () => reject(new Error("VOICE_TTS_MEDIA_SOURCE_ERROR")),
        { once: true }
      );
    });

    const readerLoop = (async () => {
      while (true) {
        const { done, value } = await responseReader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        markFirstAudioByte();
        const stableChunk = new Uint8Array(value.byteLength);
        stableChunk.set(value);
        appendQueue.push(stableChunk);
        audioBytesRead += stableChunk.byteLength;
        if (sourceBuffer) {
          drainAppendQueue();
        }
      }
      sourceBufferEnded = true;
      maybeFinalizeStream();
    })();

    await sourceOpenPromise;
    if (!this.isRunActive(runId)) return;
    if (appendQueue.length > 0) {
      drainAppendQueue();
    }

    await readerLoop;
    if (!this.isRunActive(runId)) return;

    const bodyReadElapsedMs = Math.max(0, Math.round(performance.now() - ttsBodyReadStartedAt));
    this.emitTraceEvent(
      "tts_response_body_received",
      {
        route: "/api/kai/voice/tts",
        origin: "backend_confirmed",
        status_code: statusCode,
        stream_mode: true,
        audio_bytes: audioBytesRead,
        first_audio_byte_ms: firstAudioByteMs,
        elapsed_ms: bodyReadElapsedMs,
        source: "voice_tts_playback",
      },
      { voiceTurnId: input.voiceTurnId }
    );

    if (audioBytesRead <= 0) {
      throw new Error("VOICE_TTS_EMPTY_AUDIO");
    }

    this.lifecycleHandlers?.onAudioReceived?.({
      voiceTurnId: input.voiceTurnId,
      mimeType: responseMimeType,
      audioBytesEstimate:
        typeof headerMeta.audioBytesEstimate === "number" && headerMeta.audioBytesEstimate > 0
          ? Math.round(headerMeta.audioBytesEstimate)
          : audioBytesRead,
      source: "backend_openai_audio",
      model: headerMeta.model,
      voice: headerMeta.voice || (typeof input.voice === "string" ? input.voice : undefined),
      format: headerMeta.format,
      fallbackAttempted: headerMeta.fallbackAttempted,
      candidateOrder: headerMeta.candidateOrder,
      attempts: headerMeta.attempts,
    });

    await playbackPromise;
    if (!this.isRunActive(runId)) return;
    this.setState("idle");
    this.emitTraceEvent(
      "tts_playback_ended",
      {
        route: "/api/kai/voice/tts",
        playback_source: "backend_openai_audio",
        stream_mode: true,
        source: "voice_tts_playback",
      },
      { voiceTurnId: input.voiceTurnId, finalize: true }
    );
    this.lifecycleHandlers?.onPlaybackEnded?.({
      voiceTurnId: input.voiceTurnId,
      source: "backend_openai_audio",
    });
  }

  private async playWithSpeechSynthesis(
    runId: number,
    text: string,
    fallbackReason: string,
    fallbackMeta: {
      backendInFlight: boolean;
      backendResponseReceived: boolean;
      timeoutMs: number;
      requestedVoice?: string;
    }
  ): Promise<boolean> {
    if (typeof window === "undefined") return false;
    if (!("speechSynthesis" in window) || typeof SpeechSynthesisUtterance === "undefined") {
      return false;
    }
    return new Promise<boolean>((resolve) => {
      this.usingSpeechSynthesis = true;
      this.activePlaybackSource = "browser_speech_synthesis";
      this.emitTraceEvent(
        "tts_fallback_triggered",
        {
          route: "/api/kai/voice/tts",
          fallback_triggered: true,
          fallback_reason: fallbackReason,
          backend_in_flight: fallbackMeta.backendInFlight,
          backend_response_received: fallbackMeta.backendResponseReceived,
          timeout_ms: fallbackMeta.timeoutMs,
          requested_voice: fallbackMeta.requestedVoice || null,
          source: "voice_tts_playback",
        },
        { voiceTurnId: this.activeVoiceTurnId }
      );
      this.lifecycleHandlers?.onFallbackActivated?.({
        voiceTurnId: this.activeVoiceTurnId,
        source: "browser_speech_synthesis",
        reason: fallbackReason,
        backendInFlight: fallbackMeta.backendInFlight,
        backendResponseReceived: fallbackMeta.backendResponseReceived,
        timeoutMs: fallbackMeta.timeoutMs,
        requestedVoice: fallbackMeta.requestedVoice,
      });
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.onstart = () => {
        if (!this.isRunActive(runId)) return;
        this.emitTraceEvent(
          "tts_fallback_playback_started",
          {
            route: "/api/kai/voice/tts",
            playback_source: "browser_speech_synthesis",
            source: "voice_tts_playback",
          },
          { voiceTurnId: this.activeVoiceTurnId }
        );
        this.setState("playing");
        this.lifecycleHandlers?.onPlaybackStarted?.({
          voiceTurnId: this.activeVoiceTurnId,
          source: "browser_speech_synthesis",
        });
      };
      utterance.onend = () => {
        if (!this.isRunActive(runId)) {
          resolve(true);
          return;
        }
        this.emitTraceEvent(
          "tts_fallback_playback_ended",
          {
            route: "/api/kai/voice/tts",
            playback_source: "browser_speech_synthesis",
            source: "voice_tts_playback",
          },
          { voiceTurnId: this.activeVoiceTurnId, finalize: true }
        );
        this.usingSpeechSynthesis = false;
        this.setState("idle");
        this.lifecycleHandlers?.onPlaybackEnded?.({
          voiceTurnId: this.activeVoiceTurnId,
          source: "browser_speech_synthesis",
        });
        resolve(true);
      };
      utterance.onerror = () => {
        if (!this.isRunActive(runId)) {
          resolve(false);
          return;
        }
        this.emitTraceEvent(
          "tts_fallback_playback_failed",
          {
            route: "/api/kai/voice/tts",
            playback_source: "browser_speech_synthesis",
            source: "voice_tts_playback",
          },
          { voiceTurnId: this.activeVoiceTurnId, finalize: true }
        );
        this.usingSpeechSynthesis = false;
        this.setState("idle");
        resolve(false);
      };
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utterance);
    });
  }

  stop(): void {
    this.activeRunId += 1;
    if (this.inFlightTtsAbortController) {
      this.inFlightTtsAbortController.abort("VOICE_TTS_STOPPED");
      this.inFlightTtsAbortController = null;
    }
    if (this.inFlightRealtimeCancel) {
      this.inFlightRealtimeCancel();
      this.inFlightRealtimeCancel = null;
    }
    if (this.playbackCompletionResolver) {
      this.playbackCompletionResolver();
      this.playbackCompletionResolver = null;
    }

    if (this.audio) {
      this.audio.pause();
      this.audio.src = "";
      this.audio = null;
    }
    if (this.audioUrl) {
      URL.revokeObjectURL(this.audioUrl);
      this.audioUrl = null;
    }
    if (this.usingSpeechSynthesis && typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
      this.usingSpeechSynthesis = false;
    }

    this.lifecycleHandlers?.onStopped?.({
      voiceTurnId: this.activeVoiceTurnId,
      source: this.activePlaybackSource,
    });
    this.emitTraceEvent(
      "tts_playback_stopped",
      {
        route: "/api/kai/voice/tts",
        playback_source: this.activePlaybackSource || null,
        source: "voice_tts_playback",
      },
      { voiceTurnId: this.activeVoiceTurnId, finalize: true }
    );
    this.activeVoiceTurnId = undefined;
    this.activePlaybackSource = undefined;
    this.setState("idle");
  }

  async speak(input: VoiceSpeakInput): Promise<void> {
    const text = String(input.text || "").trim();
    if (!text) return;

    this.stop();
    const runId = this.activeRunId;
    this.activeVoiceTurnId = input.voiceTurnId;
    this.setState("loading");
    this.lifecycleHandlers?.onRequested?.({
      voiceTurnId: input.voiceTurnId,
      text,
      voice: input.voice,
    });
    this.emitTraceEvent(
      "tts_request_prepared",
      {
        route: "/api/kai/voice/tts",
        origin: "frontend_optimistic",
        text_chars: text.length,
        requested_voice: input.voice || null,
        adapter: input.adapter || "backend_batch_tts",
        source: "voice_tts_playback",
      },
      { voiceTurnId: input.voiceTurnId }
    );

    if (input.adapter === "realtime_stream_tts") {
      if (!input.realtimeAdapter) {
        this.setState("idle");
        throw new Error("VOICE_TTS_REALTIME_ADAPTER_MISSING");
      }
      const realtimeTtsStartedAt = performance.now();
      let realtimeFirstAudioMarked = false;
      let realtimePlaybackStarted = false;
      this.emitTraceEvent(
        "tts_request_sent",
        {
          route: "realtime_stream",
          origin: "frontend_optimistic",
          adapter: "realtime_stream_tts",
          source: "voice_tts_playback",
        },
        { voiceTurnId: input.voiceTurnId }
      );
      this.activePlaybackSource = "realtime_stream_tts";
      this.inFlightRealtimeCancel = () => {
        try {
          input.realtimeAdapter?.cancel?.();
        } catch {
          // noop
        }
      };
      try {
        await input.realtimeAdapter.speak({
          text,
          voice: input.voice,
          voiceTurnId: input.voiceTurnId,
          responseId: input.responseId,
          segmentType: input.segmentType || "final",
          timeoutMs: input.timeoutMs,
          onFirstAudio: () => {
            const firstAudioMs = Math.max(0, Math.round(performance.now() - realtimeTtsStartedAt));
            if (!realtimeFirstAudioMarked) {
              realtimeFirstAudioMarked = true;
              this.emitTraceEvent(
                "tts_first_audio_byte_received",
                {
                  route: "realtime_stream",
                  first_audio_byte_ms: firstAudioMs,
                  stream_mode: true,
                  adapter: "realtime_stream_tts",
                  source: "voice_tts_playback",
                },
                { voiceTurnId: input.voiceTurnId }
              );
              this.emitTraceEvent(
                "tts_first_playable_data_received",
                {
                  route: "realtime_stream",
                  first_playable_data_ms: firstAudioMs,
                  stream_mode: true,
                  adapter: "realtime_stream_tts",
                  source: "voice_tts_playback",
                },
                { voiceTurnId: input.voiceTurnId }
              );
            }
            this.emitTraceEvent(
              "tts_response_body_received",
              {
                route: "realtime_stream",
                origin: "backend_confirmed",
                first_audio_byte_ms: firstAudioMs,
                adapter: "realtime_stream_tts",
                source: "voice_tts_playback",
              },
              { voiceTurnId: input.voiceTurnId }
            );
            this.lifecycleHandlers?.onAudioReceived?.({
              voiceTurnId: input.voiceTurnId,
              mimeType: "audio/realtime",
              audioBytesEstimate: 0,
              source: "realtime_stream_tts",
              model: "realtime_stream",
              voice: input.voice,
              format: "stream",
            });
          },
          onPlaybackStarted: () => {
            if (!this.isRunActive(runId)) return;
            realtimePlaybackStarted = true;
            this.emitTraceEvent(
              "tts_playback_started",
              {
                route: "realtime_stream",
                playback_source: "realtime_stream_tts",
                source: "voice_tts_playback",
              },
              { voiceTurnId: input.voiceTurnId }
            );
            this.setState("playing");
            this.lifecycleHandlers?.onPlaybackStarted?.({
              voiceTurnId: input.voiceTurnId,
              source: "realtime_stream_tts",
            });
          },
          onPlaybackEnded: () => {
            if (!this.isRunActive(runId)) return;
            this.emitTraceEvent(
              "tts_playback_ended",
              {
                route: "realtime_stream",
                playback_source: "realtime_stream_tts",
                source: "voice_tts_playback",
              },
              { voiceTurnId: input.voiceTurnId, finalize: true }
            );
            this.setState("idle");
            this.lifecycleHandlers?.onPlaybackEnded?.({
              voiceTurnId: input.voiceTurnId,
              source: "realtime_stream_tts",
            });
          },
        });
        if (!this.isRunActive(runId)) return;
        if (!realtimePlaybackStarted) {
          throw new Error("VOICE_STREAM_TTS_PLAYBACK_NOT_STARTED");
        }
        this.emitTraceEvent(
          "tts_stream_protocol_done",
          {
            route: "realtime_stream",
            adapter: "realtime_stream_tts",
            source: "voice_tts_playback",
          },
          { voiceTurnId: input.voiceTurnId }
        );
        this.setState("idle");
        return;
      } catch (error) {
        if (!this.isRunActive(runId)) return;
        const reason =
          error instanceof Error ? error.message : "VOICE_STREAM_TTS_FAILED";
        if (isRealtimeBackendFallbackEnabled()) {
          this.setState("idle");
          return this.speak({
            ...input,
            adapter: "backend_batch_tts",
            realtimeAdapter: undefined,
          });
        }
        this.setState("idle");
        this.lifecycleHandlers?.onPlaybackFailed?.({
          voiceTurnId: input.voiceTurnId,
          reason,
          source: "realtime_stream_tts",
        });
        throw error;
      } finally {
        if (this.inFlightRealtimeCancel) {
          this.inFlightRealtimeCancel = null;
        }
      }
    }

    const timeoutMs = resolveTtsTimeoutMs(input.timeoutMs);
    const ttsAbortController = new AbortController();
    this.inFlightTtsAbortController = ttsAbortController;
    let backendResponseReceived = false;

    try {
      this.emitTraceEvent(
        "tts_request_sent",
        {
          route: "/api/kai/voice/tts",
          origin: "frontend_optimistic",
          adapter: "backend_batch_tts",
          timeout_ms: timeoutMs,
          source: "voice_tts_playback",
        },
        { voiceTurnId: input.voiceTurnId }
      );
      const response = await new Promise<Response>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          if (!ttsAbortController.signal.aborted) {
            ttsAbortController.abort("VOICE_TTS_TIMEOUT");
          }
          reject(new Error("VOICE_TTS_TIMEOUT"));
        }, timeoutMs);

        void ApiService.synthesizeKaiVoice({
          userId: input.userId,
          vaultOwnerToken: input.vaultOwnerToken,
          text,
          voice: input.voice,
          voiceTurnId: input.voiceTurnId,
          signal: ttsAbortController.signal,
        })
          .then((value) => {
            window.clearTimeout(timer);
            resolve(value);
          })
          .catch((error: unknown) => {
            window.clearTimeout(timer);
            reject(error);
          });
      });
      if (!this.isRunActive(runId)) return;
      backendResponseReceived = true;
      this.emitTraceEvent(
        "tts_response_headers_received",
        {
          route: "/api/kai/voice/tts",
          origin: "backend_confirmed",
          status_code: response.status,
          response_content_type: response.headers.get("content-type") || null,
          source: "voice_tts_playback",
        },
        { voiceTurnId: input.voiceTurnId }
      );

      const responseMimeType = normalizeAudioMimeType(response.headers.get("content-type"));
      const headerModel = String(response.headers.get("x-kai-tts-model") || "").trim() || undefined;
      const headerVoice = String(response.headers.get("x-kai-tts-voice") || "").trim() || undefined;
      const headerFormat = String(response.headers.get("x-kai-tts-format") || "").trim() || undefined;
      const headerCandidateOrderRaw = String(response.headers.get("x-kai-tts-candidate-order") || "").trim();
      const headerCandidateOrder = headerCandidateOrderRaw
        ? headerCandidateOrderRaw
            .split(",")
            .map((value) => value.trim())
            .filter((value) => value.length > 0)
        : [];
      const headerFallbackAttempted = parseHeaderBoolean(
        response.headers.get("x-kai-tts-fallback-attempted")
      );
      const headerAudioBytes = Number(response.headers.get("x-kai-tts-audio-bytes") || "");
      const headerAttemptsCount = Number(response.headers.get("x-kai-tts-attempts-count") || "");

      if (!response.ok) {
        let message = `VOICE_TTS_HTTP_${response.status}`;
        const errorBodyText = await response.text().catch(() => "");
        const errorContentType = String(response.headers.get("content-type") || "").toLowerCase();
        if (errorBodyText && errorContentType.includes("application/json")) {
          try {
            const errorPayload = JSON.parse(errorBodyText) as {
              detail?: unknown;
              error?: unknown;
            };
            if (typeof errorPayload.detail === "string" && errorPayload.detail.trim()) {
              message = errorPayload.detail.trim();
            } else if (typeof errorPayload.error === "string" && errorPayload.error.trim()) {
              message = errorPayload.error.trim();
            } else if (errorBodyText.trim()) {
              message = errorBodyText.trim();
            }
          } catch {
            if (errorBodyText.trim()) {
              message = errorBodyText.trim();
            }
          }
        } else if (errorBodyText.trim()) {
          message = errorBodyText.trim();
        }
        throw new Error(message);
      }

      const ttsBodyReadStartedAt = performance.now();
      const responseReader =
        response.body && typeof response.body.getReader === "function"
          ? response.body.getReader()
          : null;
      const canStreamResponse = Boolean(responseReader) && isStreamBackedAudioPlaybackSupported(responseMimeType);
      if (canStreamResponse && responseReader) {
        await this.playBackendAudioFromStream(
          runId,
          input,
          responseMimeType,
          response.status,
          responseReader,
          ttsBodyReadStartedAt,
          {
            model: headerModel,
            voice: headerVoice,
            format: headerFormat,
            fallbackAttempted: headerFallbackAttempted,
            candidateOrder: headerCandidateOrder,
            attempts:
              Number.isFinite(headerAttemptsCount) && headerAttemptsCount > 0
                ? [{ result: `count:${Math.round(headerAttemptsCount)}` }]
                : [],
            audioBytesEstimate:
              Number.isFinite(headerAudioBytes) && headerAudioBytes > 0 ? Math.round(headerAudioBytes) : undefined,
          }
        );
        return;
      }

      const audioChunks: ArrayBuffer[] = [];
      let audioBytesRead = 0;
      let firstAudioByteMs: number | null = null;
      const markFirstAudioByte = () => {
        if (firstAudioByteMs !== null) return;
        firstAudioByteMs = Math.max(0, Math.round(performance.now() - ttsBodyReadStartedAt));
        this.emitTraceEvent(
          "tts_first_audio_byte_received",
          {
            route: "/api/kai/voice/tts",
            first_audio_byte_ms: firstAudioByteMs,
            stream_mode: Boolean(responseReader),
            source: "voice_tts_playback",
          },
          { voiceTurnId: input.voiceTurnId }
        );
        this.emitTraceEvent(
          "tts_first_playable_data_received",
          {
            route: "/api/kai/voice/tts",
            first_playable_data_ms: firstAudioByteMs,
            stream_mode: Boolean(responseReader),
            source: "voice_tts_playback",
          },
          { voiceTurnId: input.voiceTurnId }
        );
      };

      if (responseReader) {
        while (true) {
          const { done, value } = await responseReader.read();
          if (done) break;
          if (!value || value.byteLength === 0) continue;
          markFirstAudioByte();
          const stableChunk = new Uint8Array(value.byteLength);
          stableChunk.set(value);
          audioChunks.push(stableChunk.buffer);
          audioBytesRead += stableChunk.byteLength;
        }
      } else {
        const audioBuffer = await response.arrayBuffer();
        if (audioBuffer.byteLength > 0) {
          markFirstAudioByte();
          const singleChunk = new Uint8Array(audioBuffer);
          const stableChunk = new Uint8Array(singleChunk.byteLength);
          stableChunk.set(singleChunk);
          audioChunks.push(stableChunk.buffer);
          audioBytesRead = stableChunk.byteLength;
        }
      }

      const bodyReadElapsedMs = Math.max(0, Math.round(performance.now() - ttsBodyReadStartedAt));
      this.emitTraceEvent(
        "tts_response_body_received",
        {
          route: "/api/kai/voice/tts",
          origin: "backend_confirmed",
          status_code: response.status,
          stream_mode: Boolean(responseReader),
          audio_bytes: audioBytesRead,
          first_audio_byte_ms: firstAudioByteMs,
          elapsed_ms: bodyReadElapsedMs,
          source: "voice_tts_playback",
        },
        { voiceTurnId: input.voiceTurnId }
      );

      if (audioBytesRead <= 0) {
        throw new Error("VOICE_TTS_EMPTY_AUDIO");
      }

      this.lifecycleHandlers?.onAudioReceived?.({
        voiceTurnId: input.voiceTurnId,
        mimeType: responseMimeType,
        audioBytesEstimate:
          Number.isFinite(headerAudioBytes) && headerAudioBytes > 0 ? Math.round(headerAudioBytes) : audioBytesRead,
        source: "backend_openai_audio",
        model: headerModel,
        voice: headerVoice || (typeof input.voice === "string" ? input.voice : undefined),
        format: headerFormat,
        fallbackAttempted: headerFallbackAttempted,
        candidateOrder: headerCandidateOrder,
        attempts:
          Number.isFinite(headerAttemptsCount) && headerAttemptsCount > 0
            ? [{ result: `count:${Math.round(headerAttemptsCount)}` }]
            : [],
      });

      this.emitTraceEvent(
        "tts_blob_creation_started",
        {
          route: "/api/kai/voice/tts",
          audio_bytes: audioBytesRead,
          source: "voice_tts_playback",
        },
        { voiceTurnId: input.voiceTurnId }
      );
      const blob = new Blob(audioChunks, { type: responseMimeType });
      this.emitTraceEvent(
        "tts_blob_creation_finished",
        {
          route: "/api/kai/voice/tts",
          blob_bytes: blob.size,
          mime_type: blob.type || responseMimeType,
          source: "voice_tts_playback",
        },
        { voiceTurnId: input.voiceTurnId }
      );
      if (!this.isRunActive(runId)) return;

      this.audioUrl = URL.createObjectURL(blob);
      this.audio = new Audio(this.audioUrl);
      this.activePlaybackSource = "backend_openai_audio";
      this.emitTraceEvent(
        "tts_audio_src_assigned",
        {
          route: "/api/kai/voice/tts",
          playback_source: "backend_openai_audio",
          audio_url_created: Boolean(this.audioUrl),
          source: "voice_tts_playback",
        },
        { voiceTurnId: input.voiceTurnId }
      );

      await new Promise<void>((resolve, reject) => {
        if (!this.audio) {
          reject(new Error("VOICE_TTS_AUDIO_INIT"));
          return;
        }
        let settled = false;
        const safeResolve = () => {
          if (settled) return;
          settled = true;
          this.playbackCompletionResolver = null;
          resolve();
        };
        const safeReject = (error: Error) => {
          if (settled) return;
          settled = true;
          this.playbackCompletionResolver = null;
          reject(error);
        };
        this.playbackCompletionResolver = safeResolve;
        this.audio.onended = () => safeResolve();
        this.audio.onerror = () => safeReject(new Error("VOICE_TTS_AUDIO_PLAYBACK"));
        this.audio.onplay = () => {
          if (!this.isRunActive(runId)) return;
          this.emitTraceEvent(
            "tts_playback_started",
            {
              route: "/api/kai/voice/tts",
              playback_source: "backend_openai_audio",
              source: "voice_tts_playback",
            },
            { voiceTurnId: input.voiceTurnId }
          );
          this.setState("playing");
          this.lifecycleHandlers?.onPlaybackStarted?.({
            voiceTurnId: input.voiceTurnId,
            source: "backend_openai_audio",
          });
        };
        this.emitTraceEvent(
          "tts_play_requested",
          {
            route: "/api/kai/voice/tts",
            playback_source: "backend_openai_audio",
            source: "voice_tts_playback",
          },
          { voiceTurnId: input.voiceTurnId }
        );
        const playResult = this.audio.play();
        if (playResult) {
          void playResult.catch((error: unknown) =>
            safeReject(error instanceof Error ? error : new Error("VOICE_TTS_AUDIO_PLAYBACK"))
          );
        }
      });

      if (!this.isRunActive(runId)) return;
      this.setState("idle");
      this.emitTraceEvent(
        "tts_playback_ended",
        {
          route: "/api/kai/voice/tts",
          playback_source: "backend_openai_audio",
          source: "voice_tts_playback",
        },
        { voiceTurnId: input.voiceTurnId, finalize: true }
      );
      this.lifecycleHandlers?.onPlaybackEnded?.({
        voiceTurnId: input.voiceTurnId,
        source: "backend_openai_audio",
      });
    } catch (error) {
      if (!this.isRunActive(runId)) return;

      const errorMessage = error instanceof Error ? error.message : "VOICE_TTS_UNKNOWN";
      this.emitTraceEvent(
        "tts_fallback_disabled",
        {
          route: "/api/kai/voice/tts",
          fallback_triggered: false,
          reason: errorMessage,
          backend_response_received: backendResponseReceived,
          fail_fast_voice: isVoiceFailFastEnabled(),
          no_fallbacks: true,
          source: "voice_tts_playback",
        },
        { voiceTurnId: input.voiceTurnId, finalize: true }
      );
      this.setState("idle");
      this.lifecycleHandlers?.onPlaybackFailed?.({
        voiceTurnId: input.voiceTurnId,
        reason: errorMessage,
        source: this.activePlaybackSource,
      });
      throw error;
    } finally {
      if (this.inFlightTtsAbortController === ttsAbortController) {
        this.inFlightTtsAbortController = null;
      }
      this.playbackCompletionResolver = null;
      if (!this.isRunActive(runId)) return;
      if (this.audio) {
        this.audio.onended = null;
        this.audio.onerror = null;
        this.audio.onplay = null;
      }
      if (this.audioUrl) {
        URL.revokeObjectURL(this.audioUrl);
      }
      this.audio = null;
      this.audioUrl = null;
      this.activeVoiceTurnId = undefined;
      this.activePlaybackSource = undefined;
    }
  }

  async speakLocally(text: string, voiceTurnId?: string): Promise<void> {
    if (!isLegacyLocalSpeechCompatEnabled()) {
      throw new Error("VOICE_TTS_LOCAL_COMPAT_DISABLED");
    }
    const cleanText = String(text || "").trim();
    if (!cleanText) return;
    this.stop();
    this.activeVoiceTurnId = voiceTurnId;
    const runId = this.activeRunId;
    const fallbackSucceeded = await this.playWithSpeechSynthesis(
      runId,
      cleanText,
      "VOICE_TTS_LOCAL_ONLY",
      {
        backendInFlight: false,
        backendResponseReceived: false,
        timeoutMs: 0,
        requestedVoice: undefined,
      }
    );
    if (!fallbackSucceeded) {
      this.setState("idle");
      this.activeVoiceTurnId = undefined;
      throw new Error("VOICE_TTS_LOCAL_UNAVAILABLE");
    }
    if (this.isRunActive(runId)) {
      this.activeVoiceTurnId = undefined;
    }
  }
}
