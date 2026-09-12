import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { BrowserLocalSpeechAdapter, type LocalAsrEngine } from "@/lib/voice/browser-local-speech-adapter";
import { createMemoryModelPackStore } from "@/lib/voice/local-runtime-model-store";

const modelBytes = new TextEncoder().encode("hello");
const manifest = {
  pack_id: "voice-browser-test",
  version: "1.0.0",
  size_bytes: modelBytes.byteLength,
  checksum:
    "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  min_ram_gb: 0,
  min_storage_mb: 0,
  languages: ["en"],
  tasks: ["stt"],
  runtime: "sherpa_onnx_web",
  artifact_url: "https://models.example.test/voice-browser-test.pack?Expires=4102444800&Signature=test",
  preprocessing_version: "pcm16k-v1",
  entrypoint: "sherpa_onnx_browser_streaming_v1",
  source_sha: "a".repeat(40),
  catalog_version: "agent-manifest-v2-test",
  license_notice_id: "test-license-notice",
  license_approved: false,
} as const;

type CaptureNode = {
  port: { onmessage: ((event: MessageEvent) => void) | null };
  disconnect: ReturnType<typeof vi.fn>;
};

class AudioContextMock {
  state = "running";
  sampleRate = 16_000;
  audioWorklet = { addModule: vi.fn(async () => undefined) };
  source = { connect: vi.fn(), disconnect: vi.fn() };
  close = vi.fn(async () => undefined);
  resume = vi.fn(async () => undefined);
  createMediaStreamSource = vi.fn(() => this.source);
  createAudioWorkletNode = vi.fn();
}

describe("browser local speech adapter", () => {
  let captureNode: CaptureNode;
  let stream: { getTracks: () => Array<{ stop: ReturnType<typeof vi.fn> }> };

  beforeEach(() => {
    captureNode = {
      port: { onmessage: null },
      disconnect: vi.fn(),
    };
    stream = { getTracks: () => [{ stop: vi.fn() }] };
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => stream) },
    });
    Object.defineProperty(window, "AudioContext", {
      configurable: true,
      value: AudioContextMock,
    });
    vi.stubGlobal("AudioWorkletNode", class {
      port = captureNode.port;
      disconnect = captureNode.disconnect;
      constructor() {
        return captureNode;
      }
    });
    vi.stubGlobal("Worker", class {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("buffers 16 kHz PCM until the verified worker is ready and emits shared events", async () => {
    const onResult = vi.fn();
    const engine: LocalAsrEngine = {
      start: vi.fn(async ({ onResult: emit }) => {
        onResult.mockImplementation(emit);
      }),
      pushPcm: vi.fn(),
      stop: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
    };
    const { store } = createMemoryModelPackStore();
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input) === "/api/kai/local-runtime/capability") {
        return new Response(
          JSON.stringify({
            processing_mode_contract: ["cloud", "hybrid", "on_device"],
            offline_ready: false,
            installed_packs: [],
            available_packs: [manifest],
            supported_tasks: ["stt"],
            fallback_mode: "hybrid",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(modelBytes, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchImpl);

    const events: Array<Record<string, unknown>> = [];
    const adapter = new BrowserLocalSpeechAdapter(
      { onEvent: (event) => events.push(event) },
      { store, engine },
    );

    const startPromise = adapter.start({ sessionId: "web-local-1" });
    await vi.waitFor(() => expect(captureNode.port.onmessage).not.toBeNull());
    captureNode.port.onmessage?.({ data: new Float32Array([0.1, 0.2, 0.3]) } as MessageEvent);
    await startPromise;

    expect(engine.pushPcm).toHaveBeenCalledWith(new Float32Array([0.1, 0.2, 0.3]));
    onResult({ kind: "final", text: "create a circle", confidence: 0.9 });
    expect(events).toContainEqual({
      sessionId: "web-local-1",
      sequence: 1,
      kind: "final",
      text: "create a circle",
      confidence: 0.9,
      provider: "sherpa_onnx_web",
      onDevice: true,
    });

    await adapter.stop();
    expect(events.at(-1)).toMatchObject({
      kind: "end",
      sessionId: "web-local-1",
      provider: "sherpa_onnx_web",
      onDevice: true,
    });
    expect(engine.stop).toHaveBeenCalledOnce();
  });
});
