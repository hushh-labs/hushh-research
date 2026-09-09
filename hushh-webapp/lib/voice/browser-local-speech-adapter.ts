import {
  canUseWebAssemblySpeech,
  ensureLocalSpeechPack,
  fetchLocalRuntimeCapability,
} from "./local-runtime-capability";
import { LocalModelPackStore } from "./local-runtime-model-store";
import { emitLocalRuntimeEvent } from "./local-runtime-observability";
import {
  clampTranscriptText,
  createSpeechSessionId,
  type OneVoiceSpeechAdapter,
  type SpeechAdapterCallbacks,
  type SpeechAdapterStartOptions,
  type SpeechAdapterStartResult,
  type TranscriptEvent,
} from "./transcript-events";
import { BoundedPcmRingBuffer } from "./transcript-events";

type LocalAsrResult = { kind: "partial" | "final"; text: string; confidence?: number };

export type LocalAsrEngine = {
  start(input: {
    modelBytes: ArrayBuffer;
    entrypoint: string;
    onResult: (result: LocalAsrResult) => void;
    onError: (code: string) => void;
  }): Promise<void>;
  pushPcm(frame: Float32Array): void;
  stop(): Promise<void>;
  cancel(): Promise<void>;
};

type WorkerMessage =
  | { type: "ready" }
  | { type: "result"; kind: "partial" | "final"; text: string; confidence?: number }
  | { type: "done" }
  | { type: "error"; code: string };

type WorkerLike = {
  onmessage: ((event: MessageEvent<WorkerMessage>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
};

/** The only browser local ASR engine. Audio ownership remains with the adapter. */
export class WorkerLocalAsrEngine implements LocalAsrEngine {
  private worker: WorkerLike | null = null;
  private readonly workerFactory: () => WorkerLike;
  private ready: Promise<void> | null = null;
  private onResult: ((result: LocalAsrResult) => void) | null = null;
  private onError: ((code: string) => void) | null = null;

  constructor(
    workerFactory: () => WorkerLike = () =>
      new Worker(new URL("./browser-local-asr.worker.ts", import.meta.url), {
        type: "classic",
      }) as unknown as WorkerLike,
  ) {
    this.workerFactory = workerFactory;
    this.createWorker();
  }

  async start(input: {
    modelBytes: ArrayBuffer;
    entrypoint: string;
    onResult: (result: LocalAsrResult) => void;
    onError: (code: string) => void;
  }): Promise<void> {
    if (!this.worker) this.createWorker();
    if (!this.worker) throw new Error("local_asr_engine_disposed");
    this.onResult = input.onResult;
    this.onError = input.onError;
    this.ready = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("local_asr_worker_timeout")), 5_000);
      const previous = this.worker!.onmessage;
      this.worker!.onmessage = (event) => {
        if (event.data.type === "ready") {
          clearTimeout(timeout);
          this.worker!.onmessage = previous;
          resolve();
          return;
        }
        if (event.data.type === "error") {
          clearTimeout(timeout);
          reject(new Error(event.data.code));
          return;
        }
        previous?.(event);
      };
      const bytes = input.modelBytes.slice(0);
      this.worker!.postMessage(
        { type: "load", modelBytes: bytes, entrypoint: input.entrypoint },
        [bytes],
      );
    });
    await this.ready;
  }

  pushPcm(frame: Float32Array): void {
    if (!this.worker || !this.ready || frame.length === 0) return;
    const copy = new Float32Array(frame);
    this.worker.postMessage({ type: "pcm", frame: copy }, [copy.buffer]);
  }

  async stop(): Promise<void> {
    await this.ready?.catch(() => undefined);
    const worker = this.worker;
    if (!worker) return;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 1_000);
      const previous = worker.onmessage;
      worker.onmessage = (event) => {
        if (event.data.type === "done") {
          clearTimeout(timeout);
          resolve();
          return;
        }
        previous?.(event);
      };
      worker.postMessage({ type: "finish" });
    });
    worker.terminate();
    this.worker = null;
    this.ready = null;
  }

  async cancel(): Promise<void> {
    this.worker?.postMessage({ type: "cancel" });
    this.worker?.terminate();
    this.worker = null;
    this.ready = null;
    this.onResult = null;
    this.onError = null;
  }

  private createWorker(): void {
    this.worker = this.workerFactory();
    this.worker.onmessage = (event) => this.handle(event.data);
    this.worker.onerror = () => this.onError?.("local_asr_worker_failed");
  }

  private handle(message: WorkerMessage): void {
    if (message.type === "result") {
      this.onResult?.({
        kind: message.kind,
        text: clampTranscriptText(message.text),
        confidence: message.confidence,
      });
    } else if (message.type === "error") {
      this.onError?.(message.code);
    }
  }
}

function downsample(frame: Float32Array, sourceRate: number): Float32Array {
  if (sourceRate === 16_000) return frame;
  const ratio = sourceRate / 16_000;
  const result = new Float32Array(Math.floor(frame.length / ratio));
  for (let index = 0; index < result.length; index += 1) {
    result[index] = frame[Math.floor(index * ratio)] ?? 0;
  }
  return result;
}

/**
 * Local-first browser adapter. If no verified pack/runtime exists it fails
 * with a typed unavailable error; the transport then selects its explicit
 * provider-backed fallback. It never labels Browser Speech as on-device.
 */
export class BrowserLocalSpeechAdapter implements OneVoiceSpeechAdapter {
  readonly provider = "sherpa_onnx_web";
  readonly onDevice = true;
  private callbacks: SpeechAdapterCallbacks;
  private engine: LocalAsrEngine | null = null;
  private store: LocalModelPackStore;
  private audioContext: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private captureNode: AudioWorkletNode | null = null;
  private sessionId: string | null = null;
  private sequence = 0;
  private running = false;
  private readonly pendingPcm = new BoundedPcmRingBuffer(24_000);

  constructor(
    callbacks: SpeechAdapterCallbacks,
    options?: { store?: LocalModelPackStore; engine?: LocalAsrEngine },
  ) {
    this.callbacks = callbacks;
    this.store = options?.store ?? new LocalModelPackStore();
    this.engine = options?.engine ?? null;
  }

  setCallbacks(callbacks: SpeechAdapterCallbacks): void {
    this.callbacks = callbacks;
  }

  async start(options: SpeechAdapterStartOptions = {}): Promise<SpeechAdapterStartResult> {
    if (this.running && this.sessionId) {
      return { sessionId: this.sessionId, provider: this.provider, onDevice: true };
    }
    if (typeof window === "undefined" || !canUseWebAssemblySpeech()) {
      throw new Error("speech_unsupported");
    }
    this.sessionId = options.sessionId || createSpeechSessionId("web_local_voice");
    this.sequence = 0;
    this.running = true;
    // Capture begins before capability/model network work. Frames remain in a
    // bounded in-memory ring until the verified worker is ready.
    try {
      await this.openCapture();
      const capability = await fetchLocalRuntimeCapability();
      const pack = await ensureLocalSpeechPack(capability, { store: this.store });
      if (!pack) throw new Error("speech_local_unavailable");
      const modelBytes = await this.store.readInstalled(pack);
      if (!modelBytes) throw new Error("speech_local_model_missing");
      if (!this.engine) this.engine = new WorkerLocalAsrEngine();
      const inferenceStartedAt = performance.now();
      emitLocalRuntimeEvent({
        event: "local_inference_started",
        packId: pack.pack_id,
        packVersion: pack.version,
        provider: this.provider,
      });
      await this.engine.start({
        modelBytes,
        entrypoint: pack.entrypoint,
        onResult: (result) => this.emit(result.kind, result.text, result.confidence),
        onError: (code) => {
          emitLocalRuntimeEvent({
            event: "local_inference_failed",
            packId: pack.pack_id,
            packVersion: pack.version,
            provider: this.provider,
            reason: code,
          });
          this.emit("error", "", undefined, code);
        },
      });
      emitLocalRuntimeEvent({
        event: "local_inference_completed",
        packId: pack.pack_id,
        packVersion: pack.version,
        provider: this.provider,
        elapsedMs: performance.now() - inferenceStartedAt,
      });
      for (const frame of this.pendingPcm.drain()) this.engine.pushPcm(frame);
      return { sessionId: this.sessionId, provider: this.provider, onDevice: true };
    } catch (error) {
      this.running = false;
      await this.engine?.cancel().catch(() => undefined);
      await this.release(true);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.sessionId) return;
    this.running = false;
    this.pendingPcm.clear();
    await this.engine?.stop().catch(() => undefined);
    this.emit("end", "");
    await this.release(false);
  }

  async cancel(): Promise<void> {
    this.running = false;
    this.pendingPcm.clear();
    await this.engine?.cancel().catch(() => undefined);
    await this.release(true);
  }

  private async openCapture(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("speech_unsupported");
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const AudioContextConstructor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextConstructor) throw new Error("speech_unsupported");
    this.audioContext = new AudioContextConstructor();
    if (this.audioContext.state === "suspended") await this.audioContext.resume();
    await this.audioContext.audioWorklet.addModule("/audio/gemini-live-capture.worklet.js");
    this.sourceNode = this.audioContext.createMediaStreamSource(this.stream);
    this.captureNode = new AudioWorkletNode(this.audioContext, "gemini-live-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
    });
    this.sourceNode.connect(this.captureNode);
    this.captureNode.port.onmessage = (event) => {
      if (!this.running && !this.engine) return;
      const frame = event.data as Float32Array;
      const pcm = downsample(frame, this.audioContext?.sampleRate ?? 16_000);
      if (this.engine) this.engine.pushPcm(pcm);
      else this.pendingPcm.push(pcm);
    };
  }

  private emit(
    kind: TranscriptEvent["kind"],
    text: string,
    confidence?: number,
    errorCode?: string,
  ): void {
    if (!this.sessionId) return;
    this.sequence += 1;
    this.callbacks.onEvent({
      sessionId: this.sessionId,
      sequence: this.sequence,
      kind,
      text,
      provider: this.provider,
      onDevice: true,
      ...(confidence === undefined ? {} : { confidence }),
      ...(errorCode ? { errorCode } : {}),
    });
  }

  private async release(destroyEngine: boolean): Promise<void> {
    if (this.captureNode) {
      this.captureNode.port.onmessage = null;
      this.captureNode.disconnect();
      this.captureNode = null;
    }
    this.sourceNode?.disconnect();
    this.sourceNode = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    await this.audioContext?.close().catch(() => undefined);
    this.audioContext = null;
    this.pendingPcm.clear();
    if (destroyEngine) this.engine = null;
    this.sessionId = null;
    this.sequence = 0;
  }
}
