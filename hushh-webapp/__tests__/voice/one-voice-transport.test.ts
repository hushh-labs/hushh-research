import { describe, expect, it, vi } from "vitest";

import { GeminiLiveTransport } from "@/lib/services/gemini-live-client";
import { OpenAIRealtimeTransport } from "@/lib/voice/openai-realtime-transport";
import { createRealtimeVoiceTransport } from "@/lib/voice/one-voice-transport-factory";

describe("One Voice realtime transports", () => {
  it("exposes Gemini Live as the active provider-neutral transport", () => {
    const transport = new GeminiLiveTransport();

    expect(transport.provider).toBe("gemini_live");
    expect(typeof transport.start).toBe("function");
    expect(typeof transport.stop).toBe("function");
  });

  it("creates transports through the provider-neutral factory", () => {
    expect(createRealtimeVoiceTransport().provider).toBe("gemini_live");
    expect(createRealtimeVoiceTransport({}, "openai_realtime").provider).toBe(
      "openai_realtime"
    );
  });

  it("emits Gemini state events with session and source sequence metadata", () => {
    const onEvent = vi.fn();
    const onVoiceState = vi.fn();
    const transport = new GeminiLiveTransport({ onEvent, onVoiceState });
    const testTransport = transport as unknown as {
      sessionId: string | null;
      setState: (state: "connecting") => void;
    };

    testTransport.sessionId = "gemini_session_1";
    testTransport.setState("connecting");

    expect(onVoiceState).toHaveBeenCalledWith("connecting", {
      sessionId: "gemini_session_1",
      sourceId: "gemini_live",
      sourceSeq: 1,
    });
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "state",
        provider: "gemini_live",
        sessionId: "gemini_session_1",
        sourceId: "gemini_live",
        sourceSeq: 1,
      })
    );
  });

  it("normalizes ADK relay transcripts and client directives", async () => {
    const onEvent = vi.fn();
    const transport = new GeminiLiveTransport({ onEvent });
    const testTransport = transport as unknown as {
      sessionId: string | null;
      handleSocketMessage: (data: string) => Promise<void>;
    };

    testTransport.sessionId = "gemini_session_1";
    await testTransport.handleSocketMessage(
      JSON.stringify({
        inputTranscription: {
          text: "show my portfolio",
          confidence: 0.9,
        },
        outputTranscription: {
          text: "I can help with that.",
        },
      })
    );
    await testTransport.handleSocketMessage(
      JSON.stringify({
        clientDirective: {
          kind: "navigate",
          payload: { route: "/one/kai", screen: "finance" },
        },
      })
    );

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "transcript_final",
        text: "show my portfolio",
        provider: "gemini_live",
      })
    );
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "assistant_text",
        text: "I can help with that.",
        provider: "gemini_live",
      })
    );
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "client_directive",
        provider: "gemini_live",
        directive: {
          kind: "navigate",
          payload: { route: "/one/kai", screen: "finance" },
        },
      })
    );
  });

  it("returns a correlated browser action settlement to the ADK relay", () => {
    const transport = new GeminiLiveTransport();
    const send = vi.fn();
    const testTransport = transport as unknown as {
      ws: { readyState: number; send: (message: string) => void };
      setupComplete: boolean;
    };
    testTransport.ws = { readyState: WebSocket.OPEN, send };
    testTransport.setupComplete = true;

    expect(
      transport.reportActionSettlement({
        directiveId: "directive-1",
        actionId: "analysis.start",
        status: "blocked",
        summary: "Portfolio access is locked.",
        reason: "vault_locked",
      })
    ).toBe(true);
    expect(JSON.parse(send.mock.calls[0][0])).toEqual({
      type: "action_settled",
      actionSettlement: {
        directiveId: "directive-1",
        actionId: "analysis.start",
        status: "blocked",
        summary: "Portfolio access is locked.",
        reason: "vault_locked",
      },
    });
  });

  it("emits one transcript-free visitor activity frame after sustained speech", () => {
    const transport = new GeminiLiveTransport();
    const send = vi.fn();
    const testTransport = transport as unknown as {
      ws: { readyState: number; send: (message: string) => void };
      setupComplete: boolean;
      sendVisitorActivityStart: (level: number, pcm: Uint8Array) => boolean;
    };
    testTransport.ws = { readyState: WebSocket.OPEN, send };
    testTransport.setupComplete = true;

    for (let index = 0; index < 7; index += 1) {
      expect(testTransport.sendVisitorActivityStart(0.09, new Uint8Array([index]))).toBe(false);
    }
    expect(send).not.toHaveBeenCalled();

    expect(testTransport.sendVisitorActivityStart(0.09, new Uint8Array([7]))).toBe(false);
    expect(testTransport.sendVisitorActivityStart(0.5, new Uint8Array([8]))).toBe(true);

    expect(send).toHaveBeenCalledTimes(9);
    expect(JSON.parse(send.mock.calls[0][0])).toEqual({ type: "voice_activity_start" });
    expect(JSON.parse(send.mock.calls[1][0])).toMatchObject({
      realtimeInput: { audio: { data: expect.any(String) } },
    });
  });

  it("does not treat low microphone energy as visitor activity", () => {
    const transport = new GeminiLiveTransport();
    const send = vi.fn();
    const testTransport = transport as unknown as {
      ws: { readyState: number; send: (message: string) => void };
      setupComplete: boolean;
      sendVisitorActivityStart: (level: number, pcm: Uint8Array) => boolean;
    };
    testTransport.ws = { readyState: WebSocket.OPEN, send };
    testTransport.setupComplete = true;

    for (let index = 0; index < 20; index += 1) {
      testTransport.sendVisitorActivityStart(0.01, new Uint8Array([index]));
    }

    expect(send).not.toHaveBeenCalled();
  });

  it("keeps OpenAI Realtime behind the same interface until enabled", async () => {
    const onEvent = vi.fn();
    const transport = new OpenAIRealtimeTransport({ onEvent });

    await expect(transport.start()).rejects.toThrow("OpenAI Realtime is scaffolded");
    expect(transport.provider).toBe("openai_realtime");
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        provider: "openai_realtime",
      })
    );

    transport.stop();
    expect(onEvent).toHaveBeenCalledWith({
      type: "closed",
      provider: "openai_realtime",
    });
  });
});
