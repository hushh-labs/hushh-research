"use client";

import { ApiService } from "@/lib/services/api-service";
import type { OneVoiceContextSnapshot } from "@/lib/voice/screen-context-builder";
import type {
  OneVoiceTransportHandlers,
  OneVoiceTransportStartOptions,
  RealtimeVoiceTransport,
} from "@/lib/voice/one-voice-transport";
import { mapAgentVoiceStatusToOneVoiceState } from "@/lib/voice/voice-ui-state-machine";

/**
 * Browser client for Gemini Live full-duplex voice.
 *
 * Flow:
 *   1. Open a WebSocket to our backend Vertex Live relay. The relay runs Gemini
 *      Live over Vertex AI via ADC, so it works on projects where the Developer
 *      API is restricted; the managed key never reaches the browser.
 *   2. The relay owns the Live setup and announces readiness with a
 *      {"setupComplete": {}} frame.
 *   3. Capture mic audio as 16 kHz mono PCM16 and stream it up.
 *   4. Play back the 24 kHz PCM16 audio Gemini streams down, and surface input
 *      and output amplitude + a coarse status so the UI waveform can react.
 *
 * This intentionally mirrors the handler shape of the existing
 * AgentRealtimeClient so it can be wired in the same way.
 */

const INPUT_SAMPLE_RATE = 16000;
const OUTPUT_SAMPLE_RATE = 24000;

export type GeminiLiveVoiceState =
  | "idle"
  | "connecting"
  | "listening"
  | "thinking"
  | "speaking";

export type GeminiLiveVoiceEventOptions = {
  sessionId: string | null;
  sourceId: "gemini_live";
  sourceSeq: number;
};

export type GeminiLiveHandlers = {
  onVoiceState?: (
    state: GeminiLiveVoiceState,
    options: GeminiLiveVoiceEventOptions
  ) => void;
  onEvent?: OneVoiceTransportHandlers["onEvent"];
  /** Input (mic) amplitude in [0, 1], sampled continuously while listening. */
  onInputLevel?: (level: number) => void;
  /** Output (agent) amplitude in [0, 1], sampled while audio is playing. */
  onOutputLevel?: (level: number) => void;
  onError?: (message: string, options: GeminiLiveVoiceEventOptions) => void;
  onClose?: () => void;
};

function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Turn a getUserMedia / AudioWorklet failure into a specific, actionable
 * message so the bar can tell the user why voice could not start instead of a
 * generic "Voice error". The DOMException name is the reliable signal across
 * browsers.
 */
function describeMicError(error: unknown): string {
  const name = error instanceof DOMException ? error.name : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "Microphone access is blocked. Allow the mic for this site in your browser settings, then try again.";
    case "NotFoundError":
    case "OverconstrainedError":
      return "No microphone was found. Connect a mic and try again.";
    case "NotReadableError":
      return "Your microphone is in use by another app. Close it and try again.";
    case "NotSupportedError":
      return "This browser does not support voice mode. Try Chrome or Safari over HTTPS.";
    default:
      return error instanceof Error && error.message
        ? `Voice could not start: ${error.message}`
        : "Voice could not start. Check your microphone and try again.";
  }
}

/**
 * Turn a WebSocket close that arrives before the Live session is set up into a
 * specific message. The server uses code 1008 (policy violation) for auth and
 * entitlement problems and puts the cause in the close reason, so we map the
 * common ones to something the user (or operator) can act on.
 */
function describeSocketCloseError(event: CloseEvent): string {
  const reason = (event.reason || "").trim();
  const lower = reason.toLowerCase();
  if (lower.includes("denied access") || lower.includes("permission_denied")) {
    return "Voice is not enabled for this workspace yet. The Gemini project needs Live API access.";
  }
  if (lower.includes("unregistered callers") || lower.includes("api key")) {
    return "Voice could not authenticate. Please try again in a moment.";
  }
  if (lower.includes("not found") || lower.includes("not supported")) {
    return "The voice model is unavailable right now. Please try again later.";
  }
  if (reason) {
    return `Voice session could not start: ${reason}`;
  }
  return `Voice session could not start (code ${event.code}).`;
}

function bytesFromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function createGeminiLiveSessionId(): string {
  const randomUuid =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `gemini_live_${randomUuid}`;
}

/** Float32 [-1,1] -> little-endian PCM16 bytes. */
function floatToPcm16(input: Float32Array): Uint8Array {
  const out = new DataView(new ArrayBuffer(input.length * 2));
  for (let i = 0; i < input.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, input[i] ?? 0));
    out.setInt16(i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return new Uint8Array(out.buffer);
}

/** Downsample a Float32 buffer from sourceRate to INPUT_SAMPLE_RATE. */
function downsample(buffer: Float32Array, sourceRate: number): Float32Array {
  if (sourceRate === INPUT_SAMPLE_RATE) return buffer;
  const ratio = sourceRate / INPUT_SAMPLE_RATE;
  const length = Math.floor(buffer.length / ratio);
  const result = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    result[i] = buffer[Math.floor(i * ratio)] ?? 0;
  }
  return result;
}

function rms(buffer: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    const v = buffer[i] ?? 0;
    sum += v * v;
  }
  return Math.sqrt(sum / Math.max(1, buffer.length));
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export class GeminiLiveClient implements RealtimeVoiceTransport {
  readonly provider = "gemini_live" as const;
  private handlers: GeminiLiveHandlers;
  private ws: WebSocket | null = null;
  private inputContext: AudioContext | null = null;
  private outputContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private captureNode: AudioWorkletNode | null = null;
  private closed = false;
  private setupComplete = false;
  private playheadTime = 0;
  private activeSources = new Set<AudioBufferSourceNode>();
  private outputLevelTimer: ReturnType<typeof setInterval> | null = null;
  private state: GeminiLiveVoiceState = "idle";
  private sessionId: string | null = null;
  private sourceSeq = 0;
  /** Snapshot captured at start(), pushed as app_context after setup. */
  private startContext: OneVoiceContextSnapshot | null = null;
  /** Consent token for One's specialist tools; rides only in app_context frames. */
  private consentToken: string | null = null;
  /**
   * Turn fence: after a local interrupt we drop any late model audio still in
   * flight until the provider closes the interrupted turn (turnComplete) or
   * the app starts a new turn (speakText). Without this, stale audio chunks
   * resume playback after interrupt() because the relay's interrupt is only a
   * local acknowledgement.
   */
  private suppressModelAudio = false;
  /** Resolvers waiting for the audio queue to drain (speakText settle). */
  private playbackDrainResolvers = new Set<() => void>();
  /** Timestamp of the most recent enqueued audio chunk (drain heuristics). */
  private lastAudioEnqueueAt = 0;

  constructor(handlers: GeminiLiveHandlers = {}) {
    this.handlers = handlers;
  }

  private setState(next: GeminiLiveVoiceState) {
    if (this.state === next) return;
    this.state = next;
    this.sourceSeq += 1;
    const eventOptions: GeminiLiveVoiceEventOptions = {
      sessionId: this.sessionId,
      sourceId: this.provider,
      sourceSeq: this.sourceSeq,
    };
    this.handlers.onVoiceState?.(next, eventOptions);
    this.handlers.onEvent?.({
      type: "state",
      provider: this.provider,
      state: mapAgentVoiceStatusToOneVoiceState(next),
      sessionId: eventOptions.sessionId,
      sourceId: eventOptions.sourceId,
      sourceSeq: eventOptions.sourceSeq,
    });
  }

  private nextEventOptions(): GeminiLiveVoiceEventOptions {
    this.sourceSeq += 1;
    return {
      sessionId: this.sessionId,
      sourceId: this.provider,
      sourceSeq: this.sourceSeq,
    };
  }

  async start(options?: OneVoiceTransportStartOptions): Promise<void> {
    if (this.ws) return;
    this.sessionId = createGeminiLiveSessionId();
    this.sourceSeq = 0;
    this.setState("connecting");

    const context = options?.context ?? null;
    this.startContext = context;
    this.consentToken = options?.consentToken ?? null;
    let relayUrl: string;
    try {
      relayUrl = options?.relayUrl || (await ApiService.getOneAdkLiveRelayUrl());
    } catch (error) {
      this.fail(error instanceof Error ? error.message : "Could not start One voice.");
      return;
    }

    try {
      await this.openMicrophone();
    } catch (error) {
      this.fail(describeMicError(error));
      return;
    }

    if (this.closed) return;
    this.connectSocket(relayUrl);
  }

  private async openMicrophone(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new DOMException(
        "This browser does not support microphone capture.",
        "NotSupportedError"
      );
    }
    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    this.inputContext = new AudioCtx();
    // Some browsers create the context in a "suspended" state until a user
    // gesture resumes it; the conversation button click is that gesture.
    if (this.inputContext.state === "suspended") {
      await this.inputContext.resume().catch(() => undefined);
    }

    // Modern, non-deprecated capture path: an AudioWorklet running off the main
    // thread posts fixed-size mono frames back to us. Falls back gracefully if
    // the worklet module cannot load.
    await this.inputContext.audioWorklet.addModule(
      "/audio/gemini-live-capture.worklet.js"
    );
    if (this.closed) return;

    this.sourceNode = this.inputContext.createMediaStreamSource(this.mediaStream);
    this.captureNode = new AudioWorkletNode(
      this.inputContext,
      "gemini-live-capture",
      { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1 }
    );
    this.sourceNode.connect(this.captureNode);

    this.captureNode.port.onmessage = (event) => {
      const frame = event.data as Float32Array;
      if (!this.setupComplete || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return;
      }
      const level = Math.min(1, rms(frame) * 4);
      this.handlers.onInputLevel?.(level);
      this.handlers.onEvent?.({
        type: "input_level",
        provider: this.provider,
        level,
      });
      // Mic frames stream continuously, so they must never demote the
      // thinking state (that is why "Thinking" used to flash for one frame
      // and snap back to "Listening" while the model was still working).
      if (this.state !== "speaking" && this.state !== "thinking") {
        this.setState("listening");
      }
      const sourceRate = this.inputContext?.sampleRate ?? INPUT_SAMPLE_RATE;
      const pcm = floatToPcm16(downsample(frame, sourceRate));
      this.ws.send(
        JSON.stringify({
          realtimeInput: {
            audio: {
              mimeType: `audio/pcm;rate=${INPUT_SAMPLE_RATE}`,
              data: base64FromBytes(pcm),
            },
          },
        })
      );
    };
  }

  private connectSocket(relayUrl: string): void {
    const ws = new WebSocket(relayUrl);
    this.ws = ws;

    // The server relay owns the Live setup (model, voice, system instruction)
    // and announces readiness with a {"setupComplete": {}} frame, so the browser
    // does not send a setup message here. It simply waits for setupComplete and
    // then streams mic audio.

    ws.onmessage = (event) => {
      void this.handleSocketMessage(event.data);
    };

    ws.onerror = () => {
      if (!this.closed) this.fail("Gemini Live connection error.");
    };

    ws.onclose = (event) => {
      if (this.closed) return;
      // A close that arrives before setup completes means the session never
      // started (bad/expired token, model not enabled, region). Surface that as
      // an error so the bar shows why instead of silently snapping back.
      if (!this.setupComplete) {
        this.fail(describeSocketCloseError(event));
        return;
      }
      this.stop();
    };
  }

  private async handleSocketMessage(data: unknown): Promise<void> {
    let text: string;
    if (typeof data === "string") {
      text = data;
    } else if (data instanceof Blob) {
      text = await data.text();
    } else {
      return;
    }

    let message: Record<string, unknown>;
    try {
      message = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }

    if ("setupComplete" in message) {
      this.setupComplete = true;
      // Push the initial app context (screen + governed consent token) now
      // that the session is live; the relay never accepts these in the URL.
      if (this.startContext) {
        this.updateContext(this.startContext);
        this.startContext = null;
      } else if (this.consentToken) {
        this.sendAppContext({});
      }
      this.setState("listening");
      return;
    }

    const clientDirective = readRecord(message.clientDirective);
    const directiveKind = readString(clientDirective?.kind);
    if (clientDirective && directiveKind) {
      const eventOptions = this.nextEventOptions();
      this.handlers.onEvent?.({
        type: "client_directive",
        provider: this.provider,
        directive: {
          kind: directiveKind,
          payload: readRecord(clientDirective.payload) || undefined,
        },
        sessionId: eventOptions.sessionId,
        sourceId: eventOptions.sourceId,
        sourceSeq: eventOptions.sourceSeq,
      });
      return;
    }

    const serverContent = message.serverContent as
      | {
          modelTurn?: { parts?: Array<Record<string, unknown>> };
          interrupted?: boolean;
          turnComplete?: boolean;
        }
      | undefined;

    const eventOptions = this.nextEventOptions();
    const inputTranscription =
      readRecord(message.inputTranscription) ||
      readRecord(message.input_transcription) ||
      readRecord(message.transcriptFinal);
    const inputText = readString(
      inputTranscription?.text ?? inputTranscription?.transcript ?? inputTranscription?.final
    );
    if (inputText) {
      // The provider transcribed the user's speech, which means the user's
      // turn ended and the model is now working on a response. Surface that
      // processing gap as "thinking" until the first audio chunk arrives so
      // the user knows they were heard.
      if (this.state === "listening") {
        this.setState("thinking");
      }
      this.handlers.onEvent?.({
        type: "transcript_final",
        provider: this.provider,
        text: inputText,
        turnId: readString(inputTranscription?.turn_id ?? inputTranscription?.turnId),
        confidence: readNumber(inputTranscription?.confidence),
        source: "provider",
        sessionId: eventOptions.sessionId,
        sourceId: eventOptions.sourceId,
        sourceSeq: eventOptions.sourceSeq,
      });
    }

    const outputTranscription =
      readRecord(message.outputTranscription) ||
      readRecord(message.output_transcription) ||
      readRecord(message.assistantText);
    const outputText = readString(
      outputTranscription?.text ?? outputTranscription?.transcript
    );
    if (outputText) {
      this.handlers.onEvent?.({
        type: "assistant_text",
        provider: this.provider,
        text: outputText,
        turnId: readString(outputTranscription?.turn_id ?? outputTranscription?.turnId),
        source: "provider",
        sessionId: eventOptions.sessionId,
        sourceId: eventOptions.sourceId,
        sourceSeq: eventOptions.sourceSeq,
      });
    }

    const handoff = readRecord(message.handoff);
    const handoffTarget = readString(handoff?.target);
    const handoffReason = readString(handoff?.reason);
    if (
      (handoffTarget === "chat" || handoffTarget === "consent" || handoffTarget === "route") &&
      handoffReason
    ) {
      this.handlers.onEvent?.({
        type: "handoff",
        provider: this.provider,
        target: handoffTarget,
        reason: handoffReason,
        payload: readRecord(handoff?.payload) || undefined,
        sessionId: eventOptions.sessionId,
        sourceId: eventOptions.sourceId,
        sourceSeq: eventOptions.sourceSeq,
      });
    }

    if (!serverContent) return;

    if (serverContent.interrupted) {
      this.stopPlayback();
      this.setState("listening");
      return;
    }

    if (serverContent.turnComplete) {
      // The interrupted (or finished) model turn is closed; stop fencing and
      // settle back to listening when nothing is queued for playback.
      this.suppressModelAudio = false;
      if (this.activeSources.size === 0 && !this.closed && this.state !== "idle") {
        this.setState("listening");
        this.resolvePlaybackDrain();
      }
      return;
    }

    const parts = serverContent.modelTurn?.parts ?? [];
    for (const part of parts) {
      const inlineData = part.inlineData as
        | { mimeType?: string; data?: string }
        | undefined;
      if (inlineData?.data && (inlineData.mimeType ?? "").startsWith("audio/")) {
        if (!this.suppressModelAudio) {
          this.enqueueAudio(bytesFromBase64(inlineData.data));
        }
      }
      const textPart = readString(part.text);
      if (textPart) {
        const textEventOptions = this.nextEventOptions();
        this.handlers.onEvent?.({
          type: "assistant_text",
          provider: this.provider,
          text: textPart,
          source: "model",
          sessionId: textEventOptions.sessionId,
          sourceId: textEventOptions.sourceId,
          sourceSeq: textEventOptions.sourceSeq,
        });
      }
    }
  }

  async speakText(input: {
    text: string;
    turnId?: string | null;
    segmentType?: "ack" | "final";
    signal?: AbortSignal;
  }): Promise<boolean> {
    const text = input.text.trim();
    if (!text || !this.ws || this.ws.readyState !== WebSocket.OPEN || !this.setupComplete) {
      return false;
    }
    if (input.signal?.aborted) return false;
    // App speech starts a fresh model turn; lift any interrupt fence so the
    // synthesized response is audible.
    this.suppressModelAudio = false;
    this.ws.send(
      JSON.stringify({
        type: "app_speech",
        text,
        turn_id: input.turnId ?? null,
        segment_type: input.segmentType ?? "final",
      })
    );
    // Settle on playback, not on socket send. Resolving at ws.send made the
    // bridge flip the UI back to "Listening" while the answer was still being
    // synthesized and played, which read as the agent talking over itself.
    const audioStarted = await this.waitForAudioStart(4000, input.signal);
    if (audioStarted) {
      await this.waitForPlaybackDrain(30000, input.signal);
    }
    return true;
  }

  interrupt(): void {
    this.stopPlayback();
    // Fence out any model audio still in flight for the interrupted turn;
    // the relay's interrupt frame is a local acknowledgement, so without the
    // fence stale chunks resume playing right after this call.
    this.suppressModelAudio = true;
    this.resolvePlaybackDrain();
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: "interrupt" }));
  }

  private resolvePlaybackDrain(): void {
    for (const resolve of this.playbackDrainResolvers) resolve();
    this.playbackDrainResolvers.clear();
  }

  /** Resolves true when a new audio chunk starts within the timeout. */
  private waitForAudioStart(timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    const startedAfter = Date.now();
    return new Promise((resolve) => {
      const poll = setInterval(() => {
        if (this.closed || signal?.aborted) {
          clearInterval(poll);
          resolve(false);
          return;
        }
        if (this.lastAudioEnqueueAt >= startedAfter || this.activeSources.size > 0) {
          clearInterval(poll);
          resolve(true);
          return;
        }
        if (Date.now() - startedAfter > timeoutMs) {
          clearInterval(poll);
          resolve(false);
        }
      }, 50);
    });
  }

  /** Resolves when the playback queue empties (or the timeout/abort hits). */
  private waitForPlaybackDrain(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    if (this.activeSources.size === 0) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        clearInterval(abortPoll);
        this.playbackDrainResolvers.delete(done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      const abortPoll = setInterval(() => {
        if (this.closed || signal?.aborted) done();
      }, 100);
      this.playbackDrainResolvers.add(done);
    });
  }

  updateContext(context: OneVoiceContextSnapshot): boolean {
    return this.sendAppContext({
      screen: context.route.screen,
      route_family: context.route.route_family,
      persona: context.persona.active,
      voice_state: context.voice.state,
      available_action_ids: context.available_action_ids,
      visible_modules: context.ui.visible_modules,
      cache_freshness: context.cache.freshness,
      vault_ready: context.cache.vault_ready,
      portfolio_ready: context.cache.portfolio_ready,
    });
  }

  /**
   * Send an app_context frame. The governed consent token and timezone ride
   * here (post-connect, never in the URL) so One's specialist tools can act;
   * the relay stores them in session state and they never reach the model.
   */
  private sendAppContext(appContext: Record<string, unknown>): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.setupComplete) {
      return false;
    }
    const timezone =
      typeof Intl !== "undefined"
        ? Intl.DateTimeFormat().resolvedOptions().timeZone
        : undefined;
    this.ws.send(
      JSON.stringify({
        type: "app_context",
        appContext: {
          ...appContext,
          ...(this.consentToken ? { consent_token: this.consentToken } : {}),
          ...(timezone ? { timezone } : {}),
        },
      })
    );
    return true;
  }

  private ensureOutputContext(): AudioContext {
    if (!this.outputContext) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      this.outputContext = new AudioCtx({ sampleRate: OUTPUT_SAMPLE_RATE });
      this.playheadTime = this.outputContext.currentTime;
      this.startOutputLevelMeter();
    }
    return this.outputContext;
  }

  private enqueueAudio(pcmBytes: Uint8Array): void {
    const context = this.ensureOutputContext();
    const frames = pcmBytes.length / 2;
    if (frames <= 0) return;
    const view = new DataView(
      pcmBytes.buffer,
      pcmBytes.byteOffset,
      pcmBytes.byteLength
    );
    const buffer = context.createBuffer(1, frames, OUTPUT_SAMPLE_RATE);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < frames; i += 1) {
      channel[i] = view.getInt16(i * 2, true) / 0x8000;
    }

    const node = context.createBufferSource();
    node.buffer = buffer;
    node.connect(context.destination);
    const startAt = Math.max(context.currentTime, this.playheadTime);
    node.start(startAt);
    this.playheadTime = startAt + buffer.duration;
    this.lastAudioEnqueueAt = Date.now();
    this.setState("speaking");
    this.activeSources.add(node);
    node.onended = () => {
      this.activeSources.delete(node);
      if (this.activeSources.size === 0 && !this.closed) {
        this.setState("listening");
        this.handlers.onOutputLevel?.(0);
        this.resolvePlaybackDrain();
      }
    };
  }

  private startOutputLevelMeter(): void {
    if (this.outputLevelTimer) return;
    // Approximate the agent waveform with a gentle pulse while audio is queued.
    this.outputLevelTimer = setInterval(() => {
      if (this.activeSources.size === 0) return;
      const t = Date.now() / 1000;
      const level = 0.35 + 0.35 * (0.5 + 0.5 * Math.sin(t * 7));
      this.handlers.onOutputLevel?.(Math.min(1, level));
      this.handlers.onEvent?.({
        type: "output_level",
        provider: this.provider,
        level: Math.min(1, level),
      });
    }, 50);
  }

  private stopPlayback(): void {
    for (const node of this.activeSources) {
      try {
        node.stop();
      } catch {
        // ignore
      }
    }
    this.activeSources.clear();
    if (this.outputContext) this.playheadTime = this.outputContext.currentTime;
    this.handlers.onOutputLevel?.(0);
  }

  private fail(message: string): void {
    const eventOptions = this.nextEventOptions();
    this.handlers.onError?.(message, eventOptions);
    this.handlers.onEvent?.({
      type: "error",
      provider: this.provider,
      message,
      sessionId: eventOptions.sessionId,
      sourceId: eventOptions.sourceId,
      sourceSeq: eventOptions.sourceSeq,
    });
    this.stop();
  }

  stop(): void {
    if (this.closed) return;
    this.closed = true;
    this.setupComplete = false;
    this.resolvePlaybackDrain();

    if (this.outputLevelTimer) {
      clearInterval(this.outputLevelTimer);
      this.outputLevelTimer = null;
    }
    this.stopPlayback();

    if (this.captureNode) {
      this.captureNode.port.onmessage = null;
      try {
        this.captureNode.disconnect();
      } catch {
        // ignore
      }
      this.captureNode = null;
    }
    if (this.sourceNode) {
      try {
        this.sourceNode.disconnect();
      } catch {
        // ignore
      }
      this.sourceNode = null;
    }
    if (this.mediaStream) {
      for (const track of this.mediaStream.getTracks()) track.stop();
      this.mediaStream = null;
    }
    if (this.inputContext) {
      void this.inputContext.close().catch(() => undefined);
      this.inputContext = null;
    }
    if (this.outputContext) {
      void this.outputContext.close().catch(() => undefined);
      this.outputContext = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }

    this.setState("idle");
    this.handlers.onEvent?.({
      type: "closed",
      provider: this.provider,
    });
    this.handlers.onClose?.();
  }
}

export { GeminiLiveClient as GeminiLiveTransport };
