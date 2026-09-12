"use client";

import { ApiService } from "@/lib/services/api-service";
import {
  parseLocationOnboardingRunResult,
  type LocationOnboardingRunResultV1,
} from "@/lib/services/one-location-onboarding-run-client";
import {
  parseLocationCircleNameDirective,
  type LocationCircleNameDirectiveV1,
} from "@/lib/services/location-circle-name-interaction-client";
import type { OneVoiceContextSnapshot } from "@/lib/voice/screen-context-builder";
import type {
  LocationCommandNavigationDirectiveV1,
  LocationCommandStatusCardV1,
  OneVoiceActionSettlement,
  OneVoiceActionConfirmation,
  OneVoiceConfirmationMethod,
  OneVoiceContextApplyResult,
  OneVoiceSessionEvent,
} from "@/lib/voice/one-voice-transport";
import type {
  OneVoiceActivationSource,
  OneVoiceTransportHandlers,
  OneVoiceTransportStartOptions,
  RealtimeVoiceTransport,
} from "@/lib/voice/one-voice-transport";
import type {
  OneVoicePcmFrame,
  OneVoiceRealtimeAudioInput,
} from "@/lib/voice/realtime-audio-input";
import {
  BoundedTranscriptBuffer,
  type OneVoiceSpeechAdapter,
  type TranscriptEvent,
} from "@/lib/voice/transcript-events";
import { mapAgentVoiceStatusToOneVoiceState } from "@/lib/voice/voice-ui-state-machine";
import {
  createVoiceActivationId,
  createVoiceTurnId,
  logVoiceMetric,
  type OneVoiceTelemetryMetric,
} from "@/lib/voice/voice-telemetry";
import { emitLocalRuntimeEvent } from "@/lib/voice/local-runtime-observability";

/**
 * Browser client for Gemini Live full-duplex voice.
 *
 * Flow:
 *   1. Open a WebSocket to the backend relay. The first authenticated frame
 *      selects either Hushh-managed Vertex or a turn-local Gemini API key.
 *      The key is immediately cleared and never enters route state, storage,
 *      telemetry, or model context.
 *   2. The relay first acknowledges its authenticated local session, then
 *      announces provider readiness only after Gemini Live itself has yielded
 *      an event. The initial redacted app context is a third, independent
 *      barrier. PCM and the Listening state require all three.
 *   3. Capture mic audio as 16 kHz mono PCM16 and stream it directly to the
 *      relay. iOS supplies those frames through the Capacitor bridge; web
 *      uses getUserMedia + AudioWorklet. Gemini Live owns understanding,
 *      endpointing, transcripts, and dialogue on both platforms.
 *   4. Play back the 24 kHz PCM16 audio Gemini streams down, and surface input
 *      and output amplitude + a coarse status so the UI waveform can react.
 *
 * This is the only realtime full-duplex voice transport. The chat Agent Bar
 * owns the only interactive audio path; Agent Chat delegates voice requests
 * here and has no independent STT/TTS fallback transport.
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
// A real user turn must not leave the voice bar in "Thinking" indefinitely
// when a proxy, WebSocket, or provider stalls after accepting the turn.
const MODEL_REPLY_TIMEOUT_MS = 15_000;
// This is intentionally a coarse barge-in signal, not speech recognition.
// It needs sustained energy to avoid treating microphone silence/noise as a
// visitor turn and cancelling the idle welcome cue on every connection.
const VISITOR_ACTIVITY_LEVEL = 0.08;
const VISITOR_ACTIVITY_FRAMES = 8;
// The first cue is idle-only on the relay. A quiet device fan or room tone can
// otherwise look like speech during that short window and cancel the welcome
// before the owner has said anything. Once the first model audio arrives,
// normal sensitivity resumes for natural barge-in behavior.
const INITIAL_VISITOR_ACTIVITY_LEVEL = 0.14;
// v2 makes Gemini Live's server-side endpoint detector authoritative. A
// client release was the v1 command boundary and must never be accepted by
// this tap-to-command lane.
const LOCATION_COMMAND_PROTOCOL = "one_command_v2";
// A command client and relay must be released together. Keep the remediation
// truthful without exposing the internal Location protocol to someone using
// the app-wide Talk-to-One control.
const COMMAND_SERVICE_VERSION_MISMATCH_MESSAGE =
  "The command service version does not match this app. Please update and try again.";
const LOCATION_COMMAND_MAX_BUFFER_DURATION_MS = 10_000;
/**
 * A browser AudioWorklet control message normally crosses to the audio render
 * thread within one render quantum. Keep this deliberately bounded: if that
 * acknowledgement cannot arrive, we cancel the command instead of letting a
 * stale capture tail route an unverifiable prefix of the person's speech.
 */
const LOCATION_COMMAND_BROWSER_TAIL_DRAIN_TIMEOUT_MS = 750;

type LocationCommandServerResult = {
  result: LocationOnboardingRunResultV1 | null;
  circleNameDirective: LocationCircleNameDirectiveV1 | null;
  navigation: LocationCommandNavigationDirectiveV1 | null;
  statusCard: LocationCommandStatusCardV1 | null;
};

type LocationCommandTurn = {
  turnId: string;
  /** The command stream uses client-owned contiguous sequences, starting at 1. */
  nextSequence: number;
  /** Highest packet actually handed to the relay, not merely queued locally. */
  lastSentSequence: number;
  lastSequence: number;
  beginSent: boolean;
  /** Gemini Live has emitted the authenticated speech-end control frame. */
  endpointed: boolean;
  /**
   * A matching v2 relay has issued a payload-free terminal failure before an
   * endpoint could be established. It may unlock only a retry status, never
   * a card, navigation, or action result.
   */
  terminalFailure: boolean;
  /** v2 has no normal client end; these only represent explicit cancellation. */
  released: boolean;
  cancelled: boolean;
  endSent: boolean;
  finalTranscriptReceived: boolean;
  turnCompleteReceived: boolean;
  relayReady: boolean;
  resultReceived: boolean;
  nativeSequence: number | null;
  nativeTailDraining: boolean;
  /**
   * Browser capture owns its final frame on the AudioWorklet thread. The
   * marker is retained only to detect a capture discontinuity; it is never a
   * command boundary and no normal `location_command_end` is sent.
   */
  browserTailDraining: boolean;
  /** Worklet frame sequence at the start of this physical command tap. */
  browserWorkletStartSequence: number;
  /** Most recent contiguous worklet PCM frame accepted for this command tap. */
  browserWorkletLastSequence: number;
};

type LocationCommandAudioFrame = {
  pcm: Uint8Array;
  sequence: number;
};

type BrowserCapturePcmMessage = {
  type: "pcm";
  frame: Float32Array;
  sequence: number;
};

type BrowserCaptureTailDrainedMessage = {
  type: "location_command_tail_drained";
  turnId: string;
  finalSequence: number;
};

function isBrowserCapturePcmMessage(
  value: unknown,
): value is BrowserCapturePcmMessage {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.type === "pcm" &&
    record.frame instanceof Float32Array &&
    typeof record.sequence === "number" &&
    Number.isSafeInteger(record.sequence) &&
    record.sequence > 0
  );
}

function isBrowserCaptureTailDrainedMessage(
  value: unknown,
): value is BrowserCaptureTailDrainedMessage {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.type === "location_command_tail_drained" &&
    typeof record.turnId === "string" &&
    Boolean(record.turnId.trim()) &&
    typeof record.finalSequence === "number" &&
    Number.isSafeInteger(record.finalSequence) &&
    record.finalSequence >= 0
  );
}

let primedOutputContext: AudioContext | null = null;

function outputAudioContextConstructor(): typeof AudioContext | null {
  if (typeof window === "undefined") return null;
  return (
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext ||
    null
  );
}

/**
 * Creates and resumes the output context while the in-app microphone button
 * still has a user gesture. WKWebView can reject a first audio-context resume
 * that happens later from a WebSocket callback, after Gemini has replied.
 */
export function primeGeminiLiveOutputAudio(): void {
  const AudioCtx = outputAudioContextConstructor();
  if (!AudioCtx) return;
  if (!primedOutputContext || primedOutputContext.state === "closed") {
    primedOutputContext = new AudioCtx({ sampleRate: OUTPUT_SAMPLE_RATE });
  }
  const context = primedOutputContext;
  if (context.state !== "suspended") return;
  console.info("[VOICE_AUDIO] output_context_prime state=suspended");
  void context.resume().then(
    () => {
      console.info(
        `[VOICE_AUDIO] output_context_prime_result state=${context.state}`,
      );
    },
    () => {
      console.info("[VOICE_AUDIO] output_context_prime_result state=suspended");
    },
  );
}

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

function isSpeechAdapterUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || "");
  return [
    "speech_unsupported",
    "speech_on_device_unavailable",
    "speech_locale_unavailable",
    "speech_local_unavailable",
    "speech_local_model_missing",
    "local_runtime_unsupported_browser",
    "local_runtime_unsupported_device",
    "local_runtime_insufficient_memory",
    "local_runtime_insufficient_storage",
    "local_runtime_network_required",
    "local_runtime_download_failed",
    "local_runtime_pack_not_installed",
    "local_runtime_pack_not_compatible",
    "local_runtime_inference_failed",
    "local_asr_entrypoint_unsupported",
    "local_asr_runtime_asset_missing",
  ].some((code) => message.includes(code));
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

/**
 * The relay classifies a mid-call failure and sends `{"sessionEnded": {...}}`
 * before it closes the socket -- but nothing on this side ever read the
 * frame, so a genuine provider outage and a normal hangup produced the
 * identical, silent `stop()`. This is the one place that turns the relay's
 * wire-level reason into something a person can act on.
 */
function describeSessionEndedReason(reason: string, resumable: boolean): string {
  switch (reason) {
    case "provider_unavailable":
      return "Voice is temporarily unavailable. Try again in a moment.";
    case "unknown_tool_call":
      return "One hit a snag with that request. Try again.";
    case "runtime_error":
      return "Something went wrong with the voice connection. Try again.";
    default:
      return resumable
        ? "Voice session ended. Try again in a moment."
        : "Voice session ended unexpectedly. Try again.";
  }
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

/**
 * The command lane intentionally has its own relay handler. It retains the
 * same short-lived opaque ticket, but cannot fall through into the
 * conversational ADK socket merely because an old handler happens to be
 * reachable at the standard path.
 */
function toLocationCommandRelayUrl(standardRelayUrl: string): string {
  const url = new URL(standardRelayUrl);
  if (!url.pathname.endsWith("/api/one/adk/live")) {
    throw new Error("Location command relay URL is invalid.");
  }
  url.pathname = url.pathname.replace(
    /\/api\/one\/adk\/live$/,
    "/api/one/adk/location-command/live",
  );
  return url.toString();
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

/** RMS for already-normalized PCM16 frames from the native bridge. */
function pcm16Rms(buffer: Uint8Array): number {
  if (buffer.byteLength < 2) return 0;
  const view = new DataView(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength - (buffer.byteLength % 2),
  );
  let sum = 0;
  const samples = view.byteLength / 2;
  for (let i = 0; i < samples; i += 1) {
    const sample = view.getInt16(i * 2, true) / 0x8000;
    sum += sample * sample;
  }
  return Math.sqrt(sum / Math.max(1, samples));
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

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value.filter(
        (item): item is string =>
          typeof item === "string" && Boolean(item.trim()),
      ),
    ),
  ).slice(0, 64);
}

function hasExactKeys(
  source: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(source).sort();
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === expected[index])
  );
}

/**
 * The relay's Location result is intentionally not a generic tool directive.
 * Rebuild the existing bounded run-result envelope and pass it through the
 * same strict parser used by the Location HTTP client before it reaches UI.
 */
function parseLocationCommandServerResult(
  source: Record<string, unknown>,
): LocationCommandServerResult {
  const suppliedResult = readRecord(source.result);
  const result = parseLocationOnboardingRunResult(
    suppliedResult ?? {
      schemaVersion: "one.location_onboarding_run_result.v1",
      run: source.run ?? null,
      directive: source.directive ?? null,
      waitingReason: source.waitingReason ?? source.waiting_reason ?? null,
    },
  );
  const navigationSource = readRecord(source.navigation);
  const actionId = readString(source.actionId ?? source.action_id);
  const navigation =
    navigationSource &&
    hasExactKeys(navigationSource, [
      "capabilityId",
      "route",
      "schemaVersion",
      "settlement",
    ]) &&
    navigationSource.schemaVersion ===
      "one.location_navigation_directive.v1" &&
    navigationSource.settlement === "route_settlement_required" &&
    typeof navigationSource.capabilityId === "string" &&
    typeof navigationSource.route === "string" &&
    navigationSource.capabilityId === actionId &&
    /^\/one(?:\/[a-z0-9-]+)*$/u.test(navigationSource.route)
      ? {
          schemaVersion: "one.location_navigation_directive.v1" as const,
          capabilityId: navigationSource.capabilityId,
          route: navigationSource.route,
          settlement: "route_settlement_required" as const,
        }
      : null;
  const statusCardSource = readRecord(source.statusCard);
  let statusCard: LocationCommandStatusCardV1 | null = null;
  if (
    statusCardSource &&
    hasExactKeys(statusCardSource, [
      "actionId",
      "cardId",
      "schemaVersion",
      "settlement",
      "surfaceId",
    ]) &&
    statusCardSource.schemaVersion === "one.location_command_status_card.v1" &&
    statusCardSource.surfaceId === "render.data_card" &&
    statusCardSource.settlement === "verified" &&
    statusCardSource.actionId === actionId &&
    statusCardSource.cardId === "one.location.command.circle_verified.v1" &&
    statusCardSource.actionId === "location.create_circle"
  ) {
    statusCard = {
      schemaVersion: "one.location_command_status_card.v1",
      surfaceId: "render.data_card",
      cardId: "one.location.command.circle_verified.v1",
      actionId: "location.create_circle",
      settlement: "verified",
    };
  } else if (
    statusCardSource &&
    hasExactKeys(statusCardSource, [
      "actionId",
      "cardId",
      "schemaVersion",
      "settlement",
      "surfaceId",
    ]) &&
    statusCardSource.schemaVersion === "one.location_command_status_card.v1" &&
    statusCardSource.surfaceId === "render.data_card" &&
    statusCardSource.settlement === "verified" &&
    statusCardSource.actionId === actionId &&
    statusCardSource.cardId === "one.location.command.location_verified.v1" &&
    statusCardSource.actionId === "workflow.setup.location"
  ) {
    statusCard = {
      schemaVersion: "one.location_command_status_card.v1",
      surfaceId: "render.data_card",
      cardId: "one.location.command.location_verified.v1",
      actionId: "workflow.setup.location",
      settlement: "verified",
    };
  }
  return {
    result,
    circleNameDirective:
      source.outcome === "interaction_required"
        ? parseLocationCircleNameDirective(source.circleNameDirective)
        : null,
    navigation,
    statusCard,
  };
}

/**
 * Upper bound on the setup handshake (socket open + runtime_bootstrap + relay
 * run_live + first {"providerReady": {}}). Generous enough to absorb a cold
 * managed-Vertex start, small enough that a stalled session fails loudly
 * instead of hanging with a dead mic.
 */
const SETUP_COMPLETE_TIMEOUT_MS = 20_000;
/**
 * A WebSocket error event intentionally carries no useful diagnostic in
 * browsers. Give its paired close event a short chance to arrive, because the
 * close code/reason is the only safe signal we can map to an actionable
 * startup error. This is short enough to be imperceptible when a close never
 * arrives (for example, a platform network failure).
 */
const SOCKET_ERROR_CLOSE_GRACE_MS = 100;
/**
 * Retain at most this much microphone audio in RAM while relay, provider, and
 * trusted app-context readiness settle. This is a duration rather than a
 * frame count because the native bridge and browser AudioWorklet intentionally
 * use different frame sizes. It is never persisted, logged, or retained once
 * capture stops.
 */
export const ONE_VOICE_PRE_READY_PCM_BUFFER_DURATION_MS = 10_000;
/** Defensive cap for malformed/native oversized frames in that bounded queue. */
const MAX_PRE_READY_PCM_FRAME_BYTES = 16 * 1024;
const SERVER_GREETING_TEXT = "Hello, how can I help you today?";
const SERVER_GREETING_FOLLOW_UP_WINDOW_MS = 10 * 1000;

function pcmDurationMs(pcm: Uint8Array): number {
  return (pcm.byteLength / 2 / INPUT_SAMPLE_RATE) * 1000;
}

export class GeminiLiveClient implements RealtimeVoiceTransport {
  readonly provider = "gemini_live" as const;
  private handlers: GeminiLiveHandlers;
  private ws: WebSocket | null = null;
  private inputContext: AudioContext | null = null;
  private outputContext: AudioContext | null = null;
  private outputResumePromise: Promise<void> | null = null;
  private mediaStream: MediaStream | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private captureNode: AudioWorkletNode | null = null;
  private closed = false;
  /** Authenticated relay/session construction accepted the control plane. */
  private relayAccepted = false;
  /** The actual Gemini Live target has yielded its first setup event. */
  private providerReady = false;
  /**
   * Legacy alias retained only while cached pre-v2 relay clients drain. New
   * readiness logic never equates it with provider readiness after the relay
   * sent an explicit `relayAccepted` signal.
   */
  private setupComplete = false;
  /**
   * Guards the setup handshake. The socket can open and accept our
   * runtime_bootstrap yet never return {"providerReady": {}} (relay stall, a
   * model not enabled for the region, or a cold managed-Vertex start that never
   * finishes). Without this the mic stays gated forever and One silently never
   * "comes alive". On expiry we fail with a diagnosable message + telemetry.
   */
  private setupTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * WebSocket error events have no reason/code. This bounded fallback lets a
   * following close event provide the safe classified startup error instead.
   */
  private socketErrorFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  /** Bounds a real user turn after it has reached the relay. */
  private modelReplyTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private runtimeCredentialMode: "hushh_managed_vertex" | "byok" =
    "hushh_managed_vertex";
  private runtimeCredential: string | null = null;
  /**
   * The provider's own opaque continuation token. Seeded from `start()`'s
   * options when reconnecting, and replaced every time the provider issues a
   * fresh one (it rotates through a session, not just once). Sent on the next
   * `runtime_bootstrap` this instance makes, and handed off in the `closed`
   * event so a NEW instance -- start() always builds one -- can carry it
   * forward.
   */
  private resumptionHandle: string | null = null;
  /** A Voice Settings persona pick, sent on runtime_bootstrap; null uses the deployment default. */
  private voiceName: string | null = null;
  /**
   * The relay owns the greeting itself. This only lets an authenticated
   * foreground warm session suppress a greeting already delivered earlier in
   * the app session; it is never a user turn and never opens capture.
   */
  private initialGreetingEnabled = true;
  /** Server reads this only as a suppressive meaningful-activity signal. */
  private activationSource: OneVoiceActivationSource = "recovery";
  /** The relay sent one exact fixed greeting control directive this session. */
  private serverGreetingDirectiveReceived = false;
  /** Prevent replay if readiness/control frames arrive more than once. */
  private serverGreetingSpeechRequested = false;
  /** Ensures capture receives one terminal output boundary per directive. */
  private serverGreetingPlaybackSettled = false;
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
  /** Opaque per-start correlation; never derived from a user or route. */
  private activationId: string | null = null;
  /** Server-returned immutable graph revision, never inferred from routes. */
  private graphRevision: string | null = null;
  /** Safe client-side timing anchors; no text/audio values are retained. */
  private sessionStartedAt: number | null = null;
  private modelTurnObservedAt: number | null = null;
  private firstAudioMetricLoggedForTurn = false;
  private sourceSeq = 0;
  /** Snapshot captured at start(), pushed as app_context after setup. */
  private startContext: OneVoiceContextSnapshot | null = null;
  /** Most recent full snapshot; token refreshes must never replace it with {}. */
  private latestContext: OneVoiceContextSnapshot | null = null;
  /**
   * Audio must not reach One until the relay, actual Live provider, and
   * initial redacted route/action inventory have all accepted their distinct
   * readiness steps. Without this barrier a fast first utterance can be
   * evaluated against `context_pending`, or queued into a provider that is not
   * alive yet, both of which look like an unavailable action to the person.
   */
  private initialContextReady = false;
  private initialContextInFlight = false;
  /** One bounded external request waiting for the initial context barrier. */
  private pendingUserText: string | null = null;
  private pendingRealtimeAudioFrames: Uint8Array[] = [];
  private pendingRealtimeAudioDurationMs = 0;
  /**
   * Drain retained pre-ready PCM at its real-time duration. A ten-second
   * buffer must not become a ten-second WebSocket burst when a cold provider
   * finally becomes ready.
   */
  private preReadyAudioDrainTimer: ReturnType<typeof setTimeout> | null = null;
  private preReadyAudioDrainGeneration = 0;
  /** Final adapter transcripts held until the redacted context barrier. */
  private pendingSpeechEvents = new BoundedTranscriptBuffer(8);
  private speechAdapter: OneVoiceSpeechAdapter | null = null;
  /**
   * Primary platform PCM ingress. It is deliberately independent from the
   * legacy transcript adapter: iOS must never wait for Apple Speech before
   * the Live model receives a turn.
   */
  private realtimeAudioInput: OneVoiceRealtimeAudioInput | null = null;
  private audioInputStarted = false;
  private audioInputStartPromise: Promise<boolean> | null = null;
  /** Serializes capture release before a later tap may open it again. */
  private audioInputStopPromise: Promise<void> | null = null;
  /** Invalidates late frames/start completions from an earlier capture arm. */
  private audioInputGeneration = 0;
  private deferAudioInput = false;
  private executableActionIds: string[] | null = null;
  /** Consent token for One's specialist tools; rides only in app_context frames. */
  private consentToken: string | null = null;
  /**
   * The Location command lane is intentionally not a conversational model
   * turn. It owns one tap-to-command input at a time and fences every
   * model/directive result behind the provider endpoint + final transcript.
   */
  private locationCommandMode = false;
  /**
   * The relay negotiates automatic-endpoint/transcribe mode once per authenticated
   * socket. A new physical command tap inherits this control-plane fact; it must not
   * wait for a nonexistent per-turn ready frame before its final result can
   * pass the command fence.
   */
  private locationCommandSessionReady = false;
  private locationCommand: LocationCommandTurn | null = null;
  private locationCommandAudioQueue: LocationCommandAudioFrame[] = [];
  private locationCommandAudioDurationMs = 0;
  private locationCommandDrainTimer: ReturnType<typeof setTimeout> | null =
    null;
  /** Bounded proof wait for the browser AudioWorklet's ordered tail marker. */
  private locationCommandBrowserTailDrainTimer: ReturnType<
    typeof setTimeout
  > | null = null;
  /**
   * Monotonic only for the lifetime of the current browser capture node. It
   * lets the main thread prove that the tail marker follows every worklet PCM
   * message it accepted, rather than treating release as an implicit drain.
   */
  private browserWorkletLastSequence = 0;
  /** Events park until provider speech-end + final transcript + turnComplete. */
  private pendingLocationCommandEvents: OneVoiceSessionEvent[] = [];
  private visitorActivitySent = false;
  private initialGreetingPending = false;
  /** Real-time pacing guard for outbound audio; see sendRealtimeAudio. */
  private lastRealtimeAudioSentAt = 0;
  /** Frames discarded as backlog. Non-zero means the main thread stalled. */
  private droppedBacklogFrames = 0;
  /** Start-to-first-capture timing for the hardware capture SLO. */
  private captureStartedAt: number | null = null;
  private captureMetricLogged = false;
  private consecutiveSpeechFrames = 0;
  private speechOnsetReady = false;
  private bufferedVisitorSpeechFrames: Uint8Array[] = [];
  private bufferedVisitorSpeechDurationMs = 0;
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
  private contextReadyWaiters = new Set<(ready: boolean) => void>();
  private localActionProposalWaiters = new Map<
    string,
    { resolve: (accepted: boolean) => void; timer: ReturnType<typeof setTimeout> }
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

  /**
   * A legacy relay emitted only setupComplete. Treat that as all relay/provider
   * setup only when an explicit relayAccepted frame was never observed. The
   * current v2 relay always sends relayAccepted first, so its compatibility
   * setupComplete frame cannot accidentally unlock audio early.
   */
  private isRelayAccepted(): boolean {
    return this.relayAccepted || this.setupComplete;
  }

  private isProviderReady(): boolean {
    return (
      this.providerReady ||
      (!this.locationCommandMode && !this.relayAccepted && this.setupComplete)
    );
  }

  private isLiveReady(): boolean {
    return (
      this.isRelayAccepted() &&
      this.isProviderReady() &&
      this.initialContextReady
    );
  }

  /**
   * Flush only after relay, provider, and trusted runtime context have each
   * acknowledged their own boundary. This is deliberately called from either
   * order (provider-first or context-first) rather than assuming network
   * timing.
   */
  private completeLiveReadinessIfPossible(): void {
    if (!this.isLiveReady() || this.closed) return;
    for (const resolve of this.contextReadyWaiters) resolve(true);
    this.contextReadyWaiters.clear();
    if (this.locationCommandMode) {
      // Manual Location commands use their own explicit begin/end and ordered
      // PCM queue. Do not flush legacy VAD/audio or create an app-speech
      // greeting/model turn in this text-first mode.
      this.flushLocationCommandBegin();
      this.flushLocationCommandAudio();
      this.flushLocationCommandEnd();
      this.publishListeningIfCaptureIsActive();
      return;
    }
    this.flushPendingSpeechEvents();
    this.flushBufferedSpeechOnset();
    this.flushPendingRealtimeAudio();
    this.flushPendingUserText();
    this.maybeSpeakServerGreeting();
    this.publishListeningIfCaptureIsActive();
  }

  /**
   * Route only the exact server directive through the existing output lane.
   * This is neither `user_text` nor a model-authored greeting: the relay
   * receives a narrow control marker and permits it only after it issued the
   * matching directive on this authenticated socket.
   */
  private maybeSpeakServerGreeting(): void {
    if (
      this.locationCommandMode ||
      !this.serverGreetingDirectiveReceived ||
      this.serverGreetingSpeechRequested ||
      this.serverGreetingPlaybackSettled ||
      !this.isLiveReady() ||
      this.closed
    ) {
      return;
    }
    this.serverGreetingSpeechRequested = true;
    void this.speakText({
      text: SERVER_GREETING_TEXT,
      segmentType: "final",
      controlKind: "fresh_session_greeting",
      onPlaybackSettled: (played) => this.emitServerGreetingPlaybackSettled(played),
    }).catch(() => this.emitServerGreetingPlaybackSettled(false));
  }

  private emitServerGreetingPlaybackSettled(played: boolean): void {
    if (this.serverGreetingPlaybackSettled || this.closed) return;
    this.serverGreetingPlaybackSettled = true;
    const eventOptions = this.nextEventOptions();
    this.handlers.onEvent?.({
      type: "greeting_playback_settled",
      provider: this.provider,
      greeting: {
        kind: "fresh_session",
        text: SERVER_GREETING_TEXT,
        followUpWindowMs: SERVER_GREETING_FOLLOW_UP_WINDOW_MS,
      },
      played,
      sessionId: eventOptions.sessionId,
      sourceId: eventOptions.sourceId,
      sourceSeq: eventOptions.sourceSeq,
    });
  }

  private publishListeningIfCaptureIsActive(): void {
    if (
      this.audioInputStarted &&
      // For command mode, a successful physical capture start is already a
      // truthful Listening state. PCM remains in the bounded RAM queue until
      // relay + provider + trusted context are all ready, so this never means
      // audio crossed the network early.
      (this.isLiveReady() || this.locationCommandMode) &&
      this.state !== "speaking" &&
      this.state !== "thinking"
    ) {
      this.setState("listening");
    }
  }

  /**
   * Queue a real user turn until the socket and the initial redacted app
   * context are ready. Native/Siri request text is never app-composed speech
   * and is held only in this live client instance.
   */
  sendUserText(text: string): boolean {
    const normalized = text.trim().slice(0, 4_000);
    if (!normalized || this.closed) return false;
    this.pendingUserText = normalized;
    this.flushPendingUserText();
    return true;
  }

  waitForContextReady(options: {
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {}): Promise<boolean> {
    // Kept under the original transport name for callers, but a usable
    // context now means the provider is ready too. Otherwise a Siri handoff
    // or foreground-warm tap can claim Listening against a relay that has not
    // actually connected to Gemini Live yet.
    if (this.isLiveReady()) return Promise.resolve(true);
    if (this.closed) return Promise.resolve(false);
    return new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const onAbort = () => finish(false);
      const finish = (ready: boolean) => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        this.contextReadyWaiters.delete(finish);
        resolve(ready);
      };
      this.contextReadyWaiters.add(finish);
      timer = setTimeout(() => finish(false), options.timeoutMs ?? 2_000);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (this.isLiveReady()) finish(true);
    });
  }

  proposeLocalAction(input: {
    actionId: string;
    slots?: Record<string, unknown>;
    contextRevision: string;
    needsConfirmation: boolean;
    trustedActivationRequired?: boolean;
    goalId?: string | null;
  }): Promise<boolean> {
    if (
      !this.ws ||
      this.ws.readyState !== WebSocket.OPEN ||
      !this.isLiveReady()
    ) {
      return Promise.resolve(false);
    }
    const proposalId = `local_${createVoiceTurnId()}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.localActionProposalWaiters.delete(proposalId);
        resolve(false);
      }, 5_000);
      this.localActionProposalWaiters.set(proposalId, { resolve, timer });
      this.ws?.send(
        JSON.stringify({
          type: "action_propose",
          actionProposal: {
            proposalId,
            actionId: input.actionId,
            slots: input.slots || {},
            contextRevision: input.contextRevision,
            needsConfirmation: input.needsConfirmation,
            trustedActivationRequired: input.trustedActivationRequired === true,
            goalId: input.goalId || null,
          },
        }),
      );
    });
  }

  getExecutableActionIds(): readonly string[] | null {
    return this.executableActionIds;
  }

  private flushPendingUserText(): void {
    const text = this.pendingUserText;
    if (
      !text ||
      !this.ws ||
      this.ws.readyState !== WebSocket.OPEN ||
      !this.isLiveReady()
    ) {
      return;
    }
    this.pendingUserText = null;
    this.suppressModelAudio = false;
    this.ws.send(JSON.stringify({ type: "user_text", text }));
    // This intentionally records only length: it establishes that the turn
    // crossed the browser/relay boundary without retaining the user's words.
    console.info(`[VOICE_NET] user_text_sent chars=${text.length}`);
    this.modelTurnObservedAt = performance.now();
    this.firstAudioMetricLoggedForTurn = false;
    this.setState("thinking");
    this.armModelReplyTimeout();
  }

  private emitSpeechTranscript(event: TranscriptEvent): void {
    if (this.closed || !event.text) return;
    const eventOptions = this.nextEventOptions();
    if (event.kind === "final" && this.state === "listening") {
      this.setState("thinking");
    }
    if (event.kind === "partial") {
      this.handlers.onEvent?.({
        type: "transcript_partial",
        provider: this.provider,
        text: event.text,
        confidence: event.confidence ?? null,
        transcriptProvider: event.provider,
        onDevice: event.onDevice,
        sessionId: eventOptions.sessionId,
        sourceId: eventOptions.sourceId,
        sourceSeq: eventOptions.sourceSeq,
      });
      return;
    }
    if (event.kind !== "final") return;
    this.handlers.onEvent?.({
      type: "transcript_final",
      provider: this.provider,
      text: event.text,
      confidence: event.confidence ?? null,
      source: "input",
      transcriptProvider: event.provider,
      onDevice: event.onDevice,
      sessionId: eventOptions.sessionId,
      sourceId: eventOptions.sourceId,
      sourceSeq: eventOptions.sourceSeq,
    });
  }

  private handleSpeechAdapterEvent(event: TranscriptEvent): void {
    if (this.closed) return;
    if (!this.captureMetricLogged) {
      this.captureMetricLogged = true;
      this.logSessionMilestone(
        "time_to_capture_ms",
        performance.now() - (this.captureStartedAt ?? performance.now()),
        {
          speech_provider: event.provider,
          on_device: event.onDevice,
        },
      );
    }
    if (event.kind === "error") {
      this.fail("Speech input failed. Please try again.");
      return;
    }
    if (event.kind === "end") return;
    if (event.kind === "final" && !this.isLiveReady()) {
      this.pendingSpeechEvents.push(event);
      return;
    }
    this.emitSpeechTranscript(event);
  }

  private flushPendingSpeechEvents(): void {
    for (const event of this.pendingSpeechEvents.drain()) {
      this.emitSpeechTranscript(event);
    }
  }

  /**
   * Append one frame to a bounded RAM-only PCM queue and evict the oldest
   * audio by sample duration, not by platform-specific callback count.
   */
  private appendPreReadyPcm(
    frames: Uint8Array[],
    durationMs: number,
    pcm: Uint8Array,
  ): number {
    if (pcm.byteLength > MAX_PRE_READY_PCM_FRAME_BYTES) return durationMs;
    frames.push(pcm);
    let nextDurationMs = durationMs + pcmDurationMs(pcm);
    while (
      nextDurationMs > ONE_VOICE_PRE_READY_PCM_BUFFER_DURATION_MS &&
      frames.length > 1
    ) {
      const evicted = frames.shift();
      if (evicted) nextDurationMs -= pcmDurationMs(evicted);
    }
    return nextDurationMs;
  }

  private enqueueRealtimeAudio(pcm: Uint8Array): void {
    this.pendingRealtimeAudioDurationMs = this.appendPreReadyPcm(
      this.pendingRealtimeAudioFrames,
      this.pendingRealtimeAudioDurationMs,
      pcm,
    );
  }

  private enqueueVisitorSpeechFrame(pcm: Uint8Array): void {
    this.bufferedVisitorSpeechDurationMs = this.appendPreReadyPcm(
      this.bufferedVisitorSpeechFrames,
      this.bufferedVisitorSpeechDurationMs,
      pcm,
    );
  }

  private clearPreReadyAudioBuffers(): void {
    this.preReadyAudioDrainGeneration += 1;
    if (this.preReadyAudioDrainTimer) {
      clearTimeout(this.preReadyAudioDrainTimer);
      this.preReadyAudioDrainTimer = null;
    }
    this.pendingRealtimeAudioFrames = [];
    this.pendingRealtimeAudioDurationMs = 0;
    this.bufferedVisitorSpeechFrames = [];
    this.bufferedVisitorSpeechDurationMs = 0;
  }

  /**
   * Release one retained frame at a time. This preserves the first utterance
   * after a slow warm-up without turning it into an unsafe provider burst.
   * Fresh frames join this queue until it catches up, so their order remains
   * stable across the readiness boundary.
   */
  private flushPendingRealtimeAudio(): void {
    if (
      this.preReadyAudioDrainTimer ||
      !this.isLiveReady() ||
      this.pendingRealtimeAudioFrames.length === 0
    ) {
      return;
    }
    const pcm = this.pendingRealtimeAudioFrames.shift();
    if (!pcm) return;
    this.pendingRealtimeAudioDurationMs = Math.max(
      0,
      this.pendingRealtimeAudioDurationMs - pcmDurationMs(pcm),
    );
    this.sendRealtimeAudio(pcm, false);
    if (this.pendingRealtimeAudioFrames.length === 0 || this.closed) return;

    const drainGeneration = this.preReadyAudioDrainGeneration;
    this.preReadyAudioDrainTimer = setTimeout(() => {
      this.preReadyAudioDrainTimer = null;
      if (drainGeneration !== this.preReadyAudioDrainGeneration || this.closed) {
        return;
      }
      this.flushPendingRealtimeAudio();
    }, Math.max(1, pcmDurationMs(pcm)));
  }

  /** Deliver a ready frame in order behind any retained cold-start audio. */
  private sendOrQueueRealtimeAudio(pcm: Uint8Array): void {
    if (
      this.preReadyAudioDrainTimer ||
      this.pendingRealtimeAudioFrames.length > 0
    ) {
      this.enqueueRealtimeAudio(pcm);
      this.flushPendingRealtimeAudio();
      return;
    }
    this.sendRealtimeAudio(pcm);
  }

  /**
   * The activity control message must precede the buffered first frames on the
   * same socket. Move them into the shared ordered delivery queue only after
   * that control boundary has been accepted locally.
   */
  private flushBufferedVisitorSpeech(): void {
    for (const pcm of this.bufferedVisitorSpeechFrames) {
      this.enqueueRealtimeAudio(pcm);
    }
    this.bufferedVisitorSpeechFrames = [];
    this.bufferedVisitorSpeechDurationMs = 0;
    this.flushPendingRealtimeAudio();
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

  /**
   * Emit a timing/outcome-only client milestone. The opaque live session id
   * lets operators correlate browser and relay stages without storing any
   * transcript, audio, entity, slot, or credential value.
   */
  private logSessionMilestone(
    metric: OneVoiceTelemetryMetric,
    value: number,
    tags: Record<string, unknown> = {},
  ): void {
    const context = this.latestContext;
    logVoiceMetric({
      metric,
      value: Math.max(0, value),
      turnId: createVoiceTurnId(),
      correlation: {
        activation_id: this.activationId,
        voice_session_id: this.sessionId,
        context_revision: context
          ? `${context.revisions.route}:${context.revisions.ui}`
          : null,
        graph_revision: this.graphRevision,
      },
      tags: {
        provider: this.provider,
        activation_source: this.activationSource,
        ...tags,
      },
    });
  }

  async start(options?: OneVoiceTransportStartOptions): Promise<void> {
    if (this.ws) return;
    // Capture timing begins on the actual microphone arm, not on a foreground
    // socket warm-up. That makes time_to_capture_ms a real hardware metric.
    this.captureStartedAt = null;
    this.captureMetricLogged = false;
    this.sessionId = createGeminiLiveSessionId();
    this.activationId = createVoiceActivationId();
    this.graphRevision = null;
    this.sessionStartedAt = performance.now();
    this.modelTurnObservedAt = null;
    this.firstAudioMetricLoggedForTurn = false;
    this.sourceSeq = 0;
    this.visitorActivitySent = false;
    this.initialGreetingPending = true;
    this.lastRealtimeAudioSentAt = 0;
    this.droppedBacklogFrames = 0;
    this.consecutiveSpeechFrames = 0;
    this.speechOnsetReady = false;
    this.clearPreReadyAudioBuffers();
    this.relayAccepted = false;
    this.providerReady = false;
    this.setupComplete = false;
    this.initialContextReady = false;
    this.initialContextInFlight = false;
    this.pendingSpeechEvents.clear();
    this.serverGreetingDirectiveReceived = false;
    this.serverGreetingSpeechRequested = false;
    this.serverGreetingPlaybackSettled = false;
    this.speechAdapter = options?.speechAdapter ?? null;
    this.realtimeAudioInput = options?.realtimeAudioInput ?? null;
    this.deferAudioInput = options?.deferAudioInput === true;
    this.locationCommandMode = options?.locationCommandMode === true;
    this.locationCommandSessionReady = false;
    // `beginInputTurn()` may be called immediately after construction, before
    // `start()`. Preserve that pending turn, but discard any prior session's
    // buffered PCM/directives on a fresh start.
    this.clearLocationCommandBuffers();
    this.pendingLocationCommandEvents = [];
    this.audioInputStarted = false;
    this.audioInputStartPromise = null;
    this.audioInputStopPromise = null;
    this.audioInputGeneration = 0;
    // A command tap is a single, natural speech boundary: the person should
    // see Listening immediately rather than an indeterminate connection
    // label.  PCM is still held locally until all three relay readiness facts
    // are true, and an actual hardware/relay failure replaces this state.
    this.setState(this.locationCommandMode ? "listening" : "connecting");
    // A normal in-app start is called directly from the microphone tap. This
    // is a second chance to prime if the caller did not do it at the click
    // boundary (for example an external invocation).
    primeGeminiLiveOutputAudio();

    const context = options?.context ?? null;
    this.startContext = context;
    this.latestContext = context;
    this.consentToken = options?.consentToken ?? null;
    this.resumptionHandle = options?.resumptionHandle?.trim() || null;
    this.voiceName = options?.voiceName?.trim() || null;
    this.initialGreetingEnabled = options?.initialGreetingEnabled !== false;
    this.activationSource = options?.activationSource ?? "recovery";
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
    if (!this.deferAudioInput && !(await this.startAudioInput())) return;

    if (this.closed) return;

    let relayUrl: string;
    try {
      const standardRelayUrl =
        options?.relayUrl ||
        (options?.relayUrlPromise
          ? await options.relayUrlPromise
          : await ApiService.getOneAdkLiveRelayUrl());
      relayUrl = this.locationCommandMode
        ? toLocationCommandRelayUrl(standardRelayUrl)
        : standardRelayUrl;
    } catch (error) {
      this.fail(
        error instanceof Error ? error.message : "Could not start One voice.",
      );
      return;
    }

    if (this.closed) return;
    this.connectSocket(relayUrl);
  }

  /**
   * Starts hardware capture after a normal tap, or after a foreground-warmed
   * Live socket has already authenticated. The latter preserves the explicit
   * privacy boundary: foregrounding can warm server work, never the mic.
   */
  async startAudioInput(): Promise<boolean> {
    if (this.closed) return false;
    if (this.audioInputStarted) return true;
    if (this.audioInputStartPromise) return this.audioInputStartPromise;

    // A follow-up timeout or app lifecycle event can release capture just as
    // the person taps again. Wait for that release so two platform capture
    // sources never briefly own the microphone at once.
    if (this.audioInputStopPromise) {
      await this.audioInputStopPromise;
      if (this.closed) return false;
      if (this.audioInputStarted) return true;
      if (this.audioInputStartPromise) return this.audioInputStartPromise;
    }

    const inputGeneration = ++this.audioInputGeneration;
    this.captureStartedAt = performance.now();
    this.captureMetricLogged = false;
    const start = async (): Promise<boolean> => {
      try {
        let activeInput: "realtime" | "speech" | "browser" = "browser";
        let activeRealtimeAudioInput: OneVoiceRealtimeAudioInput | null = null;
        let activeSpeechAdapter: OneVoiceSpeechAdapter | null = null;
        if (this.realtimeAudioInput) {
          activeInput = "realtime";
          const input = this.realtimeAudioInput;
          activeRealtimeAudioInput = input;
          const sessionId = this.sessionId;
          if (!sessionId) throw new Error("voice_capture_session_missing");
          await input.start({
            sessionId,
            // Command v2 starts capture on the actual Talk to One tap. Gemini
            // Live, not an iOS/native manual turn, owns speech endpointing.
            // This preserves quiet first words without sending any pre-tap
            // standby audio across the bridge.
            requiresExplicitInputTurn: false,
            onFrame: (frame) => {
              if (inputGeneration !== this.audioInputGeneration) return;
              this.handleRealtimePcmFrame(frame);
            },
            onState: (event) => {
              if (inputGeneration !== this.audioInputGeneration) return;
              this.handleRealtimeAudioInputState(event);
            },
          });
        } else if (this.speechAdapter) {
          activeInput = "speech";
          // Compatibility only. New iOS sessions use realtimeAudioInput and
          // never reach this Apple/Fluid transcript gate.
          const adapter = this.speechAdapter;
          activeSpeechAdapter = adapter;
          adapter.setCallbacks({
            onEvent: (event) => {
              if (inputGeneration !== this.audioInputGeneration) return;
              this.handleSpeechAdapterEvent(event);
            },
          });
          try {
            await adapter.start({
              sessionId: this.sessionId ?? undefined,
              onDevice: true,
              allowNetwork: false,
            });
          } catch (error) {
            if (!isSpeechAdapterUnavailable(error)) throw error;
            emitLocalRuntimeEvent({
              event: "cloud_fallback_triggered",
              provider: adapter.provider,
              reason:
                error instanceof Error
                  ? error.message
                  : "speech_adapter_unavailable",
            });
            await adapter.cancel().catch(() => undefined);
            this.speechAdapter = null;
            activeSpeechAdapter = null;
            activeInput = "browser";
            await this.openMicrophone(inputGeneration);
          }
        } else {
          await this.openMicrophone(inputGeneration);
        }
        if (this.closed || inputGeneration !== this.audioInputGeneration) {
          // start() may resolve after a background/timeout stop has already
          // invalidated this arm. Release just the source we opened and leave
          // the warm relay and output context intact.
          // stopAudioInput() owns that release after it has awaited this
          // promise, avoiding a duplicate native stop while the same capture
          // bridge is unwinding.
          if (this.audioInputStopPromise) return false;
          if (activeInput === "realtime") {
            await this.stopRealtimeAudioInput(activeRealtimeAudioInput);
          } else if (activeInput === "speech") {
            await this.stopSpeechAdapterInput(activeSpeechAdapter);
          } else {
            await this.stopBrowserAudioInput();
          }
          return false;
        }
        this.audioInputStarted = true;
        // Command mode already shows Listening from the physical tap so a
        // person can speak naturally into the bounded onset buffer. PCM still
        // remains gated by complete relay/provider/context readiness.
        this.publishListeningIfCaptureIsActive();
        return true;
      } catch (error) {
        this.fail(describeMicError(error));
        return false;
      }
    };
    this.audioInputStartPromise = start().finally(() => {
      this.audioInputStartPromise = null;
    });
    return this.audioInputStartPromise;
  }

  /**
   * Releases only the live microphone/PCM source. The relay socket, accepted
   * context, and output context deliberately stay warm so a later tap can
   * re-arm capture without reconnecting or replaying product context.
   */
  async stopAudioInput(): Promise<void> {
    if (this.audioInputStopPromise) return this.audioInputStopPromise;

    const startPromise = this.audioInputStartPromise;
    const hasBrowserCapture = Boolean(
      this.captureNode ||
        this.sourceNode ||
        this.mediaStream ||
        this.inputContext,
    );
    if (!this.audioInputStarted && !startPromise && !hasBrowserCapture) return;

    // Invalidate callbacks synchronously before the platform stop promise
    // resolves. A queued native bridge frame or AudioWorklet message must not
    // be sent after the privacy boundary has closed.
    this.audioInputGeneration += 1;
    this.clearAudioInputState();

    const realtimeAudioInput = this.realtimeAudioInput;
    const speechAdapter = this.speechAdapter;
    const stop = async () => {
      // Let a start already in flight finish its local cleanup first; it sees
      // the generation change above and returns false rather than re-arming.
      await startPromise?.catch(() => undefined);
      if (realtimeAudioInput) {
        await this.stopRealtimeAudioInput(realtimeAudioInput);
      } else if (speechAdapter) {
        await this.stopSpeechAdapterInput(speechAdapter);
      } else {
        await this.stopBrowserAudioInput();
      }
    };
    this.audioInputStopPromise = stop().finally(() => {
      this.audioInputStopPromise = null;
    });
    return this.audioInputStopPromise;
  }

  private clearAudioInputState(): void {
    this.audioInputStarted = false;
    this.captureStartedAt = null;
    this.captureMetricLogged = false;
    this.clearPreReadyAudioBuffers();
    this.pendingSpeechEvents.clear();
    this.lastRealtimeAudioSentAt = 0;
    this.consecutiveSpeechFrames = 0;
    this.speechOnsetReady = false;
    this.visitorActivitySent = false;
    this.handlers.onInputLevel?.(0);
    this.handlers.onEvent?.({
      type: "input_level",
      provider: this.provider,
      level: 0,
    });
  }

  /** Use the terminal cancel path only if ordinary capture release fails. */
  private async stopRealtimeAudioInput(
    input: OneVoiceRealtimeAudioInput | null,
  ): Promise<void> {
    if (!input) return;
    try {
      await input.stop();
    } catch {
      await input.cancel?.().catch(() => undefined);
    }
  }

  /** Legacy transcript adapters retain the same privacy fallback. */
  private async stopSpeechAdapterInput(
    adapter: OneVoiceSpeechAdapter | null,
  ): Promise<void> {
    if (!adapter) return;
    try {
      await adapter.stop();
    } catch {
      await adapter.cancel().catch(() => undefined);
    }
  }

  /**
   * Replay a user-gesture resume against this session's own output context.
   * A foreground greeting may have claimed the globally primed context before
   * WKWebView accepted a gesture, so priming a new global context on a later
   * tap is not enough to make this already-warm transport audible.
   *
   * This is output-only: it deliberately does not call startAudioInput() or
   * touch the microphone/PCM capture path.
   */
  resumeOutputForUserGesture(): void {
    if (this.closed) return;
    try {
      this.resumeOutputContext(this.ensureOutputContext(), true);
    } catch {
      // Browser output support is optional. A failed resume is retried at the
      // next model PCM frame and must never interfere with the mic tap.
    }
  }

  /**
   * A physical tap may claim a foreground-warm transport while its fixed
   * server greeting is still waiting for audio or draining. Fence that output
   * before PCM begins so local capture cannot hear One's own welcome. The
   * directive is already server-authorized; cancelling it neither creates a
   * user turn nor changes greeting eligibility.
   */
  cancelGreetingOutput(): void {
    if (
      !this.serverGreetingDirectiveReceived ||
      this.serverGreetingPlaybackSettled
    ) {
      return;
    }
    // Mark settled without publishing a capture-arm event. A late playback
    // callback then becomes a no-op, and an unsent control directive cannot
    // be emitted if readiness completes after this person-originated tap.
    this.serverGreetingPlaybackSettled = true;
    if (this.serverGreetingSpeechRequested) {
      this.interrupt();
    }
  }

  isAudioInputActive(): boolean {
    return this.audioInputStarted;
  }

  /**
   * Claim one tap-to-command turn before microphone frames are admitted.
   * The physical tap opens capture; Gemini Live automatic endpointing closes
   * it. This deliberately bypasses the legacy RMS admission gate so quiet
   * first words are retained without inventing a client-side speech end.
   */
  beginInputTurn(input: { turnId: string }): boolean {
    const turnId = input.turnId.trim();
    if (!turnId || this.closed) return false;
    // A relay decides command/transcribe mode at runtime_bootstrap. Never
    // retrofit a command onto an already-open conversational socket.
    if (this.ws && !this.locationCommandMode) return false;
    const existing = this.locationCommand;
    if (
      existing &&
      existing.turnId !== turnId &&
      !existing.endSent
    ) {
      return false;
    }
    if (existing?.turnId === turnId) return true;

    this.locationCommandMode = true;
    // A completed command releases capture asynchronously. A rapid next tap
    // may arrive while that release promise is still unwinding;
    // `startAudioInput()` will wait and create a fresh worklet, whose sequence
    // starts at one. Seed the new command from that fresh boundary rather than
    // the previous node's opaque counter.
    if (!this.captureNode || this.audioInputStopPromise) {
      this.browserWorkletLastSequence = 0;
    }
    this.clearLocationCommandBuffers();
    this.pendingLocationCommandEvents = [];
    this.locationCommand = {
      turnId,
      nextSequence: 1,
      lastSentSequence: 0,
      lastSequence: 0,
      beginSent: false,
      endpointed: false,
      terminalFailure: false,
      released: false,
      cancelled: false,
      endSent: false,
      finalTranscriptReceived: false,
      turnCompleteReceived: false,
      relayReady: this.locationCommandSessionReady,
      resultReceived: false,
      nativeSequence: null,
      nativeTailDraining: false,
      browserTailDraining: false,
      browserWorkletStartSequence: this.browserWorkletLastSequence,
      browserWorkletLastSequence: this.browserWorkletLastSequence,
    };
    // Command mode has no conversational response lane. Fence a late model
    // utterance from the earlier session before the new command begins.
    this.suppressModelAudio = true;
    this.stopPlayback();
    this.flushLocationCommandBegin();
    return true;
  }

  /**
   * Explicitly cancel a tap-to-command turn.
   *
   * Normal success never calls this method: the server emits an authenticated
   * ``speech_ended`` frame once Gemini Live has found the utterance boundary.
   * Keeping cancel as the only client terminal control prevents a quick tap
   * from routing a prefix while a person is still speaking.
   */
  endInputTurn(input: {
    turnId: string;
    finalSequence?: number;
    cancelled?: boolean;
  }): boolean {
    const command = this.locationCommand;
    if (
      !command ||
      command.turnId !== input.turnId ||
      command.endSent ||
      input.cancelled !== true
    ) {
      return false;
    }
    command.released = true;
    command.cancelled = true;
    // No queued prefix may be promoted into an action after the person
    // cancels. Name the last relay-accepted sequence only for diagnostics.
    command.lastSequence = command.lastSentSequence;
    this.clearLocationCommandBuffers();
    this.flushLocationCommandEnd();
    void this.stopAudioInput();
    return true;
  }

  /**
   * Ask the browser AudioWorklet to flush its partial render buffer and then
   * emit an ordered tail marker. `MessagePort` preserves order for messages
   * emitted by the worklet, so every PCM message before this marker has passed
   * through our main-thread handler before `handleBrowser...TailDrained()` can
   * admit the terminal relay boundary.
   */
  private beginBrowserLocationCommandTailDrain(
    command: LocationCommandTurn,
  ): "started" | "not_required" | "unavailable" {
    // Native is intentionally unchanged: its bridge owns a stronger explicit
    // tail contract above. Speech adapters likewise are not the browser
    // AudioWorklet path addressed by this command-mode guard.
    if (this.realtimeAudioInput || this.speechAdapter || !this.captureNode) {
      return "not_required";
    }
    const port = this.captureNode.port;
    if (!port || typeof port.postMessage !== "function") {
      return "unavailable";
    }
    command.browserTailDraining = true;
    this.clearLocationCommandBrowserTailDrainTimer();
    try {
      port.postMessage({
        type: "location_command_tail_drain",
        turnId: command.turnId,
      });
    } catch {
      command.browserTailDraining = false;
      return "unavailable";
    }
    this.locationCommandBrowserTailDrainTimer = setTimeout(() => {
      if (
        this.locationCommand?.turnId !== command.turnId ||
        !command.browserTailDraining
      ) {
        return;
      }
      command.browserTailDraining = false;
      this.locationCommandBrowserTailDrainTimer = null;
      // A missing worklet tail marker means this browser cannot prove that the
      // final pre-release PCM crossed the capture boundary. This is a visible
      // retry, never a normal transcript/action request.
      this.cancelLocationCommandForRetry(
        command,
        "Voice input was interrupted. Tap Talk to One and try again.",
      );
      void this.stopAudioInput();
    }, LOCATION_COMMAND_BROWSER_TAIL_DRAIN_TIMEOUT_MS);
    return "started";
  }

  private clearLocationCommandBrowserTailDrainTimer(): void {
    if (this.locationCommandBrowserTailDrainTimer !== null) {
      clearTimeout(this.locationCommandBrowserTailDrainTimer);
      this.locationCommandBrowserTailDrainTimer = null;
    }
  }

  /**
   * Accept only the tail marker for the active physical command tap. The worklet's
   * final sequence must exactly match the last contiguous worklet PCM message
   * observed on the main thread; otherwise a browser message was lost or a
   * stale capture node tried to close this turn.
   */
  private handleBrowserLocationCommandTailDrained(
    message: BrowserCaptureTailDrainedMessage,
  ): void {
    const command = this.locationCommand;
    if (
      !command ||
      !command.browserTailDraining ||
      message.turnId !== command.turnId
    ) {
      return;
    }
    this.clearLocationCommandBrowserTailDrainTimer();
    if (
      message.finalSequence !== command.browserWorkletLastSequence ||
      message.finalSequence < command.browserWorkletStartSequence
    ) {
      command.browserTailDraining = false;
      this.cancelLocationCommandForRetry(
        command,
        "Voice input was interrupted. Tap Talk to One and try again.",
      );
      void this.stopAudioInput();
      return;
    }
    command.browserTailDraining = false;
    this.flushLocationCommandAudio();
    this.flushLocationCommandEnd();
  }

  private clearLocationCommandBuffers(): void {
    if (this.locationCommandDrainTimer) {
      clearTimeout(this.locationCommandDrainTimer);
      this.locationCommandDrainTimer = null;
    }
    this.clearLocationCommandBrowserTailDrainTimer();
    this.locationCommandAudioQueue = [];
    this.locationCommandAudioDurationMs = 0;
  }

  /**
   * A command that cannot preserve every captured PCM frame is never routed.
   * Keep its cancelled terminal frame pending until the command session
   * becomes ready, rather than leaving the pill in Transcribing forever when
   * readiness arrives after a local buffer/sequence failure.
   */
  private cancelLocationCommandForRetry(
    command: LocationCommandTurn,
    message: string,
  ): void {
    if (command.endSent) return;
    command.cancelled = true;
    command.released = true;
    command.browserTailDraining = false;
    // A local queue may contain sequences that never crossed the relay. The
    // cancelled boundary names only the contiguous prefix actually sent;
    // `0` correctly means no PCM was delivered at all.
    command.lastSequence = command.lastSentSequence;
    this.clearLocationCommandBuffers();
    const eventOptions = this.nextEventOptions();
    this.handlers.onEvent?.({
      type: "error",
      provider: this.provider,
      message,
      sessionId: eventOptions.sessionId,
      sourceId: eventOptions.sourceId,
      sourceSeq: eventOptions.sourceSeq,
    });
    // When ready now, this emits begin + a cancelled end. When readiness is
    // delayed, both flush methods are re-run from the session-ready handler.
    this.flushLocationCommandEnd();
  }

  private flushLocationCommandBegin(): void {
    const command = this.locationCommand;
    if (
      !command ||
      command.beginSent ||
      this.closed ||
      !this.ws ||
      this.ws.readyState !== WebSocket.OPEN ||
      !this.isLiveReady() ||
      !this.locationCommandSessionReady
    ) {
      return;
    }
    command.beginSent = true;
    this.ws.send(
      JSON.stringify({
        type: "location_command_begin",
        protocolVersion: LOCATION_COMMAND_PROTOCOL,
        turnId: command.turnId,
        startSequence: 1,
      }),
    );
  }

  private queueLocationCommandAudio(pcm: Uint8Array): void {
    const command = this.locationCommand;
    if (
      !command ||
      (command.endpointed || command.released)
    ) {
      return;
    }
    if (pcm.byteLength > MAX_PRE_READY_PCM_FRAME_BYTES) {
      this.cancelLocationCommandForRetry(
        command,
        "Voice input was interrupted. Tap Talk to One and try again.",
      );
      return;
    }
    const durationMs = pcmDurationMs(pcm);
    if (
      this.locationCommandAudioDurationMs + durationMs >
      LOCATION_COMMAND_MAX_BUFFER_DURATION_MS
    ) {
      // A command which cannot be delivered intact is never routed from a
      // truncated prefix. The terminal cancelled frame is visible as a retry,
      // not a silent dropped-word failure.
      this.cancelLocationCommandForRetry(
        command,
        "Voice input was too long to send safely. Tap Talk to One and try again.",
      );
      return;
    }
    const sequence = command.nextSequence;
    command.nextSequence += 1;
    command.lastSequence = sequence;
    this.locationCommandAudioQueue.push({ pcm, sequence });
    this.locationCommandAudioDurationMs += durationMs;
    this.flushLocationCommandAudio();
  }

  /** Duration-paced, ordered command drain. No command PCM is discarded. */
  private flushLocationCommandAudio(): void {
    const command = this.locationCommand;
    if (
      !command ||
      this.locationCommandDrainTimer ||
      this.closed ||
      !this.ws ||
      this.ws.readyState !== WebSocket.OPEN ||
      !this.isLiveReady()
    ) {
      return;
    }
    this.flushLocationCommandBegin();
    if (!command.beginSent) return;
    const frame = this.locationCommandAudioQueue.shift();
    if (!frame) {
      this.flushLocationCommandEnd();
      return;
    }
    this.locationCommandAudioDurationMs = Math.max(
      0,
      this.locationCommandAudioDurationMs - pcmDurationMs(frame.pcm),
    );
    this.ws.send(
      JSON.stringify({
        realtimeInput: {
          audio: {
            mimeType: `audio/pcm;rate=${INPUT_SAMPLE_RATE}`,
            data: base64FromBytes(frame.pcm),
          },
          locationCommand: {
            turnId: command.turnId,
            sequence: frame.sequence,
          },
        },
      }),
    );
    command.lastSentSequence = frame.sequence;
    this.locationCommandDrainTimer = setTimeout(() => {
      this.locationCommandDrainTimer = null;
      this.flushLocationCommandAudio();
    }, Math.max(1, pcmDurationMs(frame.pcm)));
  }

  private flushLocationCommandEnd(): void {
    const command = this.locationCommand;
    if (
      !command ||
      !command.cancelled ||
      command.endSent ||
      this.closed ||
      !this.ws ||
      this.ws.readyState !== WebSocket.OPEN ||
      !this.isLiveReady() ||
      !this.locationCommandSessionReady
    ) {
      return;
    }
    this.flushLocationCommandBegin();
    if (!command.beginSent) return;
    command.endSent = true;
    this.ws.send(
      JSON.stringify({
        type: "location_command_cancel",
        protocolVersion: LOCATION_COMMAND_PROTOCOL,
        turnId: command.turnId,
        finalSequence: command.lastSentSequence,
        cancelled: true,
      }),
    );
  }

  private locationCommandGateOpen(command: LocationCommandTurn): boolean {
    return (
      !command.cancelled &&
      command.endpointed &&
      command.finalTranscriptReceived &&
      command.turnCompleteReceived &&
      command.relayReady
    );
  }

  private mayEmitLocationCommandEvent(
    event: OneVoiceSessionEvent,
    command: LocationCommandTurn,
  ): boolean {
    if (this.locationCommandGateOpen(command)) return true;
    // A matching relay can fail before Gemini establishes speech end (for
    // example, a sequence discontinuity or provider setup failure). That
    // terminal failure must be visible instead of leaving the pill in
    // Listening forever, but it can only unlock a payload-free retry state;
    // it can never carry a card, navigation, or executable directive.
    return (
      event.type === "location_command_result" &&
      event.outcome === "failed" &&
      (command.endpointed || command.terminalFailure) &&
      event.result == null &&
      event.navigation == null &&
      event.statusCard == null
    );
  }

  private emitOrParkLocationCommandEvent(event: OneVoiceSessionEvent): void {
    const command = this.locationCommand;
    const eventTurnId =
      event.type === "client_directive" || event.type === "location_command_result"
        ? event.turnId
        : null;
    // In command mode, never associate an untagged or stale directive/result
    // with the current physical command tap.
    if (eventTurnId && eventTurnId !== command?.turnId) return;
    if (!command || command.cancelled || !this.mayEmitLocationCommandEvent(event, command)) {
      if (!command?.cancelled) this.pendingLocationCommandEvents.push(event);
      return;
    }
    this.handlers.onEvent?.(event);
  }

  private flushLocationCommandEvents(): void {
    const command = this.locationCommand;
    if (!command || command.cancelled) {
      return;
    }
    const events = this.pendingLocationCommandEvents;
    this.pendingLocationCommandEvents = [];
    for (const event of events) {
      if (this.mayEmitLocationCommandEvent(event, command)) {
        this.handlers.onEvent?.(event);
      } else {
        this.pendingLocationCommandEvents.push(event);
      }
    }
  }

  private handleRealtimeAudioInputState(input: {
    sessionId: string;
    state: string;
    reason?: string | null;
    timeToFirstFrameMs?: number | null;
    droppedFrames?: number | null;
    level?: number | null;
  }): void {
    if (this.closed || input.sessionId !== this.sessionId) return;
    if (
      input.state === "first_frame" &&
      typeof input.timeToFirstFrameMs === "number"
    ) {
      this.logSessionMilestone(
        "native_time_to_first_pcm_ms",
        input.timeToFirstFrameMs,
        { input_source: "ios_native_pcm" },
      );
    }
    if (
      input.state === "delivery_backpressure" &&
      typeof input.droppedFrames === "number" &&
      input.droppedFrames > 0
    ) {
      this.logSessionMilestone(
        "native_pcm_backpressure_frames",
        input.droppedFrames,
        { input_source: "ios_native_pcm" },
      );
    }
    if (input.state === "sequence_gap") {
      const command = this.locationCommand;
      if (command && !command.endpointed && !command.endSent) {
        this.cancelLocationCommandForRetry(
          command,
          "Voice input was interrupted. Tap Talk to One and try again.",
        );
      } else {
        const eventOptions = this.nextEventOptions();
        this.handlers.onEvent?.({
          type: "error",
          provider: this.provider,
          message: "Voice input was interrupted. Tap Talk to One and try again.",
          sessionId: eventOptions.sessionId,
          sourceId: eventOptions.sourceId,
          sourceSeq: eventOptions.sourceSeq,
        });
      }
      return;
    }
    if (input.state === "error") {
      // Native error details can contain OS-private values. The bridge emits a
      // bounded category for local diagnostics, while the visible failure
      // stays stable and safe.
      this.fail("Microphone capture stopped unexpectedly. Please try again.");
    }
  }

  private handleRealtimePcmFrame(frame: OneVoicePcmFrame): void {
    if (
      this.closed ||
      frame.sessionId !== this.sessionId ||
      frame.sampleRate !== INPUT_SAMPLE_RATE ||
      frame.channels !== 1 ||
      frame.encoding !== "pcm_s16le" ||
      frame.bytes.byteLength < 2 ||
      frame.bytes.byteLength % 2 !== 0
    ) {
      return;
    }
    const command = this.locationCommand;
    if (command && !command.endpointed && !command.released && !command.cancelled) {
      if (
        command.nativeSequence !== null &&
        frame.sequence !== command.nativeSequence + 1
      ) {
        // Do not send a partial command when the native bridge reports a
        // discontinuity. The terminal frame is explicitly cancelled and the
        // visible command lane can offer a retry.
        this.cancelLocationCommandForRetry(
          command,
          "Voice input was interrupted. Tap Talk to One and try again.",
        );
        return;
      }
      command.nativeSequence = frame.sequence;
    }
    this.handleCapturedPcm(
      frame.bytes,
      Math.min(1, pcm16Rms(frame.bytes) * 4),
      "ios_native_pcm",
    );
  }

  private handleCapturedPcm(
    pcm: Uint8Array,
    level: number,
    source: "browser_pcm" | "ios_native_pcm",
  ): void {
    if (this.closed) return;
    if (!this.captureMetricLogged) {
      this.captureMetricLogged = true;
      this.logSessionMilestone(
        "time_to_capture_ms",
        performance.now() - (this.captureStartedAt ?? performance.now()),
        { input_source: source },
      );
    }
    this.handlers.onInputLevel?.(level);
    this.handlers.onEvent?.({
      type: "input_level",
      provider: this.provider,
      level,
    });
    // Mic frames stream continuously, so they must never demote the thinking
    // state while the model is responding. More importantly, physical capture
    // cannot claim Listening before relayAccepted + providerReady +
    // appContextAccepted have all arrived.
    this.publishListeningIfCaptureIsActive();
    if (this.locationCommandMode) {
      // The Talk to One tap is the admission boundary. Never make quiet/soft
      // speech earn its way through an RMS threshold, and never place command
      // PCM on the legacy conversational activity path.
      this.queueLocationCommandAudio(pcm);
      return;
    }
    if (!this.sendVisitorActivityStart(level, pcm)) return;
    this.sendOrQueueRealtimeAudio(pcm);
  }

  /**
   * Browser command capture is a two-way AudioWorklet protocol. Ordinary PCM
   * arrives with a monotonic worklet sequence; a tail marker is used only to
   * detect discontinuity during cancellation. Gemini Live automatic
   * endpointing, never an AudioWorklet marker, ends a command. An old worklet
   * asset that still emits bare Float32Array frames is safe for legacy chat,
   * but deliberately fails a command turn closed because it cannot prove the
   * capture sequence.
   */
  private handleBrowserCaptureWorkletMessage(data: unknown): void {
    if (isBrowserCaptureTailDrainedMessage(data)) {
      this.handleBrowserLocationCommandTailDrained(data);
      return;
    }

    let frame: Float32Array | null = null;
    if (isBrowserCapturePcmMessage(data)) {
      const command = this.locationCommand;
      if (
        command &&
        !command.endpointed &&
        !command.endSent &&
        data.sequence !== this.browserWorkletLastSequence + 1
      ) {
        this.cancelLocationCommandForRetry(
          command,
          "Voice input was interrupted. Tap Talk to One and try again.",
        );
        void this.stopAudioInput();
        return;
      }
      this.browserWorkletLastSequence = data.sequence;
      if (command && !command.endpointed && !command.endSent) {
        command.browserWorkletLastSequence = data.sequence;
      }
      frame = data.frame;
    } else if (data instanceof Float32Array) {
      const command = this.locationCommand;
      if (
        this.locationCommandMode &&
        command &&
        !command.endpointed &&
        !command.endSent
      ) {
        // A client carrying an older static worklet cannot emit the ordered
        // tail marker/sequence contract. Do not route a potentially clipped
        // command during a mixed-version UAT rollout.
        this.cancelLocationCommandForRetry(
          command,
          "Voice input was interrupted. Tap Talk to One and try again.",
        );
        void this.stopAudioInput();
        return;
      }
      frame = data;
    }
    if (!frame) {
      const command = this.locationCommand;
      if (
        this.locationCommandMode &&
        command &&
        !command.endpointed &&
        !command.endSent
      ) {
        this.cancelLocationCommandForRetry(
          command,
          "Voice input was interrupted. Tap Talk to One and try again.",
        );
        void this.stopAudioInput();
      }
      return;
    }
    const level = Math.min(1, rms(frame) * 4);
    const sourceRate = this.inputContext?.sampleRate ?? INPUT_SAMPLE_RATE;
    const pcm = floatToPcm16(downsample(frame, sourceRate));
    this.handleCapturedPcm(pcm, level, "browser_pcm");
  }

  private async openMicrophone(inputGeneration: number): Promise<void> {
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
    this.browserWorkletLastSequence = 0;
    this.sourceNode.connect(this.captureNode);

    this.captureNode.port.onmessage = (event) => {
      // The microphone is intentionally opened before relay setup. Keep
      // processing frames while the socket/setup/context handshake catches
      // up so the bounded onset/audio buffers can preserve the first words.
      // Only a stopped client may discard a capture frame here.
      if (this.closed || inputGeneration !== this.audioInputGeneration) return;
      this.handleBrowserCaptureWorkletMessage(event.data);
    };
  }

  /**
   * Detach browser capture synchronously, then await the AudioContext close.
   * This intentionally leaves outputContext and ws alone: callers use it for
   * the follow-up timeout and foreground/background microphone boundary, not
   * as a conversation hangup.
   */
  private async stopBrowserAudioInput(): Promise<void> {
    const captureNode = this.captureNode;
    this.captureNode = null;
    // A later physical command tap creates a fresh worklet whose opaque sequence
    // starts again at one. Do not carry the prior node's tail sequence into
    // that new capture boundary.
    this.browserWorkletLastSequence = 0;
    if (captureNode) {
      captureNode.port.onmessage = null;
      try {
        captureNode.disconnect();
      } catch {
        // ignore an already-detached node
      }
    }

    const sourceNode = this.sourceNode;
    this.sourceNode = null;
    if (sourceNode) {
      try {
        sourceNode.disconnect();
      } catch {
        // ignore an already-detached node
      }
    }

    const mediaStream = this.mediaStream;
    this.mediaStream = null;
    for (const track of mediaStream?.getTracks() ?? []) track.stop();

    const inputContext = this.inputContext;
    this.inputContext = null;
    await inputContext?.close().catch(() => undefined);
  }

  private sendRealtimeAudio(pcm: Uint8Array, paced = true): void {
    if (this.closed) return;
    if (
      !this.ws ||
      this.ws.readyState !== WebSocket.OPEN ||
      !this.isLiveReady()
    ) {
      if (this.visitorActivitySent) this.enqueueRealtimeAudio(pcm);
      return;
    }
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
    // Browser worklet frames and native bridge frames have different safe
    // batch sizes. Pace against the PCM duration itself so neither side can
    // burst after a main-thread stall.
    const frameIntervalMs = Math.max(
      1,
      (pcm.byteLength / 2 / INPUT_SAMPLE_RATE) * 1000,
    );
    const now = performance.now();
    // `paced === false` is used only by the duration-paced pre-ready drain
    // after it has independently scheduled this frame at its PCM duration.
    // That preserves the activity-before-audio ordering without mistaking the
    // deliberately retained first turn for a main-thread stall backlog.
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
    const activityLevel = this.initialGreetingPending
      ? INITIAL_VISITOR_ACTIVITY_LEVEL
      : VISITOR_ACTIVITY_LEVEL;
    if (level >= activityLevel) {
      this.consecutiveSpeechFrames += 1;
      if (pcm.byteLength <= MAX_PRE_READY_PCM_FRAME_BYTES) {
        this.enqueueVisitorSpeechFrame(pcm);
      }
    } else {
      // Once a speech onset has been detected, retain its bounded PCM window
      // while the socket/setup/context handshake catches up. Clearing it on a
      // short pause used to lose the first sentence when the relay took longer
      // than the user's first utterance.
      if (!this.speechOnsetReady) {
        this.consecutiveSpeechFrames = 0;
        this.bufferedVisitorSpeechFrames = [];
        this.bufferedVisitorSpeechDurationMs = 0;
      }
    }
    if (this.consecutiveSpeechFrames >= VISITOR_ACTIVITY_FRAMES) {
      this.speechOnsetReady = true;
    }
    if (!this.speechOnsetReady) return false;
    if (
      !this.ws ||
      this.ws.readyState !== WebSocket.OPEN ||
      !this.isLiveReady()
    )
      return false;
    this.visitorActivitySent = true;
    // This is a real first-turn onset, so the idle greeting is no longer
    // owed. Return to normal sensitivity for the next utterance even if the
    // provider ultimately chooses not to emit audio for this turn.
    this.initialGreetingPending = false;
    this.ws.send(JSON.stringify({ type: "voice_activity_start" }));
    this.flushBufferedVisitorSpeech();
    this.speechOnsetReady = false;
    // A visitor who starts speaking should be able to barge in over an
    // already-playing idle cue. The interruption fence drops stale audio.
    if (this.modelTurnOpen || this.state === "speaking") {
      this.interrupt();
    }
    return false;
  }

  private flushBufferedSpeechOnset(): void {
    if (
      this.visitorActivitySent ||
      !this.speechOnsetReady ||
      !this.ws ||
      this.ws.readyState !== WebSocket.OPEN ||
      !this.isLiveReady()
    ) {
      return;
    }
    this.visitorActivitySent = true;
    this.ws.send(JSON.stringify({ type: "voice_activity_start" }));
    this.flushBufferedVisitorSpeech();
    this.speechOnsetReady = false;
  }

  private clearSetupTimeout(): void {
    if (this.setupTimeoutTimer !== null) {
      clearTimeout(this.setupTimeoutTimer);
      this.setupTimeoutTimer = null;
    }
  }

  private clearSocketErrorFallback(): void {
    if (this.socketErrorFallbackTimer !== null) {
      clearTimeout(this.socketErrorFallbackTimer);
      this.socketErrorFallbackTimer = null;
    }
  }

  private clearModelReplyTimeout(): void {
    if (this.modelReplyTimeoutTimer !== null) {
      clearTimeout(this.modelReplyTimeoutTimer);
      this.modelReplyTimeoutTimer = null;
    }
  }

  private armModelReplyTimeout(): void {
    this.clearModelReplyTimeout();
    this.modelReplyTimeoutTimer = setTimeout(() => {
      this.modelReplyTimeoutTimer = null;
      if (
        this.closed ||
        this.modelTurnOpen ||
        this.state === "speaking" ||
        this.state !== "thinking"
      ) {
        return;
      }
      console.warn("[VOICE_NET] model_reply_timeout");
      this.fail("One did not respond in time. Please try again.", true);
    }, MODEL_REPLY_TIMEOUT_MS);
  }

  private readinessPhase():
    | "pre_relay"
    | "relay_accepted"
    | "provider_ready"
    | "context_accepted" {
    if (!this.isRelayAccepted()) return "pre_relay";
    if (!this.isProviderReady()) return "relay_accepted";
    if (!this.initialContextReady) return "provider_ready";
    return "context_accepted";
  }

  private acceptRelay(options: { legacyProviderReady: boolean }): void {
    const relayWasAccepted = this.isRelayAccepted();
    this.relayAccepted = true;
    // Preserve the private field for existing integrations/tests that use it
    // as the relay-control-plane marker. New readiness checks use the three
    // explicit states above.
    this.setupComplete = true;
    if (options.legacyProviderReady && !this.locationCommandMode) {
      this.providerReady = true;
    }

    if (relayWasAccepted) return;
    this.logSessionMilestone(
      "relay_accepted_ms",
      performance.now() - (this.sessionStartedAt ?? performance.now()),
    );
    // Push the initial app context as soon as the authenticated relay can
    // receive it. Context is intentionally NOT gated on provider readiness:
    // the server uses it to construct the trusted runtime before opening the
    // Live model turn.
    if (this.startContext) {
      this.beginInitialContextHandshake(this.startContext);
      this.startContext = null;
    } else {
      this.fail("Voice is waiting for the current screen. Please try again.");
    }
  }

  private connectSocket(relayUrl: string): void {
    const ws = new WebSocket(relayUrl);
    this.ws = ws;

    // Arm the handshake watchdog for the whole open -> bootstrap -> actual
    // provider-ready path. A local relay acknowledgement alone is not enough
    // to claim that One can hear a person.
    // onerror/onclose (which call fail -> stop) clear it if the socket dies
    // first; a socket that opens but never reaches providerReady trips this.
    this.clearSetupTimeout();
    this.setupTimeoutTimer = setTimeout(() => {
      this.setupTimeoutTimer = null;
      if (this.closed || this.isProviderReady()) return;
      // Telemetry: distinct, greppable tag so a stalled handshake is
      // diagnosable in browser logs without exposing any credential.
      console.warn(
        "[one-voice] setup handshake timed out before providerReady",
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
          ...(this.resumptionHandle
            ? { resumption_handle: this.resumptionHandle }
            : {}),
          ...(this.voiceName ? { voice_name: this.voiceName } : {}),
          initial_greeting_enabled: this.initialGreetingEnabled,
          activation_source: this.activationSource,
          ...(this.locationCommandMode
            ? { location_command_protocol: LOCATION_COMMAND_PROTOCOL }
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
      if (this.closed) return;
      const phase = this.readinessPhase();
      // Browsers intentionally hide WebSocket error details. Record only the
      // safe lifecycle phase so device evidence can distinguish relay setup
      // failures from a later provider/session drop without retaining a URL,
      // close reason, credential, transcript, or audio.
      this.logSessionMilestone("relay_socket_error", 1, { phase });
      console.warn(`[VOICE_NET] socket_error phase=${phase}`);
      // WebKit commonly emits `error` immediately before `close`. Failing
      // synchronously here calls stop(), which sets closed=true and discards
      // that close event's safe code/reason. Preserve the generic fallback
      // only when a close does not follow within this bounded grace period.
      this.clearSocketErrorFallback();
      this.socketErrorFallbackTimer = setTimeout(() => {
        this.socketErrorFallbackTimer = null;
        if (this.closed) return;
        this.fail("Gemini Live connection error.");
      }, SOCKET_ERROR_CLOSE_GRACE_MS);
    };

    ws.onclose = (event) => {
      this.clearSocketErrorFallback();
      if (this.closed) return;
      const phase = this.readinessPhase();
      this.logSessionMilestone("relay_socket_closed", event.code, {
        phase,
        clean: event.wasClean,
      });
      console.warn(
        `[VOICE_NET] socket_closed phase=${phase} code=${event.code} clean=${event.wasClean}`,
      );
      // A close that arrives before the provider is ready means the session
      // never started (bad/expired token, model not enabled, region). Surface
      // that as an error so the bar shows why instead of silently snapping
      // back. relayAccepted alone is intentionally insufficient.
      if (!this.isProviderReady()) {
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

    if (readRecord(message.relayAccepted)) {
      this.acceptRelay({ legacyProviderReady: false });
      return;
    }

    if ("setupComplete" in message) {
      // Compatibility with a cached relay that predates the explicit
      // relay/provider split. A v2 server sends relayAccepted first, so this
      // frame remains a no-op for current sessions and cannot unlock PCM.
      const legacyProviderReady = !this.relayAccepted;
      if (legacyProviderReady && this.locationCommandMode) {
        this.fail(COMMAND_SERVICE_VERSION_MISMATCH_MESSAGE);
        return;
      }
      this.acceptRelay({ legacyProviderReady });
      if (legacyProviderReady) {
        this.clearSetupTimeout();
        this.logSessionMilestone(
          "provider_ready_ms",
          performance.now() - (this.sessionStartedAt ?? performance.now()),
          { protocol: "legacy_setup_complete" },
        );
      }
      return;
    }

    if (readRecord(message.providerReady)) {
      if (!this.isRelayAccepted()) {
        this.fail("Voice readiness arrived out of order. Please try again.");
        return;
      }
      if (!this.providerReady) {
        this.providerReady = true;
        this.clearSetupTimeout();
        this.logSessionMilestone(
          "provider_ready_ms",
          performance.now() - (this.sessionStartedAt ?? performance.now()),
          { protocol: "one_live_readiness.v2" },
        );
      }
      this.completeLiveReadinessIfPossible();
      return;
    }

    const greetingDirective = readRecord(message.greetingDirective);
    if (greetingDirective) {
      if (this.locationCommandMode) {
        // This lane intentionally has no conversational output. The fixed
        // greeting remains available to the ordinary voice experience, but a
        // command tap must never cause One to speak over the user's next
        // action.
        return;
      }
      // The server control directive is intentionally fixed and bounded. Do
      // not surface arbitrary relay text as a greeting. After exact validation
      // the transport may request its matching output-only control frame, but
      // neither the browser nor Gemini gets to author this product welcome.
      const kind = readString(greetingDirective.kind);
      const text = readString(greetingDirective.text);
      const followUpWindowMs = readNumber(greetingDirective.followUpWindowMs);
      if (
        kind === "fresh_session" &&
        text === SERVER_GREETING_TEXT &&
        followUpWindowMs === SERVER_GREETING_FOLLOW_UP_WINDOW_MS &&
        !this.serverGreetingDirectiveReceived
      ) {
        this.serverGreetingDirectiveReceived = true;
        const eventOptions = this.nextEventOptions();
        this.handlers.onEvent?.({
          type: "greeting",
          provider: this.provider,
          greeting: {
            kind: "fresh_session",
            text: SERVER_GREETING_TEXT,
            followUpWindowMs: SERVER_GREETING_FOLLOW_UP_WINDOW_MS,
          },
          sessionId: eventOptions.sessionId,
          sourceId: eventOptions.sourceId,
          sourceSeq: eventOptions.sourceSeq,
        });
        this.maybeSpeakServerGreeting();
      }
      return;
    }

    // The relay's own classified reason for a mid-call end, sent moments
    // before it closes the socket. Without reading this, that close reached
    // `ws.onclose` after `setupComplete` and went through the same silent
    // `stop()` a normal hangup does -- the person just saw the mic go dark.
    const sessionEnded = readRecord(message.sessionEnded);
    if (sessionEnded) {
      const reason = readString(sessionEnded.reason) ?? "unknown";
      const resumable = sessionEnded.resumable === true;
      if (reason === "location_command_boundary_rollover") {
        // A completed push-to-talk command rotates to a fresh Live provider
        // session so an untagged late old-turn transcription can never join
        // the next command tap. This happens only after the terminal card/result was
        // emitted, so it is normal transport hygiene, not an error card or a
        // conversational retry.
        const eventOptions = this.nextEventOptions();
        this.handlers.onEvent?.({
          type: "location_command_session_rollover",
          provider: this.provider,
          sessionId: eventOptions.sessionId,
          sourceId: eventOptions.sourceId,
          sourceSeq: eventOptions.sourceSeq,
        });
        this.stop();
        return;
      }
      this.fail(describeSessionEndedReason(reason, resumable), resumable);
      return;
    }

    // The provider's own continuation token, reissued through the life of a
    // session (not just once). Kept for the next runtime_bootstrap this
    // instance sends, and handed off via the `closed` event once this
    // instance tears down, so a reconnect can carry it into a fresh one.
    const sessionResumption = readRecord(message.sessionResumption);
    const resumptionHandle = readString(sessionResumption?.handle);
    if (resumptionHandle) {
      this.resumptionHandle = resumptionHandle;
      return;
    }

    // The provider's own advance warning that it is about to end the
    // session on its own terms. No reconnect exists yet to act on this, so
    // for now this only stops the signal from being silently dropped --
    // logged so "how often does this fire, and how much runway does it
    // actually give" is answerable before building on it.
    const goAway = readRecord(message.goAway);
    if (goAway) {
      // The provider's time-left payload is intentionally not telemetry: it
      // is free-form provider data. The fixed milestone alone is enough to
      // measure whether continuation handling needs work.
      this.logSessionMilestone("voice_go_away_received", 1);
      return;
    }

    const contextAck = readRecord(message.appContextAccepted);
    const contextId = readString(contextAck?.contextId);
    if (contextId) {
      const appIntelligence = readRecord(contextAck?.appIntelligence);
      const graphRevision = readString(appIntelligence?.graphRevision);
      if (graphRevision) this.graphRevision = graphRevision;
      this.executableActionIds = readStringArray(
        contextAck?.executableActionIds,
      );
      this.acknowledgedContextIds.add(contextId);
      if (!this.initialContextReady) {
        this.logSessionMilestone(
          "runtime_context_ready_ms",
          performance.now() - (this.sessionStartedAt ?? performance.now()),
        );
      }
      const resolve = this.contextAckWaiters.get(contextId);
      if (resolve) {
        this.contextAckWaiters.delete(contextId);
        resolve({
          status: "acknowledged",
          contextId,
          executableActionIds: this.executableActionIds,
        });
      }
      return;
    }

    const localProposalAccepted = readRecord(message.localActionProposalAccepted);
    const acceptedProposalId = readString(localProposalAccepted?.proposalId);
    if (acceptedProposalId) {
      const waiter = this.localActionProposalWaiters.get(acceptedProposalId);
      if (waiter) {
        clearTimeout(waiter.timer);
        this.localActionProposalWaiters.delete(acceptedProposalId);
        waiter.resolve(true);
      }
      return;
    }

    const localProposalRejected = readRecord(message.localActionProposalRejected);
    const rejectedProposalId = readString(localProposalRejected?.proposalId);
    if (rejectedProposalId) {
      const waiter = this.localActionProposalWaiters.get(rejectedProposalId);
      if (waiter) {
        clearTimeout(waiter.timer);
        this.localActionProposalWaiters.delete(rejectedProposalId);
        waiter.resolve(false);
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

    const locationCommandState = readRecord(message.locationCommandState);
    if (locationCommandState) {
      const stateTurnId = readString(locationCommandState.turnId);
      const state = readString(locationCommandState.state);
      const protocolVersion = readString(locationCommandState.protocolVersion);
      const command = this.locationCommand;
      if (
        this.locationCommandMode &&
        stateTurnId &&
        command?.turnId === stateTurnId &&
        !command.cancelled &&
        protocolVersion !== LOCATION_COMMAND_PROTOCOL
      ) {
        this.fail(COMMAND_SERVICE_VERSION_MISMATCH_MESSAGE);
        return;
      }
      if (
        protocolVersion === LOCATION_COMMAND_PROTOCOL &&
        stateTurnId &&
        command?.turnId === stateTurnId &&
        !command.cancelled
      ) {
        if (state === "speech_ended") {
          // This came from the provider's automatic endpoint detector. Stop
          // native/browser capture promptly and discard any local post-end
          // queue; it is not a client authorization boundary and results are
          // still fenced below by final transcript + turnComplete.
          command.endpointed = true;
          this.clearLocationCommandBuffers();
          void this.stopAudioInput();
          this.setState("thinking");
          const eventOptions = this.nextEventOptions();
          this.handlers.onEvent?.({
            type: "location_command_endpointed",
            provider: this.provider,
            turnId: stateTurnId,
            sessionId: eventOptions.sessionId,
            sourceId: eventOptions.sourceId,
            sourceSeq: eventOptions.sourceSeq,
          });
        } else if (state === "routing" || state === "working") {
          this.setState("thinking");
        }
      }
      return;
    }

    const locationCommandReady = readRecord(message.locationCommandReady);
    if (locationCommandReady) {
      const protocolVersion = readString(locationCommandReady.protocolVersion);
      if (protocolVersion !== LOCATION_COMMAND_PROTOCOL) {
        if (this.locationCommandMode) {
          this.fail(COMMAND_SERVICE_VERSION_MISMATCH_MESSAGE);
        }
        return;
      }
      const commandModeReady =
        locationCommandReady.relayAccepted === true &&
        locationCommandReady.providerReady === true &&
        locationCommandReady.contextAccepted === true;
      // Readiness belongs to the authenticated command-mode session, not to a
      // command tap. The relay intentionally omits a turn id here because it sends
      // this control-plane fact before any person starts speaking. A later
      // command tap inherits it from `locationCommandSessionReady`.
      this.locationCommandSessionReady = commandModeReady;
      const readyTurnId = readString(locationCommandReady.turnId);
      const command = this.locationCommand;
      if (
        commandModeReady &&
        command &&
        (!readyTurnId || command.turnId === readyTurnId)
      ) {
        command.relayReady = true;
        // A locally cancelled pre-ready command still needs its explicit
        // cancelled end once this session is usable. It is intentionally not
        // announced as ready to the UI, but it must not strand the physical
        // command tap in Transcribing or allow its partial prefix to route.
        if (!command.cancelled) {
          const eventOptions = this.nextEventOptions();
          this.handlers.onEvent?.({
            type: "location_command_ready",
            provider: this.provider,
            turnId: command.turnId,
            sessionId: eventOptions.sessionId,
            sourceId: eventOptions.sourceId,
            sourceSeq: eventOptions.sourceSeq,
          });
        }
        this.flushLocationCommandBegin();
        this.flushLocationCommandAudio();
        this.flushLocationCommandEnd();
        this.flushLocationCommandEvents();
      }
    }

    const locationCommandResult = readRecord(message.locationCommandResult);
    const resultTurnId = readString(locationCommandResult?.turnId);
    const outcome = readString(locationCommandResult?.outcome);
    const resultProtocolVersion = readString(locationCommandResult?.protocolVersion);
    const activeCommand = this.locationCommand;
    if (
      this.locationCommandMode &&
      resultTurnId &&
      activeCommand?.turnId === resultTurnId &&
      !activeCommand.cancelled &&
      resultProtocolVersion !== LOCATION_COMMAND_PROTOCOL
    ) {
      this.fail(COMMAND_SERVICE_VERSION_MISMATCH_MESSAGE);
      return;
    }
    if (
      locationCommandResult &&
      resultTurnId &&
      resultProtocolVersion === LOCATION_COMMAND_PROTOCOL &&
      (outcome === "execute_started" ||
        outcome === "interaction_required" ||
        outcome === "navigate" ||
        outcome === "ask" ||
        outcome === "blocked" ||
        outcome === "failed")
    ) {
      const command = this.locationCommand;
      if (command?.turnId === resultTurnId && !command.cancelled) {
        command.resultReceived = true;
        const serverResult = parseLocationCommandServerResult(
          locationCommandResult,
        );
        if (
          outcome === "failed" &&
          !serverResult.result &&
          !serverResult.circleNameDirective &&
          !serverResult.navigation &&
          !serverResult.statusCard
        ) {
          command.terminalFailure = true;
        }
        const eventOptions = this.nextEventOptions();
        this.emitOrParkLocationCommandEvent({
          type: "location_command_result",
          provider: this.provider,
          turnId: resultTurnId,
          outcome,
          reasonCode: readString(locationCommandResult?.reasonCode),
          result: serverResult.result,
          circleNameDirective: serverResult.circleNameDirective,
          navigation: serverResult.navigation,
          statusCard: serverResult.statusCard,
          sessionId: eventOptions.sessionId,
          sourceId: eventOptions.sourceId,
          sourceSeq: eventOptions.sourceSeq,
        });
        this.flushLocationCommandEvents();
      }
    }

    const locationCommandFailed = readRecord(message.locationCommandFailed);
    const failedTurnId = readString(locationCommandFailed?.turnId);
    if (failedTurnId && this.locationCommand?.turnId === failedTurnId) {
      const command = this.locationCommand;
      if (command && !command.cancelled) {
        command.resultReceived = true;
        const eventOptions = this.nextEventOptions();
        this.emitOrParkLocationCommandEvent({
          type: "location_command_result",
          provider: this.provider,
          turnId: failedTurnId,
          outcome: "failed",
          reasonCode: readString(locationCommandFailed?.reasonCode),
          sessionId: eventOptions.sessionId,
          sourceId: eventOptions.sourceId,
          sourceSeq: eventOptions.sourceSeq,
        });
      }
    }

    const clientDirective = readRecord(message.clientDirective);
    const directiveKind = readString(clientDirective?.kind);
    if (clientDirective && directiveKind) {
      this.clearModelReplyTimeout();
      if (this.locationCommandMode) {
        // Location command mode has no legacy Gemini/ADK directive lane.
        // Only the typed `locationCommandResult` above can present a bounded
        // Location card, route, or verified status after the turn fence.
      } else {
        const eventOptions = this.nextEventOptions();
        const payload = readRecord(clientDirective.payload) || undefined;
        const directiveTurnId =
          readString(clientDirective.turnId ?? clientDirective.turn_id) ??
          readString(payload?.turnId ?? payload?.turn_id) ??
          null;
        const directiveEvent: OneVoiceSessionEvent = {
          type: "client_directive",
          provider: this.provider,
          directive: {
            kind: directiveKind,
            payload,
            delegateAgentId: readString(clientDirective.delegateAgentId),
          },
          ...(directiveTurnId ? { turnId: directiveTurnId } : {}),
          sessionId: eventOptions.sessionId,
          sourceId: eventOptions.sourceId,
          sourceSeq: eventOptions.sourceSeq,
        };
        this.handlers.onEvent?.(directiveEvent);
        return;
      }
    }

    const toolTrace = readRecord(message.toolTrace);
    const toolTraceKind = readString(toolTrace?.kind);
    if (toolTrace && toolTraceKind) {
      this.clearModelReplyTimeout();
      if (this.locationCommandMode) {
        // A tool trace is conversational display data. Command turns are
        // transcript-first and visual-only through their typed result, so a
        // late trace cannot render an unrelated card.
      } else {
        const eventOptions = this.nextEventOptions();
        const traceEvent: OneVoiceSessionEvent = {
          type: "tool_trace",
          provider: this.provider,
          trace: {
            kind: toolTraceKind,
            payload: readRecord(toolTrace.payload) || undefined,
          },
          sessionId: eventOptions.sessionId,
          sourceId: eventOptions.sourceId,
          sourceSeq: eventOptions.sourceSeq,
        };
        this.handlers.onEvent?.(traceEvent);
        return;
      }
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
      const inputTurnId = readString(
        inputTranscription?.turn_id ?? inputTranscription?.turnId,
      );
      const command = this.locationCommand;
      if (this.locationCommandMode) {
        if (
          command &&
          !command.cancelled &&
          command.endpointed &&
          (inputTurnId === command.turnId || inputTurnId === null)
        ) {
          // This relay normally withholds raw command transcripts. If a
          // compatible relay sends one, it is only an internal completion
          // marker: never surface, mirror, log, or send it back to the app.
          command.finalTranscriptReceived = true;
          this.flushLocationCommandEvents();
        }
      }
      // The provider transcribed the user's speech, which means the user's
      // turn ended and the model is now working on a response. Surface that
      // processing gap as "thinking" until the first audio chunk arrives so
      // the user knows they were heard.
      if (this.state === "listening") {
        this.setState("thinking");
      }
      this.modelTurnObservedAt = performance.now();
      this.firstAudioMetricLoggedForTurn = false;
      // Native PCM reaches Gemini directly, so its provider transcription is
      // the first bounded proof that a real user turn was accepted. Unlike a
      // legacy adapter final it does not pass through sendUserText(), which is
      // where the watchdog is normally armed. Refresh it here without
      // retaining, logging, or re-sending the transcript.
      if (!this.locationCommandMode) {
        this.armModelReplyTimeout();
        this.handlers.onEvent?.({
          type: "transcript_final",
          provider: this.provider,
          text: inputText,
          turnId: inputTurnId,
          confidence: readNumber(inputTranscription?.confidence),
          source: "provider",
          sessionId: eventOptions.sessionId,
          sourceId: eventOptions.sourceId,
          sourceSeq: eventOptions.sourceSeq,
        });
      }
    }

    const outputTranscription =
      readRecord(message.outputTranscription) ||
      readRecord(message.output_transcription) ||
      readRecord(message.assistantText);
    const outputText = readString(
      outputTranscription?.text ?? outputTranscription?.transcript,
    );
    if (outputText && !this.locationCommandMode) {
      this.initialGreetingPending = false;
      this.clearModelReplyTimeout();
      this.setState("speaking");
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
      !this.locationCommandMode &&
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
      this.clearModelReplyTimeout();
      this.modelTurnOpen = false;
      // The turn that was open is now closed, one way or another -- whatever
      // the visitor says next is a fresh utterance, not a continuation of
      // whatever last set this. Without this reset, voice_activity_start
      // only ever fires once for the whole socket instead of once per
      // utterance, which silently breaks every backend guard keyed on it
      // meaning "fresh speech" (live_voice_context.py's per-turn dedupe
      // clears, the already-completed/already-failed loop guards, stale
      // directive disarming) for the rest of the call after the first thing
      // the visitor says.
      this.visitorActivitySent = false;
      this.stopPlayback();
      this.setState("listening");
      return;
    }

    if (serverContent.turnComplete) {
      this.clearModelReplyTimeout();
      // The interrupted (or finished) model turn is closed; stop fencing and
      // settle back to listening when nothing is queued for playback.
      // When audio is still queued, the last node's onended settles instead.
      this.modelTurnOpen = false;
      this.visitorActivitySent = false;
      this.suppressModelAudio = false;
      const command = this.locationCommand;
      if (
        this.locationCommandMode &&
        command &&
        !command.cancelled &&
        command.endpointed
      ) {
        // The command relay sends this only after its final managed
        // transcription and provider turn completion. It is intentionally a
        // boolean proof, not the transcript itself; this client must never
        // show or persist raw command text.
        command.finalTranscriptReceived = true;
        command.turnCompleteReceived = true;
        // Keep output fenced even though the generic completion path lifts
        // its barge-in audio guard below.
        this.suppressModelAudio = true;
        this.flushLocationCommandEvents();
      }
      if (
        this.activeSources.size === 0 &&
        !this.closed &&
        this.state !== "idle"
      ) {
        this.setState(this.locationCommandMode ? "thinking" : "listening");
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
        this.initialGreetingPending = false;
        if (!this.locationCommandMode && !this.suppressModelAudio) {
          this.clearModelReplyTimeout();
          this.enqueueAudio(bytesFromBase64(inlineData.data));
        }
      }
      const textPart = readString(part.text);
      if (textPart && !this.locationCommandMode) {
        // The relay preserves text-only model turns in this envelope (for
        // example the server-owned "What should I call the new circle?"
        // clarification). Treat that as the response boundary just as we do
        // outputTranscription or audio: otherwise the UI can remain in
        // "Thinking" and the watchdog can replace a real clarification with
        // a timeout error.
        this.clearModelReplyTimeout();
        this.setState("speaking");
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
    controlKind?: "fresh_session_greeting";
    /** Internal output observer used by the fixed greeting control only. */
    onPlaybackSettled?: (played: boolean) => void;
    signal?: AbortSignal;
  }): Promise<boolean> {
    const text = input.text.trim();
    if (
      this.locationCommandMode ||
      !text ||
      !this.ws ||
      this.ws.readyState !== WebSocket.OPEN ||
      !this.isLiveReady()
    ) {
      input.onPlaybackSettled?.(false);
      return false;
    }
    if (input.signal?.aborted) {
      input.onPlaybackSettled?.(false);
      return false;
    }
    // App speech starts a fresh model turn; lift any interrupt fence so the
    // synthesized response is audible.
    this.suppressModelAudio = false;
    this.ws.send(
      JSON.stringify({
        type: "app_speech",
        text,
        turn_id: input.turnId ?? null,
        segment_type: input.segmentType ?? "final",
        ...(input.controlKind === "fresh_session_greeting"
          ? { greeting_control: "fresh_session" }
          : {}),
      }),
    );
    // Settle on playback, not on socket send. Resolving at ws.send made the
    // bridge flip the UI back to "Listening" while the answer was still being
    // synthesized and played, which read as the agent talking over itself.
    const audioStarted = await this.waitForAudioStart(4000, input.signal);
    if (audioStarted) {
      await this.waitForPlaybackDrain(30000, input.signal);
    }
    input.onPlaybackSettled?.(audioStarted);
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
        if (this.closed || !this.isRelayAccepted()) return;
        if (result.status !== "acknowledged") {
          this.fail(
            "Voice could not confirm the current screen. Please try again.",
          );
          return;
        }
        this.initialContextReady = true;
        this.completeLiveReadinessIfPossible();
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
      executable_action_ids:
        context.executable_action_ids ?? context.available_action_ids,
      visible_modules: context.ui.visible_modules,
      visible_control_ids: context.ui.visible_control_ids,
      interaction_layer: context.ui.interaction_layer ?? null,
      pending_settlement: context.pending_settlement,
      cache_freshness: context.cache.freshness,
      vault_ready: context.cache.vault_ready,
      portfolio_ready: context.cache.portfolio_ready,
      onboarding: context.onboarding,
      // The surface's own live state. Without this line every backend change
      // for screen_state is dead code on the voice path: this is the only
      // place the snapshot is serialized to the live socket, and typed chat
      // takes a different route entirely.
      screen_state: context.screen_state ?? null,
    });
  }

  updateContext(context: OneVoiceContextSnapshot): boolean {
    this.latestContext = context;
    if (!this.isRelayAccepted()) {
      // Keep the newest route snapshot while the socket is opening. Otherwise
      // relayAccepted would publish the stale screen captured by start().
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
      return {
        status: "acknowledged",
        contextId,
        executableActionIds: this.executableActionIds ?? [],
      };
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
        finish({
          status: "acknowledged",
          contextId,
          executableActionIds: this.executableActionIds ?? [],
        });
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
      !this.isRelayAccepted()
    ) {
      return false;
    }
    this.logSessionMilestone("browser_action_settled", 1, {
      outcome: settlement.status,
    });
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
    confirmationMethod: OneVoiceConfirmationMethod;
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
            confirmationMethod: input.confirmationMethod,
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
      !this.isRelayAccepted()
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
      const primed = primedOutputContext;
      primedOutputContext = null;
      if (primed && primed.state !== "closed") {
        this.outputContext = primed;
      } else {
        const AudioCtx = outputAudioContextConstructor();
        if (!AudioCtx) {
          throw new DOMException(
            "This browser does not support audio playback.",
            "NotSupportedError",
          );
        }
        this.outputContext = new AudioCtx({ sampleRate: OUTPUT_SAMPLE_RATE });
      }
      this.playheadTime = this.outputContext.currentTime;
      this.startOutputLevelMeter();
    }
    return this.outputContext;
  }

  private resumeOutputContext(
    context: AudioContext,
    forceUserGesture = false,
  ): void {
    if (
      context.state !== "suspended" ||
      (this.outputResumePromise && !forceUserGesture)
    ) {
      return;
    }
    console.info("[VOICE_AUDIO] output_context_resume state=suspended");
    let resumePromise: Promise<void>;
    resumePromise = context
      .resume()
      .then(
        () => {
          console.info(
            `[VOICE_AUDIO] output_context_resume_result state=${context.state}`,
          );
        },
        () => {
          // A retry can succeed after the next tap; retain no exception or
          // transcript in the log, only this safe state category.
          console.info("[VOICE_AUDIO] output_context_resume_result state=suspended");
        },
      )
      .finally(() => {
        // A forced user-gesture retry may supersede an earlier background
        // resume. Only the latest promise owns this shared guard.
        if (this.outputResumePromise === resumePromise) {
          this.outputResumePromise = null;
        }
      });
    this.outputResumePromise = resumePromise;
  }

  private enqueueAudio(pcmBytes: Uint8Array): void {
    if (!this.firstAudioMetricLoggedForTurn) {
      this.firstAudioMetricLoggedForTurn = true;
      const modelTurnObservedAt = this.modelTurnObservedAt;
      this.logSessionMilestone(
        "model_turn_to_first_audio_ms",
        modelTurnObservedAt === null
          ? performance.now() - (this.sessionStartedAt ?? performance.now())
          : performance.now() - modelTurnObservedAt,
      );
    }
    const context = this.ensureOutputContext();
    // The click-bound priming above handles normal in-app starts. Retrying at
    // first PCM makes Siri/external starts resilient without ever logging or
    // retaining the audio itself.
    this.resumeOutputContext(context);
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

  private fail(message: string, resumable?: boolean): void {
    const eventOptions = this.nextEventOptions();
    this.handlers.onError?.(message, eventOptions);
    this.handlers.onEvent?.({
      type: "error",
      provider: this.provider,
      message,
      sessionId: eventOptions.sessionId,
      sourceId: eventOptions.sourceId,
      sourceSeq: eventOptions.sourceSeq,
      ...(resumable !== undefined ? { resumable } : {}),
    });
    this.stop();
  }

  stop(): void {
    if (this.closed) return;
    this.closed = true;
    this.relayAccepted = false;
    this.providerReady = false;
    this.setupComplete = false;
    this.clearSetupTimeout();
    this.clearSocketErrorFallback();
    this.clearModelReplyTimeout();
    this.initialContextReady = false;
    this.initialContextInFlight = false;
    this.captureStartedAt = null;
    this.captureMetricLogged = false;
    this.pendingUserText = null;
    this.clearPreReadyAudioBuffers();
    this.clearLocationCommandBuffers();
    this.pendingLocationCommandEvents = [];
    this.locationCommand = null;
    this.locationCommandMode = false;
    this.locationCommandSessionReady = false;
    this.pendingSpeechEvents.clear();
    this.audioInputGeneration += 1;
    const speechAdapter = this.speechAdapter;
    this.speechAdapter = null;
    void speechAdapter?.cancel().catch(() => undefined);
    const realtimeAudioInput = this.realtimeAudioInput;
    this.realtimeAudioInput = null;
    this.audioInputStarted = false;
    this.audioInputStartPromise = null;
    this.deferAudioInput = false;
    if (realtimeAudioInput) {
      void (realtimeAudioInput.cancel?.() ?? realtimeAudioInput.stop()).catch(
        () => undefined,
      );
    }
    this.speechOnsetReady = false;
    this.runtimeCredential = null;
    this.runtimeVertexProject = null;
    this.runtimeVertexLocation = null;
    for (const [contextId, resolve] of this.contextAckWaiters) {
      resolve({ status: "closed", contextId });
    }
    this.contextAckWaiters.clear();
    for (const resolve of this.contextReadyWaiters) resolve(false);
    this.contextReadyWaiters.clear();
    for (const waiter of this.localActionProposalWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.resolve(false);
    }
    this.localActionProposalWaiters.clear();
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

    // Detach input independently from output/socket teardown. The helper
    // synchronously releases MediaStream tracks before its asynchronous
    // AudioContext close completes.
    void this.stopBrowserAudioInput();
    if (this.outputContext) {
      void this.outputContext.close().catch(() => undefined);
      this.outputContext = null;
    }
    this.outputResumePromise = null;
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
      resumptionHandle: this.resumptionHandle,
    });
    this.handlers.onClose?.();
  }
}

export { GeminiLiveClient as GeminiLiveTransport };
