import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiService } from "@/lib/services/api-service";

import { ApiService } from "@/lib/services/api-service";
import { GeminiLiveClient } from "@/lib/services/gemini-live-client";
import type {
  OneVoiceSpeechAdapter,
  SpeechAdapterCallbacks,
} from "@/lib/voice/transcript-events";

vi.mock("@/lib/voice/voice-telemetry", () => ({
  createVoiceTurnId: () => "vturn_test",
  logVoiceMetric: vi.fn(),
}));

describe("GeminiLiveClient action confirmation", () => {
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

  it("returns a typed disconnected result instead of throwing from an absent socket", async () => {
    const transport = new GeminiLiveClient();

    await expect(
      transport.confirmActionDirective({
        directiveId: "directive_1",
        actionId: "one.navigate",
        contextRevision: "revision_1",
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
      });
      expect(send).toHaveBeenCalledWith(
        JSON.stringify({
          type: "action_confirm",
          actionConfirmation: {
            directiveId: "directive_1",
            actionId: "one.navigate",
            contextRevision: "revision_1",
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
    expect(send).toHaveBeenCalledTimes(9);
    expect(connection.speechOnsetReady).toBe(false);
    expect(connection.bufferedVisitorSpeechFrames).toHaveLength(0);
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


describe("GeminiLiveClient cancellation during startup", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("releases a permission result arriving after stop without opening audio or a socket", async () => {
    let allow!: (stream: MediaStream) => void;
    const trackStop = vi.fn();
    const getUserMedia = vi.fn(() => new Promise<MediaStream>((resolve) => { allow = resolve; }));
    const audio = vi.fn();
    const socket = vi.fn();
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    vi.stubGlobal("AudioContext", audio);
    vi.stubGlobal("WebSocket", socket);
    const transport = new GeminiLiveClient();
    const started = transport.start({ relayUrl: "wss://synthetic.example" });
    expect(getUserMedia).toHaveBeenCalledOnce();
    transport.stop();
    allow({ getTracks: () => [{ stop: trackStop }] } as unknown as MediaStream);
    await started;
    expect(trackStop).toHaveBeenCalledOnce();
    expect(audio).not.toHaveBeenCalled();
    expect(socket).not.toHaveBeenCalled();
  });

  it("never asks for a microphone when the relay ticket arrives after stop", async () => {
    let finish!: (url: string) => void;
    vi.spyOn(ApiService, "getOneAdkLiveRelayUrl").mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const getUserMedia = vi.fn();
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    const transport = new GeminiLiveClient();
    const started = transport.start();
    transport.stop();
    finish("wss://synthetic.example");
    await started;
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("stops audio resources during resume and does not load a worklet afterward", async () => {
    let resume!: () => void;
    const trackStop = vi.fn();
    const close = vi.fn().mockResolvedValue(undefined);
    const addModule = vi.fn();
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: trackStop }] }) } });
    class FakeAudioContext {
      state = "suspended";
      close = close;
      audioWorklet = { addModule };
      resume = () => new Promise<void>((resolve) => { resume = resolve; });
    }
    vi.stubGlobal("AudioContext", FakeAudioContext);
    const transport = new GeminiLiveClient();
    const started = transport.start({ relayUrl: "wss://synthetic.example" });
    await Promise.resolve();
    transport.stop();
    resume();
    await started;
    expect(trackStop).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(addModule).not.toHaveBeenCalled();
  });
});
