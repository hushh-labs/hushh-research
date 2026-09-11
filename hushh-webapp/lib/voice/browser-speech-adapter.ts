import {
  clampTranscriptText,
  createSpeechSessionId,
  type OneVoiceSpeechAdapter,
  type SpeechAdapterCallbacks,
  type SpeechAdapterStartOptions,
  type SpeechAdapterStartResult,
  type TranscriptEvent,
} from "./transcript-events";

type BrowserRecognitionResult = {
  isFinal: boolean;
  0?: { transcript?: string; confidence?: number };
};

type BrowserRecognitionEvent = Event & {
  resultIndex: number;
  results: ArrayLike<BrowserRecognitionResult>;
};

type BrowserRecognitionErrorEvent = Event & { error?: string };

type BrowserSpeechRecognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  onend: (() => void) | null;
  onerror: ((event: BrowserRecognitionErrorEvent) => void) | null;
  onresult: ((event: BrowserRecognitionEvent) => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

type BrowserSpeechRecognitionConstructor = new () => BrowserSpeechRecognition;

declare global {
  interface Window {
    SpeechRecognition?: BrowserSpeechRecognitionConstructor;
    webkitSpeechRecognition?: BrowserSpeechRecognitionConstructor;
  }
}

/**
 * Browser speech adapter used when a local WASM provider is not available.
 * The contract deliberately marks this provider as onDevice=false because
 * browser implementations may send audio to a browser-selected service.
 * A sherpa/ONNX worker can replace this adapter without changing callers.
 */
export class BrowserSpeechAdapter implements OneVoiceSpeechAdapter {
  readonly provider = "browser_speech";
  readonly onDevice = false;

  private recognition: BrowserSpeechRecognition | null = null;
  private sessionId: string | null = null;
  private sequence = 0;
  private callbacks: SpeechAdapterCallbacks | null = null;
  private running = false;

  constructor(callbacks: SpeechAdapterCallbacks) {
    this.callbacks = callbacks;
  }

  setCallbacks(callbacks: SpeechAdapterCallbacks): void {
    this.callbacks = callbacks;
  }

  async start(
    options: SpeechAdapterStartOptions = {},
  ): Promise<SpeechAdapterStartResult> {
    if (this.running) {
      return {
        sessionId: this.sessionId || createSpeechSessionId(),
        provider: this.provider,
        onDevice: this.onDevice,
      };
    }
    if (typeof window === "undefined") {
      throw new Error("speech_unsupported");
    }
    const Constructor =
      window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Constructor) throw new Error("speech_unsupported");

    const recognition = new Constructor();
    this.sessionId = options.sessionId || createSpeechSessionId();
    this.sequence = 0;
    this.running = true;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.lang = options.locale || "en-US";
    recognition.onresult = (event) => this.handleResult(event);
    recognition.onerror = (event) => {
      this.emit({
        kind: "error",
        text: "",
        errorCode: event.error || "speech_provider_error",
      });
    };
    recognition.onend = () => {
      if (!this.running) return;
      this.running = false;
      this.emit({ kind: "end", text: "" });
    };
    this.recognition = recognition;

    // start() is intentionally the first provider operation. Network setup
    // belongs to the voice transport and must not precede microphone capture.
    recognition.start();
    return {
      sessionId: this.sessionId,
      provider: this.provider,
      onDevice: this.onDevice,
    };
  }

  async stop(): Promise<void> {
    if (!this.recognition) return;
    this.running = false;
    this.recognition.stop();
    this.emit({ kind: "end", text: "" });
    this.release();
  }

  async cancel(): Promise<void> {
    if (!this.recognition) return;
    this.running = false;
    this.recognition.abort();
    this.release();
  }

  private handleResult(event: BrowserRecognitionEvent): void {
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      if (!result) continue;
      const alternative = result?.[0];
      const text = clampTranscriptText(alternative?.transcript);
      if (!text) continue;
      this.emit({
        kind: result.isFinal ? "final" : "partial",
        text,
        confidence: alternative?.confidence,
      });
    }
  }

  private emit(
    event: Pick<TranscriptEvent, "kind" | "text" | "confidence" | "errorCode">,
  ): void {
    if (!this.sessionId || !this.callbacks) return;
    this.sequence += 1;
    this.callbacks.onEvent({
      sessionId: this.sessionId,
      sequence: this.sequence,
      provider: this.provider,
      onDevice: this.onDevice,
      ...event,
    });
  }

  private release(): void {
    this.recognition = null;
    this.sessionId = null;
    this.sequence = 0;
  }
}
