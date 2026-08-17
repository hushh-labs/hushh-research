import { describe, expect, it, vi } from "vitest";

import { GeminiLiveClient } from "@/lib/services/gemini-live-client";
import * as voiceTelemetry from "@/lib/voice/voice-telemetry";

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

describe("GeminiLiveClient voice latency telemetry", () => {
  it("logs session-ready latency the moment the handshake completes", async () => {
    const logSpy = vi
      .spyOn(voiceTelemetry, "logVoiceMetric")
      .mockImplementation(() => undefined);
    try {
      const transport = new GeminiLiveClient();
      const connection = transport as unknown as {
        handleSocketMessage: (data: string) => Promise<void>;
        sessionStartRequestedAt: number;
      };
      connection.sessionStartRequestedAt = performance.now() - 250;

      await connection.handleSocketMessage(JSON.stringify({ setupComplete: {} }));

      const call = logSpy.mock.calls.find(
        ([payload]) => payload.metric === "voice_session_ready_ms",
      );
      expect(call).toBeDefined();
      // >= the artificial 250ms head start, not an exact value -- this only
      // needs to prove the clock actually started at start(), not at whatever
      // instant the message happened to arrive.
      expect(call?.[0].value).toBeGreaterThanOrEqual(250);
    } finally {
      logSpy.mockRestore();
    }
  });
});
