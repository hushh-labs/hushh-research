import { ApiService } from "@/lib/services/api-service";

export type AgentVoiceCaptureStatus =
  | "idle"
  | "connecting"
  | "listening"
  | "muted"
  | "transcribing"
  | "error";

export type AgentVoiceUtterance = {
  audio: Blob;
  mimeType: string;
  durationMs: number;
};

export type AgentVoiceTranscriptionResult = {
  transcript: string;
  uncertain: boolean;
  reason: string | null;
};

type AgentVoiceClientHandlers = {
  onStatus?: (status: AgentVoiceCaptureStatus, message?: string | null) => void;
  onLevel?: (level: number) => void;
  onUtterance?: (utterance: AgentVoiceUtterance) => Promise<void> | void;
  onError?: (message: string) => void;
};

const SILENCE_THRESHOLD_MS = 1500;
const RMS_SPEECH_THRESHOLD = 0.035;
const METER_INTERVAL_MS = 80;
const RECORDER_TIMESLICE_MS = 250;
export const AGENT_VOICE_STT_TIMEOUT_MS = 25_000;

const PREFERRED_AUDIO_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/ogg;codecs=opus",
];

type WindowWithWebkitAudio = Window & {
  webkitAudioContext?: typeof AudioContext;
};

function createTimeoutSignal(
  timeoutMs: number,
  upstream?: AbortSignal
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort();
    }
  };

  if (upstream) {
    if (upstream.aborted) {
      abort();
    } else {
      upstream.addEventListener("abort", abort, { once: true });
    }
  }

  if (timeoutMs > 0) {
    timeoutId = setTimeout(abort, timeoutMs);
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
      upstream?.removeEventListener("abort", abort);
    },
  };
}

function getSupportedAudioMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "";
  for (const mimeType of PREFERRED_AUDIO_MIME_TYPES) {
    if (MediaRecorder.isTypeSupported(mimeType)) return mimeType;
  }
  return "";
}

function getAudioContextCtor(): typeof AudioContext | null {
  if (typeof window === "undefined") return null;
  return window.AudioContext || (window as WindowWithWebkitAudio).webkitAudioContext || null;
}

export function getAgentVoiceStartErrorMessage(error: unknown): string {
  const name =
    error instanceof DOMException || error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "PermissionDeniedError") {
    return "Microphone permission was denied. Allow microphone access to use Agent voice.";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "No microphone was found on this device.";
  }
  if (name === "NotReadableError" || name === "TrackStartError") {
    return "The microphone is already in use or could not be started.";
  }
  if (name === "SecurityError") {
    return "Microphone access requires a secure browser context.";
  }
  return error instanceof Error && error.message
    ? error.message
    : "Microphone capture failed.";
}

export function shouldConfirmAgentVoiceTranscript(result: {
  transcript: string;
  uncertain?: boolean;
}): boolean {
  const transcript = result.transcript.trim();
  const alphanumericCount = Array.from(transcript).filter((char) => /\p{L}|\p{N}/u.test(char))
    .length;
  return Boolean(result.uncertain) || alphanumericCount < 2;
}

export async function transcribeAgentVoice(input: {
  userId: string;
  vaultOwnerToken: string;
  audio: Blob;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<AgentVoiceTranscriptionResult> {
  const timeout = createTimeoutSignal(input.timeoutMs ?? AGENT_VOICE_STT_TIMEOUT_MS, input.signal);
  let response: Response;
  try {
    response = await ApiService.transcribeAgentVoice({
      userId: input.userId,
      vaultOwnerToken: input.vaultOwnerToken,
      audio: input.audio,
      filename: "agent-voice-utterance.webm",
      signal: timeout.signal,
    });
  } finally {
    timeout.cleanup();
  }
  const payload = (await response.json().catch(() => ({}))) as {
    transcript?: unknown;
    uncertain?: unknown;
    reason?: unknown;
    detail?: unknown;
    message?: unknown;
  };

  if (!response.ok) {
    const detail =
      typeof payload.detail === "string"
        ? payload.detail
        : typeof payload.message === "string"
          ? payload.message
          : "Agent voice transcription failed.";
    throw new Error(detail);
  }

  return {
    transcript: typeof payload.transcript === "string" ? payload.transcript.trim() : "",
    uncertain: Boolean(payload.uncertain),
    reason: typeof payload.reason === "string" && payload.reason.trim() ? payload.reason : null,
  };
}

export class AgentVoiceClient {
  private handlers: AgentVoiceClientHandlers = {};
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private meterTimer: number | null = null;
  private chunks: Blob[] = [];
  private active = false;
  private muted = false;
  private hasSpeech = false;
  private recordingStartedAt = 0;
  private lastSpeechAt = 0;
  private processingUtterance = false;
  private capturePaused = false;
  private mimeType = "";

  get isActive(): boolean {
    return this.active;
  }

  get isMuted(): boolean {
    return this.muted;
  }

  async start(handlers: AgentVoiceClientHandlers): Promise<void> {
    if (this.active) return;
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      throw new Error("Microphone capture is not supported in this browser.");
    }
    if (typeof MediaRecorder === "undefined") {
      throw new Error("Audio recording is not supported in this browser.");
    }

    this.handlers = handlers;
    this.active = true;
    this.muted = false;
    this.capturePaused = false;
    this.mimeType = getSupportedAudioMimeType();
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      this.setupMeter();
      this.startRecorder();
    } catch (error) {
      this.active = false;
      this.stream?.getTracks().forEach((track) => track.stop());
      this.stream = null;
      this.disconnectAudioGraph();
      throw new Error(getAgentVoiceStartErrorMessage(error));
    }
  }

  async stop(): Promise<void> {
    this.active = false;
    this.muted = false;
    this.capturePaused = false;
    this.stopMeter();
    this.stopRecorder(false);
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.disconnectAudioGraph();
    this.handlers.onLevel?.(0);
    this.handlers.onStatus?.("idle");
  }

  setMuted(muted: boolean): void {
    if (!this.active || this.muted === muted) return;
    this.muted = muted;
    this.syncAudioTrackState();

    if (muted) {
      this.stopRecorder(false);
      this.handlers.onLevel?.(0);
      this.handlers.onStatus?.("muted");
      return;
    }

    this.hasSpeech = false;
    this.lastSpeechAt = performance.now();
    if (!this.recorder && !this.processingUtterance && !this.capturePaused) {
      this.startRecorder();
    }
    this.handlers.onStatus?.("listening");
  }

  toggleMuted(): void {
    this.setMuted(!this.muted);
  }

  setCapturePaused(paused: boolean): void {
    if (!this.active || this.capturePaused === paused) return;
    this.capturePaused = paused;
    this.syncAudioTrackState();

    if (paused) {
      this.stopRecorder(false);
      this.hasSpeech = false;
      this.handlers.onLevel?.(0);
      return;
    }

    if (this.muted) return;
    this.hasSpeech = false;
    this.lastSpeechAt = performance.now();
    if (!this.processingUtterance) {
      this.startRecorder();
    }
    this.handlers.onStatus?.("listening");
  }

  private syncAudioTrackState(): void {
    const enabled = this.active && !this.muted && !this.capturePaused;
    this.stream?.getAudioTracks().forEach((track) => {
      track.enabled = enabled;
    });
  }

  private setupMeter(): void {
    const AudioContextCtor = getAudioContextCtor();
    if (!AudioContextCtor || !this.stream) return;
    this.audioContext = new AudioContextCtor();
    if (this.audioContext.state === "suspended") {
      void this.audioContext.resume().catch(() => undefined);
    }
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 1024;
    this.sourceNode = this.audioContext.createMediaStreamSource(this.stream);
    this.sourceNode.connect(this.analyser);
    this.lastSpeechAt = performance.now();
    this.meterTimer = window.setInterval(() => this.sampleMeter(), METER_INTERVAL_MS);
  }

  private disconnectAudioGraph(): void {
    this.sourceNode?.disconnect();
    this.sourceNode = null;
    this.analyser = null;
    if (this.audioContext && this.audioContext.state !== "closed") {
      void this.audioContext.close().catch(() => undefined);
    }
    this.audioContext = null;
  }

  private stopMeter(): void {
    if (this.meterTimer !== null) {
      window.clearInterval(this.meterTimer);
      this.meterTimer = null;
    }
  }

  private sampleMeter(): void {
    if (
      !this.active ||
      this.muted ||
      this.capturePaused ||
      this.processingUtterance ||
      !this.analyser
    ) {
      return;
    }
    const data = new Uint8Array(this.analyser.fftSize);
    this.analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (const value of data) {
      const normalized = (value - 128) / 128;
      sum += normalized * normalized;
    }
    const rms = Math.sqrt(sum / data.length);
    const level = Math.min(1, rms / 0.18);
    this.handlers.onLevel?.(level);

    const now = performance.now();
    if (rms >= RMS_SPEECH_THRESHOLD) {
      this.hasSpeech = true;
      this.lastSpeechAt = now;
      return;
    }

    if (this.hasSpeech && now - this.lastSpeechAt >= SILENCE_THRESHOLD_MS) {
      this.finishUtterance();
    }
  }

  private startRecorder(): void {
    if (!this.active || this.muted || this.capturePaused || this.processingUtterance || !this.stream) return;
    this.chunks = [];
    this.hasSpeech = false;
    this.recordingStartedAt = performance.now();
    this.lastSpeechAt = this.recordingStartedAt;

    const options = this.mimeType ? { mimeType: this.mimeType } : undefined;
    try {
      this.recorder = new MediaRecorder(this.stream, options);
    } catch (error) {
      this.processingUtterance = false;
      this.handlers.onError?.(getAgentVoiceStartErrorMessage(error));
      return;
    }
    this.recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) this.chunks.push(event.data);
    });
    this.recorder.addEventListener("error", () => {
      this.handlers.onError?.("Agent voice recording failed. Please try again.");
    });
    this.recorder.addEventListener("stop", () => {
      void this.handleRecorderStop();
    });
    this.recorder.start(RECORDER_TIMESLICE_MS);
    this.handlers.onStatus?.("listening");
  }

  private stopRecorder(submit: boolean): void {
    const recorder = this.recorder;
    if (!recorder) return;
    if (!submit) this.chunks = [];
    if (recorder.state !== "inactive") {
      recorder.stop();
    }
    this.recorder = null;
  }

  private finishUtterance(): void {
    if (this.processingUtterance) return;
    this.processingUtterance = true;
    this.handlers.onStatus?.("transcribing");
    this.stopRecorder(true);
  }

  private async handleRecorderStop(): Promise<void> {
    if (!this.processingUtterance) return;
    const chunks = this.chunks;
    this.chunks = [];
    const durationMs = Math.max(0, performance.now() - this.recordingStartedAt);
    const audio = new Blob(chunks, {
      type: this.mimeType || chunks[0]?.type || "audio/webm",
    });

    try {
      if (audio.size > 0) {
        await this.handlers.onUtterance?.({
          audio,
          mimeType: audio.type || "audio/webm",
          durationMs,
        });
      }
    } catch (error) {
      const message =
        error instanceof Error && error.message ? error.message : "Voice transcription failed.";
      this.handlers.onError?.(message);
      this.handlers.onStatus?.("error", message);
    } finally {
      this.processingUtterance = false;
      if (this.active && !this.muted) {
        this.startRecorder();
      }
    }
  }
}
