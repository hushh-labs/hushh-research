"use client";

import { ApiService } from "@/lib/services/api-service";
import type { OneVoiceContextSnapshot } from "@/lib/voice/screen-context-builder";
import type {
  OneVoiceActionSettlement,
  OneVoiceActionConfirmation,
  OneVoiceContextApplyResult,
} from "@/lib/voice/one-voice-transport";
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
 *   1. Open a WebSocket to the backend relay. The first authenticated frame
 *      selects either Hushh-managed Vertex or a turn-local Gemini API key.
 *      The key is immediately cleared and never enters route state, storage,
 *      telemetry, or model context.
 *   2. The relay owns the Live setup and announces readiness with a
 *      {"setupComplete": {}} frame.
 *   3. Capture mic audio as 16 kHz mono PCM16 and stream it up.
 *   4. Play back the 24 kHz PCM16 audio Gemini streams down, and surface input
 *      and output amplitude + a coarse status so the UI waveform can react.
 *
 * This is the only realtime full-duplex voice transport; the chat
 * Agent Bar owns the only interactive audio path; Agent Chat delegates voice
 * requests here and has no STT/TTS fallback transport.
 */

const INPUT_SAMPLE_RATE = 16000;
const OUTPUT_SAMPLE_RATE = 24000;
// Queue playback slightly AHEAD of the clock rather than at it. Starting a
// buffer at exactly `currentTime` hands the audio thread a start time inside
// the render quantum it is already computing, which it rounds up to the next
// block boundary -- audible as a click on every chunk that arrives late.
// 80ms is well under the gap a listener notices and comfortably more than one
// quantum of jitter.
const OUTPUT_SCHEDULE_LEAD_SECONDS = 0.08;
// Fade applied only where the stream was interrupted, never between
// contiguous chunks. Ramping every chunk would put a tremolo on ordinary
// speech; ramping only after a gap removes the discontinuity that cracks.
const OUTPUT_RESUME_FADE_SECONDS = 0.006;
// This is intentionally a coarse barge-in signal, not speech recognition.
// It needs sustained energy to avoid treating microphone silence/noise as a
// visitor turn and cancelling the idle welcome cue on every connection.
/**
 * Mirrors FRAME_SIZE in public/audio/gemini-live-capture.worklet.js. Only used
 * to derive the real-time frame interval for the outbound pacing guard, so a
 * drift between the two costs pacing accuracy, never correctness.
 */
const CAPTURE_FRAME_SIZE = 2048;
const VISITOR_ACTIVITY_LEVEL = 0.08;
const VISITOR_ACTIVITY_FRAMES = 8;

export type GeminiLiveVoiceState =
  "idle" | "connecting" | "listening" | "thinking" | "speaking";

export type GeminiLiveVoiceEventOptions = {
  sessionId: string | null;
  sourceId: "gemini_live";
  sourceSeq: number;
};

export type GeminiLiveHandlers = {
  onVoiceState?: (
    state: GeminiLiveVoiceState,
    options: GeminiLiveVoiceEventOptions,
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

/**
 * Upper bound on the setup handshake (socket open + runtime_bootstrap + relay
 * run_live + first {"setupComplete": {}}). Generous enough to absorb a cold
 * managed-Vertex start, small enough that a stalled session fails loudly
 * instead of hanging with a dead mic.
 */
const SETUP_COMPLETE_TIMEOUT_MS = 20_000;

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
  /**
   * Guards the setup handshake. The socket can open and accept our
   * runtime_bootstrap yet never return {"setupComplete": {}} (relay stall, a
   * model not enabled for the region, or a cold managed-Vertex start that never
   * finishes). Without this the mic stays gated forever and One silently never
   * "comes alive". On expiry we fail with a diagnosable message + telemetry.
   */
  private setupTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private runtimeCredentialMode: "hushh_managed_vertex" | "byok" =
    "hushh_managed_vertex";
  private runtimeCredential: string | null = null;
  private runtimeCredentialTransport: "developer_api" | "vertex_api_key" =
    "developer_api";
  private runtimeVertexProject: string | null = null;
  private runtimeVertexLocation: string | null = null;
  private playheadTime = 0;
  /** Times the playback queue ran dry mid-turn. Counted so "it sounds broken" has a number. */
  private outputUnderruns = 0;
  private activeSources = new Set<AudioBufferSourceNode>();
  private activeGains = new Map<AudioBufferSourceNode, GainNode>();
  private outputLevelTimer: ReturnType<typeof setInterval> | null = null;
  private state: GeminiLiveVoiceState = "idle";
  private sessionId: string | null = null;
  private sourceSeq = 0;
  /** Snapshot captured at start(), pushed as app_context after setup. */
  private startContext: OneVoiceContextSnapshot | null = null;
  /** Most recent full snapshot; token refreshes must never replace it with {}. */
  private latestContext: OneVoiceContextSnapshot | null = null;
  /**
   * Audio must not reach One until the relay has accepted the initial redacted
   * route and action inventory. Without this barrier a fast first utterance
   * can be evaluated against `context_pending`, which looks like an action is
   * unavailable even though its onboarding control is mounted.
   */
  private initialContextReady = false;
  private initialContextInFlight = false;
  /** Consent token for One's specialist tools; rides only in app_context frames. */
  private consentToken: string | null = null;
  private visitorActivitySent = false;
  /** Real-time pacing guard for outbound audio; see sendRealtimeAudio. */
  private lastRealtimeAudioSentAt = 0;
  /** Frames discarded as backlog. Non-zero means the main thread stalled. */
  private droppedBacklogFrames = 0;
  private consecutiveSpeechFrames = 0;
  private bufferedVisitorSpeechFrames: Uint8Array[] = [];
  /**
   * True while the model's turn is open (audio received since the last
   * turnComplete/interrupted). The Live API closes a model turn with
   * turnComplete, NOT when our playback buffer happens to drain; chunks
   * arrive with network gaps, so an empty queue mid-turn must stay
   * "speaking" instead of flickering back to "listening".
   */
  private modelTurnOpen = false;
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
  private acknowledgedContextIds = new Set<string>();
  private contextAckWaiters = new Map<
    string,
    (result: OneVoiceContextApplyResult) => void
  >();
  private actionConfirmationWaiters = new Map<
    string,
    {
      resolve: (value: OneVoiceActionConfirmation) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

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
    this.visitorActivitySent = false;
    this.lastRealtimeAudioSentAt = 0;
    this.droppedBacklogFrames = 0;
    this.consecutiveSpeechFrames = 0;
    this.bufferedVisitorSpeechFrames = [];
    this.initialContextReady = false;
    this.initialContextInFlight = false;
    this.setState("connecting");

    const context = options?.context ?? null;
    this.startContext = context;
    this.latestContext = context;
    this.consentToken = options?.consentToken ?? null;
    this.runtimeCredentialMode =
      options?.runtimeCredentialMode === "byok"
        ? "byok"
        : "hushh_managed_vertex";
    this.runtimeCredential =
      this.runtimeCredentialMode === "byok"
        ? options?.runtimeCredential?.trim() || null
        : null;
    this.runtimeCredentialTransport =
      options?.runtimeCredentialTransport === "vertex_api_key"
        ? "vertex_api_key"
        : "developer_api";
    this.runtimeVertexProject =
      this.runtimeCredentialTransport === "vertex_api_key"
        ? options?.runtimeVertexProject?.trim() || null
        : null;
    this.runtimeVertexLocation =
      this.runtimeCredentialTransport === "vertex_api_key"
        ? options?.runtimeVertexLocation?.trim() || null
        : null;
    let relayUrl: string;
    try {
      relayUrl =
        options?.relayUrl || (await ApiService.getOneAdkLiveRelayUrl());
    } catch (error) {
      this.fail(
        error instanceof Error ? error.message : "Could not start One voice.",
      );
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
        "NotSupportedError",
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
      "/audio/gemini-live-capture.worklet.js",
    );
    if (this.closed) return;

    this.sourceNode = this.inputContext.createMediaStreamSource(
      this.mediaStream,
    );
    this.captureNode = new AudioWorkletNode(
      this.inputContext,
      "gemini-live-capture",
      { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1 },
    );
    this.sourceNode.connect(this.captureNode);

    this.captureNode.port.onmessage = (event) => {
      const frame = event.data as Float32Array;
      if (
        !this.setupComplete ||
        !this.initialContextReady ||
        !this.ws ||
        this.ws.readyState !== WebSocket.OPEN
      ) {
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
      if (!this.sendVisitorActivityStart(level, pcm)) return;
      this.sendRealtimeAudio(pcm);
    };
  }

  private sendRealtimeAudio(pcm: Uint8Array, paced = true): void {
    if (
      !this.ws ||
      this.ws.readyState !== WebSocket.OPEN ||
      !this.setupComplete
    )
      return;
    // Never stream faster than real time.
    //
    // The capture worklet runs on the audio thread and posts a frame every
    // ~43ms no matter what the main thread is doing. When the main thread
    // stalls -- a dev route compile blocks it for seconds -- those messages
    // queue, then drain in one synchronous burst, and the provider kills the
    // socket with 1011 "client sending data too fast". Steady state is ~23
    // frames/sec, so anything arriving well inside a frame interval is backlog
    // being flushed, not live speech.
    //
    // Dropping is the correct response, not buffering: audio that late is
    // already history in a live conversation, and re-sending it would only
    // push the burst further out. Compared against a single clock so this
    // cannot drift against the worklet's own timebase.
    const frameIntervalMs =
      (CAPTURE_FRAME_SIZE /
        (this.inputContext?.sampleRate || INPUT_SAMPLE_RATE)) *
      1000;
    const now = performance.now();
    // `paced === false` is the speech-onset flush: a bounded, once-per-session
    // catch-up of frames deliberately withheld until the activity signal could
    // precede them. It is intentional and small, unlike a stall backlog, and
    // dropping it would clip the first words of the first sentence.
    // A quarter-interval, not a half: frames legitimately arrive with tens of
    // milliseconds of scheduling jitter, and dropping a merely-early frame
    // punches a gap in the stream that the provider's VAD reads as end of
    // speech -- ending the turn and cutting playback mid-sentence. A stall
    // backlog drains ~0ms apart, so it is still caught with room to spare.
    if (paced && now - this.lastRealtimeAudioSentAt < frameIntervalMs * 0.25) {
      this.droppedBacklogFrames += 1;
      // Surfaced, not merely counted. This counter existed and was read by
      // nothing, so the only observable symptom of a stall was the provider
      // closing the socket with 1011 -- indistinguishable from the pacer not
      // running at all, which made "is the fix live in this browser?"
      // unanswerable. Logged on rising powers of two so a pathological stall
      // is loud while ordinary jitter stays quiet.
      if ((this.droppedBacklogFrames & (this.droppedBacklogFrames - 1)) === 0) {
        console.info(
          `[VOICE_AUDIO] paced out ${this.droppedBacklogFrames} backlog frame(s) ` +
            `this session; the main thread is stalling and would otherwise trip 1011`,
        );
      }
      return;
    }
    this.lastRealtimeAudioSentAt = now;
    this.ws.send(
      JSON.stringify({
        realtimeInput: {
          audio: {
            mimeType: `audio/pcm;rate=${INPUT_SAMPLE_RATE}`,
            data: base64FromBytes(pcm),
          },
        },
      }),
    );
  }

  /**
   * Returns false while an initial speech onset is buffered. That makes the
   * transcript-free activity signal precede every first-turn audio frame on
   * the same socket, instead of relying on raw silence frames as a proxy for
   * visitor intent.
   */
  private sendVisitorActivityStart(level: number, pcm: Uint8Array): boolean {
    if (this.visitorActivitySent) return true;
    if (level >= VISITOR_ACTIVITY_LEVEL) {
      this.consecutiveSpeechFrames += 1;
      this.bufferedVisitorSpeechFrames.push(pcm);
    } else {
      this.consecutiveSpeechFrames = 0;
      this.bufferedVisitorSpeechFrames = [];
    }
    if (this.consecutiveSpeechFrames < VISITOR_ACTIVITY_FRAMES) return false;
    if (
      !this.ws ||
      this.ws.readyState !== WebSocket.OPEN ||
      !this.setupComplete
    )
      return false;
    this.visitorActivitySent = true;
    this.ws.send(JSON.stringify({ type: "voice_activity_start" }));
    for (const bufferedFrame of this.bufferedVisitorSpeechFrames) {
      this.sendRealtimeAudio(bufferedFrame, false);
    }
    this.bufferedVisitorSpeechFrames = [];
    // A visitor who starts speaking should be able to barge in over an
    // already-playing idle cue. The interruption fence drops stale audio.
    if (this.modelTurnOpen || this.state === "speaking") {
      this.interrupt();
    }
    return false;
  }

  private clearSetupTimeout(): void {
    if (this.setupTimeoutTimer !== null) {
      clearTimeout(this.setupTimeoutTimer);
      this.setupTimeoutTimer = null;
    }
  }

  private connectSocket(relayUrl: string): void {
    const ws = new WebSocket(relayUrl);
    this.ws = ws;

    // Arm the handshake watchdog for the whole open -> bootstrap -> setup path.
    // onerror/onclose (which call fail -> stop) clear it if the socket dies
    // first; a socket that opens but never reaches setupComplete trips this.
    this.clearSetupTimeout();
    this.setupTimeoutTimer = setTimeout(() => {
      this.setupTimeoutTimer = null;
      if (this.closed || this.setupComplete) return;
      // Telemetry: distinct, greppable tag so a stalled handshake is
      // diagnosable in browser logs without exposing any credential.
      console.warn(
        "[one-voice] setup handshake timed out before setupComplete",
        {
          elapsedMs: SETUP_COMPLETE_TIMEOUT_MS,
          socketOpen: ws.readyState === WebSocket.OPEN,
        },
      );
      this.fail(
        "Voice took too long to start. This usually clears on a retry; if it keeps happening the voice model may not be enabled for this workspace.",
      );
    }, SETUP_COMPLETE_TIMEOUT_MS);

    // The first post-ticket frame picks the current connection's provider mode.
    // A BYOK credential exists only in this closure and is cleared immediately
    // after `send`; it never enters app_context, a URL, storage, or telemetry.
    ws.onopen = () => {
      const credential = this.runtimeCredential;
      ws.send(
        JSON.stringify({
          type: "runtime_bootstrap",
          runtime_credential_mode: this.runtimeCredentialMode,
          runtime_credential_transport: this.runtimeCredentialTransport,
          ...(this.runtimeCredentialTransport === "vertex_api_key"
            ? {
                runtime_vertex_project: this.runtimeVertexProject,
                runtime_vertex_location: this.runtimeVertexLocation,
              }
            : {}),
          ...(this.runtimeCredentialMode === "byok" && credential
            ? { runtime_credential: credential }
            : {}),
        }),
      );
      this.runtimeCredential = null;
      this.runtimeVertexProject = null;
      this.runtimeVertexLocation = null;
    };

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
      this.clearSetupTimeout();
      // Push the initial app context (screen + governed consent token) now
      // that the session is live; the relay never accepts these in the URL.
      // Do not expose a listening mic until the relay acknowledges it. The
      // server deliberately rejects action tools while that context is pending.
      if (this.startContext) {
        this.beginInitialContextHandshake(this.startContext);
        this.startContext = null;
      } else {
        this.fail("Voice is waiting for the current screen. Please try again.");
      }
      return;
    }

    const contextAck = readRecord(message.appContextAccepted);
    const contextId = readString(contextAck?.contextId);
    if (contextId) {
      this.acknowledgedContextIds.add(contextId);
      const resolve = this.contextAckWaiters.get(contextId);
      if (resolve) {
        this.contextAckWaiters.delete(contextId);
        resolve({ status: "acknowledged", contextId });
      }
      return;
    }

    const confirmationAccepted = readRecord(message.actionConfirmationAccepted);
    const acceptedDirectiveId = readString(confirmationAccepted?.directiveId);
    if (acceptedDirectiveId) {
      const waiter = this.actionConfirmationWaiters.get(acceptedDirectiveId);
      const receipt = readString(confirmationAccepted?.receipt);
      const expiresAt = readString(confirmationAccepted?.expiresAt);
      if (waiter && receipt && expiresAt) {
        clearTimeout(waiter.timer);
        this.actionConfirmationWaiters.delete(acceptedDirectiveId);
        waiter.resolve({ receipt, expiresAt });
      }
      return;
    }

    const confirmationRejected = readRecord(message.actionConfirmationRejected);
    const rejectedDirectiveId = readString(confirmationRejected?.directiveId);
    if (rejectedDirectiveId) {
      const waiter = this.actionConfirmationWaiters.get(rejectedDirectiveId);
      if (waiter) {
        clearTimeout(waiter.timer);
        this.actionConfirmationWaiters.delete(rejectedDirectiveId);
        waiter.reject(
          new Error("This voice action is stale or was already confirmed."),
        );
      }
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
          delegateAgentId: readString(clientDirective.delegateAgentId),
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
      inputTranscription?.text ??
        inputTranscription?.transcript ??
        inputTranscription?.final,
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
        turnId: readString(
          inputTranscription?.turn_id ?? inputTranscription?.turnId,
        ),
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
      outputTranscription?.text ?? outputTranscription?.transcript,
    );
    if (outputText) {
      this.handlers.onEvent?.({
        type: "assistant_text",
        provider: this.provider,
        text: outputText,
        turnId: readString(
          outputTranscription?.turn_id ?? outputTranscription?.turnId,
        ),
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
      (handoffTarget === "chat" ||
        handoffTarget === "consent" ||
        handoffTarget === "route") &&
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
      this.modelTurnOpen = false;
      this.stopPlayback();
      this.setState("listening");
      return;
    }

    if (serverContent.turnComplete) {
      // The interrupted (or finished) model turn is closed; stop fencing and
      // settle back to listening when nothing is queued for playback.
      // When audio is still queued, the last node's onended settles instead.
      this.modelTurnOpen = false;
      this.suppressModelAudio = false;
      if (
        this.activeSources.size === 0 &&
        !this.closed &&
        this.state !== "idle"
      ) {
        this.setState("listening");
        this.resolvePlaybackDrain();
      }
      return;
    }

    const parts = serverContent.modelTurn?.parts ?? [];
    for (const part of parts) {
      const inlineData = part.inlineData as
        { mimeType?: string; data?: string } | undefined;
      if (
        inlineData?.data &&
        (inlineData.mimeType ?? "").startsWith("audio/")
      ) {
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
    if (
      !text ||
      !this.ws ||
      this.ws.readyState !== WebSocket.OPEN ||
      !this.setupComplete
    ) {
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
      }),
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
  private waitForAudioStart(
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const startedAfter = Date.now();
    return new Promise((resolve) => {
      const poll = setInterval(() => {
        if (this.closed || signal?.aborted) {
          clearInterval(poll);
          resolve(false);
          return;
        }
        if (
          this.lastAudioEnqueueAt >= startedAfter ||
          this.activeSources.size > 0
        ) {
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
  private waitForPlaybackDrain(
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
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

  private beginInitialContextHandshake(context: OneVoiceContextSnapshot): void {
    if (
      this.initialContextReady ||
      this.initialContextInFlight ||
      this.closed
    ) {
      return;
    }
    this.initialContextInFlight = true;
    void this.applyContextAndWait(context, { timeoutMs: 1500 }).then(
      (result) => {
        this.initialContextInFlight = false;
        if (this.closed || !this.setupComplete) return;
        if (result.status !== "acknowledged") {
          this.fail(
            "Voice could not confirm the current screen. Please try again.",
          );
          return;
        }
        this.initialContextReady = true;
        this.setState("listening");
      },
    );
  }

  private sendSnapshotContext(context: OneVoiceContextSnapshot): boolean {
    return this.sendAppContext({
      context_id: context.snapshot_id,
      screen: context.route.screen,
      route_family: context.route.route_family,
      // route_family is the path alone, so tabs sharing a path are
      // indistinguishable without this. The relay derives the authoritative
      // screen from both; dropping it here silently pins every tab to the
      // path's default screen.
      route_query: context.route.route_query,
      route_playbook_id: context.route.playbook_id,
      context_revision: `${context.revisions.route}:${context.revisions.ui}`,
      signed_in: context.auth?.signed_in === true,
      persona: context.persona.active,
      voice_state: context.voice.state,
      available_action_ids: context.available_action_ids,
      visible_modules: context.ui.visible_modules,
      visible_control_ids: context.ui.visible_control_ids,
      interaction_layer: context.ui.interaction_layer ?? null,
      pending_settlement: context.pending_settlement,
      cache_freshness: context.cache.freshness,
      vault_ready: context.cache.vault_ready,
      portfolio_ready: context.cache.portfolio_ready,
      onboarding: context.onboarding,
    });
  }

  updateContext(context: OneVoiceContextSnapshot): boolean {
    this.latestContext = context;
    if (!this.setupComplete) {
      // Keep the newest route snapshot while the socket is opening. Otherwise
      // setupComplete would publish the stale screen captured by start().
      this.startContext = context;
      return true;
    }
    if (!this.initialContextReady && !this.initialContextInFlight) {
      this.beginInitialContextHandshake(context);
      return true;
    }
    return this.sendSnapshotContext(context);
  }

  async applyContextAndWait(
    context: OneVoiceContextSnapshot,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<OneVoiceContextApplyResult> {
    // `settleAgentGatewayAction` has already observed the destination route
    // and its mounted publisher. Give that exact stable snapshot a distinct
    // control-plane id and clear only the presentation-level pending marker;
    // otherwise the next eligible journey step can deadlock behind the source
    // action that it is about to report as settled.
    const settledSnapshotId = context.snapshot_id.endsWith(":settled")
      ? context.snapshot_id
      : `${context.snapshot_id}:settled`;
    const settledContext: OneVoiceContextSnapshot = {
      ...context,
      snapshot_id: settledSnapshotId,
      pending_settlement: false,
    };
    const contextId = settledContext.snapshot_id;
    if (!contextId || options.signal?.aborted) {
      return { status: "cancelled", contextId: contextId || null };
    }
    if (this.acknowledgedContextIds.has(contextId)) {
      return { status: "acknowledged", contextId };
    }
    if (!this.updateContext(settledContext)) {
      return { status: this.closed ? "closed" : "cancelled", contextId };
    }

    return new Promise<OneVoiceContextApplyResult>((resolve) => {
      let timeout: ReturnType<typeof setTimeout> | null = null;
      let settled = false;
      let abort: () => void = () => {};
      const finish = (result: OneVoiceContextApplyResult) => {
        if (settled) return;
        settled = true;
        if (timeout !== null) clearTimeout(timeout);
        options.signal?.removeEventListener("abort", abort);
        if (this.contextAckWaiters.get(contextId) === finish) {
          this.contextAckWaiters.delete(contextId);
        }
        resolve(result);
      };
      abort = () => finish({ status: "cancelled", contextId });
      timeout = setTimeout(() => {
        finish({ status: "timeout", contextId });
      }, options.timeoutMs ?? 1200);
      this.contextAckWaiters.set(contextId, finish);
      options.signal?.addEventListener("abort", abort, { once: true });
      if (this.acknowledgedContextIds.has(contextId)) {
        finish({ status: "acknowledged", contextId });
      }
    });
  }

  /**
   * Refresh the consent token mid-call (sign-in / vault unlock while a voice
   * session is already open). Stored locally so it also rides on the next
   * screen-change app_context frame, then pushed immediately so specialist
   * tools stop failing closed without the user having to restart the call.
   */
  updateConsentToken(consentToken: string | null): boolean {
    const trimmed = consentToken?.trim() || null;
    if (trimmed === this.consentToken) return false;
    this.consentToken = trimmed;
    // An authority-only update must retain the current route, inventory, and
    // context revision. Sending `{}` here caused the relay to sanitize an
    // empty screen and wipe a live Location journey mid-call.
    return this.latestContext
      ? this.sendSnapshotContext(this.latestContext)
      : false;
  }

  reportActionSettlement(settlement: OneVoiceActionSettlement): boolean {
    if (
      !this.ws ||
      this.ws.readyState !== WebSocket.OPEN ||
      !this.setupComplete
    ) {
      return false;
    }
    this.ws.send(
      JSON.stringify({
        type: "action_settled",
        actionSettlement: settlement,
      }),
    );
    return true;
  }

  confirmActionDirective(input: {
    directiveId: string;
    actionId: string;
    contextRevision: string;
  }): Promise<OneVoiceActionConfirmation> {
    if (
      !this.ws ||
      this.ws.readyState !== WebSocket.OPEN ||
      !this.setupComplete
    ) {
      return Promise.reject(new Error("Voice confirmation is not connected."));
    }
    if (this.actionConfirmationWaiters.has(input.directiveId)) {
      return Promise.reject(
        new Error("Voice confirmation is already pending."),
      );
    }
    return new Promise<OneVoiceActionConfirmation>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.actionConfirmationWaiters.delete(input.directiveId);
        reject(
          new Error(
            "Voice confirmation timed out. Ask One to propose it again.",
          ),
        );
      }, 5000);
      this.actionConfirmationWaiters.set(input.directiveId, {
        resolve,
        reject,
        timer,
      });
      this.ws?.send(
        JSON.stringify({
          type: "action_confirm",
          actionConfirmation: {
            directiveId: input.directiveId,
            actionId: input.actionId,
            contextRevision: input.contextRevision,
          },
        }),
      );
    });
  }

  /**
   * Send an app_context frame. The governed consent token and timezone ride
   * here (post-connect, never in the URL) so One's specialist tools can act;
   * the relay stores them in session state and they never reach the model.
   */
  private sendAppContext(appContext: Record<string, unknown>): boolean {
    if (
      !this.ws ||
      this.ws.readyState !== WebSocket.OPEN ||
      !this.setupComplete
    ) {
      return false;
    }
    const timezone =
      typeof Intl !== "undefined"
        ? Intl.DateTimeFormat().resolvedOptions().timeZone
        : undefined;
    this.ws.send(
      JSON.stringify({
        type: "app_context",
        ...(typeof appContext.context_id === "string"
          ? { contextId: appContext.context_id }
          : {}),
        appContext: {
          ...appContext,
          // Explicit null clears authority server-side when the vault locks or
          // consent is revoked during an already-open voice session.
          consent_token: this.consentToken,
          ...(timezone ? { timezone } : {}),
        },
      }),
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
      pcmBytes.byteLength,
    );
    const buffer = context.createBuffer(1, frames, OUTPUT_SAMPLE_RATE);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < frames; i += 1) {
      channel[i] = view.getInt16(i * 2, true) / 0x8000;
    }

    const node = context.createBufferSource();
    node.buffer = buffer;
    const gain = context.createGain();
    node.connect(gain);
    gain.connect(context.destination);
    // The playhead falling behind the clock means the queue ran dry and
    // silence has already played. Restarting exactly at `currentTime` -- which
    // is what Math.max did -- lands inside the render quantum the audio thread
    // is already computing, so it begins on the next block boundary instead,
    // and the discontinuity is audible as a click. Reported as speech that
    // "cracks and cuts".
    //
    // Resume slightly ahead of now instead, and fade in over a few
    // milliseconds. Contiguous chunks are untouched: they still butt directly
    // against the previous buffer with no ramp, because ramping every chunk
    // would put a tremolo on ordinary speech.
    const underran = this.playheadTime < context.currentTime;
    if (underran) {
      this.playheadTime = context.currentTime + OUTPUT_SCHEDULE_LEAD_SECONDS;
      this.outputUnderruns += 1;
      if ((this.outputUnderruns & (this.outputUnderruns - 1)) === 0) {
        console.info(
          `[VOICE_AUDIO] output underran ${this.outputUnderruns} time(s) this ` +
            `session; playback queue ran dry and speech will have broken up`,
        );
      }
    }
    const startAt = this.playheadTime;
    if (underran) {
      gain.gain.setValueAtTime(0, startAt);
      gain.gain.linearRampToValueAtTime(
        1,
        startAt + OUTPUT_RESUME_FADE_SECONDS,
      );
    }
    node.start(startAt);
    this.playheadTime = startAt + buffer.duration;
    this.lastAudioEnqueueAt = Date.now();
    this.modelTurnOpen = true;
    this.setState("speaking");
    this.activeSources.add(node);
    this.activeGains.set(node, gain);
    node.onended = () => {
      this.activeSources.delete(node);
      this.activeGains.delete(node);
      if (this.activeSources.size === 0 && !this.closed) {
        if (this.modelTurnOpen) {
          // Transient buffer underrun mid-turn: more chunks are coming
          // (the provider has not sent turnComplete). Stay "speaking".
          return;
        }
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
    const context = this.outputContext;
    const FADE_SECONDS = 0.015;
    for (const node of this.activeSources) {
      try {
        const gain = this.activeGains.get(node);
        if (context && gain) {
          const now = context.currentTime;
          gain.gain.cancelScheduledValues(now);
          gain.gain.setValueAtTime(gain.gain.value, now);
          gain.gain.linearRampToValueAtTime(0, now + FADE_SECONDS);
          node.stop(now + FADE_SECONDS);
        } else {
          node.stop();
        }
      } catch {
        // ignore
      }
    }
    this.activeSources.clear();
    this.activeGains.clear();
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
    this.clearSetupTimeout();
    this.initialContextReady = false;
    this.initialContextInFlight = false;
    this.runtimeCredential = null;
    this.runtimeVertexProject = null;
    this.runtimeVertexLocation = null;
    for (const [contextId, resolve] of this.contextAckWaiters) {
      resolve({ status: "closed", contextId });
    }
    this.contextAckWaiters.clear();
    for (const waiter of this.actionConfirmationWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("Voice session closed before confirmation."));
    }
    this.actionConfirmationWaiters.clear();
    this.acknowledgedContextIds.clear();
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
