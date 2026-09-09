/**
 * Worker boundary for the pinned sherpa-onnx browser runtime.
 *
 * The runtime glue and WASM binary are pinned, reviewable application assets.
 * The model data file remains an on-demand verified model pack and is supplied
 * through Emscripten's preloaded-package hook. Nothing in this worker can
 * execute a provider-selected URL or turn transcript text into an action.
 */

type WorkerRequest =
  | { type: "load"; modelBytes: ArrayBuffer; entrypoint: string }
  | { type: "pcm"; frame: Float32Array }
  | { type: "finish" }
  | { type: "cancel" };

type OnlineStream = {
  acceptWaveform: (sampleRate: number, samples: Float32Array) => void;
  inputFinished: () => void;
  free: () => void;
};

type OnlineRecognizer = {
  createStream: () => OnlineStream;
  isReady: (stream: OnlineStream) => boolean;
  decode: (stream: OnlineStream) => void;
  isEndpoint: (stream: OnlineStream) => boolean;
  reset: (stream: OnlineStream) => void;
  getResult: (stream: OnlineStream) => { text?: string };
  free: () => void;
};

type SherpaModule = {
  onRuntimeInitialized?: () => void;
  locateFile?: (path: string, scriptDirectory?: string) => string;
  getPreloadedPackage?: (name: string, size: number) => ArrayBuffer;
  wasmBinary?: ArrayBuffer;
};

const scope = globalThis as unknown as {
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
  onmessage: (event: MessageEvent<WorkerRequest>) => void;
  importScripts?: (...urls: string[]) => void;
  Module?: SherpaModule;
  createOnlineRecognizer?: (
    module: SherpaModule,
  ) => OnlineRecognizer;
};

const SHERPA_VERSION = "1.13.7";
const SHERPA_WASM_URL =
  "/vendor/sherpa-onnx/v1.13.7/sherpa-onnx-wasm-main-asr.wasm";
const SHERPA_ASR_URL = "/vendor/sherpa-onnx/v1.13.7/sherpa-onnx-asr.js";
const SHERPA_RUNTIME_URL =
  "/vendor/sherpa-onnx/v1.13.7/sherpa-onnx-wasm-main-asr.js";
const SHERPA_WASM_SHA256 =
  "d0c15c3042fd61ca2a158a1eeb8b8c2099201f7580945efc8f729d2830cf746d";

let loaded = false;
let transcript = "";
let recognizer: OnlineRecognizer | null = null;
let recognizerStream: OnlineStream | null = null;

function postError(code: string): void {
  scope.postMessage({ type: "error", code });
}

async function sha256Hex(value: ArrayBuffer): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("sha256_unavailable");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", value);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function loadSherpa(modelBytes: ArrayBuffer): Promise<void> {
  if (!scope.importScripts || typeof fetch !== "function") {
    throw new Error("local_asr_runtime_unavailable");
  }
  const importScripts = scope.importScripts;
  // This is a same-origin fetch for the pinned WASM runtime, not an app API
  // call. The model pack itself is passed as verified bytes below.
  // eslint-disable-next-line no-restricted-syntax
  const wasmResponse = await fetch(SHERPA_WASM_URL, {
    cache: "force-cache",
    credentials: "same-origin",
  });
  if (!wasmResponse.ok) throw new Error("local_asr_runtime_download_failed");
  const wasmBytes = await wasmResponse.arrayBuffer();
  if ((await sha256Hex(wasmBytes)) !== SHERPA_WASM_SHA256) {
    throw new Error("local_asr_runtime_integrity_failed");
  }

  const sherpaModule: SherpaModule = {
    // The official Emscripten data loader calls this hook before it starts
    // execution. The caller has already verified the model pack checksum.
    getPreloadedPackage: () => modelBytes,
    wasmBinary: wasmBytes,
    locateFile: (path) =>
      path.endsWith(".wasm") ? SHERPA_WASM_URL : path,
  };
  scope.Module = sherpaModule;

  // These are pinned, same-origin application assets. The model pack is the
  // only remote artifact and is never interpreted as JavaScript.
  importScripts(SHERPA_ASR_URL);
  await new Promise<void>((resolve, reject) => {
    sherpaModule.onRuntimeInitialized = () => resolve();
    try {
      importScripts(SHERPA_RUNTIME_URL);
    } catch (error) {
      reject(error);
    }
  });
  if (!scope.createOnlineRecognizer) {
    throw new Error("local_asr_runtime_api_missing");
  }
  recognizer = scope.createOnlineRecognizer(sherpaModule);
  recognizerStream = recognizer.createStream();
  loaded = true;
  scope.postMessage({ type: "ready", runtimeVersion: SHERPA_VERSION });
}

function currentText(): string {
  return recognizer?.getResult(recognizerStream!).text?.trim() ?? "";
}

function decodeAvailable(): void {
  if (!recognizer || !recognizerStream) return;
  while (recognizer.isReady(recognizerStream)) recognizer.decode(recognizerStream);
  const next = currentText();
  if (next && next !== transcript) {
    transcript = next;
    scope.postMessage({ type: "result", kind: "partial", text: transcript });
  }
  if (recognizer.isEndpoint(recognizerStream) && transcript) {
    scope.postMessage({ type: "result", kind: "final", text: transcript });
    transcript = "";
    recognizer.reset(recognizerStream);
  }
}

function freeRecognizer(): void {
  recognizerStream?.free();
  recognizerStream = null;
  recognizer?.free();
  recognizer = null;
  loaded = false;
  transcript = "";
}

scope.onmessage = (event) => {
  const message = event.data;
  if (message.type === "load") {
    if (message.entrypoint !== "sherpa_onnx_browser_streaming_v1") {
      postError("local_asr_entrypoint_unsupported");
      return;
    }
    void loadSherpa(message.modelBytes).catch((error) => {
      freeRecognizer();
      postError(error instanceof Error ? error.message : "local_asr_runtime_failed");
    });
    return;
  }
  if (!loaded) {
    postError("local_asr_not_ready");
    return;
  }
  if (message.type === "pcm") {
    recognizerStream?.acceptWaveform(16_000, message.frame);
    decodeAvailable();
    return;
  }
  if (message.type === "finish") {
    recognizerStream?.inputFinished();
    decodeAvailable();
    if (transcript) {
      scope.postMessage({ type: "result", kind: "final", text: transcript });
    }
    freeRecognizer();
    scope.postMessage({ type: "done" });
  }
  if (message.type === "cancel") {
    freeRecognizer();
  }
};
