/**
 * Microphone capture for One Live Voice.
 *
 * getUserMedia (mono, AEC/NS/AGC on) -> AudioContext -> AudioWorklet
 * (`/audio/one-live-capture.worklet.js`, 2048-sample Float32 frames + RMS)
 * -> downsample to 16 kHz -> PCM16 -> `onFrame`. The AudioContext should be
 * created from the user's gesture (pass it in) so Safari does not leave it
 * suspended; when none is passed, one is created here and closed on stop.
 *
 * Mute keeps the track live (the OS indicator stays honest, the AEC stays
 * warm) and simply drops frames.
 */

import {
  downsampleTo16k,
  floatToPcm16,
  levelFromRms,
  rms as frameRms,
} from "@/lib/one-voice/audio/pcm";

export const CAPTURE_WORKLET_URL = "/audio/one-live-capture.worklet.js";
export const CAPTURE_WORKLET_NAME = "one-live-capture";

export type MicErrorCode =
  | "not_allowed"
  | "not_found"
  | "not_readable"
  | "not_supported"
  | "worklet_unavailable"
  | "unknown";

export type MicError = { code: MicErrorCode; message: string };

export class MicCaptureError extends Error {
  readonly code: MicErrorCode;
  constructor(detail: MicError, cause?: unknown) {
    super(detail.message, cause !== undefined ? { cause } : undefined);
    this.name = "MicCaptureError";
    this.code = detail.code;
  }
}

/**
 * Turn a getUserMedia / AudioWorklet failure into a specific, actionable
 * message. The DOMException name is the reliable signal across browsers.
 */
export function describeMicError(error: unknown): MicError {
  if (error instanceof MicCaptureError)
    return { code: error.code, message: error.message };
  const name =
    error instanceof DOMException
      ? error.name
      : error &&
          typeof error === "object" &&
          typeof (error as { name?: unknown }).name === "string"
        ? String((error as { name: string }).name)
        : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
    case "PermissionDeniedError":
      return {
        code: "not_allowed",
        message:
          "Microphone access is blocked. Allow the mic for this site in your browser settings, then try again.",
      };
    case "NotFoundError":
    case "OverconstrainedError":
    case "DevicesNotFoundError":
      return {
        code: "not_found",
        message: "No microphone was found. Connect a mic and try again.",
      };
    case "NotReadableError":
    case "TrackStartError":
    case "AbortError":
      return {
        code: "not_readable",
        message:
          "Your microphone is in use by another app. Close it and try again.",
      };
    case "NotSupportedError":
      return {
        code: "not_supported",
        message:
          "This browser does not support voice. Try Chrome or Safari over HTTPS.",
      };
    default:
      return {
        code: "unknown",
        message:
          error instanceof Error && error.message
            ? `Voice could not start: ${error.message}`
            : "Voice could not start.",
      };
  }
}

const MIC_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
};

type AudioContextCtor = new (options?: AudioContextOptions) => AudioContext;

function resolveAudioContextCtor(): AudioContextCtor | null {
  if (typeof window === "undefined") return null;
  const candidate =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: AudioContextCtor })
      .webkitAudioContext;
  return candidate ?? null;
}

function defaultGetUserMedia(
  constraints: MediaStreamConstraints,
): Promise<MediaStream> {
  if (
    typeof navigator === "undefined" ||
    !navigator.mediaDevices?.getUserMedia
  ) {
    return Promise.reject(
      new DOMException(
        "This browser does not support microphone capture.",
        "NotSupportedError",
      ),
    );
  }
  return navigator.mediaDevices.getUserMedia(constraints);
}

/** `true`/`false` when the track reports it; `null` when the browser does not say. */
function readEchoCancellation(stream: MediaStream): boolean | null {
  const track = stream.getAudioTracks()[0];
  if (!track || typeof track.getSettings !== "function") return null;
  const value = track.getSettings().echoCancellation;
  return typeof value === "boolean" ? value : null;
}

export type CaptureStartOptions = {
  onFrame: (pcm16: Uint8Array) => void;
  onLevel?: (level: number) => void;
  /** An AudioContext created from the user's gesture. Owned by the caller. */
  audioContext?: AudioContext;
};

export type CaptureStartResult = {
  sampleRate: number;
  echoCancellation: boolean | null;
};

export type LiveAudioCaptureOptions = {
  workletUrl?: string;
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  AudioContextImpl?: AudioContextCtor;
};

type WorkletMessage = { frame?: unknown; rms?: unknown };

export class LiveAudioCapture {
  private readonly workletUrl: string;
  private readonly getUserMedia: (
    constraints: MediaStreamConstraints,
  ) => Promise<MediaStream>;
  private readonly AudioContextImpl: AudioContextCtor | null;

  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private ownsContext = false;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | null = null;
  private mutedValue = false;
  private active = false;
  private starting = false;

  constructor(options: LiveAudioCaptureOptions = {}) {
    this.workletUrl = options.workletUrl ?? CAPTURE_WORKLET_URL;
    this.getUserMedia = options.getUserMedia ?? defaultGetUserMedia;
    this.AudioContextImpl =
      options.AudioContextImpl ?? resolveAudioContextCtor();
  }

  get muted(): boolean {
    return this.mutedValue;
  }

  get running(): boolean {
    return this.active;
  }

  get sampleRate(): number | null {
    return this.context?.sampleRate ?? null;
  }

  /**
   * Open the mic and start posting 16 kHz PCM16 frames. Throws
   * `MicCaptureError` with a typed code; the stream and context are released
   * on failure.
   */
  async start(options: CaptureStartOptions): Promise<CaptureStartResult> {
    if (this.active || this.starting) {
      throw new MicCaptureError({
        code: "unknown",
        message: "Voice capture is already running.",
      });
    }
    this.starting = true;
    try {
      const stream = await this.getUserMedia(MIC_CONSTRAINTS);
      this.stream = stream;

      let context = options.audioContext ?? null;
      if (!context) {
        if (!this.AudioContextImpl) {
          throw new DOMException(
            "AudioContext is not available.",
            "NotSupportedError",
          );
        }
        context = new this.AudioContextImpl();
        this.ownsContext = true;
      }
      this.context = context;
      if (context.state === "suspended") {
        await context.resume().catch(() => undefined);
      }

      if (
        !context.audioWorklet ||
        typeof context.audioWorklet.addModule !== "function"
      ) {
        throw new MicCaptureError({
          code: "worklet_unavailable",
          message: "This browser cannot run the voice capture worklet.",
        });
      }
      try {
        await context.audioWorklet.addModule(this.workletUrl);
      } catch (error) {
        throw new MicCaptureError(
          {
            code: "worklet_unavailable",
            message: "The voice capture worklet failed to load.",
          },
          error,
        );
      }

      const source = context.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(context, CAPTURE_WORKLET_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: 1,
      });
      source.connect(node);
      this.source = source;
      this.node = node;

      const sampleRate = context.sampleRate;
      node.port.onmessage = (event: MessageEvent<WorkletMessage>) => {
        if (!this.active) return;
        const data = event.data;
        const frame =
          data && data.frame instanceof Float32Array ? data.frame : null;
        if (!frame) return;
        if (this.mutedValue) {
          options.onLevel?.(0);
          return;
        }
        const level = levelFromRms(
          typeof data.rms === "number" ? data.rms : frameRms(frame),
        );
        options.onLevel?.(level);
        options.onFrame(floatToPcm16(downsampleTo16k(frame, sampleRate)));
      };

      this.active = true;
      return { sampleRate, echoCancellation: readEchoCancellation(stream) };
    } catch (error) {
      this.release();
      throw error instanceof MicCaptureError
        ? error
        : new MicCaptureError(describeMicError(error), error);
    } finally {
      this.starting = false;
    }
  }

  /** Keep the track, drop frames. */
  setMuted(muted: boolean): void {
    this.mutedValue = muted;
  }

  stop(): void {
    this.active = false;
    this.release();
  }

  private release(): void {
    if (this.node) {
      this.node.port.onmessage = null;
      try {
        this.node.disconnect();
      } catch {
        // ignore
      }
      this.node = null;
    }
    if (this.source) {
      try {
        this.source.disconnect();
      } catch {
        // ignore
      }
      this.source = null;
    }
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        try {
          track.stop();
        } catch {
          // ignore
        }
      }
      this.stream = null;
    }
    if (this.context && this.ownsContext) {
      void this.context.close().catch(() => undefined);
    }
    this.context = null;
    this.ownsContext = false;
  }
}

export type MicrophoneProbe = {
  ok: boolean;
  sampleRate?: number;
  echoCancellation?: boolean | null;
  workletLoaded?: boolean;
  error?: MicError;
};

/**
 * Open and immediately release the mic, reporting what a session would get.
 * For the Profile "Test microphone" row: it prompts for permission like a
 * real session would and never sends audio anywhere.
 */
export async function probeMicrophone(
  options: LiveAudioCaptureOptions = {},
): Promise<MicrophoneProbe> {
  const getUserMedia = options.getUserMedia ?? defaultGetUserMedia;
  const AudioContextImpl =
    options.AudioContextImpl ?? resolveAudioContextCtor();
  let stream: MediaStream | null = null;
  let context: AudioContext | null = null;
  try {
    stream = await getUserMedia(MIC_CONSTRAINTS);
    const echoCancellation = readEchoCancellation(stream);
    if (!AudioContextImpl) {
      return {
        ok: false,
        echoCancellation,
        workletLoaded: false,
        error: {
          code: "not_supported",
          message: "This browser does not support voice.",
        },
      };
    }
    context = new AudioContextImpl();
    let workletLoaded = false;
    if (
      context.audioWorklet &&
      typeof context.audioWorklet.addModule === "function"
    ) {
      try {
        await context.audioWorklet.addModule(
          options.workletUrl ?? CAPTURE_WORKLET_URL,
        );
        workletLoaded = true;
      } catch {
        workletLoaded = false;
      }
    }
    return {
      ok: workletLoaded,
      sampleRate: context.sampleRate,
      echoCancellation,
      workletLoaded,
      ...(workletLoaded
        ? {}
        : {
            error: {
              code: "worklet_unavailable" as const,
              message: "The voice capture worklet failed to load.",
            },
          }),
    };
  } catch (error) {
    return { ok: false, error: describeMicError(error) };
  } finally {
    if (stream) {
      for (const track of stream.getTracks()) {
        try {
          track.stop();
        } catch {
          // ignore
        }
      }
    }
    if (context) void context.close().catch(() => undefined);
  }
}
