import { describe, expect, it, vi } from "vitest";

import { ApiService } from "@/lib/services/api-service";
import { ONE_LOCATION_WORKFLOW_CARD_CATALOG } from "@/lib/generated/one-location-workflow-card-catalog.v1";
import { GeminiLiveClient } from "@/lib/services/gemini-live-client";
import type {
  OneVoiceSpeechAdapter,
  SpeechAdapterCallbacks,
} from "@/lib/voice/transcript-events";
import type { OneVoiceRealtimeAudioInput } from "@/lib/voice/realtime-audio-input";

vi.mock("@/lib/voice/voice-telemetry", () => ({
  createVoiceActivationId: () => "vact_test",
  createVoiceTurnId: () => "vturn_test",
  logVoiceMetric: vi.fn(),
}));

describe("GeminiLiveClient action confirmation", () => {
  it("keeps PCM capture tap-gated while a Live session warms", async () => {
    const OriginalWebSocket = global.WebSocket;
    const start = vi.fn(async () => ({ sessionId: "pcm_1" }));
    const cancel = vi.fn(async () => undefined);
    const input = {
      source: "ios_native_pcm",
      start,
      stop: vi.fn(async () => undefined),
      cancel,
    } satisfies OneVoiceRealtimeAudioInput;
    class FakeWebSocket {
      readyState = 0;
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      send = vi.fn();
      close = vi.fn();
    }

    try {
      // @ts-expect-error -- minimal WebSocket test double
      global.WebSocket = FakeWebSocket;
      const transport = new GeminiLiveClient();
      await transport.start({
        relayUrl: "wss://example.test/relay",
        realtimeAudioInput: input,
        deferAudioInput: true,
        activationSource: "foreground_warm",
      });

      expect(start).not.toHaveBeenCalled();
      expect(transport.isAudioInputActive()).toBe(false);
      await expect(transport.startAudioInput()).resolves.toBe(true);
      expect(start).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: expect.stringMatching(/^gemini_live_/) }),
      );
      expect(transport.isAudioInputActive()).toBe(true);

      transport.stop();
      expect(cancel).toHaveBeenCalledTimes(1);
    } finally {
      global.WebSocket = OriginalWebSocket;
    }
  });

  it("starts local command capture before a relay ticket resolves and keeps PCM off the network", async () => {
    const OriginalWebSocket = global.WebSocket;
    let resolveRelayUrl: ((value: string) => void) | null = null;
    const relayUrlPromise = new Promise<string>((resolve) => {
      resolveRelayUrl = resolve;
    });
    let callbacks:
      | Parameters<OneVoiceRealtimeAudioInput["start"]>[0]
      | undefined;
    const start = vi.fn(
      async (options: Parameters<OneVoiceRealtimeAudioInput["start"]>[0]) => {
        callbacks = options;
        return { sessionId: options.sessionId };
      },
    );
    const cancel = vi.fn(async () => undefined);
    const input = {
      source: "ios_native_pcm",
      start,
      stop: vi.fn(async () => undefined),
      cancel,
    } satisfies OneVoiceRealtimeAudioInput;
    let socket: FakeWebSocket | null = null;
    class FakeWebSocket {
      readyState = 0;
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      send = vi.fn();
      close = vi.fn();

      constructor() {
        socket = this;
      }
    }

    try {
      // @ts-expect-error -- minimal WebSocket test double
      global.WebSocket = FakeWebSocket;
      const transport = new GeminiLiveClient();
      expect(transport.beginInputTurn?.({ turnId: "location-cold-start" })).toBe(true);

      const opening = transport.start({
        relayUrlPromise,
        realtimeAudioInput: input,
        locationCommandMode: true,
        activationSource: "tap",
      });

      await Promise.resolve();
      expect(start).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: expect.stringMatching(/^gemini_live_/) }),
      );
      expect(socket).toBeNull();

      callbacks?.onFrame({
        sessionId: callbacks?.sessionId ?? "missing",
        sequence: 1,
        sampleRate: 16_000,
        channels: 1,
        encoding: "pcm_s16le",
        bytes: new Uint8Array([1, 0]),
      });
      // The command frame is queued in RAM while the relay promise is pending;
      // no socket exists yet to send it to a provider.
      expect(socket).toBeNull();

      resolveRelayUrl?.("wss://example.test/api/one/adk/live?relay_ticket=test");
      await opening;
      expect(socket).not.toBeNull();

      transport.stop();
      expect(cancel).toHaveBeenCalledTimes(1);
    } finally {
      global.WebSocket = OriginalWebSocket;
    }
  });

  it("cancels local command capture before a deferred relay ticket can open a socket", async () => {
    const OriginalWebSocket = global.WebSocket;
    let resolveRelayUrl: ((value: string) => void) | null = null;
    const relayUrlPromise = new Promise<string>((resolve) => {
      resolveRelayUrl = resolve;
    });
    const cancel = vi.fn(async () => undefined);
    const input = {
      source: "ios_native_pcm",
      start: vi.fn(async (options: Parameters<OneVoiceRealtimeAudioInput["start"]>[0]) => ({
        sessionId: options.sessionId,
      })),
      stop: vi.fn(async () => undefined),
      cancel,
    } satisfies OneVoiceRealtimeAudioInput;
    let socketCount = 0;
    class FakeWebSocket {
      readyState = 0;
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      send = vi.fn();
      close = vi.fn();

      constructor() {
        socketCount += 1;
      }
    }

    try {
      // @ts-expect-error -- minimal WebSocket test double
      global.WebSocket = FakeWebSocket;
      const transport = new GeminiLiveClient();
      expect(transport.beginInputTurn?.({ turnId: "location-cold-cancel" })).toBe(true);
      const opening = transport.start({
        relayUrlPromise,
        realtimeAudioInput: input,
        locationCommandMode: true,
        activationSource: "tap",
      });

      await Promise.resolve();
      expect(input.start).toHaveBeenCalledTimes(1);
      transport.stop();
      resolveRelayUrl?.("wss://example.test/api/one/adk/live?relay_ticket=test");
      await opening;

      expect(cancel).toHaveBeenCalledTimes(1);
      expect(socketCount).toBe(0);
    } finally {
      global.WebSocket = OriginalWebSocket;
    }
  });

  it("stops native PCM without closing a warm relay or output session, then re-arms on a later tap", async () => {
    const OriginalWebSocket = global.WebSocket;
    let socket: FakeWebSocket | null = null;
    let callbacks:
      | Parameters<OneVoiceRealtimeAudioInput["start"]>[0]
      | undefined;
    const start = vi.fn(async (options: Parameters<OneVoiceRealtimeAudioInput["start"]>[0]) => {
      callbacks = options;
      return { sessionId: "pcm_1" };
    });
    const stop = vi.fn(async () => undefined);
    const input = {
      source: "ios_native_pcm",
      start,
      stop,
      cancel: vi.fn(async () => undefined),
    } satisfies OneVoiceRealtimeAudioInput;
    class FakeWebSocket {
      readyState = WebSocket.OPEN;
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      send = vi.fn();
      close = vi.fn();

      constructor() {
        socket = this;
      }
    }

    try {
      // @ts-expect-error -- minimal WebSocket test double
      global.WebSocket = FakeWebSocket;
      const onEvent = vi.fn();
      const transport = new GeminiLiveClient({ onEvent });
      const connection = transport as unknown as {
        outputContext: AudioContext | null;
      };
      const outputClose = vi.fn(async () => undefined);
      const outputContext = {
        close: outputClose,
      } as unknown as AudioContext;
      connection.outputContext = outputContext;

      await transport.start({
        relayUrl: "wss://example.test/relay",
        realtimeAudioInput: input,
        deferAudioInput: true,
      });
      await expect(transport.startAudioInput()).resolves.toBe(true);
      const sessionId = callbacks?.sessionId;
      expect(sessionId).toMatch(/^gemini_live_/);

      await transport.stopAudioInput();

      expect(stop).toHaveBeenCalledTimes(1);
      expect(transport.isAudioInputActive()).toBe(false);
      expect(socket?.close).not.toHaveBeenCalled();
      expect(connection.outputContext).toBe(outputContext);
      expect(outputClose).not.toHaveBeenCalled();

      // The listener instance supplied to the first arm must be inert after
      // capture stops; its stale PCM cannot cross into the warm session.
      onEvent.mockClear();
      callbacks?.onFrame({
        sessionId: sessionId || "missing",
        sequence: 1,
        sampleRate: 16_000,
        channels: 1,
        encoding: "pcm_s16le",
        bytes: new Uint8Array([1, 0]),
      });
      expect(onEvent).not.toHaveBeenCalled();

      await expect(transport.startAudioInput()).resolves.toBe(true);
      expect(start).toHaveBeenCalledTimes(2);
      expect(socket?.close).not.toHaveBeenCalled();

      transport.stop();
    } finally {
      global.WebSocket = OriginalWebSocket;
    }
  });

  it("releases browser PCM nodes and tracks without closing the warm transport", async () => {
    const disconnectCapture = vi.fn();
    const disconnectSource = vi.fn();
    const stopTrack = vi.fn();
    const closeInput = vi.fn(async () => undefined);
    const closeOutput = vi.fn(async () => undefined);
    const closeSocket = vi.fn();
    const transport = new GeminiLiveClient();
    const connection = transport as unknown as {
      audioInputStarted: boolean;
      captureNode: AudioWorkletNode | null;
      sourceNode: MediaStreamAudioSourceNode | null;
      mediaStream: MediaStream | null;
      inputContext: AudioContext | null;
      outputContext: AudioContext | null;
      ws: { close: () => void } | null;
    };
    connection.audioInputStarted = true;
    connection.captureNode = {
      port: { onmessage: () => undefined },
      disconnect: disconnectCapture,
    } as unknown as AudioWorkletNode;
    connection.sourceNode = {
      disconnect: disconnectSource,
    } as unknown as MediaStreamAudioSourceNode;
    connection.mediaStream = {
      getTracks: () => [{ stop: stopTrack }],
    } as unknown as MediaStream;
    connection.inputContext = {
      close: closeInput,
    } as unknown as AudioContext;
    const outputContext = {
      close: closeOutput,
    } as unknown as AudioContext;
    connection.outputContext = outputContext;
    connection.ws = { close: closeSocket };

    await transport.stopAudioInput();

    expect(disconnectCapture).toHaveBeenCalledTimes(1);
    expect(disconnectSource).toHaveBeenCalledTimes(1);
    expect(stopTrack).toHaveBeenCalledTimes(1);
    expect(closeInput).toHaveBeenCalledTimes(1);
    expect(connection.outputContext).toBe(outputContext);
    expect(closeOutput).not.toHaveBeenCalled();
    expect(closeSocket).not.toHaveBeenCalled();
    expect(transport.isAudioInputActive()).toBe(false);
  });

  it("does not re-arm capture when a stop arrives during native startup", async () => {
    const OriginalWebSocket = global.WebSocket;
    let resolveStart: ((value: { sessionId: string }) => void) | null = null;
    const start = vi.fn(
      () =>
        new Promise<{ sessionId: string }>((resolve) => {
          resolveStart = resolve;
        }),
    );
    const stop = vi.fn(async () => undefined);
    const input = {
      source: "ios_native_pcm",
      start,
      stop,
    } satisfies OneVoiceRealtimeAudioInput;
    class FakeWebSocket {
      readyState = 0;
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      send = vi.fn();
      close = vi.fn();
    }

    try {
      // @ts-expect-error -- minimal WebSocket test double
      global.WebSocket = FakeWebSocket;
      const transport = new GeminiLiveClient();
      await transport.start({
        relayUrl: "wss://example.test/relay",
        realtimeAudioInput: input,
        deferAudioInput: true,
      });

      const opening = transport.startAudioInput();
      const stopping = transport.stopAudioInput();
      resolveStart?.({ sessionId: "pcm_1" });

      await expect(opening).resolves.toBe(false);
      await stopping;
      expect(stop).toHaveBeenCalledTimes(1);
      expect(transport.isAudioInputActive()).toBe(false);

      transport.stop();
    } finally {
      global.WebSocket = OriginalWebSocket;
    }
  });

  it("uses native cancel as a fail-closed fallback when ordinary capture stop fails", async () => {
    const stop = vi.fn(async () => {
      throw new Error("native_stop_failed");
    });
    const cancel = vi.fn(async () => undefined);
    const input = {
      source: "ios_native_pcm",
      start: vi.fn(async () => ({ sessionId: "pcm_1" })),
      stop,
      cancel,
    } satisfies OneVoiceRealtimeAudioInput;
    const transport = new GeminiLiveClient();
    const connection = transport as unknown as {
      audioInputStarted: boolean;
      realtimeAudioInput: OneVoiceRealtimeAudioInput | null;
    };
    connection.audioInputStarted = true;
    connection.realtimeAudioInput = input;

    await transport.stopAudioInput();

    expect(stop).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(transport.isAudioInputActive()).toBe(false);
  });

  it("passes a suppressed server greeting across a no-mic foreground warm bootstrap", async () => {
    const OriginalWebSocket = global.WebSocket;
    let socket: FakeWebSocket | null = null;
    class FakeWebSocket {
      readyState = 0;
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      send = vi.fn();
      close = vi.fn();

      constructor() {
        socket = this;
      }
    }

    try {
      // @ts-expect-error -- minimal WebSocket test double
      global.WebSocket = FakeWebSocket;
      const transport = new GeminiLiveClient();
      await transport.start({
        relayUrl: "wss://example.test/relay",
        deferAudioInput: true,
        initialGreetingEnabled: false,
        activationSource: "foreground_warm",
      });

      socket?.onopen?.();
      const bootstrap = JSON.parse(socket?.send.mock.calls[0]?.[0] || "{}");
      expect(bootstrap).toMatchObject({
        type: "runtime_bootstrap",
        initial_greeting_enabled: false,
        activation_source: "foreground_warm",
      });
      expect(transport.isAudioInputActive()).toBe(false);

      transport.stop();
    } finally {
      global.WebSocket = OriginalWebSocket;
    }
  });

  it("accepts only the fixed server greeting directive and exposes capture after output settles", async () => {
    const onEvent = vi.fn();
    const transport = new GeminiLiveClient({ onEvent });
    const startAudioInput = vi.spyOn(transport, "startAudioInput");
    let settlePlayback: ((played: boolean) => void) | undefined;
    const connection = transport as unknown as {
      relayAccepted: boolean;
      providerReady: boolean;
      initialContextReady: boolean;
      speakText: (input: {
        text: string;
        segmentType?: "ack" | "final";
        controlKind?: "fresh_session_greeting";
        onPlaybackSettled?: (played: boolean) => void;
      }) => Promise<boolean>;
      handleSocketMessage: (data: unknown) => Promise<void>;
    };
    connection.relayAccepted = true;
    connection.providerReady = true;
    connection.initialContextReady = true;
    connection.speakText = vi.fn(async (input) => {
      settlePlayback = input.onPlaybackSettled;
      return true;
    });

    await connection.handleSocketMessage(
      JSON.stringify({
        greetingDirective: {
          kind: "fresh_session",
          text: "Hello, how can I help you today?",
          followUpWindowMs: 10_000,
        },
      }),
    );
    await Promise.resolve();

    expect(connection.speakText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Hello, how can I help you today?",
        segmentType: "final",
        controlKind: "fresh_session_greeting",
      }),
    );
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "greeting" }),
    );
    expect(onEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "greeting_playback_settled" }),
    );
    // Transport itself never opens the microphone for a greeting. AgentBar
    // must wait for the settled boundary before trying the eligible capture
    // arm, so One cannot hear its own output.
    expect(startAudioInput).not.toHaveBeenCalled();

    settlePlayback?.(true);
    await Promise.resolve();
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "greeting_playback_settled",
        played: true,
      }),
    );

    await connection.handleSocketMessage(
      JSON.stringify({
        greetingDirective: {
          kind: "fresh_session",
          text: "Untrusted greeting",
          followUpWindowMs: 10_000,
        },
      }),
    );
    expect(connection.speakText).toHaveBeenCalledTimes(1);
  });

  it("fences a pending fixed greeting before a person opens warm-session PCM", async () => {
    const onEvent = vi.fn();
    const transport = new GeminiLiveClient({ onEvent });
    const connection = transport as unknown as {
      serverGreetingDirectiveReceived: boolean;
      serverGreetingSpeechRequested: boolean;
      emitServerGreetingPlaybackSettled: (played: boolean) => void;
    };
    connection.serverGreetingDirectiveReceived = true;
    connection.serverGreetingSpeechRequested = true;
    const interrupt = vi.spyOn(transport, "interrupt");

    transport.cancelGreetingOutput();
    // A late drain callback from the canceled app_speech bridge must not arm
    // a follow-up microphone window after the person's tap has claimed it.
    connection.emitServerGreetingPlaybackSettled(true);

    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(onEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "greeting_playback_settled" }),
    );
  });

  it("resumes a warmed client's owned output context from the later physical tap", async () => {
    const resume = vi.fn(async () => undefined);
    const transport = new GeminiLiveClient();
    const connection = transport as unknown as {
      outputContext: AudioContext | null;
      outputResumePromise: Promise<void> | null;
    };
    // Simulate the context a background greeting already claimed from the
    // global priming slot. A pending background resume must not prevent the
    // user-gesture retry from calling resume on THIS context.
    connection.outputContext = {
      state: "suspended",
      currentTime: 0,
      resume,
    } as unknown as AudioContext;
    connection.outputResumePromise = new Promise<void>(() => undefined);

    transport.resumeOutputForUserGesture();

    expect(resume).toHaveBeenCalledTimes(1);
    await Promise.resolve();
  });

  it("starts the speech adapter before relay discovery and retains an early final", async () => {
    const OriginalWebSocket = global.WebSocket;
    const order: string[] = [];
    // Keep this fake deliberately small: the contract test is about ordering
    // and the context barrier, not browser audio implementation details.
    let onEvent: SpeechAdapterCallbacks["onEvent"] | undefined;
    const speechAdapter = {
      provider: "test_local_speech",
      onDevice: true,
      setCallbacks: vi.fn((callbacks: SpeechAdapterCallbacks) => {
        onEvent = callbacks.onEvent;
      }),
      start: vi.fn(async () => {
        order.push("speech");
        onEvent?.({
          sessionId: "speech_1",
          sequence: 1,
          kind: "final",
          text: "create a circle called Family",
          provider: "test_local_speech",
          onDevice: true,
        });
        return {
          sessionId: "speech_1",
          provider: "test_local_speech",
          onDevice: true,
        };
      }),
      stop: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
    } satisfies OneVoiceSpeechAdapter;

    class FakeWebSocket {
      readyState = 0;
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      send = vi.fn();
      close = vi.fn();

      constructor() {
        order.push("socket");
      }
    }

    const relayLookup = vi
      .spyOn(ApiService, "getOneAdkLiveRelayUrl")
      .mockImplementation(async () => {
        order.push("relay");
        return "wss://example.test/relay";
      });

    try {
      // @ts-expect-error -- minimal WebSocket test double
      global.WebSocket = FakeWebSocket;
      const transport = new GeminiLiveClient();
      await transport.start({ speechAdapter });

      expect(order).toEqual(["speech", "relay", "socket"]);
      const connection = transport as unknown as {
        pendingSpeechEvents: { size: number };
      };
      expect(connection.pendingSpeechEvents.size).toBe(1);
      transport.stop();
    } finally {
      relayLookup.mockRestore();
      global.WebSocket = OriginalWebSocket;
    }
  });

  it("buffers platform speech finals until context is acknowledged", () => {
    const onEvent = vi.fn();
    const transport = new GeminiLiveClient({ onEvent });
    const connection = transport as unknown as {
      initialContextReady: boolean;
      handleSpeechAdapterEvent: (event: {
        sessionId: string;
        sequence: number;
        kind: "final";
        text: string;
        provider: string;
        onDevice: boolean;
      }) => void;
      flushPendingSpeechEvents: () => void;
    };

    connection.handleSpeechAdapterEvent({
      sessionId: "speech_1",
      sequence: 1,
      kind: "final",
      text: "create a circle called Family",
      provider: "apple_speech",
      onDevice: true,
    });
    expect(onEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "transcript_final" }),
    );

    connection.initialContextReady = true;
    connection.flushPendingSpeechEvents();
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "transcript_final",
        source: "input",
        text: "create a circle called Family",
        transcriptProvider: "apple_speech",
        onDevice: true,
      }),
    );
  });

  it("does not claim Listening or send PCM until relay, provider, and context are all ready", async () => {
    const onEvent = vi.fn();
    const send = vi.fn();
    const transport = new GeminiLiveClient({ onEvent });
    const connection = transport as unknown as {
      ws: { readyState: number; send: (message: string) => void };
      startContext: unknown;
      audioInputStarted: boolean;
      relayAccepted: boolean;
      providerReady: boolean;
      initialContextReady: boolean;
      bufferedVisitorSpeechFrames: Uint8Array[];
      bufferedVisitorSpeechDurationMs: number;
      sendVisitorActivityStart: (level: number, pcm: Uint8Array) => boolean;
      handleSocketMessage: (data: unknown) => Promise<void>;
    };
    connection.ws = { readyState: WebSocket.OPEN, send };
    connection.audioInputStarted = true;
    connection.startContext = {
      snapshot_id: "ctx-readiness-1",
      route: {
        screen: "one_intro",
        route_family: "/",
        playbook_id: "route.home",
      },
      revisions: { route: 1, ui: 1 },
      auth: { signed_in: false },
      persona: { active: "default" },
      voice: { state: "idle" },
      available_action_ids: ["onboarding.claim_one"],
      ui: { visible_modules: [], visible_control_ids: [] },
      pending_settlement: false,
      cache: { freshness: "fresh", vault_ready: false, portfolio_ready: false },
      onboarding: { phase: "anonymous_auth" },
    };

    await connection.handleSocketMessage(JSON.stringify({ relayAccepted: {} }));
    expect(connection.relayAccepted).toBe(true);
    expect(connection.providerReady).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(send.mock.calls[0]?.[0] || "{}")).toMatchObject({
      type: "app_context",
      contextId: "ctx-readiness-1:settled",
    });

    // A long pre-provider burst retains up to ten seconds by PCM duration,
    // independent of the browser/native frame size, and no activity or PCM
    // crosses the socket yet.
    const pcm = new Uint8Array(3_200); // 100 ms at 16 kHz mono PCM16.
    for (let frame = 0; frame < 80; frame += 1) {
      connection.sendVisitorActivityStart(0.5, pcm);
    }
    expect(connection.bufferedVisitorSpeechFrames).toHaveLength(80);
    expect(connection.bufferedVisitorSpeechDurationMs).toBe(8_000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(onEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "state", state: "listening" }),
    );

    await connection.handleSocketMessage(
      JSON.stringify({
        appContextAccepted: { contextId: "ctx-readiness-1:settled" },
      }),
    );
    await Promise.resolve();
    expect(connection.initialContextReady).toBe(true);
    expect(connection.providerReady).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    expect(onEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "state", state: "listening" }),
    );

    await connection.handleSocketMessage(JSON.stringify({ providerReady: {} }));

    expect(connection.providerReady).toBe(true);
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "state", state: "listening" }),
    );
    expect(JSON.parse(send.mock.calls[1]?.[0] || "{}")).toEqual({
      type: "voice_activity_start",
    });
    expect(JSON.parse(send.mock.calls[2]?.[0] || "{}")).toMatchObject({
      realtimeInput: { audio: { data: expect.any(String) } },
    });
    // The remaining retained frames drain on their actual PCM duration rather
    // than becoming an unsafe post-readiness WebSocket burst.
    transport.stop();
  });

  it("returns a typed disconnected result instead of throwing from an absent socket", async () => {
    const transport = new GeminiLiveClient();

    await expect(
      transport.confirmActionDirective({
        directiveId: "directive_1",
        actionId: "one.navigate",
        contextRevision: "revision_1",
        confirmationMethod: "tap",
      }),
    ).rejects.toThrow("Voice confirmation is not connected.");
  });

  it("sends one confirmation through its connected receiver and rejects a replay", async () => {
    vi.useFakeTimers();
    try {
      const send = vi.fn();
      const transport = new GeminiLiveClient();
      const connection = transport as unknown as {
        ws: { readyState: number; send: (message: string) => void };
        setupComplete: boolean;
      };
      connection.ws = { readyState: WebSocket.OPEN, send };
      connection.setupComplete = true;

      const first = transport.confirmActionDirective({
        directiveId: "directive_1",
        actionId: "one.navigate",
        contextRevision: "revision_1",
        confirmationMethod: "voice",
      });
      expect(send).toHaveBeenCalledWith(
        JSON.stringify({
          type: "action_confirm",
          actionConfirmation: {
            directiveId: "directive_1",
            actionId: "one.navigate",
            contextRevision: "revision_1",
            confirmationMethod: "voice",
          },
        }),
      );
      const timeoutResult = expect(first).rejects.toThrow(
        "Voice confirmation timed out.",
      );
      await expect(
        transport.confirmActionDirective({
          directiveId: "directive_1",
          actionId: "one.navigate",
          contextRevision: "revision_1",
          confirmationMethod: "tap",
        }),
      ).rejects.toThrow("Voice confirmation is already pending.");

      await vi.advanceTimersByTimeAsync(5_000);
      await timeoutResult;
    } finally {
      vi.useRealTimers();
    }
  });

  it("submits a local catalog proposal only after context is ready", async () => {
    const send = vi.fn();
    const transport = new GeminiLiveClient();
    const connection = transport as unknown as {
      ws: { readyState: number; send: (message: string) => void };
      setupComplete: boolean;
      initialContextReady: boolean;
      handleSocketMessage: (data: unknown) => Promise<void>;
    };
    connection.ws = { readyState: WebSocket.OPEN, send };
    connection.setupComplete = true;
    connection.initialContextReady = true;

    const pending = transport.proposeLocalAction({
      actionId: "location.create_circle",
      slots: { name: "Family" },
      contextRevision: "route-1:ui-1",
      needsConfirmation: true,
    });
    const frame = JSON.parse(send.mock.calls[0]?.[0] || "{}");
    expect(frame.type).toBe("action_propose");
    expect(frame.actionProposal).toMatchObject({
      actionId: "location.create_circle",
      slots: { name: "Family" },
      contextRevision: "route-1:ui-1",
    });

    await connection.handleSocketMessage(
      JSON.stringify({
        localActionProposalAccepted: {
          proposalId: frame.actionProposal.proposalId,
        },
      }),
    );
    await expect(pending).resolves.toBe(true);
  });

  it("fails a local proposal when the relay rejects its authority boundary", async () => {
    const send = vi.fn();
    const transport = new GeminiLiveClient();
    const connection = transport as unknown as {
      ws: { readyState: number; send: (message: string) => void };
      setupComplete: boolean;
      initialContextReady: boolean;
      handleSocketMessage: (data: unknown) => Promise<void>;
    };
    connection.ws = { readyState: WebSocket.OPEN, send };
    connection.setupComplete = true;
    connection.initialContextReady = true;

    const pending = transport.proposeLocalAction({
      actionId: "location.trigger_sos",
      contextRevision: "route-1:ui-1",
      needsConfirmation: false,
    });
    const frame = JSON.parse(send.mock.calls[0]?.[0] || "{}");
    await connection.handleSocketMessage(
      JSON.stringify({
        localActionProposalRejected: {
          proposalId: frame.actionProposal.proposalId,
          code: "sos_send_blocked",
        },
      }),
    );
    await expect(pending).resolves.toBe(false);
  });
});

describe("GeminiLiveClient socket startup error ordering", () => {
  it("prefers the safe close reason when WebSocket error is followed by close", async () => {
    vi.useFakeTimers();
    const OriginalWebSocket = global.WebSocket;
    let socket: FakeWebSocket | null = null;
    class FakeWebSocket {
      readyState = WebSocket.OPEN;
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      send = vi.fn();
      close = vi.fn();

      constructor() {
        socket = this;
      }
    }

    try {
      // @ts-expect-error -- minimal WebSocket test double
      global.WebSocket = FakeWebSocket;
      const onError = vi.fn();
      const transport = new GeminiLiveClient({ onError });
      await transport.start({
        relayUrl: "wss://example.test/relay",
        deferAudioInput: true,
      });

      socket?.onerror?.();
      expect(onError).not.toHaveBeenCalled();

      socket?.onclose?.({
        code: 1008,
        reason: "permission_denied",
        wasClean: false,
      } as CloseEvent);

      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith(
        "Voice is not enabled for this workspace yet. The Gemini project needs Live API access.",
        expect.anything(),
      );

      // The cancelled generic fallback cannot issue a second terminal error.
      await vi.advanceTimersByTimeAsync(200);
      expect(onError).toHaveBeenCalledTimes(1);
    } finally {
      global.WebSocket = OriginalWebSocket;
      vi.useRealTimers();
    }
  });

  it("keeps the generic error fallback when no close event follows", async () => {
    vi.useFakeTimers();
    const OriginalWebSocket = global.WebSocket;
    let socket: FakeWebSocket | null = null;
    class FakeWebSocket {
      readyState = WebSocket.OPEN;
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      send = vi.fn();
      close = vi.fn();

      constructor() {
        socket = this;
      }
    }

    try {
      // @ts-expect-error -- minimal WebSocket test double
      global.WebSocket = FakeWebSocket;
      const onError = vi.fn();
      const transport = new GeminiLiveClient({ onError });
      await transport.start({
        relayUrl: "wss://example.test/relay",
        deferAudioInput: true,
      });

      socket?.onerror?.();
      await vi.advanceTimersByTimeAsync(99);
      expect(onError).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith(
        "Gemini Live connection error.",
        expect.anything(),
      );

      await vi.advanceTimersByTimeAsync(200);
      expect(onError).toHaveBeenCalledTimes(1);
    } finally {
      global.WebSocket = OriginalWebSocket;
      vi.useRealTimers();
    }
  });

  it("cancels a pending generic socket error when the transport stops", async () => {
    vi.useFakeTimers();
    const OriginalWebSocket = global.WebSocket;
    let socket: FakeWebSocket | null = null;
    class FakeWebSocket {
      readyState = WebSocket.OPEN;
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      send = vi.fn();
      close = vi.fn();

      constructor() {
        socket = this;
      }
    }

    try {
      // @ts-expect-error -- minimal WebSocket test double
      global.WebSocket = FakeWebSocket;
      const onError = vi.fn();
      const transport = new GeminiLiveClient({ onError });
      await transport.start({
        relayUrl: "wss://example.test/relay",
        deferAudioInput: true,
      });

      socket?.onerror?.();
      transport.stop();
      await vi.advanceTimersByTimeAsync(200);

      expect(onError).not.toHaveBeenCalled();
    } finally {
      global.WebSocket = OriginalWebSocket;
      vi.useRealTimers();
    }
  });
});

describe("GeminiLiveClient mid-call session frames", () => {
  // Both simulate an incoming relay frame by calling the private socket
  // message handler directly with a JSON string, the same way `ws.onmessage`
  // does -- there is no real WebSocket in this environment to send one on.

  it("routes a relay-classified sessionEnded through the same error path pre-setup failures use", async () => {
    const onError = vi.fn();
    const onEvent = vi.fn();
    const transport = new GeminiLiveClient({ onError, onEvent });
    const connection = transport as unknown as {
      handleSocketMessage: (data: unknown) => Promise<void>;
    };

    await connection.handleSocketMessage(
      JSON.stringify({ sessionEnded: { reason: "provider_unavailable", resumable: true } }),
    );

    expect(onError).toHaveBeenCalledWith(
      "Voice is temporarily unavailable. Try again in a moment.",
      expect.anything(),
    );
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error" }),
    );
  });

  it("gives every sessionEnded reason its own message, not a generic fallback", async () => {
    const cases: Array<[string, boolean, string]> = [
      ["unknown_tool_call", true, "One hit a snag with that request. Try again."],
      [
        "runtime_error",
        false,
        "Something went wrong with the voice connection. Try again.",
      ],
      [
        "something_new_the_relay_added_later",
        true,
        "Voice session ended. Try again in a moment.",
      ],
    ];
    for (const [reason, resumable, expected] of cases) {
      const onError = vi.fn();
      const transport = new GeminiLiveClient({ onError });
      const connection = transport as unknown as {
        handleSocketMessage: (data: unknown) => Promise<void>;
      };
      await connection.handleSocketMessage(
        JSON.stringify({ sessionEnded: { reason, resumable } }),
      );
      expect(onError).toHaveBeenCalledWith(expected, expect.anything());
    }
  });

  it("does not fail the session on a goAway warning, and does not crash without a timeLeft", async () => {
    const onError = vi.fn();
    const transport = new GeminiLiveClient({ onError });
    const connection = transport as unknown as {
      handleSocketMessage: (data: unknown) => Promise<void>;
    };

    await connection.handleSocketMessage(JSON.stringify({ goAway: { timeLeft: "30s" } }));
    await connection.handleSocketMessage(JSON.stringify({ goAway: { timeLeft: null } }));

    expect(onError).not.toHaveBeenCalled();
  });

  it("marks a sessionEnded's resumability on the emitted error event", async () => {
    const onEvent = vi.fn();
    const transport = new GeminiLiveClient({ onEvent });
    const connection = transport as unknown as {
      handleSocketMessage: (data: unknown) => Promise<void>;
    };

    await connection.handleSocketMessage(
      JSON.stringify({ sessionEnded: { reason: "provider_unavailable", resumable: true } }),
    );

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", resumable: true }),
    );
  });

  it("treats a completed Location command boundary rollover as a quiet fresh-session boundary", async () => {
    const onError = vi.fn();
    const onEvent = vi.fn();
    const transport = new GeminiLiveClient({ onError, onEvent });
    const connection = transport as unknown as {
      handleSocketMessage: (data: unknown) => Promise<void>;
    };

    await connection.handleSocketMessage(
      JSON.stringify({
        sessionEnded: { reason: "location_command_boundary_rollover", resumable: true },
      }),
    );

    expect(onError).not.toHaveBeenCalled();
    expect(onEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "closed" }));
  });
});

describe("GeminiLiveClient per-utterance activity signal", () => {
  // voice_activity_start tells the backend "this is fresh speech" -- several
  // guards there are keyed on it meaning that: the per-turn dedupe clear,
  // the already-completed/already-failed loop guards, stale directive
  // disarming. If it only ever fires once for the whole socket instead of
  // once per utterance, all of those silently stop working after the first
  // thing the visitor says, for the rest of the call.

  it("resets after the model's turn completes, so the next utterance sends a fresh signal", async () => {
    const transport = new GeminiLiveClient();
    const connection = transport as unknown as {
      handleSocketMessage: (data: unknown) => Promise<void>;
      visitorActivitySent: boolean;
    };
    connection.visitorActivitySent = true;

    await connection.handleSocketMessage(
      JSON.stringify({ serverContent: { turnComplete: true } }),
    );

    expect(connection.visitorActivitySent).toBe(false);
  });

  it("resets after an interrupted model turn too", async () => {
    const transport = new GeminiLiveClient();
    const connection = transport as unknown as {
      handleSocketMessage: (data: unknown) => Promise<void>;
      visitorActivitySent: boolean;
    };
    connection.visitorActivitySent = true;

    await connection.handleSocketMessage(
      JSON.stringify({ serverContent: { interrupted: true } }),
    );

    expect(connection.visitorActivitySent).toBe(false);
  });

  it("keeps a bounded speech onset until setup and context acknowledgement", () => {
    const send = vi.fn();
    const transport = new GeminiLiveClient();
    const connection = transport as unknown as {
      sendVisitorActivityStart: (level: number, pcm: Uint8Array) => boolean;
      flushBufferedSpeechOnset: () => void;
      ws: { readyState: number; send: (message: string) => void };
      setupComplete: boolean;
      initialContextReady: boolean;
      speechOnsetReady: boolean;
      bufferedVisitorSpeechFrames: Uint8Array[];
      bufferedVisitorSpeechDurationMs: number;
    };
    const pcm = new Uint8Array([1, 2, 3]);

    for (let frame = 0; frame < 8; frame += 1) {
      expect(connection.sendVisitorActivityStart(0.5, pcm)).toBe(false);
    }
    expect(connection.speechOnsetReady).toBe(true);
    expect(connection.bufferedVisitorSpeechFrames).toHaveLength(8);

    // A pause before the network handshake must not erase the captured onset.
    expect(connection.sendVisitorActivityStart(0, pcm)).toBe(false);
    expect(connection.bufferedVisitorSpeechFrames).toHaveLength(8);

    connection.ws = { readyState: WebSocket.OPEN, send };
    connection.setupComplete = true;
    connection.initialContextReady = true;
    connection.flushBufferedSpeechOnset();

    expect(send.mock.calls[0]?.[0]).toBe(
      JSON.stringify({ type: "voice_activity_start" }),
    );
    // One first frame is delivered immediately; the retained remainder is
    // deliberately duration-paced instead of bursting in this same tick.
    expect(send).toHaveBeenCalledTimes(2);
    expect(connection.speechOnsetReady).toBe(false);
    expect(connection.bufferedVisitorSpeechFrames).toHaveLength(0);
    expect(connection.bufferedVisitorSpeechDurationMs).toBe(0);
    transport.stop();
  });

  it("caps a slow-start PCM ring at ten seconds and cancels its drain when capture closes", () => {
    vi.useFakeTimers();
    try {
      const send = vi.fn();
      const transport = new GeminiLiveClient();
      const connection = transport as unknown as {
        sendVisitorActivityStart: (level: number, pcm: Uint8Array) => boolean;
        ws: { readyState: number; send: (message: string) => void };
        setupComplete: boolean;
        initialContextReady: boolean;
        pendingRealtimeAudioFrames: Uint8Array[];
        pendingRealtimeAudioDurationMs: number;
        preReadyAudioDrainTimer: ReturnType<typeof setTimeout> | null;
        sendOrQueueRealtimeAudio: (pcm: Uint8Array) => void;
      };
      // Use a 100 ms frame to model both a fine-grained native bridge and a
      // coarser browser worklet without making the assertion frame-count
      // dependent. The oldest data is evicted after ten seconds.
      const pcm = new Uint8Array(3_200);
      connection.ws = { readyState: WebSocket.OPEN, send };
      connection.setupComplete = true;
      connection.initialContextReady = true;

      for (let frame = 0; frame < 120; frame += 1) {
        if (connection.sendVisitorActivityStart(0.5, pcm)) {
          connection.sendOrQueueRealtimeAudio(pcm);
        }
      }

      expect(connection.pendingRealtimeAudioDurationMs).toBeLessThanOrEqual(
        10_000,
      );
      expect(connection.pendingRealtimeAudioFrames).toHaveLength(100);
      // One activity control and exactly one first PCM frame may be sent in
      // the same tick; later frames are paced by their sample duration.
      expect(send).toHaveBeenCalledTimes(2);

      transport.stop();
      expect(connection.preReadyAudioDrainTimer).toBeNull();
      vi.advanceTimersByTime(20_000);
      expect(send).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("GeminiLiveClient Location command turns", () => {
  function permissionRunResultSource() {
    const contract = ONE_LOCATION_WORKFLOW_CARD_CATALOG.variants.find(
      (candidate) => candidate.contractId === "one.location.permission_result.v2",
    )!;
    const directive = {
      schemaVersion: "one.location_interaction_directive.v1",
      directiveId: "locdirective_abcdefghijklmnop",
      contractId: contract.contractId,
      kind: contract.kind,
      surfaceId: "render.one_location_workflow_card",
      titleKey: contract.titleKey,
      bodyKey: contract.bodyKey,
      allowedResults: contract.results.map((entry) => entry.result),
      expiresAt: "2099-09-10T00:00:00.000Z",
      lease: { leaseId: "loclease_abcdefghijklmnop", runRevision: 2 },
    };
    return {
      schemaVersion: "one.location_onboarding_run_result.v1",
      run: {
        schemaVersion: "one.location_run_projection.v1",
        workflowId: "workflow.setup.location",
        workflowVersion: ONE_LOCATION_WORKFLOW_CARD_CATALOG.workflowVersion,
        graphRevision: ONE_LOCATION_WORKFLOW_CARD_CATALOG.graphRevision,
        runId: "run_abcdefghijklmnop",
        revision: 2,
        status: "interaction_required",
        cursor: "location.onboarding.permission",
        completionClaimAllowed: false,
        pendingDirective: directive,
        evidence: {
          permission: false,
          place: false,
          circle: false,
          completion: false,
        },
        draft: null,
        pkmFinalizeAuthorization: null,
      },
      directive,
      waitingReason: null,
    };
  }

  function commandEventTypes(onEvent: ReturnType<typeof vi.fn>): string[] {
    return onEvent.mock.calls
      .map(([event]) => event)
      .filter(
        (event): event is { type: string } =>
          Boolean(event) && typeof event === "object" && "type" in event,
      )
      .map((event) => event.type);
  }

  async function markSessionCommandReady(input: {
    handleSocketMessage: (data: unknown) => Promise<void>;
  }): Promise<void> {
    await input.handleSocketMessage(
      JSON.stringify({
        locationCommandReady: {
          protocolVersion: "one_command_v2",
          relayAccepted: true,
          providerReady: true,
          contextAccepted: true,
        },
      }),
    );
  }

  async function markCommandSpeechEnded(input: {
    connection: {
      handleSocketMessage: (data: unknown) => Promise<void>;
    };
    turnId: string;
  }): Promise<void> {
    await input.connection.handleSocketMessage(
      JSON.stringify({
        locationCommandState: {
          protocolVersion: "one_command_v2",
          turnId: input.turnId,
          state: "speech_ended",
        },
      }),
    );
  }

  it("uses tap-start plus provider speech-end, never RMS or raw transcript/directive output", async () => {
    vi.useFakeTimers();
    try {
      const send = vi.fn();
      const onEvent = vi.fn();
      const transport = new GeminiLiveClient({ onEvent });
      const connection = transport as unknown as {
        ws: { readyState: number; send: (message: string) => void };
        relayAccepted: boolean;
        providerReady: boolean;
        initialContextReady: boolean;
        audioInputStarted: boolean;
        locationCommandMode: boolean;
        locationCommandSessionReady: boolean;
        handleCapturedPcm: (
          pcm: Uint8Array,
          level: number,
          source: "browser_pcm" | "ios_native_pcm",
        ) => void;
        handleSocketMessage: (data: unknown) => Promise<void>;
      };
      connection.ws = { readyState: WebSocket.OPEN, send };
      connection.relayAccepted = true;
      connection.providerReady = true;
      connection.initialContextReady = true;
      connection.audioInputStarted = true;
      connection.locationCommandMode = true;

      // The command relay declares readiness once per authenticated socket,
      // before a command tap. A later tap must inherit this state rather
      // than wait for a nonexistent per-turn ready frame.
      await markSessionCommandReady(connection);
      expect(connection.locationCommandSessionReady).toBe(true);

      expect(transport.beginInputTurn?.({ turnId: "location-turn-1" })).toBe(true);
      // A deliberately quiet frame proves command admission does not wait for
      // the old RMS/eight-frame visitor-activity gate.
      connection.handleCapturedPcm(
        new Uint8Array(3_200),
        0,
        "browser_pcm",
      );

      expect(JSON.parse(send.mock.calls[0]?.[0] as string)).toEqual({
        type: "location_command_begin",
        protocolVersion: "one_command_v2",
        turnId: "location-turn-1",
        startSequence: 1,
      });
      expect(JSON.parse(send.mock.calls[1]?.[0] as string)).toMatchObject({
        realtimeInput: {
          audio: { mimeType: "audio/pcm;rate=16000" },
          locationCommand: { turnId: "location-turn-1", sequence: 1 },
        },
      });
      expect(send).not.toHaveBeenCalledWith(
        JSON.stringify({ type: "voice_activity_start" }),
      );

      await markCommandSpeechEnded({
        connection,
        turnId: "location-turn-1",
      });
      await connection.handleSocketMessage(
        JSON.stringify({
          locationCommandResult: {
            protocolVersion: "one_command_v2",
            turnId: "location-turn-1",
            outcome: "interaction_required",
            ...permissionRunResultSource(),
          },
          clientDirective: {
            kind: "action",
            turnId: "location-turn-1",
            payload: { actionId: "location.create_circle" },
          },
        }),
      );
      expect(commandEventTypes(onEvent)).not.toContain("client_directive");
      expect(commandEventTypes(onEvent)).not.toContain("location_command_result");

      await connection.handleSocketMessage(
        JSON.stringify({
          inputTranscription: {
            turnId: "location-turn-1",
            text: "do location onboarding",
          },
          outputTranscription: { text: "This must never be spoken." },
        }),
      );
      // A compatible relay may include input text, but command mode treats it
      // as a private completion marker only. Neither it nor model output can
      // enter the visual/conversational event lane.
      expect(commandEventTypes(onEvent)).not.toContain("transcript_final");
      expect(commandEventTypes(onEvent)).not.toContain("assistant_text");
      await connection.handleSocketMessage(
        JSON.stringify({ serverContent: { turnComplete: true } }),
      );
      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "location_command_result",
          turnId: "location-turn-1",
          outcome: "interaction_required",
          result: expect.objectContaining({
            directive: expect.objectContaining({
              contractId: "one.location.permission_result.v2",
            }),
          }),
        }),
      );
      expect(commandEventTypes(onEvent)).not.toContain("client_directive");
      expect(commandEventTypes(onEvent)).toContain("location_command_endpointed");
      transport.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a tap command and never accepts a stale result", async () => {
    const send = vi.fn();
    const onEvent = vi.fn();
    const transport = new GeminiLiveClient({ onEvent });
    const connection = transport as unknown as {
      ws: { readyState: number; send: (message: string) => void };
      relayAccepted: boolean;
      providerReady: boolean;
      initialContextReady: boolean;
      locationCommandMode: boolean;
      locationCommandSessionReady: boolean;
      handleSocketMessage: (data: unknown) => Promise<void>;
    };
    connection.ws = { readyState: WebSocket.OPEN, send };
    connection.relayAccepted = true;
    connection.providerReady = true;
    connection.initialContextReady = true;
    connection.locationCommandMode = true;
    await markSessionCommandReady(connection);
    expect(connection.locationCommandSessionReady).toBe(true);

    expect(transport.beginInputTurn?.({ turnId: "location-turn-cancel" })).toBe(true);
    expect(
      transport.endInputTurn?.({
        turnId: "location-turn-cancel",
        cancelled: true,
      }),
    ).toBe(true);
    expect(JSON.parse(send.mock.calls.at(-1)?.[0] as string)).toMatchObject({
      type: "location_command_cancel",
      turnId: "location-turn-cancel",
      finalSequence: 0,
      cancelled: true,
    });

    await connection.handleSocketMessage(
      JSON.stringify({
        locationCommandResult: {
          protocolVersion: "one_command_v2",
          turnId: "location-turn-cancel",
          outcome: "interaction_required",
          ...permissionRunResultSource(),
        },
      }),
    );
    expect(commandEventTypes(onEvent)).not.toContain("location_command_result");
    expect(commandEventTypes(onEvent)).not.toContain("client_directive");
    transport.stop();
  });

  it("renders only a payload-free retry when the relay fails before speech end", async () => {
    const send = vi.fn();
    const onEvent = vi.fn();
    const transport = new GeminiLiveClient({ onEvent });
    const connection = transport as unknown as {
      ws: { readyState: number; send: (message: string) => void };
      relayAccepted: boolean;
      providerReady: boolean;
      initialContextReady: boolean;
      locationCommandMode: boolean;
      locationCommandSessionReady: boolean;
      handleSocketMessage: (data: unknown) => Promise<void>;
    };
    connection.ws = { readyState: WebSocket.OPEN, send };
    connection.relayAccepted = true;
    connection.providerReady = true;
    connection.initialContextReady = true;
    connection.locationCommandMode = true;
    await markSessionCommandReady(connection);

    expect(transport.beginInputTurn?.({ turnId: "location-turn-pre-end-failure" })).toBe(true);
    await connection.handleSocketMessage(
      JSON.stringify({
        locationCommandResult: {
          protocolVersion: "one_command_v2",
          turnId: "location-turn-pre-end-failure",
          outcome: "failed",
          reasonCode: "sequence_gap",
        },
      }),
    );

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "location_command_result",
        turnId: "location-turn-pre-end-failure",
        outcome: "failed",
        result: null,
        navigation: null,
        statusCard: null,
      }),
    );

    // A later actionable payload cannot piggyback on the failed turn before
    // the transcript + speech-end fence exists.
    await connection.handleSocketMessage(
      JSON.stringify({
        locationCommandResult: {
          protocolVersion: "one_command_v2",
          turnId: "location-turn-pre-end-failure",
          outcome: "interaction_required",
          ...permissionRunResultSource(),
        },
      }),
    );
    expect(commandEventTypes(onEvent).filter((type) => type === "location_command_result")).toHaveLength(1);
    transport.stop();
  });

  it("fails closed when a command relay omits the negotiated protocol version", async () => {
    const onEvent = vi.fn();
    const transport = new GeminiLiveClient({ onEvent });
    const connection = transport as unknown as {
      ws: { readyState: number; send: (message: string) => void };
      relayAccepted: boolean;
      providerReady: boolean;
      initialContextReady: boolean;
      locationCommandMode: boolean;
      handleSocketMessage: (data: unknown) => Promise<void>;
    };
    connection.ws = { readyState: WebSocket.OPEN, send: vi.fn() };
    connection.relayAccepted = true;
    connection.providerReady = true;
    connection.initialContextReady = true;
    connection.locationCommandMode = true;
    expect(transport.beginInputTurn?.({ turnId: "location-turn-version" })).toBe(true);

    await connection.handleSocketMessage(
      JSON.stringify({
        locationCommandReady: {
          relayAccepted: true,
          providerReady: true,
          contextAccepted: true,
        },
      }),
    );

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        message: expect.stringContaining("does not support the current command protocol"),
      }),
    );
  });

  it("rejects an unversioned warm command relay before a tap can queue PCM", async () => {
    const onEvent = vi.fn();
    const transport = new GeminiLiveClient({ onEvent });
    const connection = transport as unknown as {
      ws: { readyState: number; send: (message: string) => void };
      relayAccepted: boolean;
      providerReady: boolean;
      initialContextReady: boolean;
      locationCommandMode: boolean;
      handleSocketMessage: (data: unknown) => Promise<void>;
    };
    connection.ws = { readyState: WebSocket.OPEN, send: vi.fn() };
    connection.relayAccepted = true;
    connection.providerReady = true;
    connection.initialContextReady = true;
    connection.locationCommandMode = true;

    await connection.handleSocketMessage(
      JSON.stringify({
        locationCommandReady: {
          relayAccepted: true,
          providerReady: true,
          contextAccepted: true,
        },
      }),
    );

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        message: expect.stringContaining("does not support the current command protocol"),
      }),
    );
    expect(transport.beginInputTurn?.({ turnId: "location-turn-after-version-failure" })).toBe(false);
  });

  it("accepts only the two static verified-status card pairs after the command fence", async () => {
    const send = vi.fn();
    const onEvent = vi.fn();
    const transport = new GeminiLiveClient({ onEvent });
    const connection = transport as unknown as {
      ws: { readyState: number; send: (message: string) => void };
      relayAccepted: boolean;
      providerReady: boolean;
      initialContextReady: boolean;
      locationCommandMode: boolean;
      locationCommandSessionReady: boolean;
      handleSocketMessage: (data: unknown) => Promise<void>;
    };
    connection.ws = { readyState: WebSocket.OPEN, send };
    connection.relayAccepted = true;
    connection.providerReady = true;
    connection.initialContextReady = true;
    connection.locationCommandMode = true;
    await markSessionCommandReady(connection);

    expect(transport.beginInputTurn?.({ turnId: "location-turn-status" })).toBe(true);
    await markCommandSpeechEnded({
      connection,
      turnId: "location-turn-status",
    });
    await connection.handleSocketMessage(
      JSON.stringify({ serverContent: { turnComplete: true } }),
    );
    await connection.handleSocketMessage(
      JSON.stringify({
        locationCommandResult: {
          protocolVersion: "one_command_v2",
          turnId: "location-turn-status",
          outcome: "execute_started",
          actionId: "location.create_circle",
          statusCard: {
            schemaVersion: "one.location_command_status_card.v1",
            surfaceId: "render.data_card",
            cardId: "one.location.command.circle_verified.v1",
            actionId: "location.create_circle",
            settlement: "verified",
          },
        },
      }),
    );
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "location_command_result",
        statusCard: {
          schemaVersion: "one.location_command_status_card.v1",
          surfaceId: "render.data_card",
          cardId: "one.location.command.circle_verified.v1",
          actionId: "location.create_circle",
          settlement: "verified",
        },
      }),
    );

    await connection.handleSocketMessage(
      JSON.stringify({
        locationCommandResult: {
          protocolVersion: "one_command_v2",
          turnId: "location-turn-status",
          outcome: "execute_started",
          actionId: "workflow.setup.location",
          statusCard: {
            schemaVersion: "one.location_command_status_card.v1",
            surfaceId: "render.data_card",
            cardId: "one.location.command.circle_verified.v1",
            actionId: "workflow.setup.location",
            settlement: "verified",
          },
        },
      }),
    );
    const commandResults = onEvent.mock.calls
      .map(([event]) => event)
      .filter(
        (event): event is { type: string; statusCard?: unknown } =>
          Boolean(event) &&
          typeof event === "object" &&
          "type" in event &&
          (event as { type?: string }).type === "location_command_result",
      );
    expect(commandResults).toHaveLength(2);
    expect(commandResults[1]?.statusCard).toBeNull();

    await connection.handleSocketMessage(
      JSON.stringify({
        locationCommandResult: {
          protocolVersion: "one_command_v2",
          turnId: "location-turn-status",
          outcome: "navigate",
          actionId: "location.open_now",
          navigation: {
            schemaVersion: "one.location_navigation_directive.v1",
            capabilityId: "location.open_now",
            route: "/one/location",
            settlement: "route_settlement_required",
          },
        },
      }),
    );
    const exactNavigation = onEvent.mock.calls
      .map(([event]) => event)
      .filter(
        (event): event is { type: string; navigation?: unknown } =>
          Boolean(event) &&
          typeof event === "object" &&
          "type" in event &&
          (event as { type?: string }).type === "location_command_result",
      )
      .at(-1);
    expect(exactNavigation?.navigation).toEqual({
      schemaVersion: "one.location_navigation_directive.v1",
      capabilityId: "location.open_now",
      route: "/one/location",
      settlement: "route_settlement_required",
    });

    await connection.handleSocketMessage(
      JSON.stringify({
        locationCommandResult: {
          protocolVersion: "one_command_v2",
          turnId: "location-turn-status",
          outcome: "navigate",
          actionId: "workflow.setup.location",
          navigation: {
            schemaVersion: "one.location_navigation_directive.v1",
            capabilityId: "location.create_circle",
            route: "/one/location",
            settlement: "route_settlement_required",
          },
        },
      }),
    );
    const navigations = onEvent.mock.calls
      .map(([event]) => event)
      .filter(
        (event): event is { type: string; navigation?: unknown } =>
          Boolean(event) &&
          typeof event === "object" &&
          "type" in event &&
          (event as { type?: string }).type === "location_command_result",
      );
    expect(navigations.at(-1)?.navigation).toBeNull();
    transport.stop();
  });

  it("turns a delayed-ready overlong buffer into a cancelled retry boundary without routing its prefix", async () => {
    const send = vi.fn();
    const onEvent = vi.fn();
    const transport = new GeminiLiveClient({ onEvent });
    const connection = transport as unknown as {
      ws: { readyState: number; send: (message: string) => void };
      relayAccepted: boolean;
      providerReady: boolean;
      initialContextReady: boolean;
      locationCommandMode: boolean;
      locationCommandSessionReady: boolean;
      handleCapturedPcm: (
        pcm: Uint8Array,
        level: number,
        source: "browser_pcm" | "ios_native_pcm",
      ) => void;
      handleSocketMessage: (data: unknown) => Promise<void>;
    };
    connection.ws = { readyState: WebSocket.OPEN, send };
    connection.relayAccepted = true;
    connection.providerReady = true;
    connection.initialContextReady = true;
    connection.locationCommandMode = true;

    expect(transport.beginInputTurn?.({ turnId: "location-turn-delayed" })).toBe(true);
    // 101 x 100ms frames exceeds the bounded ten-second pre-ready command
    // buffer. The entire partial command is discarded rather than routed.
    const frame = new Uint8Array(3_200);
    for (let index = 0; index < 101; index += 1) {
      connection.handleCapturedPcm(frame, 0, "browser_pcm");
    }
    expect(send).not.toHaveBeenCalled();
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        message: "Voice input was too long to send safely. Tap Talk to One and try again.",
      }),
    );

    await markSessionCommandReady(connection);
    const controlFrames = send.mock.calls.map(([frameText]) =>
      JSON.parse(frameText as string),
    );
    expect(controlFrames).toContainEqual({
      type: "location_command_begin",
      protocolVersion: "one_command_v2",
      turnId: "location-turn-delayed",
      startSequence: 1,
    });
    expect(controlFrames).toContainEqual({
      type: "location_command_cancel",
      protocolVersion: "one_command_v2",
      turnId: "location-turn-delayed",
      finalSequence: 0,
      cancelled: true,
    });

    await connection.handleSocketMessage(
      JSON.stringify({
        locationCommandResult: {
          protocolVersion: "one_command_v2",
          turnId: "location-turn-delayed",
          outcome: "interaction_required",
          ...permissionRunResultSource(),
        },
      }),
    );
    expect(commandEventTypes(onEvent)).not.toContain("location_command_result");
    transport.stop();
  });
});

describe("GeminiLiveClient provider input reply watchdog", () => {
  it("arms and refreshes the timeout when native PCM reaches provider transcription", async () => {
    vi.useFakeTimers();
    try {
      const onError = vi.fn();
      const transport = new GeminiLiveClient({ onError });
      const connection = transport as unknown as {
        state: "listening" | "thinking";
        modelReplyTimeoutTimer: ReturnType<typeof setTimeout> | null;
        handleSocketMessage: (data: unknown) => Promise<void>;
      };
      connection.state = "listening";

      await connection.handleSocketMessage(
        JSON.stringify({ inputTranscription: { text: "native PCM turn" } }),
      );
      expect(connection.state).toBe("thinking");
      expect(connection.modelReplyTimeoutTimer).not.toBeNull();

      await vi.advanceTimersByTimeAsync(14_000);
      await connection.handleSocketMessage(
        JSON.stringify({ inputTranscription: { text: "same accepted turn" } }),
      );
      await vi.advanceTimersByTimeAsync(2_000);

      // The second accepted provider transcription refreshed the bounded
      // watchdog rather than leaving the UI permanently in Thinking.
      expect(onError).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(13_000);
      expect(onError).toHaveBeenCalledWith(
        "One did not respond in time. Please try again.",
        expect.anything(),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("GeminiLiveClient text-only model turns", () => {
  it("surfaces the server-owned missing-circle-name clarification instead of staying thinking", async () => {
    vi.useFakeTimers();
    try {
      const onEvent = vi.fn();
      const transport = new GeminiLiveClient({ onEvent });
      const connection = transport as unknown as {
        state: "thinking" | "speaking";
        modelReplyTimeoutTimer: ReturnType<typeof setTimeout> | null;
        handleSocketMessage: (data: unknown) => Promise<void>;
      };
      connection.state = "thinking";
      connection.modelReplyTimeoutTimer = setTimeout(() => undefined, 15_000);

      await connection.handleSocketMessage(
        JSON.stringify({
          serverContent: {
            modelTurn: {
              parts: [{ text: "What should I call the new circle?" }],
            },
          },
        }),
      );

      expect(connection.state).toBe("speaking");
      expect(connection.modelReplyTimeoutTimer).toBeNull();
      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: "state", state: "result" }),
      );
      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "assistant_text",
          source: "model",
          text: "What should I call the new circle?",
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("GeminiLiveClient tool trace", () => {
  it("emits a tool_trace event for a read tool's parked display data", async () => {
    const onEvent = vi.fn();
    const transport = new GeminiLiveClient({ onEvent });
    const connection = transport as unknown as {
      handleSocketMessage: (data: unknown) => Promise<void>;
    };

    await connection.handleSocketMessage(
      JSON.stringify({
        toolTrace: {
          kind: "connections_list",
          payload: { people: [{ id: "cx1", name: "Sarah Chen" }] },
        },
      }),
    );

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "tool_trace",
        trace: {
          kind: "connections_list",
          payload: { people: [{ id: "cx1", name: "Sarah Chen" }] },
        },
      }),
    );
  });

  it("ignores a toolTrace frame with no kind", async () => {
    const onEvent = vi.fn();
    const transport = new GeminiLiveClient({ onEvent });
    const connection = transport as unknown as {
      handleSocketMessage: (data: unknown) => Promise<void>;
    };

    await connection.handleSocketMessage(JSON.stringify({ toolTrace: { payload: {} } }));

    expect(onEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "tool_trace" }),
    );
  });
});

describe("GeminiLiveClient session resumption", () => {
  it("stores an incoming resumption handle and hands it off in the closed event", async () => {
    const onEvent = vi.fn();
    const transport = new GeminiLiveClient({ onEvent });
    const connection = transport as unknown as {
      handleSocketMessage: (data: unknown) => Promise<void>;
    };

    await connection.handleSocketMessage(
      JSON.stringify({ sessionResumption: { handle: "resume-abc" } }),
    );
    transport.stop();

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "closed", resumptionHandle: "resume-abc" }),
    );
  });

  it("hands off null when no handle was ever received", () => {
    const onEvent = vi.fn();
    const transport = new GeminiLiveClient({ onEvent });

    transport.stop();

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "closed", resumptionHandle: null }),
    );
  });

  it("carries a stored resumption handle into the next bootstrap frame", async () => {
    vi.useFakeTimers();
    const OriginalWebSocket = global.WebSocket;
    try {
      const transport = new GeminiLiveClient();
      const connection = transport as unknown as {
        handleSocketMessage: (data: unknown) => Promise<void>;
        connectSocket: (relayUrl: string) => void;
      };
      await connection.handleSocketMessage(
        JSON.stringify({ sessionResumption: { handle: "resume-abc" } }),
      );

      const send = vi.fn();
      const sockets: Array<{ onopen: (() => void) | null }> = [];
      class FakeWebSocket {
        onopen: (() => void) | null = null;
        onmessage: ((event: { data: string }) => void) | null = null;
        onclose: (() => void) | null = null;
        onerror: (() => void) | null = null;
        readyState = 1;
        send = send;
        close = vi.fn();
        constructor() {
          sockets.push(this);
        }
      }
      // @ts-expect-error -- minimal stub standing in for the real WebSocket global
      global.WebSocket = FakeWebSocket;

      connection.connectSocket("wss://example.test/relay");
      sockets[0]?.onopen?.();

      expect(send).toHaveBeenCalledTimes(1);
      const sent = JSON.parse(send.mock.calls[0][0] as string) as Record<string, unknown>;
      expect(sent.resumption_handle).toBe("resume-abc");
    } finally {
      global.WebSocket = OriginalWebSocket;
      vi.useRealTimers();
    }
  });

  it("omits resumption_handle from the bootstrap frame when nothing was ever received", () => {
    vi.useFakeTimers();
    const OriginalWebSocket = global.WebSocket;
    try {
      const transport = new GeminiLiveClient();
      const connection = transport as unknown as {
        connectSocket: (relayUrl: string) => void;
      };

      const send = vi.fn();
      const sockets: Array<{ onopen: (() => void) | null }> = [];
      class FakeWebSocket {
        onopen: (() => void) | null = null;
        onmessage: ((event: { data: string }) => void) | null = null;
        onclose: (() => void) | null = null;
        onerror: (() => void) | null = null;
        readyState = 1;
        send = send;
        close = vi.fn();
        constructor() {
          sockets.push(this);
        }
      }
      // @ts-expect-error -- minimal stub standing in for the real WebSocket global
      global.WebSocket = FakeWebSocket;

      connection.connectSocket("wss://example.test/relay");
      sockets[0]?.onopen?.();

      const sent = JSON.parse(send.mock.calls[0][0] as string) as Record<string, unknown>;
      expect(sent).not.toHaveProperty("resumption_handle");
    } finally {
      global.WebSocket = OriginalWebSocket;
      vi.useRealTimers();
    }
  });
});
