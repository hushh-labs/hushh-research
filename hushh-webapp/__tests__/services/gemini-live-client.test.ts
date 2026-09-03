import { describe, expect, it, vi } from "vitest";

import { GeminiLiveClient } from "@/lib/services/gemini-live-client";

vi.mock("@/lib/voice/voice-telemetry", () => ({
  createVoiceTurnId: () => "vturn_test",
  logVoiceMetric: vi.fn(),
}));

describe("GeminiLiveClient action confirmation", () => {
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
